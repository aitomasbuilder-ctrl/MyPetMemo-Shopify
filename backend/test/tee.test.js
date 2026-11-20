'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const design = require('../lib/design');
const { renderTee, TEE_LINE, TEE_NAME_SIZE } = require('../lib/render');
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
  const three = design.normalise(teeInput({ pets: [pet(sha), pet(sha, 'https://cdn.shopify.com/b.png'), pet(sha, 'https://cdn.shopify.com/c.png')] }), { hosts });
  assert.equal(three.pets.length, 3);
});

const swatch = (r, g, b) => sharp({ create: { width: 30, height: 36, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toBuffer();

async function pixel(buf, x, y) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * info.channels;
  return { px: Array.from(data.slice(o, o + info.channels)), info };
}

function linePixel(W) { return { x: Math.round(0.07 * W), y: Math.round(TEE_LINE * W) }; }

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
  const at = linePixel(400);
  const ink = await pixel(file.buffer, at.x, at.y);
  assert.ok(ink.px[3] > 100 && ink.px[0] < 40, `dark ink on the line ${ink.px}`);
});

test('tee: white ink on a dark shirt, and the name shrinks to fit', async () => {
  const dark = design.normalise(teeInput({ color: 'Black', name: { text: 'Bo' } }), { hosts });
  const file = await renderTee({ design: dark, pets: [await swatch(20, 20, 20)], width: 400, height: 520 });
  const at = linePixel(400);
  const ink = await pixel(file.buffer, at.x, at.y);
  assert.ok(ink.px[0] > 240 && ink.px[3] > 100, `white ink ${ink.px}`);
  const short = await renderTee({ design: dark, pets: [await swatch(20, 20, 20)], width: 600, height: 780 });
  assert.equal(short.nameSize, TEE_NAME_SIZE * 600);
  const long = design.normalise(teeInput({ color: 'Black', name: { text: 'W'.repeat(24) } }), { hosts });
  const fitted = await renderTee({ design: long, pets: [await swatch(20, 20, 20)], width: 600, height: 780 });
  assert.ok(fitted.nameSize < TEE_NAME_SIZE * 600, `name size ${fitted.nameSize}`);
  assert.ok(fitted.nameSize > 0);
});

test('tee: one, two or three pets, with the centre pet in front', async () => {
  const d = (n, text = 'Mila') => design.normalise(teeInput({
    color: 'White', name: { text },
    pets: Array.from({ length: n }, (_, i) => pet(sha, `https://cdn.shopify.com/p${i}.png`))
  }), { hosts });
  const one = await renderTee({ design: d(1), pets: [await swatch(200, 30, 40)], width: 480, height: 640 });
  const mid = await pixel(one.buffer, 240, Math.round(TEE_LINE * 480) - 8);
  assert.ok(mid.px[0] > 150 && mid.px[3] > 200, `the single pet sits on the line ${mid.px}`);
  const two = await renderTee({ design: d(2), pets: [await swatch(220, 20, 20), await swatch(20, 20, 220)], width: 480, height: 640 });
  assert.equal(two.width, 480);
  const red = design.normalise(teeInput({ color: 'Olive', name: { text: 'Mila' }, pets: [pet(sha), pet(sha, 'https://cdn.shopify.com/b.png'), pet(sha, 'https://cdn.shopify.com/c.png')] }), { hosts });
  const three = await renderTee({
    design: red,
    pets: [await swatch(220, 10, 10), await swatch(10, 10, 220), await swatch(10, 180, 10)],
    width: 480, height: 640
  });
  // Overlap of the left pet and the centre pet belongs to the centre pet.
  const gap0 = 0.36 * 480, slot = (0.64 - 0.36) * 480 / 3;
  const between = Math.round(gap0 + slot);
  const over = await pixel(three.buffer, between, Math.round(TEE_LINE * 480) - 6);
  assert.ok(over.px[2] > 150 && over.px[0] < 80, `centre pet is in front ${over.px}`);
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
