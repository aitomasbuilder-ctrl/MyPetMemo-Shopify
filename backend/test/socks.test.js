'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const design = require('../lib/design');
const { checkOrder } = require('../lib/gate');
const { processPaidOrder } = require('../lib/process');
const { prepareDesignItems } = require('../lib/design-fulfillment');
const { layout, SOCK_W, SOCK_H } = require('../shared/sock-pattern');
const { renderSock, cropHead, stickerOutline } = require('../lib/sock-render');
const { client } = require('../lib/printify');
const sockHeads = require('../api/sock-heads');

const KEY = 'k'.repeat(40);
process.env.DESIGN_SIGNING_SECRET = KEY;
const hosts = ['cdn.shopify.com'];
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

test('sock pattern matches the storefront preview file', () => {
  const shared = fs.readFileSync(path.join(__dirname, '../shared/sock-pattern.js'), 'utf8');
  const theme = fs.readFileSync(path.join(__dirname, '../../theme-install/pet-socks/assets/sock-pattern.js'), 'utf8');
  assert.equal(theme, shared);
});

test('sock pattern: approved v3 density, mixed tilts, pets alternate', () => {
  const left = layout({ side: 'left', petCount: 1 });
  const right = layout({ side: 'right', petCount: 1 });
  // The approved print files measure 14 faces on the left leg and 15 on the right.
  assert.equal(left.stats.headsVisible, 14);
  assert.equal(right.stats.headsVisible, 16);
  assert.ok(left.stats.pawsVisible >= 8 && left.stats.pawsVisible <= 20);
  assert.ok(left.stats.heartsVisible >= 8 && left.stats.heartsVisible <= 20);
  assert.equal(left.width, SOCK_W);
  assert.equal(left.height, SOCK_H);
  assert.equal(left.position, 'left_leg');
  assert.equal(right.position, 'right_leg');
  assert.notEqual(left.seed, right.seed);
  const angles = new Set(left.heads.filter(h => h.visible).map(h => Math.sign(h.angle)));
  assert.ok(angles.has(1) && angles.has(-1), 'faces tilt both ways');
  const two = layout({ side: 'left', petCount: 2 });
  assert.deepEqual(two.heads.map(h => h.pet), two.heads.map((_, i) => i % 2));
  const rightTwo = layout({ side: 'right', petCount: 2 });
  assert.equal(rightTwo.heads[0].pet, 1, 'the right sock starts on the other pet');
  assert.deepEqual(layout({ side: 'left' }).heads, left.heads);
  const scaled = layout({ width: SOCK_W / 5, height: SOCK_H / 5, side: 'left', petCount: 1 });
  assert.equal(scaled.stats.headsVisible, left.stats.headsVisible);
});

test('sock design: one to four pets, blob heads allowed, anything else rejected', () => {
  const pet = (url = 'https://cdn.shopify.com/a.png') => ({ url, sha256: 'a'.repeat(64) });
  const base = { product_id: '15550963253350', variant_id: '68205267550310', sku: '17654706273220393183' };
  const one = design.normalise({ ...base, family: 'socks', pets: [pet()] }, { hosts });
  assert.equal(one.family, 'socks');
  assert.equal(one.pets.length, 1);
  assert.equal(design.normalise({ ...base, family: 'socks', pets: [pet(), pet(), pet(), pet()] }, { hosts }).pets.length, 4);
  const blob = design.normalise({
    ...base, family: 'socks',
    pets: [{ url: 'https://abc.public.blob.vercel-storage.com/sock-heads/' + 'ab'.repeat(32) + '.png', sha256: 'b'.repeat(64) }]
  }, { hosts });
  assert.equal(blob.pets[0].url.includes('/sock-heads/'), true);
  const bad = (pets, code) => assert.throws(() => design.normalise({ ...base, family: 'socks', pets }, { hosts }), e => e.code === code);
  bad([], 'pets_count');
  bad([pet(), pet(), pet(), pet(), pet()], 'pets_count');
  bad([{ url: 'https://evil.example/a.png', sha256: 'a'.repeat(64) }], 'pet_host');
  bad([{ url: 'https://abc.public.blob.vercel-storage.com/other/a.png', sha256: 'a'.repeat(64) }], 'pet_host');
  const { token, id } = design.sign(one, KEY);
  assert.equal(design.verify(token, KEY).id, id);
});

async function face(r, g, b, w = 160, h = 180) {
  const block = await sharp({ create: { width: Math.round(w * 0.7), height: Math.round(h * 0.75), channels: 4, background: { r, g, b, alpha: 1 } } }).png().toBuffer();
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: block, left: Math.round(w * 0.15), top: Math.round(h * 0.1) }]).png().toBuffer();
}

test('sock render: sticker outline, head crop, and both pets on a light-blue print', async () => {
  const red = await face(210, 40, 40);
  const ringed = await stickerOutline(red);
  const before = await sharp(red).metadata();
  const { data, info } = await sharp(ringed).raw().toBuffer({ resolveWithObject: true });
  let white = 0, redPx = 0;
  for (let i = 0; i < info.width * info.height; i++) {
    const o = i * info.channels;
    if (data[o + 3] > 200 && data[o] > 240 && data[o + 1] > 240 && data[o + 2] > 240) white++;
    if (data[o + 3] > 200 && data[o] > 180 && data[o + 2] < 80) redPx++;
  }
  assert.ok(white > 50, `white sticker pixels ${white}`);
  assert.ok(redPx > 100, 'the face stays');
  const after = await sharp(ringed).metadata();
  assert.ok(after.width <= before.width + before.width * 0.15, `outline stayed a ring ${before.width} -> ${after.width}`);

  const tall = await sharp({ create: { width: 80, height: 220, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: await sharp({ create: { width: 70, height: 70, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } } }).png().toBuffer(), left: 5, top: 8 },
      { input: await sharp({ create: { width: 24, height: 30, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } } }).png().toBuffer(), left: 28, top: 78 },
      { input: await sharp({ create: { width: 70, height: 90, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } } }).png().toBuffer(), left: 5, top: 110 }
    ]).png().toBuffer();
  const head = await cropHead(tall);
  const cropped = await sharp(head).metadata();
  assert.ok(cropped.height < 150, `head crop kept the body ${cropped.height}`);
  assert.ok(cropped.height > 60, `head crop ate the face ${cropped.height}`);

  const file = await renderSock({ pets: [await face(210, 40, 40), await face(40, 40, 210)], side: 'left', width: 360, height: 1080 });
  assert.equal(file.width, 360);
  assert.equal(file.height, 1080);
  const raw = await sharp(file.buffer).raw().toBuffer({ resolveWithObject: true });
  let blue = 0, reds = 0, blues = 0;
  const step = 3;
  for (let y = 0; y < raw.info.height; y += step) for (let x = 0; x < raw.info.width; x += step) {
    const o = (y * raw.info.width + x) * raw.info.channels;
    const R = raw.data[o], G = raw.data[o + 1], B = raw.data[o + 2];
    if (B > R + 10 && G > R && R > 120 && R < 190) blue++;
    if (R > 160 && B < 90 && G < 90) reds++;
    if (B > 160 && R < 90 && G < 90) blues++;
  }
  assert.ok(blue > 500, `light blue ground ${blue}`);
  assert.ok(reds > 20 && blues > 20, `both pets red ${reds} blue ${blues}`);
});

function sockLine(token, id) {
  return {
    id: 9, product_id: 15550963253350, variant_id: 68205267550310, sku: '17654706273220393183', quantity: 1,
    properties: [
      { name: 'Design ID', value: id },
      { name: 'Pets', value: '2' },
      { name: '_design', value: token }
    ]
  };
}

test('sock order: paid fulfillment uploads both legs and Printify receives them', async () => {
  const red = await face(200, 30, 30);
  const blue = await face(30, 30, 200);
  const pets = [
    { url: 'https://cdn.shopify.com/red.png', sha256: sha(red) },
    { url: 'https://cdn.shopify.com/blue.png', sha256: sha(blue) }
  ];
  const d = design.normalise({
    family: 'socks', product_id: '15550963253350', variant_id: '68205267550310', sku: '17654706273220393183', pets
  }, { hosts });
  const { token, id } = design.sign(d, KEY);
  const order = { id: 501, name: '#1501', financial_status: 'paid', shipping_address: { country_code: 'LT' }, line_items: [sockLine(token, id)] };
  const gate = checkOrder(order, { verify: t => design.verify(t, KEY), hosts });
  assert.equal(gate.ok, true);
  assert.equal(gate.items[0].artwork_url, undefined);
  const stored = [];
  let printful = false;
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'HEAD') {
      const hit = stored.find(s => s.url === url);
      return { ok: !!hit, headers: new Map([['content-length', String(hit ? hit.size : 0)]]) };
    }
    const buf = url.endsWith('red.png') ? red : url.endsWith('blue.png') ? blue : null;
    return buf ? { ok: true, arrayBuffer: async () => buf } : { ok: false, status: 404 };
  };
  const put = async (p, buf) => { const url = `https://blob.example/${p}`; stored.push({ url, size: buf.length, buf }); return url; };
  const catalog = {
    variantForSku: async () => ({ blueprint_id: 496, print_provider_id: 26, printify_variant_id: 88, position: 'left_leg', is_enabled: true }),
    printAreas: async () => [{ position: 'right_leg', width: 1417, height: 4252 }, { position: 'left_leg', width: 1417, height: 4252 }],
    printArea: async () => { throw new Error('single area'); }
  };
  const prepare = (o, items) => prepareDesignItems(o, items, { catalog, put, fetchImpl, hosts, printfulRoute: () => { printful = true; } });
  const calls = [];
  const printify = { createDraftOrder: async (o, items) => { calls.push(items); return { id: 'py-sock' }; }, sendToProduction: async () => {} };
  const store = { m: new Map(), get: async k => store.m.get(k) || null, claim: async k => { store.m.set(k, { claimed: true }); return true; }, set: async (k, p) => store.m.set(k, { ...(store.m.get(k) || {}), ...p }) };
  const result = await processPaidOrder(order, { store, printify, prepare, gateOptions: { verify: t => design.verify(t, KEY), hosts } });
  assert.equal(result.action, 'draft_created');
  assert.equal(printful, false);
  assert.equal(calls.length, 1);
  const line = calls[0][0];
  assert.equal(line.blueprint_id, 496);
  assert.equal(line.print_provider_id, 26);
  assert.equal(line.printify_variant_id, 88);
  assert.deepEqual(line.print_files.map(f => f.position), ['left_leg', 'right_leg']);
  assert.equal(stored.length, 2);
  for (const file of stored) {
    const meta = await sharp(file.buf).metadata();
    assert.equal(meta.width, 1417);
    assert.equal(meta.height, 4252);
    assert.equal(meta.format, 'png');
  }
  const sent = [];
  const api = client({ token: 't', shopId: '1', fetchImpl: async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, text: async () => '{"id":"py"}' }; } });
  await api.createDraftOrder(order, line.print_files ? [{ ...line }] : [], { printify: { print_position: 'front' } });
  assert.deepEqual(sent[0].line_items[0].print_areas, {
    left_leg: line.print_files[0].url,
    right_leg: line.print_files[1].url
  });
  const record = store.m.get('501');
  assert.equal(record.lines['9'].print_files.length, 2);
  assert.equal(record.status, 'paid');
});

test('sock order: a photo that does not match the approval is held and not sent', async () => {
  const red = await face(200, 30, 30);
  const d = design.normalise({
    family: 'socks', product_id: '15550963253350', variant_id: '68205267550310', sku: 'S',
    pets: [{ url: 'https://cdn.shopify.com/red.png', sha256: 'c'.repeat(64) }]
  }, { hosts });
  const { token, id } = design.sign(d, KEY);
  const order = { id: 502, name: '#1502', financial_status: 'paid', line_items: [sockLine(token, id)] };
  let drafted = false;
  const prepare = (o, items) => prepareDesignItems(o, items, {
    catalog: { variantForSku: async () => ({ blueprint_id: 496, print_provider_id: 26, printify_variant_id: 1, is_enabled: true }), printAreas: async () => [{ position: 'left_leg', width: 1417, height: 4252 }, { position: 'right_leg', width: 1417, height: 4252 }] },
    put: async () => 'https://blob.example/x.png',
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => red }),
    hosts
  });
  const store = { m: new Map(), get: async k => store.m.get(k) || null, claim: async () => true, set: async (k, p) => store.m.set(k, { ...(store.m.get(k) || {}), ...p }), applyHold: async () => {} };
  const result = await processPaidOrder(order, {
    store, prepare, gateOptions: { verify: t => design.verify(t, KEY), hosts },
    printify: { createDraftOrder: async () => { drafted = true; return { id: 'no' }; } }
  });
  assert.equal(result.action, 'error');
  assert.equal(drafted, false);
  assert.match(store.m.get('502').error, /artwork_does_not_match_approved_design/);
});

test('printify: a single print area is unchanged', async () => {
  const sent = [];
  const api = client({ token: 't', shopId: '1', fetchImpl: async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, text: async () => '{"id":"py"}' }; } });
  await api.createDraftOrder({ id: 1, name: '#1', shipping_address: {} }, [{
    blueprint_id: 12, print_provider_id: 30, printify_variant_id: 4, quantity: 1, position: 'front', print_file_url: 'https://cdn.shopify.com/tee.png'
  }], { printify: { print_position: 'front' } });
  assert.deepEqual(sent[0].line_items[0].print_areas, { front: 'https://cdn.shopify.com/tee.png' });
});

const resOf = () => ({ headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = JSON.parse(b); } });

test('sock heads: cut-out, sticker, cache, and a clear failure when the model is missing', async () => {
  const image = await sharp({ create: { width: 48, height: 40, channels: 3, background: '#224466' } }).png().toBuffer();
  const soft = new Float32Array(48 * 40);
  for (let y = 8; y < 32; y++) for (let x = 10; x < 36; x++) soft[y * 48 + x] = 1;
  const mem = new Map();
  let inferred = 0;
  const deps = {
    image,
    infer: async () => { inferred++; return soft; },
    cacheGet: async key => mem.get(key) || null,
    cachePut: async (key, png) => {
      const url = `https://abc.public.blob.vercel-storage.com/sock-heads/${key}.png`;
      mem.set(key, { png, url, sha256: sha(png) });
      return url;
    }
  };
  const out = resOf();
  await sockHeads({ method: 'POST', headers: { 'x-forwarded-for': '10.9.1.1' } }, out, deps);
  assert.equal(out.statusCode, 200);
  assert.equal(inferred, 1);
  const png = Buffer.from(out.body.image.slice('data:image/png;base64,'.length), 'base64');
  assert.equal(out.body.sha256, sha(png));
  assert.notEqual(out.body.sha256, sha(image));
  assert.match(out.body.url, /\/sock-heads\//);
  const again = resOf();
  await sockHeads({ method: 'POST', headers: { 'x-forwarded-for': '10.9.1.1' } }, again, deps);
  assert.equal(again.body.cached, true);
  assert.equal(inferred, 1);

  const empty = resOf();
  await sockHeads({ method: 'POST', headers: { 'x-forwarded-for': '10.9.1.2' } }, empty, {
    image, infer: async () => new Float32Array(48 * 40),
    cacheGet: async () => null, cachePut: async () => 'https://abc.public.blob.vercel-storage.com/sock-heads/x.png'
  });
  assert.equal(empty.statusCode, 422);
  assert.equal(empty.body.code, 'pet_not_found');

  const missing = resOf();
  await sockHeads({ method: 'POST', headers: { 'x-forwarded-for': '10.9.1.3' } }, missing, { modelPath: '/tmp/no-such-sock-model.onnx' });
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.body.code, 'cutout_not_configured');
});
