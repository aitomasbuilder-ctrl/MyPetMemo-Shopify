'use strict';
// Production renderer: draws an approved design at the exact Printify print-area size.
// Geometry mirrors the storefront preview (theme/assets/pet-studio.js, drawDesign):
//   pet:  width = pet.w * W, height from the artwork's aspect, centred on (cx*W, cy*H), rotated pet.rot degrees
//   name: font size = name.size * W, centred on cx*W, alphabetic baseline at cy*H + 0.35 * font size,
//         outline width 0.16 * font size drawn under the fill
const crypto = require('node:crypto');
const sharp = require('sharp');
const backgrounds = require('../shared/pet-backgrounds');
const { textPath } = require('./text-path');

const NAME_BASELINE = 0.35;
const NAME_STROKE = 0.16;

sharp.cache(false);

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

async function backgroundLayer(bg, W, H, backgroundImage) {
  if (bg.kind === 'image') {
    if (!backgroundImage) throw new Error('background_image_missing');
    return sharp(backgroundImage).resize(W, H, { fit: 'cover', position: 'centre' }).flatten({ background: bg.color || '#ffffff' }).png().toBuffer();
  }
  return sharp(Buffer.from(backgrounds.svg(bg, W, H)), { limitInputPixels: false }).png().toBuffer();
}

/** Pet layer cropped to the canvas, so the composite never extends past the print area. */
async function petLayer(design, artwork, W, H) {
  const meta = await sharp(artwork).metadata();
  const pw = Math.max(1, Math.round(design.pet.w * W));
  const ph = Math.max(1, Math.round(pw * meta.height / meta.width));
  let img = sharp(artwork).ensureAlpha().resize(pw, ph, { fit: 'fill', kernel: 'lanczos3' });
  if (design.pet.rot) img = sharp(await img.png().toBuffer()).rotate(design.pet.rot, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
  const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
  const left = Math.round(design.pet.cx * W - info.width / 2);
  const top = Math.round(design.pet.cy * H - info.height / 2);
  const x0 = Math.max(0, left), y0 = Math.max(0, top);
  const x1 = Math.min(W, left + info.width), y1 = Math.min(H, top + info.height);
  if (x1 <= x0 || y1 <= y0) return null;
  const input = (x0 === left && y0 === top && x1 - x0 === info.width && y1 - y0 === info.height)
    ? data
    : await sharp(data).extract({ left: x0 - left, top: y0 - top, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
  return { input, left: x0, top: y0 };
}

function nameLayer(design, W, H) {
  const n = design.name;
  if (!n) return null;
  const size = n.size * W;
  const cx = n.cx * W, cy = n.cy * H;
  const { d } = textPath(n.text, n.font, size, cx, cy + NAME_BASELINE * size);
  const rot = n.rot ? ` transform="rotate(${n.rot} ${cx} ${cy})"` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><g${rot}>` +
    `<path d="${esc(d)}" fill="none" stroke="${n.stroke}" stroke-width="${(NAME_STROKE * size).toFixed(2)}" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="${esc(d)}" fill="${n.fill}"/></g></svg>`;
  return { input: Buffer.from(svg), left: 0, top: 0 };
}

/**
 * Renders the print file. Returns { buffer, width, height, format, sha256 }.
 * `format` is 'jpeg' (default, full-bleed blankets have no transparency) or 'png'.
 */
async function renderDesign({ design, artwork, backgroundImage, width, height, format = 'jpeg', dpi = 150 }) {
  const W = Math.round(width), H = Math.round(height);
  if (!(W > 0 && H > 0)) throw new Error('print_size_missing');
  const base = await backgroundLayer(design.background, W, H, backgroundImage);
  const layers = [];
  const pet = await petLayer(design, artwork, W, H);
  if (pet) layers.push(pet);
  const name = nameLayer(design, W, H);
  if (name) layers.push(name);
  let out = sharp(base, { limitInputPixels: false }).composite(layers).withMetadata({ density: dpi });
  out = format === 'png' ? out.png({ compressionLevel: 6 }) : out.flatten({ background: '#ffffff' }).jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: false });
  const buffer = await out.toBuffer();
  const meta = await sharp(buffer, { limitInputPixels: false }).metadata();
  if (meta.width !== W || meta.height !== H) throw new Error(`render_size_mismatch:${meta.width}x${meta.height}`);
  return { buffer, width: W, height: H, format, sha256: sha256(buffer) };
}

module.exports = { renderDesign, sha256, NAME_BASELINE, NAME_STROKE };
