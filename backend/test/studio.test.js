const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const sharp = require('sharp');
const design = require('../lib/design');
const { renderDesign, sha256 } = require('../lib/render');
const { checkOrder } = require('../lib/gate');
const { processPaidOrder } = require('../lib/process');
const { prepareDesignItems } = require('../lib/design-fulfillment');
const webhook = require('../api/orders-paid');
const approve = require('../api/designs');

const KEY = 'k'.repeat(40);
process.env.DESIGN_SIGNING_SECRET = KEY;
const hosts = ['cdn.shopify.com'];

async function artworkPng(w = 400, h = 500) {
  // transparent canvas with an opaque red "pet" block in the middle
  const pet = await sharp({ create: { width: w / 2, height: h / 2, channels: 4, background: { r: 220, g: 20, b: 20, alpha: 1 } } }).png().toBuffer();
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: pet, left: w / 4, top: h / 4 }]).png().toBuffer();
}
const input = (art, over = {}) => ({
  product_id: '15409350508646', variant_id: '67641501188198', sku: 'SKU-50', print: { w: 5000, h: 6000 },
  background: { id: 'pink-hearts' }, pet: { cx: 0.5, cy: 0.6, w: 0.8, rot: 0 },
  name: { text: 'Zoë', cx: 0.5, cy: 0.13, size: 0.14, font: 'fredoka', fill: '#FFFFFF', stroke: '#2a2230' },
  artwork: { sha256: sha256(art), w: 400, h: 500 }, ...over
});

test('design: normalise rounds, lowercases and keeps a stable id', async () => {
  const art = await artworkPng();
  const a = design.normalise(input(art, { pet: { cx: 0.512345678, cy: 0.6, w: 0.8 } }), { hosts });
  assert.equal(a.pet.cx, 0.5123); assert.equal(a.name.fill, '#ffffff'); assert.equal(a.background.name, 'Pink Hearts');
  const b = design.normalise(JSON.parse(JSON.stringify(input(art, { pet: { cx: 0.512345678, cy: 0.6, w: 0.8 } }))), { hosts });
  assert.equal(design.designId(a), design.designId(b));
  const c = design.normalise(input(art, { background: { id: 'florals' } }), { hosts });
  assert.notEqual(design.designId(a), design.designId(c), 'any change is a new design version');
});

test('design: rejects bad input with readable codes', async () => {
  const art = await artworkPng();
  const bad = (over, code) => assert.throws(() => design.normalise(input(art, over), { hosts }), e => e.code === code);
  bad({ background: { id: 'nope' } }, 'background_unknown');
  bad({ background: { id: 'x', kind: 'image', image_url: 'https://evil.example/bg.jpg' } }, 'background_host');
  bad({ name: { text: 'Rex 🐶', cx: 0.5, cy: 0.1, size: 0.1 } }, 'name_characters');
  bad({ name: { text: 'x'.repeat(30), cx: 0.5, cy: 0.1, size: 0.1 } }, 'name_too_long');
  bad({ pet: { cx: 9, cy: 0.5, w: 1 } }, 'invalid_number');
  bad({ artwork: { sha256: 'nothex', w: 10, h: 10 } }, 'invalid_field');
  assert.equal(design.normalise(input(art, { name: { text: '   ' } }), { hosts }).name, null, 'empty name leaves the area empty');
  assert.ok(design.normalise(input(art, { name: { text: 'Łucja Ñoño', cx: 0.5, cy: 0.1, size: 0.1 } }), { hosts }).name, 'accented characters are supported');
  assert.equal(design.normalise(input(art, { background: { id: 'custom', color: '#12AB34' } }), { hosts }).background.color, '#12ab34');
});

test('design: tokens verify, and tampering or a different key is rejected', async () => {
  const d = design.normalise(input(await artworkPng()), { hosts });
  const { id, token } = design.sign(d, KEY);
  assert.equal(design.verify(token, KEY).id, id);
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...d, variant_id: '1' })).toString('base64url');
  assert.throws(() => design.verify(`${forged}.${mac}`, KEY), e => e.code === 'bad_signature');
  assert.throws(() => design.verify(token, 'z'.repeat(40)), e => e.code === 'bad_signature');
  assert.throws(() => design.verify(body, KEY), e => e.code === 'bad_token');
});

test('render: exact print size, pet where the design says, name drawn, safe crop at edges', async () => {
  const art = await artworkPng();
  const d = design.normalise(input(art, { background: { id: 'white' }, pet: { cx: 0.5, cy: 0.95, w: 0.8, rot: 15 } }), { hosts });
  const r = await renderDesign({ design: d, artwork: art, width: 1000, height: 1200 });
  assert.equal(r.width, 1000); assert.equal(r.height, 1200);
  const { data, info } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => Array.from(data.slice((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
  const [rr, gg] = px(500, 1140); // pet centre (0.5, 0.95) is red even though the pet runs off the bottom
  assert.ok(rr > 180 && gg < 80, `pet centre ${px(500, 1140)}`);
  assert.deepEqual(px(20, 600).map(v => v > 240), [true, true, true], 'background white away from pet');
  // name: some dark outline pixels around y = 0.13 * 1200
  let dark = 0;
  for (let x = 300; x < 700; x++) for (let y = 120; y < 200; y++) { const [a, b, c] = px(x, y); if (a < 80 && b < 80 && c < 80) dark++; }
  assert.ok(dark > 200, `name outline pixels ${dark}`);
});

test('render: image backgrounds need the image, PNG output keeps size', async () => {
  const art = await artworkPng();
  const d = design.normalise(input(art, { background: { id: 'holly', kind: 'image', image_url: 'https://cdn.shopify.com/x.jpg', color: '#ffffff' }, name: null }), { hosts });
  await assert.rejects(renderDesign({ design: d, artwork: art, width: 300, height: 360 }), /background_image_missing/);
  const bg = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#00ff00' } }).jpeg().toBuffer();
  const r = await renderDesign({ design: d, artwork: art, backgroundImage: bg, width: 300, height: 360, format: 'png' });
  const m = await sharp(r.buffer).metadata();
  assert.equal(m.format, 'png'); assert.equal(m.width, 300);
});

// ---------- orders ----------
const mkStore = () => {
  const m = new Map();
  return { m,
    get: async id => m.get(id) || null,
    claim: async id => { const r = m.get(id) || {}; if (r.claimed) return false; m.set(id, { ...r, claimed: true }); return true; },
    set: async (id, p) => m.set(id, { ...(m.get(id) || {}), ...p }),
    applyHold: async () => {} };
};
const mkPrintify = fail => { const calls = []; return { calls,
  createDraftOrder: async (o, items) => { calls.push(items); if (fail) throw new Error('boom'); return { id: 'pf-' + calls.length }; },
  sendToProduction: async () => {} }; };

async function signedLine(lineId, over = {}, art) {
  art = art || await artworkPng();
  const d = design.normalise(input(art, over), { hosts });
  const { token, id } = design.sign(d, KEY);
  return { id, art, line: { id: lineId, product_id: 15409350508646, variant_id: Number(d.variant_id), sku: 'SKU-50', quantity: 1,
    properties: [{ name: 'Pet name', value: 'Zoë' }, { name: 'Design ID', value: id }, { name: '_design', value: token }, { name: '_artwork', value: `https://cdn.shopify.com/s/files/1/uploads/${lineId}.png` }] } };
}
const fakeCatalog = () => ({
  variantForSku: async sku => ({ blueprint_id: 522, print_provider_id: 99, printify_variant_id: sku === 'SKU-50' ? 111 : 222, position: 'front', is_enabled: true }),
  printArea: async () => ({ position: 'front', width: 500, height: 600 })
});
function deps(arts, { failRender } = {}) {
  const stored = [];
  const fetchImpl = async (url, opts = {}) => {
    if (opts.method === 'HEAD') { const f = stored.find(s => s.url === url); return { ok: !!f, headers: new Map([['content-length', String(f ? f.size : 0)]]) }; }
    const buf = arts[url];
    return buf ? { ok: true, arrayBuffer: async () => buf } : { ok: false, status: 404 };
  };
  const put = async (path, buf) => { const url = `https://blob.example/${path}`; stored.push({ url, size: buf.length }); return url; };
  return { stored, prepare: (order, items) => prepareDesignItems(order, items, { catalog: fakeCatalog(), put, fetchImpl, hosts,
    render: failRender ? async () => { throw new Error('render exploded'); } : undefined }) };
}
const gateOptions = { verify: t => design.verify(t, KEY), hosts };

test('order: two designs in one order become two Printify lines with their own print files', async () => {
  const a = await signedLine(1, {}); const b = await signedLine(2, { background: { id: 'clouds' }, name: null });
  const order = { id: 77, name: '#1077', financial_status: 'paid', line_items: [a.line, b.line, { id: 3, product_id: 5, properties: [] }] };
  const { prepare, stored } = deps({ 'https://cdn.shopify.com/s/files/1/uploads/1.png': a.art, 'https://cdn.shopify.com/s/files/1/uploads/2.png': b.art });
  const store = mkStore(), printify = mkPrintify();
  const r = await processPaidOrder(order, { store, printify, prepare, gateOptions });
  assert.equal(r.action, 'draft_created');
  const items = printify.calls[0];
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(i => i.blueprint_id), [522, 522]);
  assert.notEqual(items[0].print_file_url, items[1].print_file_url);
  assert.equal(stored.length, 2);
  const rec = store.m.get('77');
  assert.equal(rec.lines['1'].design_id, a.id); assert.equal(rec.lines['2'].design_id, b.id);
  assert.equal(rec.lines['1'].size, '500x600'); assert.equal(rec.lines['1'].artwork_check, 'sha256');
});

test('ornament: family and shape are part of the design; blankets stay unchanged', async () => {
  const art = await artworkPng();
  const blanket = design.normalise(input(art), { hosts });
  assert.equal(blanket.family, 'blanket'); assert.equal('shape' in blanket, false);
  const heart = design.normalise(input(art, { family: 'ornament', shape: 'heart', print: { w: 1200, h: 1200 } }), { hosts });
  assert.equal(heart.family, 'ornament'); assert.equal(heart.shape, 'heart');
  assert.equal(design.normalise(input(art, { family: 'ornament', shape: 'blob' }), { hosts }).shape, 'circle');
  const star = design.normalise(input(art, { family: 'ornament', shape: 'star', print: { w: 1200, h: 1200 } }), { hosts });
  assert.notEqual(design.designId(heart), design.designId(star), 'another shape is another design');
});

test('order: an ornament design renders at the Printify print area and becomes a draft line', async () => {
  const a = await signedLine(5, { family: 'ornament', shape: 'star', print: { w: 1200, h: 1200 }, pet: { cx: 0.5, cy: 0.43, w: 0.5, rot: 0 }, name: { text: 'Bo', cx: 0.5, cy: 0.69, size: 0.1, font: 'fredoka', fill: '#ffffff', stroke: '#2a2230' } });
  const order = { id: 91, name: '#1091', financial_status: 'paid', line_items: [a.line] };
  const { prepare, stored } = deps({ 'https://cdn.shopify.com/s/files/1/uploads/5.png': a.art });
  const store = mkStore(), printify = mkPrintify();
  const r = await processPaidOrder(order, { store, printify, prepare, gateOptions });
  assert.equal(r.action, 'draft_created');
  assert.equal(printify.calls[0].length, 1);
  assert.equal(stored.length, 1);
  assert.equal(store.m.get('91').lines['5'].design_id, a.id);
});

test('order: duplicate and concurrent webhooks create one Printify order', async () => {
  const a = await signedLine(1);
  const order = { id: 78, financial_status: 'paid', line_items: [a.line] };
  const { prepare } = deps({ 'https://cdn.shopify.com/s/files/1/uploads/1.png': a.art });
  const store = mkStore(), printify = mkPrintify();
  await Promise.all([1, 2, 3].map(() => processPaidOrder(order, { store, printify, prepare, gateOptions })));
  const again = await processPaidOrder(order, { store, printify, prepare, gateOptions });
  assert.equal(printify.calls.length, 1); assert.equal(again.action, 'duplicate_skipped');
});

test('order: artwork that does not match the approved design is held, never sent', async () => {
  const a = await signedLine(1);
  const other = await artworkPng(300, 300);
  const { prepare } = deps({ 'https://cdn.shopify.com/s/files/1/uploads/1.png': other });
  const store = mkStore(), printify = mkPrintify();
  const r = await processPaidOrder({ id: 79, financial_status: 'paid', line_items: [a.line] }, { store, printify, prepare, gateOptions });
  assert.equal(r.action, 'error'); assert.match(r.error, /artwork_does_not_match/);
  assert.equal(printify.calls.length, 0); assert.equal(store.m.get('79').hold, true);
});

test('order: render failure holds the order and a retry succeeds once fixed', async () => {
  const a = await signedLine(1);
  const order = { id: 80, financial_status: 'paid', line_items: [a.line] };
  const store = mkStore(), printify = mkPrintify();
  const r1 = await processPaidOrder(order, { store, printify, prepare: deps({}, { failRender: true }).prepare, gateOptions });
  assert.equal(r1.action, 'error'); assert.equal(store.m.get('80').status, 'error');
  const r2 = await processPaidOrder(order, { store, printify, prepare: deps({ 'https://cdn.shopify.com/s/files/1/uploads/1.png': a.art }).prepare, gateOptions });
  assert.equal(r2.action, 'draft_created'); assert.equal(store.m.get('80').hold, false);
});

test('gate: tampered, unsigned, wrong-variant and foreign-host lines are blocked', async () => {
  const a = await signedLine(1);
  const props = (line, patch) => ({ ...line, properties: line.properties.map(p => (p.name in patch ? { ...p, value: patch[p.name] } : p)) });
  const check = line => checkOrder({ financial_status: 'paid', line_items: [line] }, gateOptions);
  assert.ok(check(a.line).ok);
  assert.match(check(props(a.line, { _design: a.line.properties[2].value.replace(/.$/, 'A') })).reasons[0], /^design_invalid/);
  assert.match(check({ ...a.line, variant_id: 67641501220966 }).reasons[0], /^design_variant_mismatch/);
  assert.match(check(props(a.line, { _artwork: 'https://evil.example/a.png' })).reasons[0], /^artwork_host_not_allowed/);
  const unsigned = { ...a.line, properties: [{ name: '_design_unsigned', value: '{}' }] };
  assert.match(check(unsigned).reasons[0], /^design_unsigned/);
  assert.deepEqual(checkOrder({ financial_status: 'paid', line_items: [a.line] }, { verify: () => { throw new design.DesignError('signing_not_configured'); }, hosts }).reasons, ['design_signing_not_configured:1']);
});

test('webhook: design orders are acknowledged at once and processed in the background', async () => {
  const a = await signedLine(1);
  const body = JSON.stringify({ id: 81, financial_status: 'paid', line_items: [a.line] });
  const SECRET = 'whsec';
  const req = new EventEmitter(); req.method = 'POST'; req.headers = { 'x-shopify-hmac-sha256': crypto.createHmac('sha256', SECRET).update(body).digest('base64') };
  const res = { setHeader() {}, end(b) { this.body = b; this.done(); } };
  const done = new Promise(r => { res.done = r; });
  const pending = [];
  const store = mkStore(), printify = mkPrintify();
  webhook(req, res, { secret: SECRET, store, printify, prepare: deps({ 'https://cdn.shopify.com/s/files/1/uploads/1.png': a.art }).prepare, gateOptions, waitUntil: p => pending.push(p) });
  process.nextTick(() => { req.emit('data', Buffer.from(body)); req.emit('end'); });
  await done;
  assert.equal(JSON.parse(res.body).action, 'accepted');
  await Promise.all(pending);
  assert.equal(printify.calls.length, 1); assert.equal(store.m.get('81').status, 'paid');
});

// ---------- approval endpoint ----------
function callApprove(body, headers = {}) {
  const req = new EventEmitter(); req.method = 'POST'; req.headers = { origin: 'https://mypetmemo.com', 'x-forwarded-for': '1.2.3.4', ...headers };
  req[Symbol.asyncIterator] = async function* () { yield Buffer.from(body); };
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  return approve(req, res).then(() => ({ status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null }));
}
test('approve endpoint: signs valid designs, explains invalid ones, rejects other origins', async () => {
  const art = await artworkPng();
  const ok = await callApprove(JSON.stringify({ design: input(art) }));
  assert.equal(ok.status, 200); assert.match(ok.json.id, /^MPM-[0-9A-F]{10}$/);
  assert.equal(ok.headers['Access-Control-Allow-Origin'], 'https://mypetmemo.com');
  assert.equal(design.verify(ok.json.token, KEY).id, ok.json.id);
  const bad = await callApprove(JSON.stringify({ design: input(art, { name: { text: 'Rex 🐶', cx: 0.5, cy: 0.1, size: 0.1 } }) }));
  assert.equal(bad.status, 400); assert.equal(bad.json.error, 'name_characters');
  const foreign = await callApprove('{}', { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const preview = await callApprove(JSON.stringify({ design: input(art) }), { origin: 'https://abc123.shopifypreview.com' });
  assert.equal(preview.status, 200);
});

test('backgrounds: theme copy is identical to the backend copy', () => {
  const fs = require('node:fs'), path = require('node:path');
  const theme = path.join(__dirname, '..', '..', 'theme', 'assets', 'pet-backgrounds.js');
  if (!fs.existsSync(theme)) return;
  assert.equal(fs.readFileSync(theme, 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'shared', 'pet-backgrounds.js'), 'utf8'));
});

test('caption: optional year or dates and message lines are validated and drawn under the name', async () => {
  const art = await artworkPng();
  const base = input(art, { family: 'ornament', shape: 'circle', print: { w: 1200, h: 1200 }, background: { id: 'white' } });
  assert.equal('caption' in design.normalise(base, { hosts }), false, 'no caption by default');
  assert.equal('caption' in design.normalise({ ...base, caption: { lines: ['  ', ''] } }, { hosts }), false, 'empty lines are dropped');
  const cap = { lines: [' 2012  –  2026 ', 'Forever in my heart'], cx: 0.5, cy: 0.9, size: 0.05, font: 'fredoka', fill: '#FFFFFF', stroke: '#2A2230' };
  const d = design.normalise({ ...base, caption: cap }, { hosts });
  assert.deepEqual(d.caption.lines, ['2012 – 2026', 'Forever in my heart']);
  assert.equal(d.caption.fill, '#ffffff');
  assert.notEqual(design.designId(d), design.designId(design.normalise({ ...base, caption: { ...cap, lines: ['2026'] } }, { hosts })));
  assert.throws(() => design.normalise({ ...base, caption: { ...cap, lines: ['a', 'b', 'c'] } }, { hosts }), e => e.code === 'caption_lines');
  assert.throws(() => design.normalise({ ...base, caption: { ...cap, lines: ['x'.repeat(33)] } }, { hosts }), e => e.code === 'caption_too_long');
  const r = await renderDesign({ design: d, artwork: art, width: 600, height: 600 });
  const { data, info } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
  const dark = (y0, y1) => { let n = 0; for (let x = 100; x < 500; x++) for (let y = y0; y < y1; y++) { const i = (y * info.width + x) * info.channels; if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80) n++; } return n; };
  // two lines centred at 0.9 * 600 = 540 with spacing 1.25 * 30 px → around y 521 and 559
  assert.ok(dark(505, 535) > 50, 'first caption line drawn');
  assert.ok(dark(545, 575) > 50, 'second caption line drawn');
  assert.ok(dark(420, 470) < 5, 'nothing between the pet and the caption');
});

test('backgrounds: new Christmas and memorial designs exist and render to valid SVG', async () => {
  const backgrounds = require('../shared/pet-backgrounds');
  for (const id of ['snowflakes', 'winter-snow', 'candy-cane', 'holiday-plaid', 'twinkle-lights', 'christmas-red', 'evergreen',
    'soft-clouds', 'watercolor-sky', 'watercolor-blush', 'watercolor-lavender', 'watercolor-sage', 'watercolor-sunset']) {
    const bg = backgrounds.byId[id];
    assert.ok(bg, `${id} exists`);
    const png = await sharp(Buffer.from(backgrounds.svg(bg, 300, 300))).png().toBuffer();
    assert.equal((await sharp(png).metadata()).width, 300, id);
    assert.equal(backgrounds.svg(bg, 300, 300), backgrounds.svg(bg, 300, 300), `${id} is deterministic`);
  }
});
