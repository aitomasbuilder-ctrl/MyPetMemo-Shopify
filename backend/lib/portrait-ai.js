'use strict';
// Turns a customer's pet photo into the MyPetMemo vector-style portrait with Google Gemini.
// The pet comes back on a flat chroma-green background; the storefront keys that out and puts the
// pet on whichever pastel background the shopper picks, so changing the background never re-generates.

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const CHROMA = '#00FF00';

const PROMPT = [
  'Turn the pet in this photo into a modern illustrated pet portrait.',
  'Keep this exact animal: the same breed, face shape, markings, fur colors and pattern, eye color, ear shape,',
  'expression and head angle, and keep any collar, tag or bandana it is wearing. Do not replace it with a different or generic animal.',
  'Style: clean flat vector illustration with crisp sharp edges, built from layered flat color shapes for the fur,',
  'highlights and shadows (3 to 5 tones per color area), detailed eyes with catchlights, detailed nose, mouth and ears.',
  'No outlines, no paper or brush texture, no gradients, no painterly strokes.',
  'Composition: head and upper chest only, centered, facing the viewer as in the photo, with even empty margins around the pet',
  'and a little more space below the chest.',
  `Remove the original background completely. Place the pet on a perfectly flat, solid pure green background (${CHROMA}),`,
  'with no shadow, vignette, floor or other objects, and do not use that green anywhere on the pet.',
  'Show only the animal: leave out blankets, pillows, furniture, toys, hands and people that touch or cover it,',
  'and draw the chest fur that would be underneath. Keep only a collar, tag, harness or bandana the pet is actually wearing.',
  'If there are several animals, portray only the most prominent one. No text, no border, no watermark.'
].join(' ');

class PortraitError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

/**
 * @param {{ image: Buffer, mimeType: string }} photo
 * @param {{ apiKey?: string, model?: string, fetchImpl?: typeof fetch, signal?: AbortSignal }} opts
 * @returns {Promise<{ image: Buffer, mimeType: string }>}
 */
async function generatePortrait(photo, opts = {}) {
  const apiKey = opts.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new PortraitError('not_configured', 'Our portrait service isn’t connected yet. Please try again later.', 503);
  const model = opts.model || process.env.GEMINI_IMAGE_MODEL || DEFAULT_MODEL;
  const doFetch = opts.fetchImpl || fetch;
  const body = {
    contents: [{ role: 'user', parts: [{ text: PROMPT }, { inline_data: { mime_type: photo.mimeType, data: photo.image.toString('base64') } }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } }
  };
  const res = await doFetch(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: opts.signal
  });
  if (res.status === 429) throw new PortraitError('busy', 'Lots of people are designing right now. Please wait a minute and try again.', 429);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error('gemini failed', res.status, detail.slice(0, 500));
    throw new PortraitError('upstream_error', 'Our portrait service had a hiccup. Please try again.', 502);
  }
  const json = await res.json();
  const candidate = (json.candidates || [])[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  const out = parts.map(p => p.inlineData || p.inline_data).find(d => d && d.data);
  if (!out) {
    const blocked = (json.promptFeedback && json.promptFeedback.blockReason) || (candidate && candidate.finishReason);
    console.warn('gemini returned no image', blocked);
    throw new PortraitError('no_pet', 'We couldn’t find a pet in that photo. Please use a clear photo with one pet and its face visible.', 422);
  }
  return { image: Buffer.from(out.data, 'base64'), mimeType: out.mimeType || out.mime_type || 'image/png' };
}

module.exports = { generatePortrait, PortraitError, PROMPT, CHROMA, DEFAULT_MODEL };
