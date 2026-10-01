const test = require('node:test');
const assert = require('node:assert');
const { processPaidOrder } = require('../lib/process');
const { canTransition } = require('../lib/status');

const mkStore = () => {
  const m = new Map();
  return { m,
    get: async id => m.get(id) || null,
    claim: async id => { const r = m.get(id) || {}; if (r.claimed) return false; m.set(id, { ...r, claimed: true }); return true; },
    set: async (id, p) => m.set(id, { ...(m.get(id) || {}), ...p }) };
};
const mkPrintify = (fail) => { const calls = []; return { calls,
  createDraftOrder: async () => { calls.push('draft'); if (fail) throw new Error('boom'); return { id: 'pf1' }; },
  sendToProduction: async () => calls.push('send') }; };
const order = { id: 1, name: '#1001', financial_status: 'paid', line_items: [{ id: 9, product_id: 9612228264038, variant_id: 48957877813350,
  properties: [{ name: '_approved', value: 'true' }, { name: '_print_file_url', value: 'https://f.example/a.png' }] }] };

test('default mode creates draft only, never sends to production', async () => {
  const p = mkPrintify(); const r = await processPaidOrder(order, { store: mkStore(), printify: p });
  assert.equal(r.action, 'draft_created'); assert.deepEqual(p.calls, ['draft']);
});
test('webhook delivered twice submits once', async () => {
  const s = mkStore(), p = mkPrintify();
  await processPaidOrder(order, { store: s, printify: p });
  const r = await processPaidOrder(order, { store: s, printify: p });
  assert.equal(r.action, 'duplicate_skipped'); assert.equal(p.calls.length, 1);
});
test('concurrent deliveries submit once', async () => {
  const s = mkStore(), p = mkPrintify();
  await Promise.all([processPaidOrder(order, { store: s, printify: p }), processPaidOrder(order, { store: s, printify: p })]);
  assert.equal(p.calls.filter(c => c === 'draft').length, 1);
});
test('unapproved order never reaches Printify and is held with error', async () => {
  const s = mkStore(), p = mkPrintify();
  const bad = { ...order, line_items: [{ ...order.line_items[0], properties: [] }] };
  const r = await processPaidOrder(bad, { store: s, printify: p });
  assert.equal(r.action, 'blocked'); assert.equal(p.calls.length, 0);
  assert.equal(s.m.get('1').status, 'error'); assert.equal(s.m.get('1').hold, true);
});
test('Printify failure holds order with error and allows a later retry', async () => {
  const s = mkStore();
  const r = await processPaidOrder(order, { store: s, printify: mkPrintify(true) });
  assert.equal(r.action, 'error'); assert.equal(s.m.get('1').hold, true);
  const p2 = mkPrintify(); const r2 = await processPaidOrder(order, { store: s, printify: p2 });
  assert.equal(r2.action, 'draft_created');
});
test('status transitions are forward-only', () => {
  assert.ok(canTransition('approved', 'paid')); assert.ok(!canTransition('paid', 'approved')); assert.ok(canTransition('paid', 'error'));
});
