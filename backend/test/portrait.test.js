// Personalized Pet Portrait: styles and decor in the signed design, decor in the print file,
// framed/canvas lines to Printify, digital lines rendered and delivered instead.
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const design = require('../lib/design');
const { renderDesign, sha256 } = require('../lib/render');
const { processPaidOrder } = require('../lib/process');
const { prepareDesignItems } = require('../lib/design-fulfillment');
const backgrounds = require('../shared/pet-backgrounds');

const KEY = 'p'.repeat(40);
process.env.DESIGN_SIGNING_SECRET = KEY;
const hosts = ['cdn.shopify.com'];

async function artworkPng(w = 400, h = 500) {
  const pet = await sharp({ create: { width: w / 2, height: h / 2, channels: 4, background: { r: 120, g: 80, b: 40, alpha: 1 } } }).png().toBuffer();
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: pet, left: w / 4, top: h / 4 }]).png().toBuffer();
}
const portrait = (art, over = {}) => ({
  family: 'portrait', style: 'watercolor', frame: 'black',
  product_id: '15500000000001', variant_id: '67700000000001', sku: '15562437253703177661', print: { w: 1200, h: 1500 },
  background: { id: 'soft-pink' }, pet: { cx: 0.5, cy: 0.45, w: 0.6, rot: 0, fade: 0.16 },
  name: { text: 'Maple', cx: 0.5, cy: 0.88, size: 0.08, font: 'playfair', fill: '#5a4a52', stroke: '#f4d9de' },
  decor: { kind: 'wash', cx: 0.5, cy: 0.4, r: 0.4, color: '#D99AA6' },
  artwork: { sha256: sha256(art), w: 400, h: 500 }, ...over
});

test('portrait: style, frame and decor are part of the signed design', async () => {
  const art = await artworkPng();
  const d = design.normalise(portrait(art), { hosts });
  assert.equal(d.family, 'portrait'); assert.equal(d.style, 'watercolor'); assert.equal(d.frame, 'black');
  assert.deepEqual(d.decor, { kind: 'wash', cx: 0.5, cy: 0.4, r: 0.4, color: '#d99aa6' });
  assert.equal(d.background.name, 'Blush Pink');
  const classic = design.normalise(portrait(art, { style: 'classic', decor: { kind: 'vignette', cx: 0.5, cy: 0.4, r: 0.33, color: '#c3a9ad' } }), { hosts });
  assert.notEqual(design.designId(d), design.designId(classic), 'another style is another design');
  assert.equal(design.normalise(portrait(art, { style: 'cubist' }), { hosts }).style, 'modern');
  assert.throws(() => design.normalise(portrait(art, { decor: { kind: 'lasers', cx: 0.5, cy: 0.5, r: 0.3, color: '#ffffff' } }), { hosts }), e => e.code === 'decor_unknown');
  const blanket = design.normalise({ ...portrait(art), family: 'blanket' }, { hosts });
  assert.equal('style' in blanket, false); assert.equal('decor' in blanket, false);
});

test('portrait: all eight wall colours exist for print', () => {
  for (const id of ['soft-pink', 'warm-cream', 'beige', 'sage-green', 'light-blue', 'white', 'charcoal', 'terracotta']) {
    assert.ok(backgrounds.byId[id], id);
  }
  assert.equal(backgrounds.byId['soft-pink'].color, '#f4d9de');
});

test('render: the style decoration sits between the background and the pet', async () => {
  const art = await artworkPng();
  const d = design.normalise(portrait(art, { name: null, pet: { cx: 0.5, cy: 0.5, w: 0.3, rot: 0 } }), { hosts });
  const r = await renderDesign({ design: d, artwork: art, width: 600, height: 750 });
  const { data, info } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => Array.from(data.slice((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
  const corner = px(10, 10), nearHead = px(300, 230), pet = px(300, 375);
  assert.deepEqual(corner, [0xf4, 0xd9, 0xde], 'plain background away from the decor');
  assert.ok(nearHead[1] < corner[1] - 15, `decor tints the area around the pet ${nearHead} vs ${corner}`);
  assert.ok(pet[0] < 140 && pet[2] < 70, `pet drawn on top of the decor ${pet}`);
});

const mkStore = () => {
  const m = new Map();
  return { m,
    get: async id => m.get(id) || null,
    claim: async id => { const r = m.get(id) || {}; if (r.claimed) return false; m.set(id, { ...r, claimed: true }); return true; },
    set: async (id, p) => m.set(id, { ...(m.get(id) || {}), ...p }),
    applyHold: async () => {} };
};
const mkPrintify = fail => { const calls = []; return { calls,
  createDraftOrder: async (o, items) => { calls.push(items); if (fail) throw new Error('printify down'); return { id: 'pf-' + calls.length }; },
  sendToProduction: async () => {} }; };

async function line(lineId, sku, over = {}) {
  const art = await artworkPng();
  const d = design.normalise(portrait(art, { sku, ...over }), { hosts });
  const { token, id } = design.sign(d, KEY);
  return { id, art, line: { id: lineId, product_id: 15500000000001, variant_id: Number(d.variant_id), sku, quantity: 1,
    properties: [{ name: 'Design ID', value: id }, { name: '_design', value: token }, { name: '_artwork', value: `https://cdn.shopify.com/s/files/1/uploads/${lineId}.png` }] } };
}
function deps(arts) {
  const stored = [], catalogCalls = [];
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'HEAD') { const f = stored.find(s => s.url === url); return { ok: !!f, headers: new Map([['content-length', String(f ? f.size : 0)]]) }; }
    return arts[url] ? { ok: true, arrayBuffer: async () => arts[url] } : { ok: false, status: 404 };
  };
  const put = async (path, buf) => { const url = `https://blob.example/${path}`; stored.push({ url, size: buf.length, path }); return url; };
  const catalog = {
    variantForSku: async sku => { catalogCalls.push(sku); return { blueprint_id: 1191, print_provider_id: 105, printify_variant_id: 9001, position: 'front', is_enabled: true }; },
    printArea: async () => ({ position: 'front', width: 900, height: 1100 })
  };
  return { stored, catalogCalls, prepare: (order, items) => prepareDesignItems(order, items, { catalog, put, fetchImpl, hosts }) };
}
const gateOptions = { verify: t => design.verify(t, KEY), hosts };

test('order: a framed portrait goes to Printify and a digital portrait is delivered, each once', async () => {
  const framed = await line(1, '15562437253703177661');
  const digital = await line(2, 'MPM-DIGITAL-PORTRAIT', { frame: 'digital', print: { w: 4800, h: 6000 } });
  const order = { id: 501, name: '#1501', financial_status: 'paid', line_items: [framed.line, digital.line] };
  const { prepare, stored, catalogCalls } = deps({ 'https://cdn.shopify.com/s/files/1/uploads/1.png': framed.art, 'https://cdn.shopify.com/s/files/1/uploads/2.png': digital.art });
  const store = mkStore(), printify = mkPrintify(), delivered = [];
  const deliver = async (o, items) => { delivered.push(...items); return 'sent'; };
  const r = await processPaidOrder(order, { store, printify, prepare, deliver, gateOptions });
  assert.equal(r.action, 'draft_created');
  assert.equal(printify.calls[0].length, 1, 'only the framed line goes to Printify');
  assert.equal(printify.calls[0][0].printify_variant_id, 9001);
  assert.deepEqual(catalogCalls, ['15562437253703177661'], 'the digital SKU is never looked up in Printify');
  assert.equal(delivered.length, 1); assert.equal(delivered[0].line_id, 2);
  const file = stored.find(s => s.path.startsWith('digital/'));
  assert.ok(file, 'digital file stored');
  assert.equal(delivered[0].print_file_url, file.url);
  assert.equal(delivered[0].production.width, 4800); assert.equal(delivered[0].production.height, 6000);
  const rec = store.m.get('501');
  assert.equal(rec.lines['2'].delivered, true); assert.equal(rec.lines['1'].size, '900x1100');
  const again = await processPaidOrder(order, { store, printify, prepare, deliver, gateOptions });
  assert.equal(again.action, 'duplicate_skipped'); assert.equal(delivered.length, 1);
});

test('order: digital-only orders never create a Printify order', async () => {
  const digital = await line(3, 'MPM-DIGITAL-PORTRAIT', { frame: 'digital', print: { w: 4800, h: 6000 } });
  const order = { id: 502, financial_status: 'paid', line_items: [digital.line] };
  const { prepare } = deps({ 'https://cdn.shopify.com/s/files/1/uploads/3.png': digital.art });
  const store = mkStore(), printify = mkPrintify(), delivered = [];
  const r = await processPaidOrder(order, { store, printify, prepare, deliver: async (o, i) => { delivered.push(...i); return 'sent'; }, gateOptions });
  assert.equal(r.action, 'digital_delivered');
  assert.equal(printify.calls.length, 0); assert.equal(delivered.length, 1);
  assert.equal(store.m.get('502').status, 'delivered');
});

test('order: a retry after a Printify failure does not email the digital file twice', async () => {
  const framed = await line(4, '15562437253703177661');
  const digital = await line(5, 'MPM-DIGITAL-PORTRAIT', { frame: 'digital', print: { w: 4800, h: 6000 } });
  const order = { id: 503, financial_status: 'paid', line_items: [framed.line, digital.line] };
  const arts = { 'https://cdn.shopify.com/s/files/1/uploads/4.png': framed.art, 'https://cdn.shopify.com/s/files/1/uploads/5.png': digital.art };
  const store = mkStore(), delivered = [];
  const deliver = async (o, i) => { delivered.push(...i); return 'sent'; };
  const r1 = await processPaidOrder(order, { store, printify: mkPrintify(true), prepare: deps(arts).prepare, deliver, gateOptions });
  assert.equal(r1.action, 'error'); assert.equal(store.m.get('503').hold, true);
  const r2 = await processPaidOrder(order, { store, printify: mkPrintify(), prepare: deps(arts).prepare, deliver, gateOptions });
  assert.equal(r2.action, 'draft_created');
  assert.equal(delivered.length, 1, 'delivered once');
});

test('order: a too-small digital file is held, never delivered', async () => {
  const digital = await line(6, 'MPM-DIGITAL-PORTRAIT', { frame: 'digital', print: { w: 800, h: 1000 } });
  const order = { id: 504, financial_status: 'paid', line_items: [digital.line] };
  const { prepare } = deps({ 'https://cdn.shopify.com/s/files/1/uploads/6.png': digital.art });
  const store = mkStore(), delivered = [];
  const r = await processPaidOrder(order, { store, printify: mkPrintify(), prepare, deliver: async (o, i) => { delivered.push(...i); return 'sent'; }, gateOptions });
  assert.equal(r.action, 'error'); assert.match(r.error, /digital_file_too_small/);
  assert.equal(delivered.length, 0);
});

test('shopify: a digital line is fulfilled with its download link and the customer is notified', async () => {
  const { shopifyStore } = require('../lib/shopify-store');
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (/DigitalLines/.test(body.query)) {
      return { ok: true, json: async () => ({ data: { order: { fulfillmentOrders: { nodes: [
        { id: 'gid://shopify/FulfillmentOrder/1', status: 'OPEN', lineItems: { nodes: [{ id: 'gid://shopify/FulfillmentOrderLineItem/11', remainingQuantity: 1, lineItem: { id: 'gid://shopify/LineItem/7' } }] } },
        { id: 'gid://shopify/FulfillmentOrder/2', status: 'OPEN', lineItems: { nodes: [{ id: 'gid://shopify/FulfillmentOrderLineItem/12', remainingQuantity: 1, lineItem: { id: 'gid://shopify/LineItem/8' } }] } }
      ] } } } }) };
    }
    if (/fulfillmentCreate/.test(body.query)) return { ok: true, json: async () => ({ data: { fulfillmentCreate: { fulfillment: { id: 'f1' }, userErrors: [] } } }) };
    return { ok: true, json: async () => ({ data: { tagsAdd: { userErrors: [] } } }) };
  };
  const store = shopifyStore({ shop: 'x.myshopify.com', token: 't', fetchImpl });
  const r = await store.fulfillDigital(900, [{ line_id: 8, design_id: 'MPM-ABC', print_file_url: 'https://blob.example/digital/900/8.jpg' }]);
  assert.equal(r, 'sent');
  const create = calls.find(c => /fulfillmentCreate/.test(c.query)).variables.fulfillment;
  assert.equal(create.notifyCustomer, true);
  assert.equal(create.trackingInfo.url, 'https://blob.example/digital/900/8.jpg');
  assert.deepEqual(create.lineItemsByFulfillmentOrder, [{ fulfillmentOrderId: 'gid://shopify/FulfillmentOrder/2', fulfillmentOrderLineItems: [{ id: 'gid://shopify/FulfillmentOrderLineItem/12', quantity: 1 }] }]);
  const held = await store.fulfillDigital(900, [], { notify: false });
  assert.equal(held, 'held');
});
