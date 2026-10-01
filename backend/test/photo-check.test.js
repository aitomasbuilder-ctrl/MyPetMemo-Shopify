const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { checkPhoto, MAX_BYTES } = require('../lib/photo-check');
const sample = fs.readFileSync(path.join(__dirname, 'fixtures/sample-dog.webp'));
const png = img => img.png().toBuffer();

test('sample dog photo passes with no errors', async () => {
  const r = await checkPhoto(await png(sharp(sample)));
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.errors.length, 0);
});
test('heavily blurred copy is rejected as blurry', async () => {
  const r = await checkPhoto(await png(sharp(sample).blur(25)));
  assert.equal(r.ok, false); assert.ok(r.errors.some(e => e.code === 'blurry'));
});
test('darkened copy is rejected as too dark', async () => {
  const r = await checkPhoto(await png(sharp(sample).linear(0.12, 0)));
  assert.equal(r.ok, false); assert.ok(r.errors.some(e => e.code === 'too_dark'));
});
test('tiny copy is rejected as too small', async () => {
  const r = await checkPhoto(await png(sharp(sample).resize(300, 300)));
  assert.ok(r.errors.some(e => e.code === 'too_small'));
});
test('800px copy only warns', async () => {
  const r = await checkPhoto(await png(sharp(sample).resize(800, 800)));
  assert.equal(r.ok, true); assert.ok(r.warnings.some(w => w.code === 'small'));
});
test('non-image and oversize files are rejected', async () => {
  assert.ok((await checkPhoto(Buffer.from('hello world, not an image at all'))).errors.some(e => e.code === 'unsupported_type'));
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(MAX_BYTES)]);
  assert.ok((await checkPhoto(big)).errors.some(e => e.code === 'file_too_large'));
});
test('HEIC header is accepted and flagged for conversion', async () => {
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(32)]);
  const r = await checkPhoto(heic); assert.equal(r.ok, true); assert.equal(r.info.needs_conversion, true);
});
test('corrupt JPEG is rejected', async () => {
  const r = await checkPhoto(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('garbagegarbagegarbage')]));
  assert.equal(r.ok, false);
});
