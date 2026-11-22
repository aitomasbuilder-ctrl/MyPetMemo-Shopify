'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const sharp = require('sharp');
const handler = require('../api/portrait');
const { generatePortrait, PROMPT, WATERCOLOR_PROMPT, MOONLIGHT_PROMPT, CHRISTMAS_PROMPT, NORTHERN_NIGHT_PROMPT, NEON_NIGHTS_PROMPT, NEON_NIGHTS_IDENTITY_RETRY_PROMPT, SCENE_NO_LETTERING, DEFAULT_MODEL } = require('../lib/portrait-ai');
const { referenceDistance } = require('../lib/reference-copy');

const photo = fs.readFileSync(path.join(__dirname, 'fixtures/style-corgi.jpg'));

async function call({ origin = 'https://mypetmemo.com', file = photo, generate, style, log, elapsed } = {}) {
  const form = new FormData();
  if (file) form.append('image', new Blob([file], { type: 'image/jpeg' }), 'pet.jpg');
  form.append('product', '123');
  if (style) form.append('style', style);
  const r = new Request('http://x/', { method: 'POST', body: form });
  const body = Buffer.from(await r.arrayBuffer());
  const req = Readable.from([body]);
  Object.assign(req, { method: 'POST', headers: { origin, 'content-type': r.headers.get('content-type'), 'x-forwarded-for': `10.0.0.${Math.random() * 250 | 0}` } });
  const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } };
  await handler(req, res, { generate, log, elapsed });
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

test('neon-nights: a whole neon poster scene, nothing cut out, other styles unchanged', async () => {
  let opts;
  const dusk = await sharp({ create: { width: 30, height: 40, channels: 3, background: '#6b2d6b' } }).jpeg().toBuffer();
  const res = await call({ style: 'neon-nights', generate: async (p, o) => { opts = o; return { image: dusk, mimeType: 'image/jpeg' }; } });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(opts.style, 'neon-nights');
  assert.strictEqual(res.body.style, 'neon-nights');
  assert.strictEqual(res.body.background, 'scene');
  let sent;
  let requested = '';
  const fetchImpl = async (url, init) => { requested = url; sent = JSON.parse(init.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: 'eA==' } }] } }] }), { status: 200 }); };
  await generatePortrait({ image: Buffer.from('jpg'), mimeType: 'image/jpeg' }, { apiKey: 'k', fetchImpl, style: 'neon-nights' });
  assert.strictEqual(sent.contents[0].parts[0].text, NEON_NIGHTS_PROMPT);
  assert.strictEqual(sent.generationConfig.imageConfig.aspectRatio, '3:4');
  assert.match(requested, new RegExp(`${DEFAULT_MODEL}:generateContent$`));
  const style = 'Hand-drawn digital poster illustration in a premium graphic-novel / high-end print style. The pet is a three-quarter view, chest-up, large and filling the frame, with a happy expression (for dogs, mouth open with tongue out if it suits the photo). The pet\'s body continues naturally down and out of the bottom edge of the frame. Shoulders and chest are cropped by the frame edge, never ending in a point, a cut-out shape, a sticker outline or a fade. The pet sits in the street scene, lit by the sunset and the neon, not pasted on top of it. It wears black sunglasses with orange-to-magenta mirrored reflections of palms and sunset, and a heavy polished gold chain. Fur is drawn as bold stylised clumps with confident hand-inked dark linework and hard-edged shadow shapes. Not soft airbrushed fur, not photoreal, and it must not look AI-generated. Keep the pet\'s true fur colours, but render them deep and rich, with warm burnt-orange or deep shadows and magenta-purple reflected light on the shaded side. Very high contrast, deep saturated colours, inky dark purples in the shadows. Background: a deep violet and electric magenta sky with streaky clouds, a blazing orange sunset glow low on the horizon, black palm tree silhouettes on both sides, and a neon city street with intense pink and violet glow and a dark wet reflective road. Building signs are plain glowing neon tubes and rectangles with no characters or symbols.';
  assert.ok(NEON_NIGHTS_PROMPT.startsWith('Draw the animal in the photo labelled THE PET TO DRAW.'), 'identity instructions come first');
  assert.ok(NEON_NIGHTS_PROMPT.includes(style), 'neon-nights style direction');
  assert.match(NEON_NIGHTS_PROMPT, /draw THAT breed: its own head shape, muzzle length, ear shape, coat length and texture, and markings\. If the pet is short-coated, keep it short-coated\. Do not replace it with the dog in the style reference\./);
  assert.match(NEON_NIGHTS_PROMPT, /The photo labelled STYLE REFERENCE \(technique only\) is not an animal to draw\. Do not copy its dog, breed, face, fluffy coat, expression, pose, framing or composition\. Its dog's breed, fluffy coat and face shape must NOT appear unless they are already in THE PET TO DRAW\./);
  assert.match(NEON_NIGHTS_PROMPT, /Correct anatomy: exactly one head, exactly two ears, two eyes, one nose, one mouth\. No duplicated ears or features, no extra limbs\. The sunglasses sit on the face; the ears stay above or behind them and are not repeated\./);
  assert.match(NEON_NIGHTS_PROMPT, /Render the pet's true fur colours deep, saturated and high-contrast: rich mid-tones, dark inky shadows, magenta-violet reflected light\. Never pale or washed out\./);
  assert.match(NEON_NIGHTS_PROMPT, /Use the style reference for technique only: hand-inked linework, colour palette, lighting, level of fur detail, sunglasses-and-gold-chain styling and the neon-street mood\. Do not copy any lettering from the reference signs\. Do not match the reference picture's composition\./);
  assert.doesNotMatch(NEON_NIGHTS_PROMPT, /as closely as possible/);
  assert.doesNotMatch(NEON_NIGHTS_PROMPT, /match its rendering style/);
  assert.doesNotMatch(NEON_NIGHTS_IDENTITY_RETRY_PROMPT, /as closely as possible/);
  assert.doesNotMatch(NEON_NIGHTS_IDENTITY_RETRY_PROMPT, /STYLE REFERENCE/);
  assert.match(NEON_NIGHTS_IDENTITY_RETRY_PROMPT, /There is no style-reference picture and no other animal to copy/);
  assert.match(NEON_NIGHTS_IDENTITY_RETRY_PROMPT, /Do not substitute a generic fluffy golden retriever/);
  assert.ok(NEON_NIGHTS_IDENTITY_RETRY_PROMPT.includes(style), 'retry keeps the neon-nights look');
  assert.match(NEON_NIGHTS_IDENTITY_RETRY_PROMPT, /Correct anatomy: exactly one head, exactly two ears, two eyes/);
  assert.match(NEON_NIGHTS_PROMPT, /recognisable likeness of the uploaded photo: the same species and breed, the exact face, face shape, fur colours and markings, eye colour, ear shape and expression/);
  assert.match(NEON_NIGHTS_PROMPT, /Do not replace it with a different or generic animal/);
  assert.match(NEON_NIGHTS_PROMPT, /Keep the pet's exact face, fur colours and markings clear/);
  assert.match(NEON_NIGHTS_PROMPT, /The scene fills the entire canvas edge to edge\. No poster frame, no border, no mat, no white margin and no blank strip on any side/);
  assert.match(NEON_NIGHTS_PROMPT, /The bottom 15 percent stays a calm, darker street, because a name will be written there later\. The pet's body may overlap it, as long as that area stays darker and calm/);
  assert.match(NEON_NIGHTS_PROMPT, /Show only this pet: no people or hands\. If there are several animals in the photo, use only the most prominent one/);
  assert.match(NEON_NIGHTS_PROMPT, /This must be an original artwork: no logos, no brand marks and no trademarked typography/);
  assert.match(NEON_NIGHTS_PROMPT, /No letters, no words, and no numbers anywhere in the image\. No text, no signature, no watermark/);
  const water = await call({ style: 'watercolor', generate: async (p, o) => { opts = o; return { image: dusk, mimeType: 'image/jpeg' }; } });
  assert.strictEqual(opts.style, 'watercolor');
  assert.strictEqual(water.body.background, 'white');
  const moon = await call({ style: 'moonlight', generate: async (p, o) => { opts = o; return { image: dusk, mimeType: 'image/jpeg' }; } });
  assert.strictEqual(opts.style, 'moonlight');
  assert.strictEqual(moon.body.background, 'scene');
  await generatePortrait({ image: Buffer.from('jpg'), mimeType: 'image/jpeg' }, { apiKey: 'k', fetchImpl, style: 'watercolor' });
  assert.strictEqual(sent.contents[0].parts[0].text, WATERCOLOR_PROMPT);
  await generatePortrait({ image: Buffer.from('jpg'), mimeType: 'image/jpeg' }, { apiKey: 'k', fetchImpl, style: 'moonlight' });
  assert.strictEqual(sent.contents[0].parts[0].text, MOONLIGHT_PROMPT);
  await generatePortrait({ image: Buffer.from('jpg'), mimeType: 'image/jpeg' }, { apiKey: 'k', fetchImpl, style: 'northern-night' });
  assert.strictEqual(sent.contents[0].parts[0].text, NORTHERN_NIGHT_PROMPT);
  const vector = await call({ style: 'cubist', generate: async (p, o) => { opts = o; return { image: dusk, mimeType: 'image/jpeg' }; } });
  assert.strictEqual(opts.style, 'vector');
  assert.strictEqual(vector.body.background, 'chroma');
});

test('scene prompts forbid any lettering; watercolor and vector stay as they were', () => {
  const line = 'No artist signatures, watermarks, monograms, logos, captions, or any text or letters anywhere in the image. The customer\'s name is added later by our renderer.';
  assert.strictEqual(SCENE_NO_LETTERING, line);
  for (const prompt of [MOONLIGHT_PROMPT, CHRISTMAS_PROMPT, NORTHERN_NIGHT_PROMPT, NEON_NIGHTS_PROMPT]) {
    assert.ok(prompt.endsWith(line), prompt.slice(-line.length));
    assert.strictEqual(prompt.split(line).length, 2);
  }
  assert.match(MOONLIGHT_PROMPT, /No text, no letters, no signature, no watermark\./);
  assert.match(CHRISTMAS_PROMPT, /No text, no letters, no signature, no watermark\./);
  assert.match(NORTHERN_NIGHT_PROMPT, /No text, no letters, no signature, no watermark\./);
  assert.match(NEON_NIGHTS_PROMPT, /No letters, no words, and no numbers anywhere in the image\./);
  assert.doesNotMatch(WATERCOLOR_PROMPT, /monograms/);
  assert.doesNotMatch(PROMPT, /monograms/);
  assert.match(WATERCOLOR_PROMPT, /No text, no letters, no signature, no watermark\.$/);
  assert.match(PROMPT, /No text, no border, no watermark\.$/);
});

test('portrait model: PORTRAIT_MODEL_NEON_NIGHTS selects neon-nights only, and the default stays', async () => {
  const image = async (env, style) => {
    let url = '';
    const fetchImpl = async (u) => {
      url = u;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: 'eA==' } }] } }] }), { status: 200 });
    };
    await generatePortrait({ image: Buffer.from('jpg'), mimeType: 'image/jpeg' }, { apiKey: 'k', fetchImpl, style, env });
    return url;
  };
  const neonOnly = { PORTRAIT_MODEL_NEON_NIGHTS: 'gemini-3-pro-image' };
  assert.match(await image(neonOnly, 'neon-nights'), /\/models\/gemini-3-pro-image:generateContent$/);
  assert.match(await image(neonOnly, 'watercolor'), new RegExp(`/models/${DEFAULT_MODEL}:generateContent$`));
  assert.match(await image(neonOnly, 'vector'), new RegExp(`/models/${DEFAULT_MODEL}:generateContent$`));
  assert.match(await image(neonOnly, 'moonlight'), new RegExp(`/models/${DEFAULT_MODEL}:generateContent$`));
  assert.match(await image({}, 'neon-nights'), new RegExp(`/models/${DEFAULT_MODEL}:generateContent$`));
  const both = { PORTRAIT_MODEL_NEON_NIGHTS: 'gemini-3-pro-image', GEMINI_IMAGE_MODEL: 'shop-default-model' };
  assert.match(await image(both, 'neon-nights'), /\/models\/gemini-3-pro-image:generateContent$/);
  assert.match(await image(both, 'watercolor'), /\/models\/shop-default-model:generateContent$/);
  assert.match(await image({ PORTRAIT_MODEL_NEON_NIGHTS: '   ' }, 'neon-nights'), new RegExp(`/models/${DEFAULT_MODEL}:generateContent$`));
  assert.strictEqual(DEFAULT_MODEL, 'gemini-2.5-flash-image');
});

test('neon-nights sends the customer photo then the style reference; other styles send one image', async () => {
  const pet = Buffer.from('customer-pet');
  const ref = fs.readFileSync(path.join(__dirname, '../assets/style/neon-nights-ref.jpg'));
  const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: 'eA==' } }] } }] }), { status: 200 });
  async function partsFor(style) {
    let parts;
    const fetchImpl = async (url, init) => { parts = JSON.parse(init.body).contents[0].parts; return ok(); };
    await generatePortrait({ image: pet, mimeType: 'image/jpeg' }, { apiKey: 'k', fetchImpl, style });
    return parts;
  }
  const neon = await partsFor('neon-nights');
  assert.strictEqual(neon.length, 5);
  assert.ok(neon[0].text.startsWith('Draw the animal in the photo labelled THE PET TO DRAW.'));
  assert.strictEqual(neon[1].text, 'THE PET TO DRAW:');
  assert.strictEqual(neon[2].inline_data.mime_type, 'image/jpeg');
  assert.strictEqual(neon[2].inline_data.data, pet.toString('base64'));
  assert.strictEqual(neon[3].text, 'STYLE REFERENCE (technique only):');
  assert.strictEqual(neon[4].inline_data.mime_type, 'image/jpeg');
  assert.strictEqual(neon[4].inline_data.data, ref.toString('base64'));
  let retry;
  const retryFetch = async (url, init) => { retry = JSON.parse(init.body).contents[0].parts; return ok(); };
  await generatePortrait({ image: pet, mimeType: 'image/jpeg' }, { apiKey: 'k', fetchImpl: retryFetch, style: 'neon-nights', omitStyleReference: true });
  assert.strictEqual(retry.length, 3);
  assert.strictEqual(retry[0].text, NEON_NIGHTS_IDENTITY_RETRY_PROMPT);
  assert.strictEqual(retry[1].text, 'THE PET TO DRAW:');
  assert.strictEqual(retry[2].inline_data.data, pet.toString('base64'));
  assert.ok(!retry.some(p => p.inline_data && p.inline_data.data === ref.toString('base64')));
  for (const style of ['vector', 'watercolor', 'moonlight', 'christmas', 'northern-night']) {
    const parts = await partsFor(style);
    assert.strictEqual(parts.length, 2, style);
    assert.strictEqual(parts.filter(p => p.inline_data).length, 1, style);
    assert.strictEqual(parts[1].inline_data.data, pet.toString('base64'), style);
    assert.ok(!parts.some(p => p.text && p.text.includes('STYLE REFERENCE')), style);
    assert.ok(!parts.some(p => p.text && p.text.includes('THE PET TO DRAW')), style);
  }
});

test('neon-nights: a near-copy of the style reference is retried once without it', async () => {
  const ref = fs.readFileSync(path.join(__dirname, '../assets/style/neon-nights-ref.jpg'));
  const other = await sharp({ create: { width: 96, height: 128, channels: 3, background: '#1a3050' } }).png().toBuffer();
  const logs = [];
  let calls = 0;
  let firstPhoto;
  const res = await call({
    style: 'neon-nights',
    log: (event, detail) => logs.push({ event, detail }),
    generate: async (photo, opts) => {
      calls++;
      if (calls === 1) {
        firstPhoto = photo;
        assert.notStrictEqual(opts.omitStyleReference, true);
        return { image: ref, mimeType: 'image/jpeg' };
      }
      assert.strictEqual(opts.omitStyleReference, true);
      assert.strictEqual(opts.style, 'neon-nights');
      assert.ok(photo.image.equals(firstPhoto.image));
      return { image: other, mimeType: 'image/png' };
    }
  });
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(logs.map(l => l.event), ['neon reference copy']);
  assert.ok(logs[0].detail.score <= 36);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.background, 'scene');
  const png = Buffer.from(res.body.image.replace(/^data:image\/png;base64,/, ''), 'base64');
  const verdict = await referenceDistance(png);
  assert.strictEqual(verdict.copy, false);
  const px = await sharp(png).raw().toBuffer();
  assert.ok(px[2] > px[0] && px[2] > 40, 'response is the replacement portrait, not the reference');
});

test('neon-nights: a second near-copy is a retryable error and the reference is not returned', async () => {
  const ref = fs.readFileSync(path.join(__dirname, '../assets/style/neon-nights-ref.jpg'));
  const logs = [];
  let calls = 0;
  const res = await call({
    style: 'neon-nights',
    log: (event, detail) => logs.push({ event, detail }),
    generate: async (photo, opts) => {
      calls++;
      if (calls === 2) assert.strictEqual(opts.omitStyleReference, true);
      return { image: ref, mimeType: 'image/jpeg' };
    }
  });
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(logs.map(l => l.event), ['neon reference copy', 'neon reference copy rejected']);
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.code, 'reference_copy');
  assert.match(res.body.message, /try again/i);
  assert.strictEqual(res.body.image, undefined);
});

test('neon-nights: a near-copy close to the time budget is refused without a second call', async () => {
  const ref = fs.readFileSync(path.join(__dirname, '../assets/style/neon-nights-ref.jpg'));
  const logs = [];
  let calls = 0;
  const res = await call({
    style: 'neon-nights',
    elapsed: 50000,
    log: (event, detail) => logs.push({ event, detail }),
    generate: async () => { calls++; return { image: ref, mimeType: 'image/jpeg' }; }
  });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(logs.map(l => l.event), ['neon reference copy', 'neon reference copy rejected']);
  assert.strictEqual(logs[1].detail.reason, 'budget');
  assert.strictEqual(res.statusCode, 503);
  assert.strictEqual(res.body.code, 'reference_copy');
  assert.strictEqual(res.body.image, undefined);
});

test('neon-nights: a portrait that is not the reference is returned once', async () => {
  const other = await sharp({ create: { width: 90, height: 120, channels: 3, background: '#5a2048' } })
    .png().toBuffer();
  let calls = 0;
  const logs = [];
  const res = await call({
    style: 'neon-nights',
    log: (event) => logs.push(event),
    generate: async () => { calls++; return { image: other, mimeType: 'image/png' }; }
  });
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(logs, []);
  assert.strictEqual(res.statusCode, 200);
});

test('a near-copy of the neon reference is not blocked for other styles', async () => {
  const ref = fs.readFileSync(path.join(__dirname, '../assets/style/neon-nights-ref.jpg'));
  let calls = 0;
  const res = await call({
    style: 'watercolor',
    generate: async (photo, opts) => {
      calls++;
      assert.notStrictEqual(opts.omitStyleReference, true);
      return { image: ref, mimeType: 'image/jpeg' };
    }
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.background, 'white');
});
