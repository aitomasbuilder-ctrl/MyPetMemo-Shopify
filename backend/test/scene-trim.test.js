'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const handler = require('../api/portrait');
const { trimSceneBorder } = require('../lib/scene-trim');

const photo = fs.readFileSync(path.join(__dirname, 'fixtures/style-corgi.jpg'));

/** 3:4 frame. `bars` paints near-white side strips; otherwise the picture goes to the edge. */
async function frame({ bars }) {
  const w = 120, h = 160, bar = 10;
  const content = { r: 180, g: 40, b: 90 };
  const img = sharp({ create: { width: w, height: h, channels: 3, background: bars ? '#f7f7f7' : content } });
  if (!bars) return img.png().toBuffer();
  const mid = await sharp({ create: { width: w - bar * 2, height: h, channels: 3, background: content } }).png().toBuffer();
  return img.composite([{ input: mid, left: bar, top: 0 }]).png().toBuffer();
}

async function edge(buf, x, y) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const o = (y * info.width + x) * info.channels;
  return [data[o], data[o + 1], data[o + 2], info.width, info.height];
}

test('scene trim: near-white side bars are cropped and the frame is filled again', async () => {
  const src = await frame({ bars: true });
  const before = await edge(src, 0, 80);
  assert.ok(before[0] > 240 && before[1] > 240 && before[2] > 240, `left bar ${before}`);
  const out = await trimSceneBorder(src);
  assert.strictEqual(out.trimmed, true);
  const left = await edge(out.buffer, 0, 80);
  const right = await edge(out.buffer, left[3] - 1, 80);
  assert.deepStrictEqual([left[3], left[4]], [120, 160]);
  for (const px of [left, right]) {
    assert.ok(px[0] > 150 && px[1] < 80 && px[2] < 120, `edge should be the picture, not a white bar ${px}`);
  }
});

test('scene trim: a picture with no bar is returned unchanged', async () => {
  const src = await frame({ bars: false });
  const out = await trimSceneBorder(src);
  assert.strictEqual(out.trimmed, false);
  assert.strictEqual(out.buffer, src);
  // A flat night sky is the picture, not a bar.
  const night = await sharp({ create: { width: 90, height: 120, channels: 3, background: '#0b1030' } }).png().toBuffer();
  const sky = await trimSceneBorder(night);
  assert.strictEqual(sky.trimmed, false);
  assert.strictEqual(sky.buffer, night);
});

test('portrait: scene styles are trimmed, watercolor is not', async () => {
  const barred = await frame({ bars: true });
  async function call(style, file) {
    const form = new FormData();
    form.append('image', new Blob([photo], { type: 'image/jpeg' }), 'pet.jpg');
    form.append('style', style);
    const r = new Request('http://x/', { method: 'POST', body: form });
    const body = Buffer.from(await r.arrayBuffer());
    const req = Readable.from([body]);
    Object.assign(req, { method: 'POST', headers: { origin: 'https://mypetmemo.com', 'content-type': r.headers.get('content-type'), 'x-forwarded-for': '10.9.9.9' } });
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
    await handler(req, res, { generate: async () => ({ image: file, mimeType: 'image/png' }) });
    return res;
  }
  const scene = await call('neon-nights', barred);
  assert.strictEqual(scene.statusCode, 200);
  assert.strictEqual(scene.body.background, 'scene');
  const png = Buffer.from(scene.body.image.replace(/^data:image\/png;base64,/, ''), 'base64');
  const left = await edge(png, 0, 80);
  assert.ok(left[0] > 150 && left[1] < 80, `scene response still has a white bar ${left}`);
  const paper = await call('watercolor', barred);
  assert.strictEqual(paper.body.background, 'white');
  const paperPng = Buffer.from(paper.body.image.replace(/^data:image\/png;base64,/, ''), 'base64');
  const paperEdge = await edge(paperPng, 0, 80);
  assert.ok(paperEdge[0] > 240 && paperEdge[1] > 240 && paperEdge[2] > 240, `watercolor should keep its paper ${paperEdge}`);
});
