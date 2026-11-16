'use strict';
const config = require('../config/printify-variants.json');
const { checkOrder } = require('./gate');

// store: { get(orderId) -> record|null, claim(orderId) -> bool (atomic), set(orderId, patch) }
// prepare(order, items) -> items: renders and stores print files for pet-studio designs (design-fulfillment.js).
// deliver(order, digitalItems): sends digital portraits to the customer (Shopify fulfillment with the download link).
// Production is only reached if MODE === 'production'. Default is draft: nothing is produced.
// printful (optional): EU blanket lines marked fulfiller 'printful' by prepare() go there as a Printful draft.
async function processPaidOrder(order, { store, printify, printful, prepare, deliver, gateOptions, mode = 'draft' }) {
  const id = String(order.id);
  const gate = checkOrder(order, gateOptions);
  if (!gate.ok) {
    // Not ours / not eligible: hold and surface the reason (but never touch Printify).
    if (gate.reasons.length === 1 && gate.reasons[0] === 'no_personalized_lines') return { action: 'ignored' };
    await store.set(id, { status: 'error', error: gate.reasons.join(', '), hold: true });
    if (store.applyHold) await store.applyHold(id, gate.reasons.join(', '));
    return { action: 'blocked', reasons: gate.reasons };
  }
  const existing = await store.get(id);
  // A run that stopped half way (complete === false) is resumed; each maker's order is created only once.
  if (existing && existing.complete !== false && (existing.printify_order_id || existing.printful_order_id || existing.status === 'delivered')) return { action: 'duplicate_skipped', printify_order_id: existing.printify_order_id, printful_order_id: existing.printful_order_id };
  if (!(await store.claim(id))) return { action: 'duplicate_skipped' }; // another worker holds the lock
  try {
    let items = gate.items;
    if (items.some(i => i.kind === 'design')) {
      if (!prepare) throw new Error('print_file_renderer_not_configured');
      await store.set(id, { status: 'rendering', error: null });
      items = await prepare(order, items);
    }
    const lines = Object.fromEntries(items.map(i => [String(i.line_id), {
      kind: i.kind, printify_variant_id: i.printify_variant_id, print_file_url: i.print_file_url,
      ...(i.fulfiller === 'printful' ? { fulfiller: 'printful', printful_variant_id: i.printful_variant_id } : {}),
      ...(i.production ? { design_id: i.production.design_id, size: `${i.production.width}x${i.production.height}`, sha256: i.production.sha256, artwork_check: i.production.artwork_check } : {})
    }]));
    const physical = items.filter(i => !i.digital), digital = items.filter(i => i.digital);
    if (digital.length) {
      // A retry never emails the same file twice: delivered lines are recorded straight away.
      const sent = new Set(((existing && existing.digital_delivered) || []).map(String));
      const todo = digital.filter(i => !sent.has(String(i.line_id)));
      if (todo.length) {
        if (!deliver) throw new Error('digital_delivery_not_configured');
        const result = await deliver(order, todo);
        if (result !== 'held') {
          todo.forEach(i => sent.add(String(i.line_id)));
          await store.set(id, { digital_delivered: Array.from(sent) });
        }
      }
      for (const i of digital) lines[String(i.line_id)].delivered = sent.has(String(i.line_id));
    }
    if (!physical.length) {
      await store.set(id, { status: 'delivered', error: null, hold: false, lines });
      return { action: 'digital_delivered' };
    }
    const viaPrintful = physical.filter(i => i.fulfiller === 'printful'), viaPrintify = physical.filter(i => i.fulfiller !== 'printful');
    const result = { action: mode === 'production' ? 'sent' : 'draft_created' };
    let pfId = existing && existing.printful_order_id, pyId = existing && existing.printify_order_id;
    if (viaPrintful.length && !pfId) {
      if (!printful) throw new Error('printful_not_configured');
      const draft = await printful.createDraftOrder(order, viaPrintful);
      pfId = String(draft.id);
      await store.set(id, { printful_order_id: pfId, complete: false, lines });
    }
    if (viaPrintify.length && !pyId) {
      const draft = await printify.createDraftOrder(order, viaPrintify, config);
      pyId = draft.id;
      await store.set(id, { printify_order_id: pyId, complete: false, lines });
    }
    await store.set(id, { status: 'paid', error: null, hold: false, lines, complete: mode !== 'production' });
    if (pfId) result.printful_order_id = pfId;
    if (pyId) result.printify_order_id = pyId;
    if (mode === 'production') {
      if (viaPrintful.length && !(existing && existing.printful_confirmed)) { await printful.confirmOrder(pfId); await store.set(id, { printful_confirmed: true }); }
      if (viaPrintify.length && !(existing && existing.printify_sent)) { await printify.sendToProduction(pyId); await store.set(id, { printify_sent: true }); }
      await store.set(id, { status: 'sent_to_printify', complete: true });
    }
    return result;
  } catch (err) {
    await store.set(id, { status: 'error', error: String(err.message).slice(0, 500), hold: true, claimed: false });
    if (store.applyHold) await store.applyHold(id, err.message);
    return { action: 'error', error: err.message };
  }
}
module.exports = { processPaidOrder };
