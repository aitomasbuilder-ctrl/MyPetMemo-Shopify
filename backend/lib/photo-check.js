'use strict';
// Server-side check of a customer's pet photo BEFORE any paid AI step runs.
// Returns { ok, errors:[{code,message}], warnings:[{code,message}], info }.
// errors block the upload; warnings let the customer continue or retake.
const sharp = require('sharp');

const MAX_BYTES = 15 * 1024 * 1024;
const MIN_SIDE_ERROR = 500;   // below this the print would be pixelated
const MIN_SIDE_WARN = 1000;
const BLUR_ERROR = 40, BLUR_WARN = 120;   // variance of Laplacian on a 512px greyscale copy
const DARK_ERROR = 35, DARK_WARN = 70;    // mean luminance 0-255

function sniff(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.slice(4, 8).toString() === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1)/.test(buf.slice(8, 12).toString())) return 'heic';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp'; // accepted internally (browser re-encodes)
  return null;
}

const MSG = {
  type: 'Please upload a JPG, PNG or HEIC photo.',
  size: 'This photo is larger than 15 MB. Please choose a smaller file.',
  small: 'This photo is too small and would print pixelated. Please upload a larger original (at least 1000 px wide).',
  smallWarn: 'This photo is on the small side. The print may look soft; a larger original is better.',
  blur: 'This photo looks blurry. Please upload a sharper photo taken in good light.',
  blurWarn: 'This photo may be slightly blurry. A sharper photo gives a better portrait.',
  dark: 'This photo is too dark. Please use a photo taken in bright, natural light.',
  darkWarn: 'This photo is fairly dark. Brighter light gives a better portrait.'
};

async function checkPhoto(buf) {
  const errors = [], warnings = [], info = {};
  if (buf.length > MAX_BYTES) errors.push({ code: 'file_too_large', message: MSG.size });
  const kind = sniff(buf);
  info.format = kind;
  if (!kind) { errors.push({ code: 'unsupported_type', message: MSG.type }); return { ok: false, errors, warnings, info }; }
  if (kind === 'heic') { // HEIC is accepted, but decoded by the converter step, not here
    info.needs_conversion = true;
    return { ok: errors.length === 0, errors, warnings, info };
  }
  let img;
  try { img = sharp(buf, { failOn: 'error' }); info.width = (await img.metadata()).width; info.height = (await img.metadata()).height; }
  catch { errors.push({ code: 'corrupt_image', message: MSG.type }); return { ok: false, errors, warnings, info }; }
  const side = Math.min(info.width, info.height);
  if (side < MIN_SIDE_ERROR) errors.push({ code: 'too_small', message: MSG.small });
  else if (side < MIN_SIDE_WARN) warnings.push({ code: 'small', message: MSG.smallWarn });

  const { data, info: d } = await sharp(buf).rotate().resize(512, 512, { fit: 'inside' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sum = 0; for (const v of data) sum += v;
  info.brightness = Math.round(sum / data.length);
  if (info.brightness < DARK_ERROR) errors.push({ code: 'too_dark', message: MSG.dark });
  else if (info.brightness < DARK_WARN) warnings.push({ code: 'dark', message: MSG.darkWarn });

  // Variance of the Laplacian: low = few sharp edges = blurry.
  const w = d.width, h = d.height; let n = 0, s1 = 0, s2 = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const l = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w];
    n++; s1 += l; s2 += l * l;
  }
  info.sharpness = Math.round(s2 / n - (s1 / n) ** 2);
  if (info.sharpness < BLUR_ERROR) errors.push({ code: 'blurry', message: MSG.blur });
  else if (info.sharpness < BLUR_WARN) warnings.push({ code: 'maybe_blurry', message: MSG.blurWarn });
  // NOTE: "several pets" cannot be detected with pixel statistics; it is checked by the AI vision step.
  return { ok: errors.length === 0, errors, warnings, info };
}
module.exports = { checkPhoto, sniff, MAX_BYTES };
