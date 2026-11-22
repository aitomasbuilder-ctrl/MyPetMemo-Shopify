'use strict';
const fs = require('fs');
const path = require('path');
// Turns a customer's pet photo into the MyPetMemo vector-style portrait with Google Gemini.
// The pet comes back on a flat chroma-green background; the storefront keys that out and puts the
// pet on whichever pastel background the shopper picks, so changing the background never re-generates.
// The watercolor style is painted on plain white instead: its soft edges and splashes can't be keyed
// out of green, so the storefront turns the white paper transparent (see whiteToAlpha in pet-studio.js).

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-2.5-flash-image';
const CHROMA = '#00FF00';
// Scene paintings must not invent lettering. The shopper's name is drawn afterwards by the print renderer.
const SCENE_NO_LETTERING = 'No artist signatures, watermarks, monograms, logos, captions, or any text or letters anywhere in the image. The customer\'s name is added later by our renderer.';

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

const WATERCOLOR_PROMPT = [
  'Turn the pet in this photo into a realistic watercolor painting.',
  'Keep this exact animal: the same breed, face shape, markings, fur colors and pattern, eye color, ear shape,',
  'expression and head angle. Do not replace it with a different or generic animal.',
  'Style: a realistic, finely detailed watercolor painting, as a skilled watercolor artist would paint it from the photo:',
  'the eyes, nose, mouth and fur are painted with true-to-life detail, shading and soft fur texture.',
  'Not a cartoon, not a flat illustration, no outlines.',
  'Toward the outer edges the painting breaks up into loose watercolor: soft wet-in-wet washes, irregular paint blots and blooms,',
  'and scattered spatter dots of different sizes in the pet\'s own fur colors (darker and lighter shades), so the outline of the pet',
  'dissolves organically into the white paper instead of ending in a clean edge.',
  'Composition: head, chest and shoulders, large and centered, facing the viewer as in the photo. The painting fills about',
  '85 percent of the image height and 75 percent of the width; at the bottom the chest fades out into loose washes and spatter.',
  'Remove the original background completely: the background is plain pure white (#FFFFFF) with no paper texture, shadow or frame.',
  'Show only the animal: leave out blankets, scarves, pillows, furniture, toys, hands and people that touch or cover it,',
  'and paint the fur that would be underneath. Keep only a collar, tag, harness or bandana the pet is actually wearing.',
  'If there are several animals, portray only the most prominent one. No text, no letters, no signature, no watermark.'
].join(' ');

const MOONLIGHT_PROMPT = [
  'Create a dreamy memorial painting of the pet in this photo, in the moonlight.',
  'Keep this exact animal: the same species and breed, face shape, markings, fur colors and pattern, eye color, ear shape and',
  'expression. Do not replace it with a different or generic animal, and keep it the same animal in both places below.',
  'Scene, in a tall portrait format: a deep navy night sky with soft clouds. Upper left: a large, bright full moon with a warm golden glow.',
  'Upper right and centre: the same pet painted very large in the sky, head and chest only, soft, luminous and slightly translucent,',
  'looking gently toward the moon, as if watching over from the stars. Lower half: the same pet, full body, smaller, standing on',
  'a rocky cliff ledge at the lower left, looking up at the sky. A swirling trail of tiny golden sparkles and stardust spirals up',
  'from the pet on the cliff around the pet in the sky. Background below: misty mountains, dark pine forest silhouettes and a small',
  'waterfall, with warm golden moonlight on the horizon. Keep the lower right quarter calm and fairly dark, with no important details,',
  'because a name will be written there later.',
  'Style: a rich, painterly digital painting with soft glow, fine fur detail and a deep navy and warm gold palette.',
  'The painting fills the entire image edge to edge: no border, no frame, no white margin, no blanket or product mockup.',
  'Show only animals of this pet: no people or hands. If there are several animals in the photo, use only the most prominent one.',
  'No text, no letters, no signature, no watermark.',
  SCENE_NO_LETTERING
].join(' ');

const CHRISTMAS_PROMPT = [
  'Create a cozy, funny Christmas painting starring the pet in this photo.',
  'Keep this exact animal: the same species and breed, face shape, markings, fur colors and pattern, eye color, ear shape and',
  'expression. Do not replace it with a different or generic animal.',
  'Scene, in a tall portrait format: a warm living room on Christmas Eve. The pet is the big star in the centre, seen from the',
  'chest up to a full sitting pose, wearing a chunky hand-knitted Christmas sweater and a slightly too big Santa hat that flops over',
  'one ear. It is cheekily caught in the act: tangled in a string of glowing warm fairy lights, with cookie crumbs on its whiskers,',
  'next to a plate of Christmas cookies with one big bite missing and a mug of hot cocoa with marshmallows. Behind it: a decorated',
  'Christmas tree with one ornament knocked over, a crackling fireplace with knitted stockings, wrapped presents, and a window with',
  'gently falling snow. The look is joyful and funny, never scary.',
  'The bottom fifth of the picture is a calm, dark red knitted rug with no objects on it, because a name will be written there later.',
  'Style: a rich, painterly digital painting, soft warm candle and fairy-light glow, fine fur detail, a red, green, gold and cream palette.',
  'The painting fills the entire image edge to edge: no border, no frame, no white margin, no blanket or product mockup.',
  'Show only this pet: no people or hands. If there are several animals in the photo, use only the most prominent one.',
  'No text, no letters, no signature, no watermark.',
  SCENE_NO_LETTERING
].join(' ');

const NORTHERN_NIGHT_PROMPT = [
  'Create a premium, magical "Northern Night" painting of the pet in this photo.',
  'Keep this exact animal: the same species and breed, face shape, markings, fur colors and pattern, eye color, ear shape and',
  'expression. Do not replace it with a different or generic animal, and keep it the same animal in both places below.',
  'Scene, in a tall portrait format: a deep starry midnight-blue sky full of tiny stars.',
  'Upper left and centre: the pet painted very large, head and chest only, photorealistic with fine, natural fur detail and',
  'bright, lifelike eyes, softly lit by the moon and blending gently into the night sky at its lower edge.',
  'Upper right: a glowing golden crescent moon. Behind and beside the large pet: flowing emerald green and violet northern lights.',
  'Lower half: snow-capped mountains and frosted pine forest under the aurora, and the same pet, full body and much smaller,',
  'standing on a snowy cliff ledge at the lower left of centre, looking up at the moon.',
  'Thin trails of glowing gold stardust curve through the scene from the small pet up around the large pet.',
  'Keep the lower right area calm and fairly dark (night sky and soft snowy hills, no important details),',
  'because a name will be written there later.',
  'Style: a rich, premium, photorealistic digital painting with a soft glow; palette of deep navy, midnight blue, emerald, violet',
  'and warm gold. The painting fills the entire image edge to edge: no border, no frame, no white margin, no room, no furniture,',
  'no blanket or product mockup. Show only animals of this pet: no people or hands. If there are several animals in the photo,',
  'use only the most prominent one. No text, no letters, no signature, no watermark.',
  SCENE_NO_LETTERING
].join(' ');

const NEON_NIGHTS_REFERENCE = path.join(__dirname, '..', 'assets', 'style', 'neon-nights-ref.jpg');
let neonNightsReference;
function neonNightsStyleImage() {
  if (!neonNightsReference) neonNightsReference = fs.readFileSync(NEON_NIGHTS_REFERENCE);
  return neonNightsReference;
}

// The approved Neon Nights look, described in words. The style-reference photo is
// technique only; these lines are what keep the framing, ink and street when that
// photo is left out.
const NEON_NIGHTS_LOOK = [
  'Hand-drawn digital poster illustration in a premium graphic-novel / high-end print style.',
  'The pet is a three-quarter view, chest-up, large and filling the frame, with a happy expression (for dogs, mouth open with tongue out if it suits the photo).',
  'The pet\'s body continues naturally down and out of the bottom edge of the frame. Shoulders and chest are cropped by the frame edge, never ending in a point, a cut-out shape, a sticker outline or a fade. The pet sits in the street scene, lit by the sunset and the neon, not pasted on top of it.',
  'It wears black sunglasses with orange-to-magenta mirrored reflections of palms and sunset, and a heavy polished gold chain.',
  'Fur is drawn as bold stylised clumps with confident hand-inked dark linework and hard-edged shadow shapes.',
  'Not soft airbrushed fur, not photoreal, and it must not look AI-generated.',
  'Keep the pet\'s true fur colours, but render them deep and rich, with warm burnt-orange or deep shadows and magenta-purple reflected light on the shaded side.',
  'Very high contrast, deep saturated colours, inky dark purples in the shadows.',
  'Background: a deep violet and electric magenta sky with streaky clouds, a blazing orange sunset glow low on the horizon, black palm tree silhouettes on both sides, and a neon city street with intense pink and violet glow and a dark wet reflective road.',
  'Building signs are plain glowing neon tubes and rectangles with no characters or symbols.'
];
const NEON_NIGHTS_ANATOMY = 'Correct anatomy: exactly one head, exactly two ears, two eyes, one nose, one mouth. No duplicated ears or features, no extra limbs. The sunglasses sit on the face; the ears stay above or behind them and are not repeated.';
const NEON_NIGHTS_CLOSING = [
  'The pet must stay a recognisable likeness of the uploaded photo: the same species and breed, the exact face, face shape, fur colours and markings, eye colour, ear shape and expression. Do not replace it with a different or generic animal.',
  'Keep the pet\'s exact face, fur colours and markings clear.',
  'The scene fills the entire canvas edge to edge. No poster frame, no border, no mat, no white margin and no blank strip on any side.',
  'The bottom 15 percent stays a calm, darker street, because a name will be written there later. The pet\'s body may overlap it, as long as that area stays darker and calm.',
  'Show only this pet: no people or hands. If there are several animals in the photo, use only the most prominent one.',
  'This must be an original artwork: no logos, no brand marks and no trademarked typography.',
  'No letters, no words, and no numbers anywhere in the image. No text, no signature, no watermark.',
  SCENE_NO_LETTERING
];

const NEON_NIGHTS_PROMPT = [
  'Draw the animal in the photo labelled THE PET TO DRAW. Identify its exact species and breed (for example Shiba Inu, beagle, Labrador or tabby cat) and draw THAT breed: its own head shape, muzzle length, ear shape, coat length and texture, and markings. If the pet is short-coated, keep it short-coated. Do not replace it with the dog in the style reference.',
  'The photo labelled STYLE REFERENCE (technique only) is not an animal to draw. Do not copy its dog, breed, face, fluffy coat, expression, pose, framing or composition. Its dog\'s breed, fluffy coat and face shape must NOT appear unless they are already in THE PET TO DRAW.',
  NEON_NIGHTS_ANATOMY,
  'Render the pet\'s true fur colours deep, saturated and high-contrast: rich mid-tones, dark inky shadows, magenta-violet reflected light. Never pale or washed out.',
  'Use the style reference for technique only: hand-inked linework, colour palette, lighting, level of fur detail, sunglasses-and-gold-chain styling and the neon-street mood. Do not copy any lettering from the reference signs. Do not match the reference picture\'s composition.',
  ...NEON_NIGHTS_LOOK,
  ...NEON_NIGHTS_CLOSING
].join(' ');

// Used once, and only after a near-copy of the style reference was detected.
// The reference image is not sent with this prompt, so it must not point at one.
const NEON_NIGHTS_IDENTITY_RETRY_PROMPT = [
  'Draw only the animal in the photo labelled THE PET TO DRAW. That photo is the only image. There is no style-reference picture and no other animal to copy.',
  'Identify its exact species and breed and draw THAT breed: its own head shape, muzzle length, ear shape, coat length and texture, and markings. If the pet is short-coated, keep it short-coated. Do not substitute a generic fluffy golden retriever. A cream, yellow or Labrador-type dog stays the dog in the photo: its own muzzle, ear set, coat length and markings.',
  NEON_NIGHTS_ANATOMY,
  'Render the pet\'s true fur colours deep, saturated and high-contrast: rich mid-tones, dark inky shadows, magenta-violet reflected light. Never pale or washed out.',
  ...NEON_NIGHTS_LOOK,
  ...NEON_NIGHTS_CLOSING
].join(' ');

/** Art styles the service paints. `background` tells the storefront how to cut the pet out. */
const STYLES = {
  vector: { prompt: PROMPT, background: 'chroma', aspectRatio: '1:1' },
  // Portrait format: head, chest and the loose washes below it, for a large painting on the blanket.
  watercolor: { prompt: WATERCOLOR_PROMPT, background: 'white', aspectRatio: '3:4' },
  // A whole painted picture that covers the blanket (memorial "moonlight" design); nothing is cut out.
  moonlight: { prompt: MOONLIGHT_PROMPT, background: 'scene', aspectRatio: '3:4' },
  // A whole cozy Christmas Eve picture for the Christmas blanket.
  christmas: { prompt: CHRISTMAS_PROMPT, background: 'scene', aspectRatio: '3:4' },
  // E23: premium night sky with crescent moon, northern lights and the pet twice (Northern Night blanket).
  'northern-night': { prompt: NORTHERN_NIGHT_PROMPT, background: 'scene', aspectRatio: '3:4' },
  // Hand-drawn full-bleed poster: graphic-novel pet, sunset, palms and a wet neon street.
  'neon-nights': { prompt: NEON_NIGHTS_PROMPT, background: 'scene', aspectRatio: '3:4' }
};
const styleFor = name => STYLES[name] || STYLES.vector;

class PortraitError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}

// PORTRAIT_MODEL_<STYLE> (hyphens become underscores, so PORTRAIT_MODEL_NEON_NIGHTS).
// Unset, the style uses GEMINI_IMAGE_MODEL or gemini-2.5-flash-image. The default is unchanged.
function modelFor(styleName, env = process.env) {
  const key = `PORTRAIT_MODEL_${String(styleName || '').toUpperCase().replace(/-/g, '_')}`;
  const specific = String(env[key] || '').trim();
  if (specific) return specific;
  return env.GEMINI_IMAGE_MODEL || DEFAULT_MODEL;
}

/**
 * @param {{ image: Buffer, mimeType: string }} photo
 * @param {{ style?: string, apiKey?: string, model?: string, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, signal?: AbortSignal }} opts
 * @returns {Promise<{ image: Buffer, mimeType: string }>}
 */
async function generatePortrait(photo, opts = {}) {
  const env = opts.env || process.env;
  const apiKey = opts.apiKey || env.GEMINI_API_KEY;
  if (!apiKey) throw new PortraitError('not_configured', 'Our portrait service isn’t connected yet. Please try again later.', 503);
  const styleName = STYLES[opts.style] ? opts.style : 'vector';
  const model = opts.model || modelFor(styleName, env);
  const doFetch = opts.fetchImpl || fetch;
  const style = styleFor(styleName);
  const neon = styleName === 'neon-nights';
  // omitStyleReference is the one retry after a near-copy of the style image.
  // The portrait handler asks for it; the reference bytes are left out.
  const omitReference = neon && opts.omitStyleReference === true;
  const requestParts = [
    { text: omitReference ? NEON_NIGHTS_IDENTITY_RETRY_PROMPT : style.prompt }
  ];
  // The pet and the style image are labelled separately so the model cannot treat
  // the reference dog as the animal to draw. Other styles stay prompt plus one photo.
  if (neon) requestParts.push({ text: 'THE PET TO DRAW:' });
  requestParts.push({ inline_data: { mime_type: photo.mimeType, data: photo.image.toString('base64') } });
  if (neon && !omitReference) {
    requestParts.push(
      { text: 'STYLE REFERENCE (technique only):' },
      { inline_data: { mime_type: 'image/jpeg', data: neonNightsStyleImage().toString('base64') } }
    );
  }
  const body = {
    contents: [{ role: 'user', parts: requestParts }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: style.aspectRatio } }
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

module.exports = { generatePortrait, PortraitError, PROMPT, WATERCOLOR_PROMPT, MOONLIGHT_PROMPT, CHRISTMAS_PROMPT, NORTHERN_NIGHT_PROMPT, NEON_NIGHTS_PROMPT, NEON_NIGHTS_IDENTITY_RETRY_PROMPT, SCENE_NO_LETTERING, STYLES, styleFor, modelFor, CHROMA, DEFAULT_MODEL };
