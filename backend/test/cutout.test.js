'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { guidedFilter } = require('../lib/matte-refine');
const handler = require('../api/cutout');
const { hardenAlpha, cleanEdges, upsampleMatte } = require('../api/cutout');

const resOf = () => ({ headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = JSON.parse(b); } });
const req = ip => ({ method: 'POST', headers: { 'x-forwarded-for': ip } });

test('matte: a hard edge in the photo pulls a soft mask onto that edge', () => {
  const w = 40, h = 8;
  const guide = new Float32Array(w * h);
  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    guide[y * w + x] = x < 20 ? 0.05 : 0.95;
    alpha[y * w + x] = x / (w - 1);
  }
  const q = guidedFilter(guide, alpha, w, h, 5, 1e-4);
  assert.ok(q[4 * w + 6] < 0.4, `left of the edge ${q[4 * w + 6]}`);
  assert.ok(q[4 * w + 32] > 0.6, `right of the edge ${q[4 * w + 32]}`);
});

test('cutout: a resized matte stays one channel, so the subject is not turned into stripes', async () => {
  const small = Buffer.alloc(4 * 4, 255);
  const up = await upsampleMatte(small, 4, 4, 9, 6);
  assert.equal(up.length, 54);
  assert.ok(up.every(v => v === 255));
});

test('cutout: the matte is hardened and the fur edge loses the backdrop colour', () => {
  assert.equal(hardenAlpha(0), 0);
  assert.equal(hardenAlpha(0.30), 0);
  assert.equal(hardenAlpha(0.50), 0.5);
  assert.ok(Math.abs(hardenAlpha(0.70) - 1) < 1e-9);
  assert.equal(hardenAlpha(1), 1);
  // A grey fringe (128) over white, half covered, is really a dark hair.
  const rgb = Buffer.from([128, 128, 128]);
  const out = cleanEdges(rgb, 1, 1, new Float32Array([0.5]));
  assert.ok(out[0] < 20 && out[3] === 128, `cleaned pixel ${Array.from(out)}`);
});

test('cutout: a missing model file fails clearly, and a cached photo is not run again', async () => {
  const missing = resOf();
  await handler(req('10.8.1.1'), missing, { modelPath: '/tmp/no-such-cutout-model.onnx' });
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.body.code, 'cutout_not_configured');

  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#224466' } }).png().toBuffer();
  let infers = 0;
  const mem = new Map();
  const deps = {
    image,
    modelUrl: 'https://example.blob.vercel-storage.com/birefnet-general-lite.onnx',
    infer: async () => { infers++; return new Float32Array(16).fill(1); },
    cacheGet: async sha => mem.get(sha) || null,
    cachePut: async (sha, png) => { mem.set(sha, { png, url: `https://blob.example/${sha}.png` }); return `https://blob.example/${sha}.png`; }
  };
  const first = resOf();
  await handler(req('10.8.1.2'), first, deps);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.cached, false);
  assert.equal(infers, 1);
  assert.match(first.body.image, /^data:image\/png;base64,/);
  const second = resOf();
  await handler(req('10.8.1.3'), second, deps);
  assert.equal(second.body.cached, true);
  assert.equal(infers, 1);

  const limited = resOf();
  await handler(req('10.8.1.4'), limited, { ...deps, allow: () => false });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.body.code, 'rate_limited');
});

test('cutout: a small disconnected scrap is removed and a second pet is kept', async () => {
  const { dropSpecks } = require('../lib/alpha-trim');
  const w = 40, h = 30;
  const raw = Buffer.alloc(w * h * 4);
  const paint = (x0, y0, bw, bh) => {
    for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) {
      const i = (y * w + x) * 4;
      raw[i] = 200; raw[i + 1] = 40; raw[i + 2] = 40; raw[i + 3] = 255;
    }
  };
  paint(2, 2, 16, 20);
  paint(24, 4, 12, 18);
  paint(38, 28, 1, 1);
  const png = await sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  const out = await dropSpecks(png);
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  const alpha = (x, y) => data[(y * info.width + x) * 4 + 3];
  assert.ok(alpha(8, 8) > 200, 'the first pet stays');
  assert.ok(alpha(28, 10) > 200, 'the second pet stays');
  assert.equal(alpha(38, 28), 0, 'the scrap is gone');
});

test('cutout: a blob outage still returns the picture', async () => {
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#224466' } }).png().toBuffer();
  const out = resOf();
  await handler(req('10.8.3.1'), out, {
    image,
    infer: async () => new Float32Array(64).fill(1),
    cacheGet: async () => { throw new Error('No blob credentials found'); },
    cachePut: async () => { throw new Error('No blob credentials found'); }
  });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.url, null);
  assert.match(out.body.image, /^data:image\/png;base64,/);
});

test('cutout: transparent padding is cropped to the subject, with a small margin', async () => {
  const image = await sharp({ create: { width: 30, height: 24, channels: 3, background: '#224466' } }).png().toBuffer();
  const soft = new Float32Array(30 * 24);
  for (let y = 6; y < 18; y++) for (let x = 8; x < 20; x++) soft[y * 30 + x] = 1;
  const mem = new Map();
  const out = resOf();
  await handler(req('10.8.2.1'), out, {
    image,
    infer: async () => soft,
    cacheGet: async sha => mem.get(sha) || null,
    cachePut: async (sha, png) => { mem.set(sha, { png, url: `https://blob.example/${sha}.png` }); return `https://blob.example/${sha}.png`; }
  });
  assert.equal(out.statusCode, 200);
  const png = Buffer.from(out.body.image.slice('data:image/png;base64,'.length), 'base64');
  const meta = await sharp(png).metadata();
  assert.ok(meta.width >= 14 && meta.width <= 18, `trimmed width ${meta.width}`);
  assert.ok(meta.height >= 14 && meta.height <= 18, `trimmed height ${meta.height}`);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const corner = data[3];
  const mid = data[((info.height >> 1) * info.width + (info.width >> 1)) * 4 + 3];
  assert.equal(corner, 0, 'the margin stays transparent');
  assert.ok(mid > 200, 'the subject is kept');
});
