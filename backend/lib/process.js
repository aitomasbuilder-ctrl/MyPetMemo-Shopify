'use strict';
const config = require('../config/printify-variants.json');
const { checkOrder } = require('./gate');

// store: { get(orderId) -> record|null, claim(orderId) -> bool (atomic), set(orderId, patch) }
// prepare(order, items) -> items: renders and stores print files for pet-studio designs (design-fulfillment.js).
// Production is only reached if MODE === 'production'. Default is draft: nothing is produced.
async function processPaidOrder(order, { store, printify, prepare, gateOptions, mode = 'draft' }) {
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
  if (existing && existing.printify_order_id) return { action: 'duplicate_skipped', printify_order_id: existing.printify_order_id };
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
      ...(i.production ? { design_id: i.production.design_id, size: `${i.production.width}x${i.production.height}`, sha256: i.production.sha256, artwork_check: i.production.artwork_check } : {})
    }]));
    const draft = await printify.createDraftOrder(order, items, config);
    await store.set(id, { status: 'paid', printify_order_id: draft.id, error: null, hold: false, lines });
    if (mode === 'production') {
      await printify.sendToProduction(draft.id);
      await store.set(id, { status: 'sent_to_printify' });
      return { action: 'sent', printify_order_id: draft.id };
    }
    return { action: 'draft_created', printify_order_id: draft.id };
  } catch (err) {
    await store.set(id, { status: 'error', error: String(err.message).slice(0, 500), hold: true, claimed: false });
    if (store.applyHold) await store.applyHold(id, err.message);
    return { action: 'error', error: err.message };
  }
}
module.exports = { processPaidOrder };
