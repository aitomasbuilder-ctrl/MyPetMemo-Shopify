'use strict';
// POST /api/portrait — the pet studio's "Portrait generation URL".
// Body: multipart form with `image` (the shopper's pet photo) and optional `style` (`watercolor`, `moonlight`, `christmas`, `northern-night` or `neon-nights`;
// anything else is the vector style); `product` and `shape` are accepted and ignored.
// Response: { image: data URL, background: 'chroma' (vector, on flat green), 'white' (watercolor, on white paper)
// or 'scene' (moonlight, christmas, northern-night, neon-nights: a whole picture, nothing cut out) }.
const sharp = require('sharp');
const { generatePortrait, PortraitError, STYLES, styleFor } = require('../lib/portrait-ai');
const { trimSceneBorder, thickSceneBar, cropThickSceneBorder } = require('../lib/scene-trim');
const { referenceDistance } = require('../lib/reference-copy');
const { cors, send, limiter, clientIp } = require('../lib/http');

const MAX_UPLOAD = 15 * 1024 * 1024;
const allow = limiter({ max: Number(process.env.PORTRAITS_PER_HOUR || 20), windowMs: 3600e3 });
// api/portrait maxDuration is 60s. One extra Gemini call is about 10s; leave a few seconds to trim and reply.
const PORTRAIT_BUDGET_MS = 60000;
const RETRY_CALL_MS = 10000;
const RETRY_TAIL_MS = 8000;
// pet-studio.js shows `message` and a Retry button for every status except 422 and 413.
const REFERENCE_COPY_MESSAGE = 'We couldn’t lock onto your pet this time. Please try again.';

function elapsedMs(started, deps) {
  return Number.isFinite(deps.elapsed) ? deps.elapsed : Date.now() - started;
}

function withinBudget(started, deps) {
  return elapsedMs(started, deps) + RETRY_CALL_MS + RETRY_TAIL_MS <= PORTRAIT_BUDGET_MS;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** Crop a blank edge. A bar too thick to crop becomes the existing retryable border error. */
async function settleSceneBorder(source, style, log) {
  source = (await trimSceneBorder(source)).buffer;
  const still = await thickSceneBar(source);
  if (!still) return source;
  const cropped = await cropThickSceneBorder(source);
  const detail = barDetail(style, still);
  if (!cropped) {
    log('scene border rejected', detail);
    throw new PortraitError('border', 'The portrait came back with a blank strip along the edge. Please try again.', 502);
  }
  log('scene border crop', detail);
  return cropped.buffer;
}

function rejectReferenceCopy(log, score, extra) {
  log('neon reference copy rejected', { score: round1(score), ...extra });
  throw new PortraitError('reference_copy', REFERENCE_COPY_MESSAGE, 503);
}

function barDetail(style, bar) {
  return {
    style,
    sides: bar.sides,
    left: bar.left,
    right: bar.right,
    top: bar.top,
    bottom: bar.bottom,
    width: bar.width,
    height: bar.height
  };
}

async function readPhoto(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_UPLOAD) throw new PortraitError('too_large', 'That photo is too large. Please choose a smaller one.', 413); chunks.push(c); }
  let form;
  try {
    form = await new Request('http://local/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] || '' }, body: Buffer.concat(chunks) }).formData();
  } catch { throw new PortraitError('bad_request', 'That photo couldn’t be processed. Please try a different one.', 400); }
  const file = form.get('image');
  if (!file || typeof file.arrayBuffer !== 'function') throw new PortraitError('bad_request', 'Please choose a photo of your pet.', 400);
  // Re-encode: checks it really is an image, applies phone rotation and keeps the AI request small.
  try {
    const image = await sharp(Buffer.from(await file.arrayBuffer())).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    const style = String(form.get('style') || '');
    return { image, mimeType: 'image/jpeg', style: STYLES[style] ? style : 'vector' };
  } catch { throw new PortraitError('bad_image', 'That photo couldn’t be processed. Please try a different one.', 400); }
}

async function handler(req, res, deps = {}) {
  const started = Date.now();
  const log = deps.log || ((event, detail) => console.warn(event, JSON.stringify(detail)));
  if (!cors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  if (!allow(clientIp(req))) return send(res, 429, { code: 'rate_limited', message: 'You’ve made a lot of portraits in a short time. Please wait a little and try again.' });
  try {
    const { style, ...photo } = await readPhoto(req);
    const generate = deps.generate || generatePortrait;
    const scene = styleFor(style).background === 'scene';
    const budget = () => withinBudget(started, deps);
    let art = await generate(photo, { style });
    let source = art.image;
    let identityRetried = false;
    // Neon Nights can echo the style-reference dog. Detect that on the model output
    // and, when there is time, draw once more without the reference image.
    // A blank-edge retry still happens for a portrait that is not a copy.
    // The check runs again after the edge trim: a white strip can hide a copy.
    if (style === 'neon-nights') {
      const verdict = await referenceDistance(source);
      if (verdict && verdict.copy) {
        log('neon reference copy', { score: round1(verdict.score) });
        if (!budget()) rejectReferenceCopy(log, verdict.score, { reason: 'budget' });
        art = await generate(photo, { style, omitStyleReference: true });
        source = art.image;
        identityRetried = true;
      }
    }
    if (!identityRetried && scene) {
      const thick = await thickSceneBar(source);
      if (thick) {
        const elapsed = elapsedMs(started, deps);
        const detail = barDetail(style, thick);
        if (budget()) {
          log('scene border retry', detail);
          art = await generate(photo, { style });
          source = art.image;
        } else {
          log('scene border retry skipped', { ...detail, elapsed, reason: 'budget' });
        }
      }
    }
    if (scene) source = await settleSceneBorder(source, style, log);
    if (style === 'neon-nights') {
      const verdict = await referenceDistance(source);
      if (verdict && verdict.copy) {
        if (!identityRetried && budget()) {
          log('neon reference copy', { score: round1(verdict.score) });
          art = await generate(photo, { style, omitStyleReference: true });
          source = await settleSceneBorder(art.image, style, log);
          const again = await referenceDistance(source);
          if (again && again.copy) rejectReferenceCopy(log, again.score);
        } else {
          rejectReferenceCopy(log, verdict.score, identityRetried ? {} : { reason: 'budget' });
        }
      }
    }
    const png = await sharp(source).png().toBuffer();
    return send(res, 200, { image: `data:image/png;base64,${png.toString('base64')}`, background: styleFor(style).background, style });
  } catch (err) {
    if (err instanceof PortraitError) return send(res, err.status, { code: err.code, message: err.message });
    console.error('portrait failed', err);
    return send(res, 500, { code: 'server_error', message: 'Our portrait service had a hiccup. Please try again.' });
  }
}
module.exports = handler;
