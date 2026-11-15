const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { blanketRouter, sizeKey, client } = require('../lib/printful');
const { processPaidOrder } = require('../lib/process');
const { prepareDesignItems } = require('../lib/design-fulfillment');

const env = { PRINTFUL_API_TOKEN: 'x' };
// Printful catalogue: product 7 "Throw Blanket", landscape print files (Printful's own orientation).
const fakeApi = (calls = []) => ({
  call: async (method, path) => {
    calls.push(path);
    if (path === '/products') return [{ id: 3, title: 'Sherpa Blanket', model: 'Sherpa Blanket' }, { id: 7, title: 'Throw Blanket', model: 'Throw Blanket', type_name: 'Blanket' }];
    if (path === '/products/7') return { variants: [{ id: 701, size: '50″×60″' }, { id: 702, size: '60″×80″' }, { id: 703, size: '30″×40″', in_stock: false }] };
    if (path === '/mockup-generator/printfiles/7') return {
      printfiles: [{ printfile_id: 1, width: 9000, height: 7500 }, { printfile_id: 2, width: 12000, height: 9000 }],
      variant_printfiles: [{ variant_id: 701, placements: { default: 1 } }, { variant_id: 702, placements: { default: 2 } }]
    };
    throw new Error('unexpected ' + path);
  }
});
const blanket = { blueprint_id: 522, print_provider_id: 99, printify_variant_id: 111, title: '50″ × 60″', position: 'front' };
const area = { position: 'front', width: 7875, height: 9375 };

test('size keys are read from Printify and Printful titles', () => {
  assert.equal(sizeKey('50″ × 60″'), '50x60');
  assert.equal(sizeKey('60" x 80"'), '60x80');
  assert.equal(sizeKey('127 × 152 cm (50 × 60 in)'), '50x60');
  assert.equal(sizeKey('70.5" × 52"'), null);
});

test('EU blanket goes to the Printful variant of the same size, turned to the design orientation', async () => {
  const route = blanketRouter({ api: fakeApi(), env });
  const r = await route(blanket, area, 'LT');
  assert.deepEqual(r, { printful_variant_id: 701, width: 7500, height: 9000, rotate: true, size: '50x60' });
});

test('US orders, other products, unknown sizes and a switched-off router stay on Printify', async () => {
  const route = blanketRouter({ api: fakeApi(), env });
  assert.equal(await route(blanket, area, 'US'), null);
  assert.equal(await route({ ...blanket, blueprint_id: 1359 }, area, 'LT'), null);
  assert.equal(await route({ ...blanket, title: '30″ × 40″' }, area, 'LT'), null);
  assert.equal(await blanketRouter({ api: fakeApi(), env: {} })(blanket, area, 'LT'), null);
  assert.equal(await blanketRouter({ api: fakeApi(), env: { ...env, PRINTFUL_BLANKETS: 'off' } })(blanket, area, 'LT'), null);
});

test('a different print shape stays on Printify', async () => {
  const route = blanketRouter({ api: fakeApi(), env });
  assert.equal(await route(blanket, { position: 'front', width: 9000, height: 9000 }, 'LT'), null);
});

test('Printful errors never block the order: it stays on Printify', async () => {
  const route = blanketRouter({ api: { call: async () => { throw new Error('Printful 401'); } }, env });
  assert.equal(await route(blanket, area, 'LT'), null);
});

test('a configured product id skips the catalogue search', async () => {
  const calls = [];
  await blanketRouter({ api: fakeApi(calls), env: { ...env, PRINTFUL_BLANKET_PRODUCT_ID: '7' } })(blanket, area, 'LT');
  assert.ok(!calls.includes('/products'));
});

test('client sends a draft order with the print file and the Shopify order id', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { ok: true, text: async () => JSON.stringify({ result: { id: 55 } }) }; };
  const api = client({ token: 't', storeId: '42', fetchImpl });
  const r = await api.createDraftOrder({ id: 123, email: 'a@b.lt', shipping_address: { first_name: 'Ona', last_name: 'K', address1: 'Gatvė 1', city: 'Vilnius', country_code: 'LT', zip: 'LT-01100' } },
    [{ printful_variant_id: 701, quantity: 1, print_file_url: 'https://blob.example/p.png' }]);
  assert.equal(r.id, 55);
  assert.equal(seen.url, 'https://api.printful.com/orders?confirm=false');
  assert.equal(seen.opts.headers['X-PF-Store-Id'], '42');
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.external_id, '123');
  assert.equal(body.recipient.name, 'Ona K');
  assert.deepEqual(body.items[0].files, [{ type: 'default', url: 'https://blob.example/p.png' }]);
});

// ---- order processing with mixed makers ----
const mkStore = () => {
  const m = new Map();
  return { m, get: async id => m.get(id) || null,
    claim: async id => { const r = m.get(id) || {}; if (r.claimed) return false; m.set(id, { ...r, claimed: true }); return true; },
    set: async (id, p) => m.set(id, { ...(m.get(id) || {}), ...p }) };
};
const order = { id: 5, name: '#1005', financial_status: 'paid', shipping_address: { country_code: 'LT' },
  line_items: [{ id: 1, product_id: 9612228264038, variant_id: 48957877813350, properties: [{ name: '_approved', value: 'true' }, { name: '_print_file_url', value: 'https://f.example/a.png' }] },
    { id: 2, product_id: 77, variant_id: 88, properties: [{ name: '_design', value: 'tok' }, { name: '_artwork', value: 'https://cdn.shopify.com/a.png' }] }] };
const gateOptions = { verify: () => ({ id: 'd1', design: { variant_id: 88, product_id: 77 } }), hosts: ['cdn.shopify.com'] };
const prepare = async (o, items) => items.map(i => i.kind === 'design' ? { ...i, fulfiller: 'printful', printful_variant_id: 701, print_file_url: 'https://blob.example/p.png' } : i);
const makers = (failPrintify) => {
  const calls = [];
  return { calls,
    printful: { createDraftOrder: async (o, items) => { calls.push(['printful', items.length]); return { id: 900 }; }, confirmOrder: async id => calls.push(['confirm', id]) },
    printify: { createDraftOrder: async (o, items) => { calls.push(['printify', items.length]); if (failPrintify) throw new Error('boom'); return { id: 'py1' }; }, sendToProduction: async id => calls.push(['send', id]) } };
};

test('a mixed EU order makes one Printful draft for the blanket and one Printify draft for the rest', async () => {
  const s = mkStore(), k = makers();
  const r = await processPaidOrder(order, { store: s, printify: k.printify, printful: k.printful, prepare, gateOptions });
  assert.equal(r.action, 'draft_created');
  assert.deepEqual(k.calls, [['printful', 1], ['printify', 1]]);
  assert.equal(s.m.get('5').printful_order_id, '900');
  const again = await processPaidOrder(order, { store: s, printify: k.printify, printful: k.printful, prepare, gateOptions });
  assert.equal(again.action, 'duplicate_skipped');
  assert.equal(k.calls.length, 2);
});

test('a retry after a Printify failure does not make a second Printful order', async () => {
  const s = mkStore(), k1 = makers(true);
  const r1 = await processPaidOrder(order, { store: s, printify: k1.printify, printful: k1.printful, prepare, gateOptions });
  assert.equal(r1.action, 'error');
  const k2 = makers();
  const r2 = await processPaidOrder(order, { store: s, printify: k2.printify, printful: k2.printful, prepare, gateOptions });
  assert.equal(r2.action, 'draft_created');
  assert.deepEqual(k2.calls, [['printify', 1]]);
  assert.equal(r2.printful_order_id, '900');
});

test('production mode confirms the Printful order and sends the Printify order', async () => {
  const s = mkStore(), k = makers();
  const r = await processPaidOrder(order, { store: s, printify: k.printify, printful: k.printful, prepare, gateOptions, mode: 'production' });
  assert.equal(r.action, 'sent');
  assert.deepEqual(k.calls, [['printful', 1], ['printify', 1], ['confirm', '900'], ['send', 'py1']]);
});

test('a blanket line without Printful set up is held, not lost', async () => {
  const s = mkStore(), k = makers();
  const r = await processPaidOrder(order, { store: s, printify: k.printify, prepare, gateOptions });
  assert.equal(r.action, 'error');
  assert.match(r.error, /printful_not_configured/);
});

test('the print file is rendered at Printful size and turned to Printful orientation', async () => {
  const png = await sharp({ create: { width: 10, height: 12, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const render = async ({ width, height }) => {
    const buffer = await sharp({ create: { width, height, channels: 3, background: '#fff' } }).png().toBuffer();
    return { buffer, width, height, format: 'png', sha256: 'x' };
  };
  const catalog = { variantForSku: async () => ({ ...blanket, is_enabled: true }), regionalVariant: async m => m, printArea: async () => area };
  let stored;
  const put = async (key, buf) => { stored = buf; return 'https://blob.example/' + key; };
  const fetchImpl = async (url, opts) => (opts && opts.method === 'HEAD')
    ? { ok: true, headers: { get: () => String(stored.length) } }
    : { ok: true, arrayBuffer: async () => png };
  const item = { kind: 'design', line_id: 2, quantity: 1, sku: 'S', design_id: 'd1', artwork_url: 'https://cdn.shopify.com/a.png',
    design: { artwork: { sha256: require('node:crypto').createHash('sha256').update(png).digest('hex'), w: 10, h: 12 }, background: { kind: 'color' } } };
  const route = async () => ({ printful_variant_id: 701, width: 75, height: 90, rotate: true });
  const [out] = await prepareDesignItems({ id: 5, shipping_address: { country_code: 'LT' } }, [item], { catalog, put, fetchImpl, hosts: ['cdn.shopify.com', 'blob.example'], render, printfulRoute: route });
  assert.equal(out.fulfiller, 'printful');
  assert.equal(out.printful_variant_id, 701);
  const meta = await sharp(stored).metadata();
  assert.deepEqual([meta.width, meta.height], [90, 75]);
});
