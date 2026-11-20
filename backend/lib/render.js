'use strict';
// Production renderer: draws an approved design at the exact Printify print-area size.
// Geometry mirrors the storefront preview (theme/assets/pet-studio.js, drawDesign):
//   pet:  width = pet.w * W, height from the artwork's aspect, centred on (cx*W, cy*H), rotated pet.rot degrees;
//         with pet.fade the alpha falls linearly to 0 over the bottom pet.fade of the artwork height (before rotation)
//   name: font size = name.size * W, centred on cx*W, alphabetic baseline at cy*H + 0.35 * font size,
//         outline width 0.16 * font size drawn under the fill
//   caption (optional lines under the name): same rules per line, line i centred at
//         cy*H + (i - (n-1)/2) * 1.25 * font size, all lines rotated caption.rot around (cx*W, cy*H)
//   mugs (design.sides = 2): W above is one side, round(print width / 2); pet and text are drawn on the left
//         side and again on the right side (offset print width - side width), each cropped to its side.
//         Patterns run across the whole wrap at the scale of one side; gradients and images fill each side.
//   portraits: design.decor (watercolor wash, classic oval, memorial glow) is the shared SVG decorSvg() drawn
//         over the background and under the pet, exactly like the preview.
const crypto = require('node:crypto');
const sharp = require('sharp');
const backgrounds = require('../shared/pet-backgrounds');
const { textPath, measure } = require('./text-path');

const NAME_BASELINE = 0.35;
const NAME_STROKE = 0.16;
// An outline in the fill colour is no visible outline, only a slightly heavier pen line (same rule as the storefront).
const NAME_PEN = 0.03;
const strokeFor = t => (String(t.stroke).toLowerCase() === String(t.fill).toLowerCase() ? NAME_PEN : NAME_STROKE);
const CAPTION_LINE = 1.25;

sharp.cache(false);

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

async function backgroundLayer(bg, W, H, backgroundImage, viewWidth) {
  if (bg.kind === 'image') {
    if (!backgroundImage) throw new Error('background_image_missing');
    return sharp(backgroundImage).resize(W, H, { fit: 'cover', position: 'centre' }).flatten({ background: bg.color || '#ffffff' }).png().toBuffer();
  }
  return sharp(Buffer.from(backgrounds.svg(bg, W, H, viewWidth)), { limitInputPixels: false }).png().toBuffer();
}

/** Mug background: a pattern continues around the wrap; anything else fills each side like the preview. */
async function mugBackground(bg, W, H, PW, backgroundImage) {
  if (bg.kind === 'pattern') return backgroundLayer(bg, W, H, null, 1000 * W / PW);
  const side = await backgroundLayer(bg, PW, H, backgroundImage);
  const right = W - PW === PW ? side : await backgroundLayer(bg, W - PW, H, backgroundImage);
  return sharp({ create: { width: W, height: H, channels: 4, background: '#ffffff' } })
    .composite([{ input: side, left: 0, top: 0 }, { input: right, left: PW, top: 0 }]).png().toBuffer();
}

/** Pet layer cropped to the canvas, so the composite never extends past the print area. */
async function petLayer(design, artwork, W, H) {
  const meta = await sharp(artwork).metadata();
  const pw = Math.max(1, Math.round(design.pet.w * W));
  const ph = Math.max(1, Math.round(pw * meta.height / meta.width));
  let img = sharp(artwork).ensureAlpha().resize(pw, ph, { fit: 'fill', kernel: 'lanczos3' });
  if (design.pet.fade) {
    const mask = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}"><defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="${ph}" gradientUnits="userSpaceOnUse">` +
      `<stop offset="${(1 - design.pet.fade).toFixed(4)}" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>` +
      `<rect width="${pw}" height="${ph}" fill="url(#f)"/></svg>`;
    img = sharp(await img.png().toBuffer()).composite([{ input: Buffer.from(mask), blend: 'dest-in' }]);
  }
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

/** Outlined text: each line is { text, y } (y = line centre in pixels) around a rotation centre cx/cy. */
function textLayer(t, lines, W, H) {
  const size = t.size * W;
  const cx = t.cx * W, cy = t.cy * H;
  const d = lines.map(l => textPath(l.text, t.font, size, cx, l.y + NAME_BASELINE * size).d).join('');
  const rot = t.rot ? ` transform="rotate(${t.rot} ${cx} ${cy})"` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><g${rot}>` +
    `<path d="${esc(d)}" fill="none" stroke="${t.stroke}" stroke-width="${(strokeFor(t) * size).toFixed(2)}" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<path d="${esc(d)}" fill="${t.fill}"/></g></svg>`;
  return { input: Buffer.from(svg), left: 0, top: 0 };
}

function nameLayer(design, W, H) {
  const n = design.name;
  if (!n) return null;
  return textLayer(n, [{ text: n.text, y: n.cy * H }], W, H);
}

function captionLayer(design, W, H) {
  const c = design.caption;
  if (!c || !c.lines || !c.lines.length) return null;
  const size = c.size * W, k = c.lines.length;
  return textLayer(c, c.lines.map((text, i) => ({ text, y: c.cy * H + (i - (k - 1) / 2) * CAPTION_LINE * size })), W, H);
}

/**
 * Renders the print file. Returns { buffer, width, height, format, sha256 }.
 * `format` is 'jpeg' (default, full-bleed blankets have no transparency) or 'png'.
 */
/** Pet, name and caption for a design area W x H whose left edge is at `left` in the print file. */
async function designLayers(design, artwork, W, H, left = 0) {
  const layers = [await petLayer(design, artwork, W, H), nameLayer(design, W, H), captionLayer(design, W, H)].filter(Boolean);
  return layers.map(l => ({ ...l, left: l.left + left }));
}

async function renderDesign({ design, artwork, backgroundImage, width, height, format = 'jpeg', dpi = 150 }) {
  const W = Math.round(width), H = Math.round(height);
  if (!(W > 0 && H > 0)) throw new Error('print_size_missing');
  let base, layers;
  if (design.sides === 2) {
    const PW = Math.round(W / 2);
    base = await mugBackground(design.background, W, H, PW, backgroundImage);
    // The right side is PW wide too (cropped at the print edge when W is odd), so both sides match the preview.
    layers = (await designLayers(design, artwork, PW, H, 0)).concat(await designLayers(design, artwork, PW, H, W - PW));
  } else {
    base = await backgroundLayer(design.background, W, H, backgroundImage);
    layers = await designLayers(design, artwork, W, H);
    if (design.decor) layers.unshift({ input: await sharp(Buffer.from(backgrounds.decorSvg(design.decor, W, H)), { limitInputPixels: false }).png().toBuffer(), left: 0, top: 0 });
  }
  let out = sharp(base, { limitInputPixels: false }).composite(layers).withMetadata({ density: dpi });
  out = format === 'png' ? out.png({ compressionLevel: 6 }) : out.flatten({ background: '#ffffff' }).jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: false });
  const buffer = await out.toBuffer();
  const meta = await sharp(buffer, { limitInputPixels: false }).metadata();
  if (meta.width !== W || meta.height !== H) throw new Error(`render_size_mismatch:${meta.width}x${meta.height}`);
  return { buffer, width: W, height: H, format, sha256: sha256(buffer) };
}

// Heartbeat tee. Every distance is a fraction of the print width, measured from the top.
const TEE_LINE = 0.42;
const TEE_STROKE = 0.0062;
const TEE_NAME_GAP = 0.035;
const TEE_NAME_SIZE = 0.085;
const TEE_NAME_WIDTH = 0.8;
const TEE_INK = { dark: '#1c1a17', white: '#ffffff' };

function teePoints(W, pairs) {
  const y0 = TEE_LINE * W;
  return pairs.map(([fx, dy]) => ({ x: fx * W, y: y0 + dy * W }));
}

/** Left trace (flat, P, QRS, T) and right trace (flat, heart loop, flat). The gap between them holds the pets. */
function teeTraces(W) {
  const left = teePoints(W, [
    [0.045, 0], [0.09, 0],
    [0.105, -0.004], [0.118, -0.016], [0.131, -0.004], [0.148, 0],
    [0.168, 0], [0.176, 0.012], [0.188, -0.062], [0.200, 0.022], [0.214, 0],
    [0.232, -0.003], [0.252, -0.022], [0.272, -0.003], [0.30, 0], [0.34, 0]
  ]);
  const right = teePoints(W, [
    [0.66, 0], [0.755, 0],
    [0.775, -0.012], [0.788, -0.030], [0.802, -0.040], [0.816, -0.026], [0.828, -0.006],
    [0.840, -0.026], [0.854, -0.040], [0.868, -0.030], [0.882, -0.010],
    [0.894, 0.014], [0.908, 0], [0.955, 0]
  ]);
  return { left, right, lineY: TEE_LINE * W };
}

/** Filled ribbon around a polyline. The outer ends taper to a point. */
function taperedRibbon(points, width, { taperStart, taperEnd, taper }) {
  const lens = [0];
  for (let i = 1; i < points.length; i++) lens.push(lens[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  const total = lens[lens.length - 1] || 1;
  const left = [], right = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
    let tx = next.x - prev.x, ty = next.y - prev.y;
    const mag = Math.hypot(tx, ty) || 1;
    tx /= mag; ty /= mag;
    let scale = 1;
    if (taperStart && lens[i] < taper) scale = Math.min(scale, lens[i] / taper);
    if (taperEnd && total - lens[i] < taper) scale = Math.min(scale, (total - lens[i]) / taper);
    const hw = (width / 2) * scale;
    left.push([points[i].x + (-ty) * hw, points[i].y + tx * hw]);
    right.push([points[i].x - (-ty) * hw, points[i].y - tx * hw]);
  }
  const poly = left.concat(right.reverse());
  return poly.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join('') + 'Z';
}

function teeNameSize(text, font, W) {
  let size = TEE_NAME_SIZE * W;
  const width = measure(text, font, size);
  const limit = TEE_NAME_WIDTH * W;
  if (width > limit) size *= limit / width;
  return size;
}

/**
 * Transparent print file for the heartbeat tee. Pets sit in the gap in the line;
 * the pet nearest the centre is drawn last, so it is in front.
 */
async function renderTee({ design, pets = [], width, height }) {
  const W = Math.round(width), H = Math.round(height);
  if (!(W > 0 && H > 0)) throw new Error('print_size_missing');
  const ink = TEE_INK[design.ink] || TEE_INK.dark;
  const { left, right, lineY } = teeTraces(W);
  const stroke = TEE_STROKE * W;
  const taper = 0.035 * W;
  const ribbon = taperedRibbon(left, stroke, { taperStart: true, taperEnd: false, taper })
    + taperedRibbon(right, stroke, { taperStart: false, taperEnd: true, taper });
  const layers = [{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><path d="${ribbon}" fill="${ink}"/></svg>`), left: 0, top: 0 }];
  const gap0 = 0.36 * W, gap1 = 0.64 * W;
  const n = pets.length;
  const placed = [];
  for (let i = 0; i < n; i++) {
    const meta = await sharp(pets[i]).metadata();
    const slot = (gap1 - gap0) / n;
    const pw = Math.max(1, Math.round(Math.min(slot * 1.2, 0.26 * W)));
    const ph = Math.max(1, Math.round(pw * (meta.height || 1) / (meta.width || 1)));
    const buf = await sharp(pets[i]).ensureAlpha().resize(pw, ph, { fit: 'fill' }).png().toBuffer();
    const cx = gap0 + slot * (i + 0.5);
    placed.push({ buf, cx, pw, ph, i });
  }
  const center = placed.reduce((best, p) => (Math.abs(p.cx - W / 2) < Math.abs(best.cx - W / 2) ? p : best), placed[0]);
  for (const p of placed.filter(p => p !== center).concat(center || [])) {
    layers.push({ input: p.buf, left: Math.round(p.cx - p.pw / 2), top: Math.round(lineY - p.ph) });
  }
  let nameSize = 0;
  if (design.name && design.name.text) {
    nameSize = teeNameSize(design.name.text, design.name.font || 'dancingscript', W);
    const baseline = lineY + TEE_NAME_GAP * W + nameSize * 0.8;
    const { d } = textPath(design.name.text, design.name.font || 'dancingscript', nameSize, W / 2, baseline);
    layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><path d="${d}" fill="${ink}"/></svg>`), left: 0, top: 0 });
  }
  const base = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const buffer = await sharp(base, { limitInputPixels: false }).composite(layers).withMetadata({ density: 300 }).png().toBuffer();
  const meta = await sharp(buffer, { limitInputPixels: false }).metadata();
  if (meta.width !== W || meta.height !== H) throw new Error(`render_size_mismatch:${meta.width}x${meta.height}`);
  return { buffer, width: W, height: H, format: 'png', sha256: sha256(buffer), nameSize };
}

module.exports = { renderDesign, renderTee, sha256, NAME_BASELINE, NAME_STROKE, CAPTION_LINE, TEE_LINE, TEE_STROKE, TEE_NAME_GAP, TEE_NAME_SIZE, TEE_NAME_WIDTH };
