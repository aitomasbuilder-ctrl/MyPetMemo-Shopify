'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const sharp = require('sharp');
const handler = require('../api/portrait');
const { generatePortrait, PROMPT, WATERCOLOR_PROMPT, MOONLIGHT_PROMPT, CHRISTMAS_PROMPT, NORTHERN_NIGHT_PROMPT } = require('../lib/portrait-ai');

const photo = fs.readFileSync(path.join(__dirname, 'fixtures/style-corgi.jpg'));

async function call({ origin = 'https://mypetmemo.com', file = photo, generate, style } = {}) {
  const form = new FormData();
  if (file) form.append('image', new Blob([file], { type: 'image/jpeg' }), 'pet.jpg');
  form.append('product', '123');
  if (style) form.append('style', style);
  const r = new Request('http://x/', { method: 'POST', body: form });
  const body = Buffer.from(await r.arrayBuffer());
  const req = Readable.from([body]);
  Object.assign(req, { method: 'POST', headers: { origin, 'content-type': r.headers.get('content-type'), 'x-forwarded-for': `10.0.0.${Math.random() * 250 | 0}` } });
  const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
  await handler(req, res, { generate });
  return res;
}

test('returns the generated art as a PNG on a chroma background', async () => {
  const green = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#00ff00' } }).jpeg().toBuffer();
  let got;
  const res = await call({ generate: async p => { got = p; return { image: green, mimeType: 'image/jpeg' }; } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.background, 'chroma');
  assert.match(res.body.image, /^data:image\/png;base64,/);
  assert.strictEqual(got.mimeType, 'image/jpeg');
  assert.strictEqual(res.headers['access-control-allow-origin'], 'https://mypetmemo.com');
});

test('rejects other websites, missing photos and non-images', async () => {
  assert.strictEqual((await call({ origin: 'https://evil.example' })).statusCode, 403);
  assert.strictEqual((await call({ file: null })).statusCode, 400);
  assert.strictEqual((await call({ file: Buffer.from('not an image') })).statusCode, 400);
});

test('without GEMINI_API_KEY the service says it is not connected', async () => {
  const saved = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY;
  try {
    const res = await call();
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'not_configured');
  } finally { if (saved) process.env.GEMINI_API_KEY = saved; }
});

test('sends the photo with the vector-style prompt and reads the image back', async () => {
  let req;
  const fetchImpl = async (url, init) => {
    req = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: Buffer.from('png').toString('base64') } }] } }] }), { status: 200 });
  };
  const out = await generatePortrait({ image: Buffer.from('jpg'), mimeType: 'image/jpeg' }, { apiKey: 'k', fetchImpl });
  assert.match(req.url, /gemini-2\.5-flash-image:generateContent$/);
  assert.strictEqual(req.init.headers['x-goog-api-key'], 'k');
  const parts = req.body.contents[0].parts;
  assert.strictEqual(parts[0].text, PROMPT);
  assert.match(PROMPT, /vector/); assert.match(PROMPT, /head and upper chest/); assert.match(PROMPT, /#00FF00/); assert.match(PROMPT, /exact animal/);
  assert.strictEqual(parts[1].inline_data.data, Buffer.from('jpg').toString('base64'));
  assert.deepStrictEqual(req.body.generationConfig.responseModalities, ['IMAGE']);
  assert.strictEqual(out.image.toString(), 'png');
});

test('no image in the answer means no pet was found; rate limits pass through', async () => {
  const noImage = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'no animal' }] } }] }), { status: 200 });
  await assert.rejects(generatePortrait({ image: Buffer.from('x'), mimeType: 'image/jpeg' }, { apiKey: 'k', fetchImpl: noImage }), e => e.status === 422);
  const busy = async () => new Response('{}', { status: 429 });
  await assert.rejects(generatePortrait({ image: Buffer.from('x'), mimeType: 'image/jpeg' }, { apiKey: 'k', fetchImpl: busy }), e => e.status === 429);
});

test('watercolor: asks for the watercolor painting and says the background is white paper', async () => {
  const white = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
  let opts;
  const res = await call({ style: 'watercolor', generate: async (p, o) => { opts = o; return { image: white, mimeType: 'image/jpeg' }; } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(opts.style, 'watercolor');
  assert.strictEqual(res.body.background, 'white');
  const other = await call({ style: 'cubist', generate: async (p, o) => { opts = o; return { image: white, mimeType: 'image/jpeg' }; } });
  assert.strictEqual(opts.style, 'vector'); assert.strictEqual(other.body.background, 'chroma');
  let sent;
  const fetchImpl = async (url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: 'eA==' } }] } }] }), { status: 200 }); };
  await generatePortrait({ image: Buffer.from('jpg'), mimeType: 'image/jpeg' }, { apiKey: 'k', fetchImpl, style: 'watercolor' });
  assert.strictEqual(sent.contents[0].parts[0].text, WATERCOLOR_PROMPT);
  assert.strictEqual(sent.generationConfig.imageConfig.aspectRatio, '3:4');
  assert.match(WATERCOLOR_PROMPT, /watercolor/); assert.match(WATERCOLOR_PROMPT, /#FFFFFF/); assert.match(WATERCOLOR_PROMPT, /exact animal/); assert.match(WATERCOLOR_PROMPT, /No text/);
});

test('moonlight: paints a whole night scene and says nothing is cut out', async () => {
  const night = await sharp({ create: { width: 48, height: 64, channels: 3, background: '#141a2b' } }).jpeg().toBuffer();
  let opts;
  const res = await call({ style: 'moonlight', generate: async (p, o) => { opts = o; return { image: night, mimeType: 'image/jpeg' }; } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(opts.style, 'moonlight');
  assert.strictEqual(res.body.background, 'scene');
  let sent;
  const fetchImpl = async (url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: 'eA==' } }] } }] }), { status: 200 }); };
  await generatePortrait({ image: Buffer.from('jpg'), mimeType: 'image/jpeg' }, { apiKey: 'k', fetchImpl, style: 'moonlight' });
  assert.strictEqual(sent.contents[0].parts[0].text, MOONLIGHT_PROMPT);
  assert.strictEqual(sent.generationConfig.imageConfig.aspectRatio, '3:4');
  assert.match(MOONLIGHT_PROMPT, /moon/); assert.match(MOONLIGHT_PROMPT, /exact animal/); assert.match(MOONLIGHT_PROMPT, /No text/);
});

test('christmas: a whole cozy Christmas scene, nothing cut out', async () => {
  const red = await sharp({ create: { width: 48, height: 64, channels: 3, background: '#7a1f1f' } }).jpeg().toBuffer();
  const res = await call({ style: 'christmas', generate: async () => ({ image: red, mimeType: 'image/jpeg' }) });
  assert.strictEqual(res.body.background, 'scene');
  assert.match(CHRISTMAS_PROMPT, /Christmas/); assert.match(CHRISTMAS_PROMPT, /exact animal/); assert.match(CHRISTMAS_PROMPT, /No text/);
});

test('northern-night: a whole night-sky scene, nothing cut out', async () => {
  let opts;
  const night = await sharp({ create: { width: 30, height: 40, channels: 3, background: '#0b1030' } }).jpeg().toBuffer();
  const res = await call({ style: 'northern-night', generate: async (p, o) => { opts = o; return { image: night, mimeType: 'image/jpeg' }; } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(opts.style, 'northern-night');
  assert.strictEqual(res.body.style, 'northern-night');
  assert.strictEqual(res.body.background, 'scene');
  let sent;
  const fetchImpl = async (url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: 'eA==' } }] } }] }), { status: 200 }); };
  await generatePortrait({ image: Buffer.from('jpg'), mimeType: 'image/jpeg' }, { apiKey: 'k', fetchImpl, style: 'northern-night' });
  assert.strictEqual(sent.contents[0].parts[0].text, NORTHERN_NIGHT_PROMPT);
  assert.strictEqual(sent.generationConfig.imageConfig.aspectRatio, '3:4');
  assert.match(NORTHERN_NIGHT_PROMPT, /Northern Night/);
  assert.match(NORTHERN_NIGHT_PROMPT, /crescent moon/);
  assert.match(NORTHERN_NIGHT_PROMPT, /emerald green and violet/);
  assert.match(NORTHERN_NIGHT_PROMPT, /gold stardust/);
  assert.match(NORTHERN_NIGHT_PROMPT, /snowy cliff/);
  assert.match(NORTHERN_NIGHT_PROMPT, /exact animal/);
  assert.match(NORTHERN_NIGHT_PROMPT, /No text/);
  assert.match(NORTHERN_NIGHT_PROMPT, /no blanket or product mockup/);
});
