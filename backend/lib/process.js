'use strict';
const config = require('../config/printify-variants.json');
const { checkOrder } = require('./gate');

// store: { get(orderId) -> record|null, claim(orderId) -> bool (atomic), set(orderId, patch) }
// Production is only reached if MODE === 'production'. Default is draft: nothing is produced.
async function processPaidOrder(order, { store, printify, mode = 'draft' }) {
  const id = String(order.id);
  const gate = checkOrder(order);
  if (!gate.ok) {
    // Not ours / not eligible: hold and surface the reason (but never touch Printify).
    if (gate.reasons.length === 1 && gate.reasons[0] === 'no_ornament_lines') return { action: 'ignored' };
    await store.set(id, { status: 'error', error: gate.reasons.join(', '), hold: true });
    return { action: 'blocked', reasons: gate.reasons };
  }
  const existing = await store.get(id);
  if (existing && existing.printify_order_id) return { action: 'duplicate_skipped', printify_order_id: existing.printify_order_id };
  if (!(await store.claim(id))) return { action: 'duplicate_skipped' }; // another worker holds the lock
  try {
    const draft = await printify.createDraftOrder(order, gate.items, config);
    await store.set(id, { status: 'paid', printify_order_id: draft.id, error: null, hold: false });
    if (mode === 'production') {
      await printify.sendToProduction(draft.id);
      await store.set(id, { status: 'sent_to_printify' });
      return { action: 'sent', printify_order_id: draft.id };
    }
    return { action: 'draft_created', printify_order_id: draft.id };
  } catch (err) {
    await store.set(id, { status: 'error', error: String(err.message).slice(0, 500), hold: true, claimed: false });
    return { action: 'error', error: err.message };
  }
}
module.exports = { processPaidOrder };
