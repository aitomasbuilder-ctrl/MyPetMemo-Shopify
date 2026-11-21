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

async function call(style, file, opts = {}) {
  const form = new FormData();
  form.append('image', new Blob([photo], { type: 'image/jpeg' }), 'pet.jpg');
  form.append('style', style);
  const r = new Request('http://x/', { method: 'POST', body: form });
  const body = Buffer.from(await r.arrayBuffer());
  const req = Readable.from([body]);
  Object.assign(req, { method: 'POST', headers: { origin: 'https://mypetmemo.com', 'content-type': r.headers.get('content-type'), 'x-forwarded-for': opts.ip || '10.9.9.9' } });
  const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
  const generate = opts.generate || (async () => ({ image: file, mimeType: 'image/png' }));
  await handler(req, res, { generate, log: opts.log, elapsed: opts.elapsed });
  return res;
}

/** 3:4 frame. The picture is uneven; a near-white strip covers the bottom. 0.24 is 24 px of 100. */
async function bottomBar(fraction) {
  const w = 75, h = 100, barPx = Math.round(h * fraction);
  const raw = Buffer.alloc(w * h * 3, 247);
  for (let y = 0; y < h - barPx; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      raw[o] = 40 + ((x * 17 + y * 13) % 160);
      raw[o + 1] = 20 + ((x * 9 + y * 3) % 80);
      raw[o + 2] = 30 + ((x * 5 + y * 11) % 140);
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

function pngOf(res) {
  return Buffer.from(res.body.image.replace(/^data:image\/png;base64,/, ''), 'base64');
}

test('portrait: scene styles are trimmed, watercolor is not', async () => {
  const barred = await frame({ bars: true });
  const scene = await call('neon-nights', barred);
  assert.strictEqual(scene.statusCode, 200);
  assert.strictEqual(scene.body.background, 'scene');
  const left = await edge(pngOf(scene), 0, 80);
  assert.ok(left[0] > 150 && left[1] < 80, `scene response still has a white bar ${left}`);
  const paper = await call('watercolor', barred, { ip: '10.9.9.10' });
  assert.strictEqual(paper.body.background, 'white');
  const paperEdge = await edge(pngOf(paper), 0, 80);
  assert.ok(paperEdge[0] > 240 && paperEdge[1] > 240 && paperEdge[2] > 240, `watercolor should keep its paper ${paperEdge}`);
});

test('scene trim: a 24% white bar is past the cap, so the normal trim leaves it', async () => {
  const src = await bottomBar(0.24);
  const bar = await edge(src, 10, 99);
  assert.ok(bar[0] > 240 && bar[1] > 240 && bar[2] > 240, `bottom should start white ${bar}`);
  const out = await trimSceneBorder(src);
  assert.strictEqual(out.trimmed, false);
  assert.strictEqual(out.buffer, src);
});

test('portrait: a 24% white bottom bar is retried once and then cropped', async () => {
  const barred = await bottomBar(0.24);
  const logs = [];
  let calls = 0;
  let first;
  const res = await call('neon-nights', null, {
    ip: '10.9.9.11',
    log: (event, detail) => logs.push({ event, detail }),
    generate: async (photo, opts) => {
      calls++;
      if (!first) first = { image: photo.image, mimeType: photo.mimeType, style: opts.style };
      else {
        assert.strictEqual(opts.style, first.style);
        assert.strictEqual(photo.mimeType, first.mimeType);
        assert.ok(photo.image.equals(first.image));
      }
      return { image: barred, mimeType: 'image/png' };
    }
  });
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(logs.map(l => l.event), ['scene border retry', 'scene border crop']);
  assert.deepStrictEqual(logs[0].detail.sides, ['bottom']);
  assert.strictEqual(logs[0].detail.bottom, 24);
  assert.strictEqual(logs[0].detail.height, 100);
  assert.strictEqual(res.statusCode, 200);
  const bottom = await edge(pngOf(res), 37, 99);
  const top = await edge(pngOf(res), 37, 0);
  assert.deepStrictEqual([bottom[3], bottom[4]], [75, 100]);
  for (const px of [bottom, top]) {
    assert.ok(!(px[0] > 230 && px[1] > 230 && px[2] > 230), `cropped edge should be the picture, not a white bar ${px}`);
  }
});

test('portrait: a scene with no bar is not retried', async () => {
  const src = await frame({ bars: false });
  const logs = [];
  let calls = 0;
  const res = await call('northern-night', null, {
    ip: '10.9.9.12',
    log: (event, detail) => logs.push({ event, detail }),
    generate: async () => { calls++; return { image: src, mimeType: 'image/png' }; }
  });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(logs, []);
  assert.strictEqual(res.statusCode, 200);
  const px = await edge(pngOf(res), 0, 159);
  assert.ok(px[0] > 150 && px[1] < 80, `picture should reach the edge ${px}`);
});

test('portrait: a dark night sky is not treated as a bar', async () => {
  const night = await sharp({ create: { width: 90, height: 120, channels: 3, background: '#0b1030' } }).png().toBuffer();
  const logs = [];
  let calls = 0;
  const res = await call('moonlight', null, {
    ip: '10.9.9.13',
    log: (event, detail) => logs.push(event),
    generate: async () => { calls++; return { image: night, mimeType: 'image/png' }; }
  });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(logs, []);
  assert.strictEqual(res.statusCode, 200);
  for (const [x, y] of [[0, 0], [89, 119], [0, 119]]) {
    const px = await edge(pngOf(res), x, y);
    assert.ok(px[0] < 40 && px[1] < 40 && px[2] < 80, `night sky pixel ${px} at ${x},${y}`);
  }
});

test('portrait: a thick bar that would leave less than 60% is a retryable error', async () => {
  const barred = await bottomBar(0.5);
  const logs = [];
  let calls = 0;
  const res = await call('christmas', null, {
    ip: '10.9.9.14',
    log: (event) => logs.push(event),
    generate: async () => { calls++; return { image: barred, mimeType: 'image/png' }; }
  });
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(logs, ['scene border retry', 'scene border rejected']);
  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(res.body.code, 'border');
  assert.match(res.body.message, /blank strip/);
  assert.match(res.body.message, /try again/i);
  assert.strictEqual(res.body.image, undefined);
});

test('portrait: a thick bar near the time budget is cropped without a second call', async () => {
  const barred = await bottomBar(0.24);
  const logs = [];
  let calls = 0;
  const res = await call('neon-nights', null, {
    ip: '10.9.9.15',
    elapsed: 50000,
    log: (event) => logs.push(event),
    generate: async () => { calls++; return { image: barred, mimeType: 'image/png' }; }
  });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(logs, ['scene border retry skipped', 'scene border crop']);
  assert.strictEqual(res.statusCode, 200);
  const bottom = await edge(pngOf(res), 10, 99);
  assert.ok(!(bottom[0] > 230 && bottom[1] > 230 && bottom[2] > 230), `budget path should still crop the bar ${bottom}`);
});

test('portrait: watercolor keeps a thick white bar and is not retried', async () => {
  const barred = await bottomBar(0.24);
  let calls = 0;
  const logs = [];
  const res = await call('watercolor', null, {
    ip: '10.9.9.16',
    log: (event) => logs.push(event),
    generate: async () => { calls++; return { image: barred, mimeType: 'image/png' }; }
  });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(logs, []);
  assert.strictEqual(res.body.background, 'white');
  const bottom = await edge(pngOf(res), 10, 99);
  assert.ok(bottom[0] > 240 && bottom[1] > 240 && bottom[2] > 240, `watercolor should keep its paper ${bottom}`);
});
