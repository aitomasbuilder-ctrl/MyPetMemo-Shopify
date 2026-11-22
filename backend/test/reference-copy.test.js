'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { referenceDistance, COPY_MAX, GRID_W, GRID_H } = require('../lib/reference-copy');
const { trimSceneBorder } = require('../lib/scene-trim');

const ref = fs.readFileSync(path.join(__dirname, '../assets/style/neon-nights-ref.jpg'));

test('reference copy: the style image, a recompress and a small shift are copies', async () => {
  assert.strictEqual(COPY_MAX, 36);
  assert.deepStrictEqual([GRID_W, GRID_H], [96, 128]);
  const same = await referenceDistance(ref);
  assert.ok(same.score < 2, `identical reference scored ${same.score}`);
  assert.strictEqual(same.copy, true);
  const jpeg = await sharp(ref).jpeg({ quality: 40 }).toBuffer();
  const compressed = await referenceDistance(jpeg);
  assert.ok(compressed.score < 5, `recompressed reference scored ${compressed.score}`);
  assert.strictEqual(compressed.copy, true);
  const meta = await sharp(ref).metadata();
  const shifted = await sharp(ref).extract({ left: 16, top: 0, width: meta.width - 16, height: meta.height }).jpeg().toBuffer();
  const moved = await referenceDistance(shifted);
  assert.ok(moved.score <= 28, `16px shift scored ${moved.score}`);
  assert.strictEqual(moved.copy, true);
  // A 10% reframe of the same picture still reads as the reference (about 35 on this grid).
  const cw = Math.round(meta.width * 0.9);
  const ch = Math.round(meta.height * 0.9);
  const cropped = await sharp(ref).extract({
    left: Math.round((meta.width - cw) / 2),
    top: Math.round((meta.height - ch) / 2),
    width: cw,
    height: ch
  }).jpeg().toBuffer();
  const reframed = await referenceDistance(cropped);
  assert.ok(reframed.score <= COPY_MAX, `reframed reference scored ${reframed.score}`);
  assert.strictEqual(reframed.copy, true);
});

test('reference copy: a different animal is not a copy, a partly edited reference still is', async () => {
  const corgi = fs.readFileSync(path.join(__dirname, 'fixtures/style-corgi.jpg'));
  const pet = await referenceDistance(corgi);
  assert.ok(pet.score >= 44, `corgi photo scored ${pet.score}`);
  assert.strictEqual(pet.copy, false);
  const meta = await sharp(ref).metadata();
  async function paint(fw, fh) {
    const w = Math.round(meta.width * fw);
    const h = Math.round(meta.height * fh);
    return sharp(ref).composite([{
      input: await sharp({ create: { width: w, height: h, channels: 3, background: '#2040c0' } }).png().toBuffer(),
      left: Math.round((meta.width - w) / 2),
      top: Math.round(meta.height * 0.12)
    }]).jpeg().toBuffer();
  }
  // Most of the reference dog is still there, so this must not reach a customer.
  const partial = await referenceDistance(await paint(0.5, 0.45));
  assert.ok(partial.score <= 28, `partial edit scored ${partial.score}`);
  assert.strictEqual(partial.copy, true);
  // Replacing the pet and most of the street is a different picture.
  const replaced = await referenceDistance(await paint(0.85, 0.75));
  assert.ok(replaced.score >= 44, `replaced reference scored ${replaced.score}`);
  assert.strictEqual(replaced.copy, false);
  assert.strictEqual(await referenceDistance(Buffer.from('not an image')), null);
});

test('reference copy: a 20px white left strip does not hide the reference', async () => {
  const meta = await sharp(ref).metadata();
  const extended = await sharp({
    create: { width: meta.width + 20, height: meta.height, channels: 3, background: '#ffffff' }
  }).composite([{ input: ref, left: 20, top: 0 }]).jpeg().toBuffer();
  const before = await referenceDistance(extended);
  assert.strictEqual(before.copy, true, `strip scored ${before.score}`);
  const trimmed = await trimSceneBorder(extended);
  assert.strictEqual(trimmed.trimmed, true);
  const after = await referenceDistance(trimmed.buffer);
  assert.strictEqual(after.copy, true, `trimmed strip scored ${after.score}`);
  assert.ok(after.score <= before.score + 1, 'trimming the strip must not make a copy look original');
});
