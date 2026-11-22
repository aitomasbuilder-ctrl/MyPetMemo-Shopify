'use strict';
// Production renderer: draws an approved design at the exact Printify print-area size.
// Geometry mirrors the storefront preview (theme/assets/pet-studio.js, drawDesign):
//   pet:  width = pet.w * W, height from the artwork's aspect, centred on (cx*W, cy*H), rotated pet.rot degrees;
//         with pet.fade the alpha falls linearly to 0 over the bottom pet.fade of the artwork height (before rotation)
//   name: font size = fittedNameSize * W, centred on cx*W, alphabetic baseline at cy*H + 0.35 * font size,
//         outline width 0.16 * font size drawn under the fill.
//         Scene blankets (the solid colours below): a script name stored at size 0.13 is drawn at 0.11,
//         and every scene name is shrunk so its width is at most 70% of the print width.
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
// Scene blankets fill the print with a painting and write the name on top. These are the solid colours
// the storefront uses for moonlight, christmas, northern-night and neon-nights.
const SCENE_NAME_COLORS = new Set(['#141a2b', '#5b1a1c', '#0b1030', '#1b0b33']);
const SCENE_NAME_MAX_WIDTH = 0.70;
// The northern-night and neon-nights layouts used to request the script face at 0.13, which runs a little wide.
const SCENE_SCRIPT_SIZE = 0.11;
const SCENE_SCRIPT_SIZE_FROM = 0.13;
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

function isSceneDesign(design) {
  const color = design && design.background && String(design.background.color || '').toLowerCase();
  return SCENE_NAME_COLORS.has(color);
}

/** Font size (fraction of print width) actually drawn. Deterministic: same name, font and width, same size. */
function fittedNameSize(name, printWidth, scene) {
  let size = name.size;
  if (scene && name.font === 'msmadi' && Math.abs(size - SCENE_SCRIPT_SIZE_FROM) < 0.0005) size = SCENE_SCRIPT_SIZE;
  if (!scene) return size;
  const natural = measure(name.text, name.font, size * printWidth);
  const max = SCENE_NAME_MAX_WIDTH * printWidth;
  if (natural > max && natural > 0) size *= max / natural;
  return size;
}

function nameLayer(design, W, H) {
  const n = design.name;
  if (!n) return null;
  const size = fittedNameSize(n, W, isSceneDesign(design));
  return textLayer({ ...n, size }, [{ text: n.text, y: n.cy * H }], W, H);
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

// Heartbeat tee, matched to the heybalu Herzschlag layout.
// TEE_LINE is a fraction of the print height (mid-chest). Every other length is a fraction of the print width.
const TEE_LINE = 0.46;
const TEE_SPAN = 0.58;
const TEE_STROKE = 0.0033;
const TEE_SPIKE = 0.080;
const TEE_PET_H = 2.5 * TEE_SPIKE;
const TEE_SIDE_MIN = 0.145;
const TEE_PET_GAP = 0.016;
const TEE_TAPER = 0.022;
const TEE_NAME_GAP = 0.014;
const TEE_NAME_SIZE = 0.034;
const TEE_NAME_WIDTH = 0.40;
const TEE_NAME_SHIFT = 0.020;
const TEE_INK = { dark: '#1c1a17', white: '#ffffff' };

// t goes from the outer tip (0) to the pet's feet (1) on the left, and from the feet (0) to the outer tip (1) on the right.
// y is a multiple of the spike height; negative is above the line. One sharp peak on each side — not a heart, not an M.
const LEFT_ECG = [
  [0.00, 0],
  [0.24, 0],
  [0.30, -0.15],
  [0.36, 0],
  [0.41, 0.16],
  [0.47, -1.00],
  [0.53, 0.36],
  [0.59, 0],
  [0.66, -0.20],
  [0.76, 0],
  [1.00, 0]
];
const RIGHT_ECG = [
  [0.00, 0],
  [0.22, 0],
  [0.30, -0.14],
  [0.37, 0.14],
  [0.44, -0.88],
  [0.51, 0.30],
  [0.58, 0],
  [0.66, -0.16],
  [0.78, 0],
  [1.00, 0]
];

function mapEcg(motif, x0, x1, lineY, spike) {
  const span = x1 - x0;
  return motif.map(([t, y]) => ({ x: x0 + t * span, y: lineY + y * spike }));
}

function pathOf(points) {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join('');
}

/** Outer tip of a trace, drawn as a filled point so the stroke can stay one weight. */
function taperCap(tip, base, width) {
  const dx = base.x - tip.x, dy = base.y - tip.y;
  const mag = Math.hypot(dx, dy) || 1;
  const nx = -dy / mag, ny = dx / mag;
  const hw = width / 2;
  return `M${base.x + nx * hw} ${base.y + ny * hw} L${tip.x} ${tip.y} L${base.x - nx * hw} ${base.y - ny * hw} Z`;
}

function splitOuter(points, taperLen, fromStart) {
  const a = fromStart ? points[0] : points[points.length - 1];
  const b = fromStart ? points[1] : points[points.length - 2];
  const dx = b.x - a.x, dy = b.y - a.y;
  const mag = Math.hypot(dx, dy) || 1;
  const t = Math.min(0.85, taperLen / mag);
  const mid = { x: a.x + dx * t, y: a.y + dy * t };
  const rest = fromStart ? [mid, ...points.slice(1)] : [...points.slice(0, -1), mid];
  return { tip: a, base: mid, rest };
}

function teeNameSize(text, font, W) {
  let size = TEE_NAME_SIZE * W;
  const width = measure(text, font, size);
  const limit = TEE_NAME_WIDTH * W;
  if (width > limit) size *= limit / width;
  return size;
}

/** A point on the full-weight flat tail, left of the QRS. */
function teeProbe(W, H) {
  const x0 = (W - TEE_SPAN * W) / 2;
  return { x: Math.round(x0 + 0.032 * W), y: Math.round(TEE_LINE * H) };
}

/** Tight opaque box. The bottom edge is the feet, with no padding under them. */
async function petBox(buf) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, c = info.channels;
  let minx = w, miny = h, maxx = -1, maxy = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * c;
    for (let x = 0; x < w; x++) {
      if (data[row + x * c + 3] > 12) {
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
      }
    }
  }
  if (maxx < 0) return null;
  // Only the lowest rows. The body just above the toes is wider, and stopping
  // the line there leaves a gap beside the paws.
  const footTop = maxy - Math.max(1, Math.round((maxy - miny + 1) * 0.03));
  let fx0 = w, fx1 = -1;
  for (let y = footTop; y <= maxy; y++) {
    const row = y * w * c;
    for (let x = minx; x <= maxx; x++) {
      if (data[row + x * c + 3] > 12) {
        if (x < fx0) fx0 = x;
        if (x > fx1) fx1 = x;
      }
    }
  }
  if (fx1 < 0) { fx0 = minx; fx1 = maxx; }
  const left = Math.max(0, minx - 1);
  const top = Math.max(0, miny - 1);
  const right = Math.min(w, maxx + 2);
  const bottom = maxy + 1;
  const extracted = await sharp(buf).extract({ left, top, width: right - left, height: bottom - top }).png().toBuffer();
  return {
    buffer: extracted,
    sw: right - left,
    sh: bottom - top,
    fx0: fx0 - left,
    fx1: fx1 - left
  };
}

/**
 * Transparent print file for the heartbeat tee. The whole animal stands on the line,
 * which runs into the feet. Pets share one height. A QRS sits on each side of them.
 */
async function renderTee({ design, pets = [], width, height }) {
  const W = Math.round(width), H = Math.round(height);
  if (!(W > 0 && H > 0)) throw new Error('print_size_missing');
  const ink = TEE_INK[design.ink] || TEE_INK.dark;
  const lineY = TEE_LINE * H;
  const stroke = Math.max(1, TEE_STROKE * W);
  const spike = TEE_SPIKE * W;
  const span = TEE_SPAN * W;
  const x0 = (W - span) / 2;
  const x1 = x0 + span;
  const boxes = [];
  for (const pet of pets) {
    const box = await petBox(pet);
    if (box) boxes.push(box);
  }
  let ph = TEE_PET_H * W;
  const gap = boxes.length > 1 ? TEE_PET_GAP * W : 0;
  // No single pet wider than about a quarter of the line, so a wide corgi
  // does not tower over a narrower cat that shares its height.
  const quarter = 0.25 * span;
  const widest = boxes.reduce((m, b) => Math.max(m, ph * (b.sw / b.sh)), 0);
  if (widest > quarter) ph *= quarter / widest;
  const natural = boxes.reduce((sum, b) => sum + ph * (b.sw / b.sh), 0) + gap * Math.max(0, boxes.length - 1);
  const budget = Math.max(1, span - 2 * TEE_SIDE_MIN * W);
  if (natural > budget) ph *= budget / natural;
  const placed = [];
  let groupW = 0;
  for (const b of boxes) {
    const s = ph / b.sh;
    const pw = Math.max(1, b.sw * s);
    groupW += pw;
    placed.push({ ...b, s, pw, ph: b.sh * s });
  }
  if (placed.length > 1) groupW += gap * (placed.length - 1);
  let cursor = (W - groupW) / 2;
  for (const p of placed) {
    const rw = Math.max(1, Math.round(p.sw * p.s));
    const rh = Math.max(1, Math.round(p.sh * p.s));
    const left = Math.round(cursor);
    // The bottom row of the resized pet is the line, so the feet stand on it.
    const top = Math.round(lineY + stroke * 0.35) - rh;
    const buf = await sharp(p.buffer).resize(rw, rh, { fit: 'fill' }).png().toBuffer();
    const sx = rw / p.sw;
    p.buf = buf;
    p.left = left;
    p.top = top;
    p.pw = rw;
    p.ph = rh;
    p.footL = left + p.fx0 * sx;
    p.footR = left + (p.fx1 + 1) * sx;
    cursor += p.pw + gap;
  }
  const parts = [];
  const addTrace = (points, taperStart) => {
    if (points.length < 2 || points[points.length - 1].x - points[0].x < 2) return;
    const split = splitOuter(points, TEE_TAPER * W, taperStart);
    parts.push(`<path d="${taperCap(split.tip, split.base, stroke)}" fill="${ink}"/>`);
    parts.push(`<path d="${pathOf(split.rest)}" fill="none" stroke="${ink}" stroke-width="${stroke.toFixed(2)}" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="8"/>`);
  };
  const into = p => Math.max(0.02 * W, (p.footR - p.footL) * 0.28);
  if (!placed.length) {
    addTrace(mapEcg(LEFT_ECG, x0, (x0 + x1) / 2, lineY, spike).concat(mapEcg(RIGHT_ECG, (x0 + x1) / 2, x1, lineY, spike).slice(1)), true);
  } else {
    addTrace(mapEcg(LEFT_ECG, x0, placed[0].footL + into(placed[0]), lineY, spike), true);
    for (let i = 0; i < placed.length - 1; i++) {
      const a = placed[i].footR - into(placed[i]), b = placed[i + 1].footL + into(placed[i + 1]);
      if (b - a > 1) parts.push(`<path d="M${a.toFixed(2)} ${lineY.toFixed(2)} L${b.toFixed(2)} ${lineY.toFixed(2)}" fill="none" stroke="${ink}" stroke-width="${stroke.toFixed(2)}" stroke-linecap="butt"/>`);
    }
    const last = placed[placed.length - 1];
    addTrace(mapEcg(RIGHT_ECG, last.footR - into(last), x1, lineY, spike), false);
  }
  const layers = [{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`), left: 0, top: 0 }];
  for (const p of placed) layers.push({ input: p.buf, left: p.left, top: p.top });
  let nameSize = 0;
  let nameCx = W / 2 + TEE_NAME_SHIFT * W;
  if (placed.length) {
    const a = placed[0].left, b = placed[placed.length - 1].left + placed[placed.length - 1].pw;
    nameCx = (a + b) / 2 + TEE_NAME_SHIFT * W;
  }
  if (design.name && design.name.text) {
    nameSize = teeNameSize(design.name.text, design.name.font || 'dancingscript', W);
    const baseline = lineY + TEE_NAME_GAP * W + nameSize * 0.75;
    const { d } = textPath(design.name.text, design.name.font || 'dancingscript', nameSize, nameCx, baseline);
    layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><path d="${d}" fill="${ink}"/></svg>`), left: 0, top: 0 });
  }
  const base = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const buffer = await sharp(base, { limitInputPixels: false }).composite(layers).withMetadata({ density: 300 }).png().toBuffer();
  const meta = await sharp(buffer, { limitInputPixels: false }).metadata();
  if (meta.width !== W || meta.height !== H) throw new Error(`render_size_mismatch:${meta.width}x${meta.height}`);
  const petHeight = placed.length ? placed[0].ph : 0;
  return {
    buffer, width: W, height: H, format: 'png', sha256: sha256(buffer), nameSize, lineY, petHeight, nameCx,
    placements: placed.map(p => ({ left: p.left, top: p.top, width: Math.round(p.pw), height: p.ph, footL: p.footL, footR: p.footR }))
  };
}

module.exports = { renderDesign, renderTee, sha256, NAME_BASELINE, NAME_STROKE, CAPTION_LINE, fittedNameSize, isSceneDesign, SCENE_NAME_COLORS, SCENE_NAME_MAX_WIDTH, SCENE_SCRIPT_SIZE, SCENE_SCRIPT_SIZE_FROM, TEE_LINE, TEE_SPAN, TEE_STROKE, TEE_SPIKE, TEE_PET_H, TEE_NAME_GAP, TEE_NAME_SIZE, TEE_NAME_WIDTH, TEE_NAME_SHIFT, teeProbe };
