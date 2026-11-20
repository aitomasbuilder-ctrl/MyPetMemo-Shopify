'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sharp = require('sharp');
const { upscaleArtwork } = require('../lib/upscale');

const art = (alpha) => sharp({ create: { width: 40, height: 30, channels: alpha ? 4 : 3, background: alpha ? { r: 200, g: 120, b: 40, alpha: 0.5 } : '#0b1030' } }).png().toBuffer();

test('upscale: small artwork printed large is enlarged x4 by the model', async () => {
  const r = await upscaleArtwork(await art(false), { printedWidth: 400 });
  assert.strictEqual(r.upscaled, true);
  const m = await sharp(r.buffer).metadata();
  assert.deepStrictEqual([m.width, m.height], [160, 120]);
});

test('upscale: keeps transparency of cut-out pets', async () => {
  const r = await upscaleArtwork(await art(true), { printedWidth: 400 });
  const m = await sharp(r.buffer).metadata();
  assert.strictEqual(r.upscaled, true); assert.strictEqual(m.hasAlpha, true);
  const { data } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
  assert.ok(Math.abs(data[3] - 128) <= 2);
});

test('upscale: skipped when not needed, disabled, or unreadable (fail-open)', async () => {
  const b = await art(false);
  assert.strictEqual((await upscaleArtwork(b, { printedWidth: 50 })).upscaled, false);
  process.env.UPSCALE_ARTWORK = 'off';
  try { assert.strictEqual((await upscaleArtwork(b, { printedWidth: 400 })).info, 'disabled'); } finally { delete process.env.UPSCALE_ARTWORK; }
  const bad = Buffer.from('not an image');
  assert.strictEqual((await upscaleArtwork(bad, { printedWidth: 400 })).buffer, bad);
});
