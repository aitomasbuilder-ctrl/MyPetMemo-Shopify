'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const design = require('../lib/design');
const { renderTee, TEE_LINE, TEE_SPAN, TEE_NAME_SIZE, TEE_SPIKE, TEE_PET_H, TEE_BEATS, TEE_PET_WIDTH_MAX, teeProbe, heartbeatPoints } = require('../lib/render');
const { catalog } = require('../lib/printify-catalog');

const hosts = ['cdn.shopify.com'];
const pet = (sha, url = 'https://cdn.shopify.com/pet.png') => ({ url, sha256: sha });
const sha = 'ab'.repeat(32);

function teeInput(over = {}) {
  return {
    family: 'tee', product_id: '15409350508646', variant_id: '67641501188198', sku: 'TEE-NAVY-L',
    color: 'Navy / L',
    pets: [pet(sha)],
    name: { text: 'Šarūnė' },
    ...over
  };
}

test('tee: ink follows the shirt colour, and the name uses the script font', () => {
  const navy = design.normalise(teeInput(), { hosts });
  assert.equal(navy.family, 'tee');
  assert.equal(navy.ink, 'white');
  assert.equal(navy.color, 'navy');
  assert.equal(navy.name.font, 'dancingscript');
  assert.equal(navy.name.text, 'Šarūnė');
  assert.equal(design.inkForColor('Brown'), 'white');
  assert.equal(design.inkForColor('Black'), 'white');
  assert.equal(design.inkForColor('Military Green'), 'white');
  assert.equal(design.inkForColor('White'), 'dark');
  assert.equal(design.inkForColor('Athletic Heather'), 'dark');
  assert.equal(design.inkForColor('Light Blue'), 'dark');
  assert.equal(design.inkForColor('Tan'), 'dark');
  assert.equal(design.inkForColor('Olive'), 'dark');
  assert.throws(() => design.normalise(teeInput({ color: 'Hot Pink' }), { hosts }), e => e.code === 'ink_unknown');
  assert.throws(() => design.normalise(teeInput({ name: { text: 'x'.repeat(25) } }), { hosts }), e => e.code === 'name_too_long');
  assert.throws(() => design.normalise(teeInput({ name: { text: 'Rex 🐶' } }), { hosts }), e => e.code === 'name_characters');
  assert.throws(() => design.normalise(teeInput({ pets: [] }), { hosts }), e => e.code === 'pets_count');
  assert.throws(() => design.normalise(teeInput({ pets: [pet(sha), pet(sha), pet(sha), pet(sha)] }), { hosts }), e => e.code === 'pets_count');
  assert.throws(() => design.normalise(teeInput({ pets: [{ url: 'https://evil.example/a.png', sha256: sha }] }), { hosts }), e => e.code === 'pet_host');
  assert.throws(() => design.normalise(teeInput({ pets: [{ url: 'https://evil.public.blob.vercel-storage.com/cutouts/a.png', sha256: sha }] }), { hosts }), e => e.code === 'pet_host');
  const three = design.normalise(teeInput({ pets: [pet(sha), pet(sha, 'https://cdn.shopify.com/b.png'), pet(sha, 'https://cdn.shopify.com/c.png')] }), { hosts });
  assert.equal(three.pets.length, 3);
});

const swatch = (r, g, b) => sharp({ create: { width: 30, height: 36, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toBuffer();

async function pixel(buf, x, y) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * info.channels;
  return { px: Array.from(data.slice(o, o + info.channels)), info };
}

function linePixel(W, H) { return teeProbe(W, H); }

test('tee: the print is a transparent PNG at the print size and 300 dpi', async () => {
  const d = design.normalise(teeInput({ ink: undefined, color: 'White', name: { text: 'Bo' } }), { hosts });
  assert.equal(d.ink, 'dark');
  const file = await renderTee({ design: d, pets: [await swatch(200, 40, 60)], width: 400, height: 520 });
  assert.equal(file.format, 'png');
  assert.equal(file.width, 400);
  assert.equal(file.height, 520);
  const meta = await sharp(file.buffer).metadata();
  assert.equal(meta.width, 400);
  assert.equal(meta.height, 520);
  assert.equal(meta.density, 300);
  assert.equal(meta.hasAlpha, true);
  const corner = await pixel(file.buffer, 2, 2);
  assert.equal(corner.px[3], 0, 'the shirt shows through the empty canvas');
  const at = linePixel(400, 520);
  const ink = await pixel(file.buffer, at.x, at.y);
  assert.ok(ink.px[3] > 100 && ink.px[0] < 40, `dark ink on the line ${ink.px}`);
});

test('tee: white ink on a dark shirt, and the name shrinks to fit', async () => {
  const dark = design.normalise(teeInput({ color: 'Black', name: { text: 'Bo' } }), { hosts });
  const file = await renderTee({ design: dark, pets: [await swatch(20, 20, 20)], width: 400, height: 520 });
  const at = linePixel(400, 520);
  const ink = await pixel(file.buffer, at.x, at.y);
  assert.ok(ink.px[0] > 240 && ink.px[3] > 100, `white ink ${ink.px}`);
  const short = await renderTee({ design: dark, pets: [await swatch(20, 20, 20)], width: 600, height: 780 });
  assert.equal(short.nameSize, TEE_NAME_SIZE * 600);
  const long = design.normalise(teeInput({ color: 'Black', name: { text: 'W'.repeat(24) } }), { hosts });
  const fitted = await renderTee({ design: long, pets: [await swatch(20, 20, 20)], width: 600, height: 780 });
  assert.ok(fitted.nameSize < TEE_NAME_SIZE * 600, `name size ${fitted.nameSize}`);
  assert.ok(fitted.nameSize > 0);
});

async function colorBox(buf, match) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  let minx = info.width, miny = info.height, maxx = -1, maxy = -1, n = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const o = (y * info.width + x) * info.channels;
    if (match(data[o], data[o + 1], data[o + 2], data[o + 3])) {
      n++;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
  }
  return n ? { minx, miny, maxx, maxy, h: maxy - miny + 1, w: maxx - minx + 1 } : null;
}

function peaksOn(points, lineY, spike, x0, x1) {
  const spikes = [];
  const dips = [];
  const bumps = [];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    if (p.x < x0 || p.x > x1) continue;
    const prev = points[i - 1].y, next = points[i + 1].y;
    if (p.y < prev && p.y < next && p.y < lineY - 0.75 * spike) spikes.push(p);
    if (p.y > prev && p.y > next && p.y > lineY + 0.25 * spike) dips.push(p);
    if (p.y < prev && p.y < next && p.y < lineY - 0.08 * spike && p.y > lineY - 0.35 * spike) bumps.push(p);
  }
  return { spikes, dips, bumps };
}

test('tee: the pet is small, stands on a long line, and each side repeats the beat', async () => {
  const d = (n, text = 'Luna') => design.normalise(teeInput({
    color: 'White', name: { text },
    pets: Array.from({ length: n }, (_, i) => pet(sha, `https://cdn.shopify.com/p${i}.png`))
  }), { hosts });
  const W = 720, H = 960;
  const one = await renderTee({ design: d(1), pets: [await swatch(200, 30, 40)], width: W, height: H });
  assert.ok(TEE_LINE <= 0.36, 'the design sits high on the chest');
  assert.ok(TEE_SPAN >= 0.78, 'the line spans most of the chest');
  assert.equal(TEE_BEATS, 2);
  assert.ok(Math.abs(one.lineY - TEE_LINE * H) < 0.01);
  assert.ok(Math.abs(one.petHeight - TEE_PET_H * W) < 1.5, `pet height ${one.petHeight}`);
  assert.ok(one.petHeight < 0.22 * TEE_SPAN * W, 'the pet is small next to the line');
  const place = one.placements[0];
  assert.ok(place.width <= TEE_PET_WIDTH_MAX * TEE_SPAN * W + 2);
  const foot = await pixel(one.buffer, Math.round((place.left + place.left + place.width) / 2), Math.round(one.lineY) - 3);
  assert.ok(foot.px[0] > 150 && foot.px[3] > 200, `the pet stands on the line ${foot.px}`);
  const trace = heartbeatPoints({ width: W, height: H, footL: place.footL, footR: place.footR });
  for (let i = 1; i < trace.points.length; i++) assert.ok(trace.points[i].x >= trace.points[i - 1].x - 0.01, 'one continuous stroke');
  const under = trace.points.some((p, i) => {
    const q = trace.points[i + 1];
    return q && Math.abs(p.y - one.lineY) < 0.01 && Math.abs(q.y - one.lineY) < 0.01 && p.x <= place.footL + 1 && q.x >= place.footR - 1;
  });
  assert.ok(under, 'the line continues under the feet');
  const left = peaksOn(trace.points, one.lineY, TEE_SPIKE * W, trace.x0, place.left);
  const right = peaksOn(trace.points, one.lineY, TEE_SPIKE * W, place.left + place.width, trace.x1);
  assert.equal(left.spikes.length, TEE_BEATS, `left spikes ${left.spikes.length}`);
  assert.equal(right.spikes.length, TEE_BEATS, `right spikes ${right.spikes.length}`);
  assert.equal(left.dips.length, TEE_BEATS);
  assert.equal(right.dips.length, TEE_BEATS);
  assert.ok(left.bumps.length >= TEE_BEATS && right.bumps.length >= TEE_BEATS, 'a small bump sits on each beat');
  const petMid = place.left + place.width / 2;
  assert.ok(one.nameCx > petMid && one.nameCx < petMid + 0.08 * W, `the name sits slightly right of the pet ${one.nameCx}`);
  const above = Math.round(one.lineY - 0.72 * TEE_SPIKE * W);
  const { data, info } = await sharp(one.buffer).raw().toBuffer({ resolveWithObject: true });
  let leftInk = 0, rightInk = 0;
  for (let x = 0; x < info.width; x++) {
    const o = (above * info.width + x) * info.channels;
    if (data[o + 3] > 80 && data[o] < 50) {
      if (x < place.left - 2) leftInk++;
      else if (x > place.left + place.width + 2) rightInk++;
    }
  }
  assert.ok(leftInk > 2 && rightInk > 2, `ink of the tall spikes is drawn on both sides ${leftInk}/${rightInk}`);
});

test('tee: two pets share a height, so a wide pet stays as tall as a narrow one', async () => {
  const d = design.normalise(teeInput({
    color: 'White', name: { text: 'Milo & Luna' },
    pets: [pet(sha), pet(sha, 'https://cdn.shopify.com/b.png')]
  }), { hosts });
  const tall = await sharp({ create: { width: 24, height: 90, channels: 4, background: { r: 210, g: 30, b: 30, alpha: 1 } } }).png().toBuffer();
  const wide = await sharp({ create: { width: 90, height: 24, channels: 4, background: { r: 30, g: 30, b: 210, alpha: 1 } } }).png().toBuffer();
  const file = await renderTee({ design: d, pets: [tall, wide], width: 640, height: 820 });
  const red = await colorBox(file.buffer, (r, g, b, a) => a > 200 && r > 150 && b < 80);
  const blue = await colorBox(file.buffer, (r, g, b, a) => a > 200 && b > 150 && r < 80);
  assert.ok(red && blue, 'both pets are drawn');
  assert.ok(Math.abs(red.h - blue.h) <= 2, `shared height red ${red.h} blue ${blue.h}`);
  assert.ok(blue.w > red.w * 2, `the wide pet keeps its shape ${blue.w} vs ${red.w}`);
  assert.ok(Math.abs(red.maxy - blue.maxy) <= 2, 'both stand on the same line');
  assert.ok(red.maxx < blue.minx, 'they sit side by side');
  assert.ok(red.w <= TEE_PET_WIDTH_MAX * TEE_SPAN * 640 + 2, `wide pet stays within the line ${red.w}`);
  assert.ok(blue.w <= TEE_PET_WIDTH_MAX * TEE_SPAN * 640 + 2, `wide pet stays within the line ${blue.w}`);
});

test('tee: /api/designs accepts only the store blob host, and rejects every other host', async () => {
  const { EventEmitter } = require('node:events');
  const approve = require('../api/designs');
  const prev = {
    secret: process.env.DESIGN_SIGNING_SECRET,
    token: process.env.BLOB_READ_WRITE_TOKEN,
    store: process.env.BLOB_STORE_ID,
    hosts: process.env.ALLOWED_ASSET_HOSTS
  };
  process.env.DESIGN_SIGNING_SECRET = 'k'.repeat(40);
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_abcstore_notasecretvalue';
  delete process.env.BLOB_STORE_ID;
  delete process.env.ALLOWED_ASSET_HOSTS;
  const own = 'abcstore.public.blob.vercel-storage.com';
  assert.deepEqual(design.configuredBlobHosts(), [own]);
  const call = async url => {
    const body = JSON.stringify({ design: teeInput({ color: 'White', pets: [{ url, sha256: sha }] }) });
    const req = new EventEmitter();
    req.method = 'POST';
    req.headers = { origin: 'https://mypetmemo.com', 'x-forwarded-for': '9.9.9.9' };
    req[Symbol.asyncIterator] = async function* () { yield Buffer.from(body); };
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
    await approve(req, res);
    return { status: res.statusCode, json: JSON.parse(res.body) };
  };
  try {
    const ok = await call(`https://${own}/cutouts/a.png`);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.design.pets[0].url, `https://${own}/cutouts/a.png`);
    const shop = await call('https://cdn.shopify.com/pet.png');
    assert.equal(shop.status, 200);
    const mine = await call('https://www.mypetmemo.com/pet.png');
    assert.equal(mine.status, 200);
    for (const url of [
      'https://evil.example/a.png',
      'https://otherstore.public.blob.vercel-storage.com/cutouts/a.png',
      'https://abcstore.public.blob.vercel-storage.com.evil.example/a.png',
      'http://abcstore.public.blob.vercel-storage.com/a.png'
    ]) {
      const rejected = await call(url);
      assert.equal(rejected.status, 400, url);
      assert.equal(rejected.json.error, 'pet_host', url);
    }
    process.env.BLOB_STORE_ID = 'store_fromenv1';
    assert.ok(design.configuredBlobHosts().includes('fromenv1.public.blob.vercel-storage.com'));
    const fromStore = await call('https://fromenv1.public.blob.vercel-storage.com/cutouts/a.png');
    assert.equal(fromStore.status, 200);
  } finally {
    for (const [key, value] of Object.entries({ DESIGN_SIGNING_SECRET: prev.secret, BLOB_READ_WRITE_TOKEN: prev.token, BLOB_STORE_ID: prev.store, ALLOWED_ASSET_HOSTS: prev.hosts })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function teeFetch(calls = []) {
  const variant = (id, title, width, height) => ({ id, title, placeholders: [{ position: 'front', width, height }] });
  const routes = {
    '/catalog/blueprints/12/print_providers/39/variants.json': { variants: [variant(3901, 'Navy / L', 2767, 3598)] },
    '/catalog/blueprints/12/print_providers/29/variants.json': { variants: [variant(2901, 'Navy / L', 3000, 4000), variant(2902, 'Olive / S', 3000, 4000)] },
    '/catalog/blueprints/12/print_providers/30/variants.json': { variants: [variant(3001, 'Navy / L', 3461, 3955)] }
  };
  return async url => {
    const p = url.replace('https://api.printify.com/v1', '').replace(/\?.*$/, '');
    calls.push(p);
    const body = routes[p];
    return { ok: !!body, status: body ? 200 : 404, text: async () => JSON.stringify(body || {}) };
  };
}
const shopTee = { blueprint_id: 99, print_provider_id: 1, printify_variant_id: 7, title: 'Navy / L', position: 'front', family: 'tee' };

test('tee routing: US uses SwiftPOD then Monster Digital, EU stays on OPT, and the aspect check is skipped', async () => {
  const calls = [];
  const c = catalog({ token: 't', shopId: 's', fetchImpl: teeFetch(calls) });
  const us = await c.regionalVariant(shopTee, 'US', { family: 'tee' });
  assert.equal(us.blueprint_id, 12);
  assert.equal(us.print_provider_id, 39);
  assert.equal(us.printify_variant_id, 3901);
  assert.equal(us.region, 'us:39');
  assert.deepEqual(await c.printArea(us), { position: 'front', width: 2767, height: 3598 });
  assert.ok(!calls.some(p => p.includes('/29/')), 'SwiftPOD matched, so Monster Digital is not asked');

  const olive = { ...shopTee, title: 'Olive / S' };
  const monster = await c.regionalVariant(olive, 'US', { family: 'tee' });
  assert.equal(monster.print_provider_id, 29);
  assert.equal(monster.printify_variant_id, 2902);

  // OPT's print area is a different shape from a square shop file. A blanket would refuse it; a tee does not.
  const eu = await c.regionalVariant({ ...shopTee, title: 'Navy / L' }, 'LT', { family: 'tee' });
  assert.equal(eu.print_provider_id, 30);
  assert.equal(eu.blueprint_id, 12);
  assert.equal(eu.region, 'eu:30');
  assert.deepEqual(await c.printArea(eu), { position: 'front', width: 3461, height: 3955 });
  const shopRatio = 1000 / 1000, optRatio = 3461 / 3955;
  assert.ok(Math.abs(optRatio - shopRatio) > 0.02 * shopRatio);

  const blank = [];
  const blankets = catalog({ token: 't', shopId: 's', fetchImpl: teeFetch(blank) });
  const kept = await blankets.regionalVariant({ blueprint_id: 50, print_provider_id: 1, printify_variant_id: 1, title: 'Navy / L', position: 'front' }, 'US');
  assert.equal(kept.print_provider_id, 1);
  assert.deepEqual(blank, []);

  process.env.PRINTIFY_EU_ROUTING = 'off';
  try {
    const off = await c.regionalVariant(shopTee, 'US', { family: 'tee' });
    assert.equal(off, shopTee);
  } finally { delete process.env.PRINTIFY_EU_ROUTING; }
});
