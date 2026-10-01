const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const handler = require('../api/orders-paid');
const { verifyShopifyHmac } = require('../lib/hmac');
const { shopifyStore } = require('../lib/shopify-store');

const SECRET = 's3cret';
const sign = b => crypto.createHmac('sha256', SECRET).update(b).digest('base64');
function call(body, sig, deps) {
  const req = new EventEmitter(); req.method = 'POST'; req.headers = { 'x-shopify-hmac-sha256': sig };
  const res = { headers: {}, setHeader() {}, end(b) { this.body = b; this.done(); } };
  const p = new Promise(r => { res.done = r; });
  handler(req, res, { secret: SECRET, ...deps }); process.nextTick(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  return p.then(() => res);
}
test('hmac accepts valid, rejects tampered/missing', () => {
  assert.ok(verifyShopifyHmac('x', sign('x'), SECRET));
  assert.ok(!verifyShopifyHmac('y', sign('x'), SECRET));
  assert.ok(!verifyShopifyHmac('x', undefined, SECRET));
  assert.ok(!verifyShopifyHmac('x', sign('x'), ''));
});
test('bad signature -> 401 and Printify untouched', async () => {
  let touched = false;
  const res = await call('{"id":1}', 'bad', { store: {}, printify: { createDraftOrder: () => { touched = true; } } });
  assert.equal(res.statusCode, 401); assert.equal(touched, false);
});
test('valid signature for non-ornament order -> 200 ignored', async () => {
  const body = JSON.stringify({ id: 1, financial_status: 'paid', line_items: [] });
  const res = await call(body, sign(body), { store: { get: async () => null, claim: async () => true, set: async () => {} }, printify: {} });
  assert.equal(res.statusCode, 200); assert.equal(JSON.parse(res.body).action, 'ignored');
});
test('shopify store: claim uses compareDigest and loses on STALE_OBJECT', async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => {
    const { query, variables } = JSON.parse(opts.body); sent.push({ query, variables });
    if (query.includes('OrderState')) return { ok: true, json: async () => ({ data: { order: { metafield: null, fulfillmentOrders: { nodes: [] } } } }) };
    return { ok: true, json: async () => ({ data: { metafieldsSet: { userErrors: [{ message: 'stale', code: 'STALE_OBJECT' }] } } }) };
  };
  const s = shopifyStore({ shop: 'x.myshopify.com', token: 't', fetchImpl });
  assert.equal(await s.claim('5'), false);
  assert.equal(sent[1].variables.metafields[0].compareDigest, null);
});
test('shopify store: hold is applied to OPEN fulfillment orders only', async () => {
  const holds = [];
  const fetchImpl = async (url, opts) => {
    const { query, variables } = JSON.parse(opts.body);
    if (query.includes('OrderState')) return { ok: true, json: async () => ({ data: { order: { metafield: null, fulfillmentOrders: { nodes: [{ id: 'fo1', status: 'OPEN' }, { id: 'fo2', status: 'CLOSED' }] } } } }) };
    holds.push(variables.id); return { ok: true, json: async () => ({ data: { fulfillmentOrderHold: { userErrors: [] } } }) };
  };
  await shopifyStore({ shop: 'x', token: 't', fetchImpl }).applyHold('5', 'why');
  assert.deepEqual(holds, ['fo1']);
});
