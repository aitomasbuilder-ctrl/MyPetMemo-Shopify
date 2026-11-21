'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const handler = require('../api/cutout');
const { hardenAlpha, cleanEdges } = require('../api/cutout');

const resOf = () => ({ headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = JSON.parse(b); } });
const req = ip => ({ method: 'POST', headers: { 'x-forwarded-for': ip } });

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

test('cutout: a missing model URL fails clearly, and a cached photo is not run again', async () => {
  delete process.env.CUTOUT_MODEL_URL;
  const missing = resOf();
  await handler(req('10.8.1.1'), missing, {});
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
