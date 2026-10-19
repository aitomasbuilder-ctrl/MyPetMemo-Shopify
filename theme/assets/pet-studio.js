/* MyPetMemo pet studio (personalized blankets, ornaments, mugs and wall portraits)
 * Upload → AI portrait (transparent) → background, name, placement → approve & add to cart.
 * The approved design is signed by the MyPetMemo backend and travels with the cart line; the print
 * file is rendered server side after payment from the same design data (see backend/lib/render.js).
 * drawDesign() below and renderDesign() on the server must stay geometrically identical.
 */
(() => {
  'use strict';

  /* Translations: window.MPM_I18N (assets/pet-i18n-<locale>.js) maps the English text to the shop language. */
  const T = (text, vars) => {
    const s = (window.MPM_I18N && window.MPM_I18N[text]) || text;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
  };
  const METRIC = !!(window.MPM_I18N && window.MPM_I18N.__metric);   // centimetres first

  const DEG = Math.PI / 180;
  const TAU = Math.PI * 2;
  const NAME_BASELINE = 0.35;          // baseline offset from the name centre, in font sizes
  const NAME_STROKE = 0.16;            // outline width, in font sizes
  const CAPTION_LINE = 1.25;           // caption line spacing, in caption font sizes
  const CAPTION_RATIO = 0.5;           // caption size relative to the name
  const MAX_SOURCE_EDGE = 1536;
  const GENERATION_TIMEOUT_MS = 180000;
  const PREVIEW_EXPORT = 1200;
  const HANDLE_COLOR = '#3b8beb';
  const STORE_TTL_MS = 14 * 24 * 3600 * 1000;
  const HEIC_LIB = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
  const FONTS = {
    fredoka: { family: 'Fredoka', weight: 600, fallback: 'Nunito' },   // Fredoka lacks ą č ę ė į ų ū: Nunito draws those
    pacifico: { family: 'Pacifico', weight: 400 },
    montserrat: { family: 'Montserrat', weight: 800 },
    playfair: { family: 'Playfair Display', weight: 700 }
  };
  // Mug drawing: handle width and rim depth as fractions of the body width.
  const MUG_HANDLE = 0.26;
  const MUG_RIM = 0.07;
  // Accent mug colours (handle and inside) by the variant's colour name.
  const MUG_COLORS = {
    black: '#1f1f22', white: '#f4f4f4', blue: '#2563c9', 'light blue': '#8fc3ea', navy: '#1c2a4f', red: '#c4142b',
    pink: '#f3a0bd', green: '#2f8f4e', 'light green': '#8fd19e', 'dark green': '#1f5135', orange: '#f07b22',
    yellow: '#f5cf2b', purple: '#6b3fa0', grey: '#9aa0a6', gray: '#9aa0a6', brown: '#6b4226', maroon: '#6d1a2a'
  };
  const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

  /* ---------- helpers ---------- */
  /** Ornament outline from a variant option such as "Heart / One Size". Blankets have none. */
  function shapeFromOptions(options) {
    for (const o of options || []) {
      const v = String(o).toLowerCase();
      if (/snow|snaig/.test(v)) return 'snowflake';
      if (/star|žvaigžd/.test(v)) return 'star';
      if (/heart|šird/.test(v)) return 'heart';
      if (/circle|round|apskrit|apval/.test(v)) return 'circle';
    }
    return null;
  }
  // Heart outline as cubic segments in a unit frame centred on 0 (x and y from -1 to 1), starting at the top dip.
  const HEART_START = [0, -0.55];
  const HEART_SEGS = [
    [[0.12, -1.02], [1.02, -1.02], [1, -0.4]],
    [[0.98, 0.12], [0.45, 0.55], [0, 1]],
    [[-0.45, 0.55], [-0.98, 0.12], [-1, -0.4]],
    [[-1.02, -1.02], [-0.12, -1.02], [0, -0.55]]
  ];
  /** Five-pointed star corners in the same unit frame (shared by the outline and the layout maths). */
  function starPoints() {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.52 : 1;
      pts.push([Math.cos(a) * r, (Math.sin(a) * r + 0.095) * 1.05]);
    }
    return pts;
  }
  /** Traces an ornament outline inside the box x/y/w/h (scaled by k around its centre). */
  function shapePath(ctx, shape, x, y, w, h, k = 1) {
    const cx = x + w / 2, cy = y + h / 2, rx = (w / 2) * k, ry = (h / 2) * k;
    ctx.beginPath();
    if (shape === 'circle') { ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU); return; }
    if (shape === 'heart') {
      const X = u => cx + u * rx, Y = v => cy + v * ry;
      ctx.moveTo(X(HEART_START[0]), Y(HEART_START[1]));
      HEART_SEGS.forEach(([a, b, c]) => ctx.bezierCurveTo(X(a[0]), Y(a[1]), X(b[0]), Y(b[1]), X(c[0]), Y(c[1])));
      ctx.closePath();
      return;
    }
    if (shape === 'snowflake') {
      // Solid six-pointed snowflake blank: short pointed tips with a notch between each pair.
      for (let i = 0; i < 18; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 9, r = [1, 0.8, 0.8][i % 3];
        const k2 = i % 3 === 0 ? 0 : (i % 3 === 1 ? 1 : -1) * 0.12;
        const px = cx + Math.cos(a + k2) * r * rx, py = cy + Math.sin(a + k2) * r * ry;
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.closePath();
      return;
    }
    // star: five points filling the box from top to bottom.
    starPoints().forEach(([u, v], i) => { if (i) ctx.lineTo(cx + u * rx, cy + v * ry); else ctx.moveTo(cx + u * rx, cy + v * ry); });
    ctx.closePath();
  }

  /* ---------- shape-aware ornament layouts (star and heart) ----------
   * Each shape has its own arrangement instead of a rectangular design cropped by the outline:
   *   star:  name, dates and message across the wide middle (the arms), the portrait in the centre below them
   *   heart: the portrait under the top dip (and the hanging hole), the text above the narrow bottom point
   * Positions are print fractions (x of the width, y of the height). Distances to the outline are in
   * print-width units so the safe margin is the same on every side. */
  const SHAPE_FIT = {
    star: { textFirst: true, hole: [0.5, 0.13, 0.032], text: [0.3, 0.7], petEnd: 0.9, headMin: 0.3, headMax: 0.46, nameMax: 0.13 },
    heart: { textFirst: false, hole: [0.5, 0.255, 0.03], text: [0.42, 0.92], petEnd: 0.9, headMin: 0.34, headMax: 0.54, nameMax: 0.14 }
  };
  const FIT_MARGIN = 0.045;     // smallest distance from any text or the pet's head to the outline
  const FIT_GAP = 0.022;        // space between the text block and the head
  const HOLE_CLEAR = 0.035;     // space between the hanging hole and the top of the head
  const NAME_MIN = 0.062, CAPTION_MIN = 0.04;
  const GRID = 160;
  const gridCache = new Map();
  /** Outline as a polygon in print fractions. */
  function shapePolygon(shape) {
    const map = ([u, v]) => [0.5 + u / 2, 0.5 + v / 2];
    if (shape === 'star') return starPoints().map(map);
    if (shape === 'heart') {
      const pts = [];
      let s = HEART_START;
      HEART_SEGS.forEach(([a, b, c]) => {
        for (let i = 1; i <= 48; i++) {
          const t = i / 48, u = 1 - t;
          pts.push(map([u * u * u * s[0] + 3 * u * u * t * a[0] + 3 * u * t * t * b[0] + t * t * t * c[0],
            u * u * u * s[1] + 3 * u * u * t * a[1] + 3 * u * t * t * b[1] + t * t * t * c[1]]));
        }
        s = c;
      });
      return pts;
    }
    return null;
  }
  /** Distance to the outline (print-width units, negative outside) on a grid, for print area proportions `aspect` (h / w). */
  function depthGrid(shape, aspect) {
    const key = shape + ':' + aspect.toFixed(3);
    if (gridCache.has(key)) return gridCache.get(key);
    const poly = shapePolygon(shape).map(([x, y]) => [x, y * aspect]);
    const data = new Float32Array((GRID + 1) * (GRID + 1));
    for (let j = 0; j <= GRID; j++) {
      for (let i = 0; i <= GRID; i++) {
        const px = i / GRID, py = (j / GRID) * aspect;
        let inside = false, d = Infinity;
        for (let k = 0, l = poly.length - 1; k < poly.length; l = k++) {
          const a = poly[k], b = poly[l];
          if ((a[1] > py) !== (b[1] > py) && px < ((b[0] - a[0]) * (py - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
          const dx = b[0] - a[0], dy = b[1] - a[1];
          const t = clamp(((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
          d = Math.min(d, Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy));
        }
        data[j * (GRID + 1) + i] = inside ? d : -d;
      }
    }
    const grid = {
      depth(x, y) {
        if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return -1;
        const fx = x * GRID, fy = y * GRID, i = Math.min(GRID - 1, Math.floor(fx)), j = Math.min(GRID - 1, Math.floor(fy));
        const tx = fx - i, ty = fy - j, at = (a, b) => data[b * (GRID + 1) + a];
        return (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - ty) + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * ty;
      },
      /** Smallest depth over a rectangle's outline and centre line (x0..x1, y0..y1). */
      rect(x0, y0, x1, y1) {
        let m = Infinity;
        for (let k = 0; k <= 8; k++) {
          const x = x0 + ((x1 - x0) * k) / 8;
          m = Math.min(m, this.depth(x, y0), this.depth(x, y1), this.depth(x, (y0 + y1) / 2));
        }
        for (let k = 1; k < 4; k++) { const y = y0 + ((y1 - y0) * k) / 4; m = Math.min(m, this.depth(x0, y), this.depth(x1, y)); }
        return m;
      }
    };
    gridCache.set(key, grid);
    return grid;
  }
  /** Splits a line at the space that gives the most even halves (prefers breaking after a dash or comma). */
  function splitLine(text, measure) {
    const words = text.split(' ');
    if (words.length < 2) return [text];
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
      let score = Math.max(measure(a), measure(b));
      if (/[–—,-]$/.test(a)) score *= 0.85;
      if (/^[–—-]/.test(b)) score *= 1.3;
      if (!best || score < best.score) best = { score, lines: [a, b] };
    }
    return best.lines;
  }
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
  const round4 = n => Math.round(n * 10000) / 10000;
  const isHeic = file => /hei[cf]/i.test(file.type || '') || /\.hei[cf]$/i.test(file.name || '');

  function formatMoney(cents, format) {
    const fmt = format || '${{amount}}';
    const value = Number(cents) / 100;
    const sep = (n, dec, thou, decSep) => {
      const parts = n.toFixed(dec).split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, thou);
      return parts.length > 1 ? parts[0] + decSep + parts[1] : parts[0];
    };
    return fmt.replace(/\{\{\s*(\w+)\s*\}\}/, (_, key) => {
      switch (key) {
        case 'amount_no_decimals': return sep(value, 0, ',', '.');
        case 'amount_with_comma_separator': return sep(value, 2, '.', ',');
        case 'amount_no_decimals_with_comma_separator': return sep(value, 0, '.', ',');
        case 'amount_with_apostrophe_separator': return sep(value, 2, "'", '.');
        case 'amount_with_space_separator': return sep(value, 2, ' ', ',');
        default: return sep(value, 2, ',', '.');
      }
    });
  }
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    const n = m ? parseInt(m[1], 16) : 0xf6eef1;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  /** Colour for a variant value such as "Light Blue" or "11oz / Navy"; null when it names no known colour. */
  function colorHex(value) {
    const v = String(value || '').toLowerCase();
    const key = Object.keys(MUG_COLORS).sort((a, b) => b.length - a.length).find(k => new RegExp(`\\b${k}\\b`).test(v));
    return key ? MUG_COLORS[key] : null;
  }
  /** "50" × 60"" → { w: 50, h: 60 } (inches). Translated values such as "127 × 152 cm (50 × 60 in)" use the inch part. */
  function parseInches(text) {
    const m = /(\d+(?:\.\d+)?)\s*(?:"|″|in)?\s*[×x]\s*(\d+(?:\.\d+)?)\s*(?:"|″|in\b)/.exec(String(text || ''))
      || /(\d+(?:\.\d+)?)\D{1,6}?(\d+(?:\.\d+)?)/.exec(String(text || ''));
    return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
  }
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image_load_failed'));
      img.src = src;
    });
  }
  function canvasToBlob(canvas, type = 'image/png', quality) {
    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('export_failed'))), type, quality));
  }
  function createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }
  async function sha256Hex(blobOrBuffer) {
    const buf = blobOrBuffer instanceof Blob ? await blobOrBuffer.arrayBuffer() : blobOrBuffer;
    if (!(window.crypto && crypto.subtle)) throw new Error('crypto_unavailable');
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = () => reject(new Error('script_failed'));
      document.head.appendChild(s);
    });
  }

  class StudioError extends Error {
    constructor(code, message, retryable = true) { super(message); this.code = code; this.retryable = retryable; }
  }

  /* ---------- tiny IndexedDB key-value store (refresh recovery + artwork cache) ---------- */
  const kv = (() => {
    let dbp;
    const open = () => {
      if (!('indexedDB' in window)) return Promise.reject(new Error('no_idb'));
      dbp = dbp || new Promise((resolve, reject) => {
        const req = indexedDB.open('mypetmemo-studio', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbp;
    };
    const tx = (mode, fn) => open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction('kv', mode);
      const r = fn(t.objectStore('kv'));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
    }));
    return {
      get: k => tx('readonly', s => s.get(k)).catch(() => undefined),
      set: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => undefined),
      del: k => tx('readwrite', s => s.delete(k)).catch(() => undefined)
    };
  })();

  /* ---------- image processing ---------- */
  async function decodeFile(file) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* fall through */ }
    }
    const url = URL.createObjectURL(file);
    try { return await loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
  async function heicToJpeg(file) {
    if (!window.heic2any) await loadScript(HEIC_LIB);
    const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    return Array.isArray(out) ? out[0] : out;
  }
  async function normalizePhoto(source) {
    const scale = Math.min(1, MAX_SOURCE_EDGE / Math.max(source.width, source.height));
    const canvas = createCanvas(source.width * scale, source.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvasToBlob(canvas, 'image/jpeg', 0.9);
  }
  /** Removes a flat studio background (chroma) by flood fill from the borders, then trims. */
  function removeFlatBackground(image) {
    // A thin line or vignette at the very edge of the AI image hides the flat background from the edge flood,
    // so if little was removed, try again from a ring a few percent inside the edge.
    const first = keyOutBackground(image, 0);
    if (first.removedRatio >= 0.2) return first;
    const second = keyOutBackground(image, Math.round(Math.min(image.width, image.height) * 0.03));
    return second.removedRatio > first.removedRatio && second.removedRatio <= 0.97 ? second : first;
  }
  function keyOutBackground(image, inset) {
    const w = image.width, h = image.height;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    const samples = [[], [], []];
    const step = Math.max(1, Math.floor((w + h) / 200));
    const push = (x, y) => { const i = (y * w + x) * 4; samples[0].push(px[i]); samples[1].push(px[i + 1]); samples[2].push(px[i + 2]); };
    const x0 = inset, y0 = inset, x1 = w - 1 - inset, y1 = h - 1 - inset;
    for (let x = x0; x <= x1; x += step) { push(x, y0); push(x, y1); }
    for (let y = y0; y <= y1; y += step) { push(x0, y); push(x1, y); }
    const median = arr => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    const key = [median(samples[0]), median(samples[1]), median(samples[2])];
    const keyIsGreen = key[1] > 140 && key[1] > key[0] + 60 && key[1] > key[2] + 60;
    const hard = 70, soft = 140;
    const distTo = i => Math.sqrt((px[i] - key[0]) ** 2 + (px[i + 1] - key[1]) ** 2 + (px[i + 2] - key[2]) ** 2);
    const removed = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    const tryPush = p => { if (!removed[p] && distTo(p * 4) < hard) { removed[p] = 1; queue[tail++] = p; } };
    // Everything outside the ring is edge noise: drop it and start the flood from the ring.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < x0 || x > x1 || y < y0 || y > y1) removed[y * w + x] = 1;
    for (let x = x0; x <= x1; x++) { tryPush(y0 * w + x); tryPush(y1 * w + x); }
    for (let y = y0; y <= y1; y++) { tryPush(y * w + x0); tryPush(y * w + x1); }
    while (head < tail) {
      const p = queue[head++], x = p % w, y = (p - x) / w;
      if (x > 0) tryPush(p - 1);
      if (x < w - 1) tryPush(p + 1);
      if (y > 0) tryPush(p - w);
      if (y < h - 1) tryPush(p + w);
    }
    if (tail === 0) return { canvas, removedRatio: 0 };
    for (let p = 0; p < w * h; p++) if (removed[p]) px[p * 4 + 3] = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (removed[p] || !(removed[p - 1] || removed[p + 1] || removed[p - w] || removed[p + w])) continue;
        const i = p * 4, d = distTo(i);
        if (d < soft) px[i + 3] = Math.round(255 * clamp((d - hard) / (soft - hard), 0.15, 1));
        if (keyIsGreen) { const cap = Math.max(px[i], px[i + 2]); if (px[i + 1] > cap) px[i + 1] = cap; }
      }
    }
    ctx.putImageData(data, 0, 0);
    return { canvas: trimTransparent(canvas), removedRatio: tail / (w * h) };
  }
  function trimTransparent(canvas) {
    const w = canvas.width, h = canvas.height;
    const px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 16) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (maxX < 0) return canvas;
    minX = Math.max(0, minX - 2); minY = Math.max(0, minY - 2); maxX = Math.min(w - 1, maxX + 2); maxY = Math.min(h - 1, maxY + 2);
    const out = createCanvas(maxX - minX + 1, maxY - minY + 1);
    out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  /* ---------- views (main stage and full editor share one design) ---------- */
  class View {
    constructor(studio, canvas, { interactive, scene = false }) {
      this.studio = studio;
      this.canvas = canvas;
      this.scene = scene;
      this.ctx = canvas.getContext('2d');
      this.interactive = interactive;
      this.pointers = new Map();
      this.gesture = null;
      this.bind();
      const resize = () => this.resize();
      if ('ResizeObserver' in window) new ResizeObserver(resize).observe(canvas);
      window.addEventListener('resize', resize);
      this.resize();
    }
    resize() {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width) return;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      this.w = rect.width; this.h = rect.height;
      const W = Math.round(this.w * this.dpr), H = Math.round(this.h * this.dpr);
      if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
      this.render();
    }
    /** The print area inside this view: real print proportions, centred. */
    box() { return this.studio.fitBox(this.w, this.h); }
    render() {
      if (!this.w) return;
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      const box = this.box();
      const s = this.studio;
      const shape = s.shape();
      if (s.isMug()) {
        s.drawMug(ctx, box, { dpr: this.dpr, editing: this.isEditing(), placeholder: !s.state.artwork });
        this.drawEditing(ctx, box);
        return;
      }
      if (s.isPortrait() && this.scene && !this.isEditing()) {
        s.drawScene(ctx, this.w, this.h, { dpr: this.dpr });
        this.canvas.dataset.editing = 'false';
        return;
      }
      // blanket or ornament on the stage
      ctx.save();
      ctx.shadowColor = 'rgba(27, 42, 78, 0.22)';
      ctx.shadowBlur = this.w * 0.03;
      ctx.shadowOffsetY = this.w * 0.01;
      ctx.fillStyle = s.state.background.color || '#fff';
      if (shape) { shapePath(ctx, shape, box.x, box.y, box.w, box.h); ctx.fill(); } else ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.restore();
      if (shape) {
        // While editing, the part of the design outside the ornament stays faintly visible.
        if (this.isEditing()) { ctx.save(); ctx.globalAlpha = 0.22; s.drawDesign(ctx, box.x, box.y, box.w, box.h, { dpr: this.dpr }); ctx.restore(); }
        ctx.save();
        shapePath(ctx, shape, box.x, box.y, box.w, box.h); ctx.clip();
        s.drawDesign(ctx, box.x, box.y, box.w, box.h, { dpr: this.dpr, placeholder: !s.state.artwork });
        ctx.restore();
        ctx.save();
        shapePath(ctx, shape, box.x, box.y, box.w, box.h);
        ctx.lineWidth = Math.max(1.5, box.w * 0.006); ctx.strokeStyle = 'rgba(27, 42, 78, 0.18)'; ctx.stroke();
        ctx.restore();
        s.drawHole(ctx, box.x, box.y, box.w, box.h);
      } else {
        s.drawDesign(ctx, box.x, box.y, box.w, box.h, { dpr: this.dpr, placeholder: !s.state.artwork });
        if (s.isPortrait()) s.drawBleed(ctx, box);
      }
      this.drawEditing(ctx, box);
    }
    drawEditing(ctx, box) {
      const s = this.studio;
      if (this.isEditing()) {
        s.drawSafeArea(ctx, box);
        for (const which of ['pet', 'name']) {
          const g = s.geometry(which, box);
          if (!g) continue;
          if (s.state.selected === which) this.drawHandles(ctx, g); else this.drawOutline(ctx, g);
        }
      }
      this.canvas.dataset.editing = String(this.isEditing());
    }
    isEditing() { return this.interactive() && !!this.studio.state.artwork; }
    drawOutline(ctx, g) {
      ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(g.rot * DEG);
      ctx.setLineDash([6, 5]); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(59, 139, 235, 0.75)';
      ctx.strokeRect(-g.w / 2, -g.h / 2, g.w, g.h);
      ctx.restore();
    }
    drawHandles(ctx, g) {
      const hs = this.handleSize();
      ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(g.rot * DEG);
      ctx.lineWidth = 2; ctx.strokeStyle = HANDLE_COLOR;
      ctx.strokeRect(-g.w / 2, -g.h / 2, g.w, g.h);
      const ry = -g.h / 2 - this.rotateOffset();
      ctx.beginPath(); ctx.moveTo(0, -g.h / 2); ctx.lineTo(0, ry); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, ry, hs * 0.6, 0, TAU); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
      ctx.fillStyle = HANDLE_COLOR;
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) ctx.fillRect(sx * g.w / 2 - hs / 2, sy * g.h / 2 - hs / 2, hs, hs);
      ctx.restore();
    }
    handleSize() { return this.lastPointerType === 'touch' ? 18 : 13; }
    rotateOffset() { return this.lastPointerType === 'touch' ? 34 : 26; }

    bind() {
      const c = this.canvas;
      c.addEventListener('pointerdown', e => this.down(e));
      c.addEventListener('pointermove', e => this.move(e));
      c.addEventListener('pointerup', e => this.up(e));
      c.addEventListener('pointercancel', e => this.up(e));
      c.addEventListener('lostpointercapture', e => this.up(e));
      c.addEventListener('wheel', e => {
        if (!this.isEditing() || !this.studio.state.selected) return;
        e.preventDefault();
        this.studio.nudge({ scale: e.deltaY < 0 ? 1.04 : 1 / 1.04 });
      }, { passive: false });
      c.addEventListener('keydown', e => this.key(e));
    }
    point(e) {
      const r = this.canvas.getBoundingClientRect();
      return [(e.clientX - r.left) * (this.w / r.width), (e.clientY - r.top) * (this.h / r.height)];
    }
    toLocal(g, x, y) {
      const dx = x - g.x, dy = y - g.y, a = -g.rot * DEG;
      return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
    }
    hit(x, y) {
      const s = this.studio, box = this.box();
      const tol = this.lastPointerType === 'touch' ? 24 : 14;
      const sel = s.state.selected;
      if (sel) {
        const g = s.geometry(sel, box);
        if (g) {
          const [lx, ly] = this.toLocal(g, x, y);
          if (dist(lx, ly, 0, -g.h / 2 - this.rotateOffset()) <= tol) return { target: sel, handle: 'rotate', g };
          for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            if (dist(lx, ly, sx * g.w / 2, sy * g.h / 2) <= tol) return { target: sel, handle: 'resize', corner: [sx, sy], g };
          }
        }
      }
      for (const which of ['name', 'pet']) {
        const g = s.geometry(which, box);
        if (!g) continue;
        const [lx, ly] = this.toLocal(g, x, y);
        if (Math.abs(lx) <= g.w / 2 + 6 && Math.abs(ly) <= g.h / 2 + 6) return { target: which, handle: 'move', g };
      }
      return null;
    }
    down(e) {
      const s = this.studio;
      if (this.compareDrag(e, 'down')) return;
      if (!s.state.artwork || s.state.galleryOpen) return;
      if (!this.isEditing()) {
        // Tapping the design on the main stage opens the Adjust panel.
        if (e.pointerType === 'mouse' || e.isPrimary) { this.tapStart = { x: e.clientX, y: e.clientY, t: Date.now() }; }
        return;
      }
      this.lastPointerType = e.pointerType;
      const [x, y] = this.point(e);
      this.pointers.set(e.pointerId, { x, y });
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
      this.canvas.focus({ preventScroll: true });
      if (this.pointers.size === 2 && s.state.selected) {
        const [a, b] = Array.from(this.pointers.values());
        this.gesture = { type: 'pinch', target: s.state.selected, start: { ...s.state[s.state.selected] },
          startDist: Math.max(10, dist(a.x, a.y, b.x, b.y)), startAngle: Math.atan2(b.y - a.y, b.x - a.x), startMid: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
        return;
      }
      if (this.pointers.size > 1) return;
      const hit = this.hit(x, y);
      if (!hit) { this.gesture = null; s.select(null); return; }
      s.select(hit.target);
      this.gesture = { type: hit.handle, target: hit.target, startX: x, startY: y, start: { ...s.state[hit.target] }, g: hit.g,
        startAngle: Math.atan2(y - hit.g.y, x - hit.g.x), startDist: dist(x, y, hit.g.x, hit.g.y) };
    }
    move(e) {
      const s = this.studio;
      if (this.compareDrag(e, 'move')) return;
      if (!this.isEditing()) return;
      const [x, y] = this.point(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });
      const gst = this.gesture;
      if (!gst) {
        if (e.pointerType === 'mouse') {
          this.lastPointerType = 'mouse';
          const hit = this.hit(x, y);
          this.canvas.dataset.cursor = !hit ? '' : hit.handle === 'rotate' ? 'rotate' : hit.handle === 'resize' ? (hit.corner[0] * hit.corner[1] > 0 ? 'nwse' : 'nesw') : 'move';
        }
        return;
      }
      e.preventDefault();
      const box = this.box();
      const obj = s.state[gst.target], st = gst.start;
      if (gst.type === 'pinch') {
        if (this.pointers.size < 2) return;
        const [a, b] = Array.from(this.pointers.values());
        s.applyScale(gst.target, st, dist(a.x, a.y, b.x, b.y) / gst.startDist);
        obj.rot = s.snapAngle(st.rot + (Math.atan2(b.y - a.y, b.x - a.x) - gst.startAngle) / DEG);
        obj.cx = st.cx + ((a.x + b.x) / 2 - gst.startMid[0]) / box.w;
        obj.cy = st.cy + ((a.y + b.y) / 2 - gst.startMid[1]) / box.h;
      } else if (gst.type === 'move') {
        obj.cx = st.cx + (x - gst.startX) / box.w;
        obj.cy = st.cy + (y - gst.startY) / box.h;
      } else if (gst.type === 'resize') {
        s.applyScale(gst.target, st, dist(x, y, gst.g.x, gst.g.y) / Math.max(1, gst.startDist));
      } else if (gst.type === 'rotate') {
        obj.rot = s.snapAngle(st.rot + (Math.atan2(y - gst.g.y, x - gst.g.x) - gst.startAngle) / DEG);
      }
      s.changed({ placement: true });
    }
    up(e) {
      const s = this.studio;
      if (this.compareDrag(e, 'up')) return;
      if (this.tapStart && !this.isEditing()) {
        const moved = dist(this.tapStart.x, this.tapStart.y, e.clientX, e.clientY);
        if (moved < 8 && Date.now() - this.tapStart.t < 500 && e.type === 'pointerup') {
          const [x, y] = this.point(e);
          const hit = this.hit(x, y);
          s.openAdjust(hit ? hit.target : 'pet');
        }
        this.tapStart = null;
        return;
      }
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 1 && this.gesture && this.gesture.type === 'pinch') {
        const [p] = Array.from(this.pointers.values());
        const target = this.gesture.target;
        this.gesture = { type: 'move', target, startX: p.x, startY: p.y, start: { ...s.state[target] } };
        return;
      }
      if (this.pointers.size === 0 && this.gesture) { this.gesture = null; s.changed({ placement: true, commit: true }); }
    }
    /** Before / after view: dragging anywhere on the preview moves the divider. */
    compareDrag(e, phase) {
      const s = this.studio;
      if (!this.scene || !s.isPortrait() || s.sceneMode() !== 'compare' || this.isEditing()) return false;
      if (phase === 'down') { this.comparing = true; try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      if (phase === 'up') { this.comparing = false; return true; }
      if (!this.comparing) return true;
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect();
      s.state.compareX = clamp((e.clientX - r.left) / r.width, 0.02, 0.98);
      this.render();
      return true;
    }
    key(e) {
      const s = this.studio;
      if (s.isPortrait() && this.scene && s.sceneMode() === 'compare' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        s.state.compareX = clamp(s.state.compareX + (e.key === 'ArrowLeft' ? -0.05 : 0.05), 0.02, 0.98);
        this.render();
        return;
      }
      if (!this.isEditing()) return;
      if (e.key === 'Tab') return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const order = ['pet'].concat(s.hasLabel() ? ['name'] : []);
        s.select(order[(order.indexOf(s.state.selected) + 1) % order.length]);
        return;
      }
      if (e.key === 'Escape') { s.select(null); return; }
      const step = e.shiftKey ? 0.05 : 0.01;
      const map = {
        ArrowLeft: { dx: -step }, ArrowRight: { dx: step }, ArrowUp: { dy: -step }, ArrowDown: { dy: step },
        '+': { scale: 1.04 }, '=': { scale: 1.04 }, '-': { scale: 1 / 1.04 }, '[': { rot: -5 }, ']': { rot: 5 }
      };
      if (!map[e.key] || !s.state.selected) return;
      e.preventDefault();
      s.nudge(map[e.key]);
    }
  }

  /* ---------- studio ---------- */
  /* One review at a time under the generation countdown. Fixed height (all slides share one grid
   * cell), gentle fade, dots and previous/next buttons. Auto-rotation pauses while the shopper
   * hovers, focuses or has used the controls, and is off for reduced motion. */
  class ReviewCarousel {
    constructor(root, reviews) {
      this.root = root;
      this.reviews = reviews;
      this.index = 0;
      this.timer = null;
      this.paused = false;
      this.reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.slides = root.querySelector('[data-carousel-slides]');
      this.dots = root.querySelector('[data-carousel-dots]');
      const prev = root.querySelector('[data-carousel-prev]'), next = root.querySelector('[data-carousel-next]');
      reviews.forEach((r, i) => {
        this.slides.appendChild(this.card(r, i));
        const d = document.createElement('button');
        d.type = 'button';
        d.className = 'mps__gen-dot';
        d.setAttribute('aria-label', T('Show review {n} of {total}', { n: i + 1, total: reviews.length }));
        d.addEventListener('click', () => { this.hold(); this.show(i); });
        this.dots.appendChild(d);
      });
      const single = reviews.length < 2;
      prev.hidden = next.hidden = this.dots.hidden = single;
      prev.addEventListener('click', () => { this.hold(); this.show(this.index - 1); });
      next.addEventListener('click', () => { this.hold(); this.show(this.index + 1); });
      root.addEventListener('pointerenter', () => { this.paused = true; });
      root.addEventListener('pointerleave', () => { if (!this.held) this.paused = false; });
      root.addEventListener('focusin', () => { this.paused = true; });
      root.addEventListener('focusout', e => { if (!root.contains(e.relatedTarget) && !this.held) this.paused = false; });
      this.show(0);
    }
    card(r, i) {
      const fig = document.createElement('figure');
      fig.className = 'mps__gen-card' + (r.sample ? ' is-sample' : '');
      fig.setAttribute('role', 'group');
      fig.setAttribute('aria-roledescription', 'slide');
      fig.setAttribute('aria-label', T('{n} of {total}', { n: i + 1, total: this.reviews.length }));
      const media = document.createElement('div');
      media.className = 'mps__gen-card-media';
      if (r.image) { const img = document.createElement('img'); img.src = r.image; img.alt = ''; img.loading = 'lazy'; media.appendChild(img); }
      else { const sp = document.createElement('span'); sp.textContent = r.name.trim().charAt(0).toUpperCase(); sp.setAttribute('aria-hidden', 'true'); media.appendChild(sp); }
      const body = document.createElement('figcaption');
      const head = document.createElement('p');
      head.className = 'mps__gen-card-name';
      head.textContent = r.name;
      if (r.verified) { const v = document.createElement('span'); v.className = 'mps-review__verified'; v.textContent = T('Verified purchase'); head.appendChild(v); }
      if (r.sample) { const v = document.createElement('span'); v.className = 'mps-review__sample'; v.textContent = T('Sample · preview only'); head.appendChild(v); }
      const stars = document.createElement('div');
      stars.className = 'mps-stars mps-stars--small';
      const rating = Math.max(1, Math.min(5, Number(r.rating) || 5));
      stars.style.setProperty('--rating', `${rating * 20}%`);
      stars.setAttribute('role', 'img');
      stars.setAttribute('aria-label', T('{rating} out of 5 stars', { rating }));
      const text = document.createElement('blockquote');
      text.className = 'mps__gen-card-text';
      const t = String(r.text);
      text.textContent = t.length > 170 ? `${t.slice(0, 167).replace(/\s+\S*$/, '')}…` : t;
      body.append(head, stars, text);
      if (r.about) { const a = document.createElement('p'); a.className = 'mps-review__about'; a.textContent = T('Review of {product}', { product: r.about }); body.appendChild(a); }
      fig.append(media, body);
      return fig;
    }
    show(i) {
      const n = this.reviews.length;
      this.index = (i + n) % n;
      Array.from(this.slides.children).forEach((c, j) => { const on = j === this.index; c.classList.toggle('is-active', on); c.setAttribute('aria-hidden', String(!on)); });
      Array.from(this.dots.children).forEach((d, j) => d.setAttribute('aria-current', String(j === this.index)));
    }
    hold() { this.held = true; this.paused = true; }
    start() {
      this.stop();
      this.held = false; this.paused = false;
      this.show(0);
      if (this.reduce || this.reviews.length < 2) return;
      this.timer = setInterval(() => { if (!this.paused && !document.hidden) this.show(this.index + 1); }, 7000);
    }
    stop() { clearInterval(this.timer); this.timer = null; }
  }

  class PetStudio {
    constructor(root) {
      this.root = root;
      this.config = JSON.parse(root.querySelector('[data-studio-config]').textContent);
      this.B = window.MyPetMemoBackgrounds;
      const q = s => root.querySelector(s), qa = s => Array.from(root.querySelectorAll(s));
      this.el = {
        stage: q('[data-stage]'), fileInput: q('[data-file-input]'), uploadPanel: q('[data-upload-panel]'),
        photoRow: q('[data-photo-row]'), thumb: q('[data-thumb]'), photoStatus: q('[data-photo-status]'),
        error: q('[data-error]'), errorText: q('[data-error-text]'), retry: q('[data-retry]'),
        gen: q('[data-gen]'), genTitle: q('[data-gen-title]'), genStatus: q('[data-gen-status]'), genBar: q('[data-gen-bar]'), genFill: q('[data-gen-fill]'),
        genTime: q('[data-gen-time]'), genCancel: q('[data-gen-cancel]'), uploadNote: q('[data-upload-note]'),
        dropHint: q('[data-drop-hint]'), swatches: q('[data-swatches]'), editorSwatches: q('[data-editor-swatches]'), seeAll: q('[data-see-all]'),
        bgNames: qa('[data-bg-name]'), nameInput: q('[data-name-input]'), nameErrors: qa('[data-name-error]'),
        editRow: q('[data-edit-row]'), adjustBtn: q('[data-adjust]'), adjustPanel: q('[data-adjust-panel]'),
        primaries: qa('[data-primary]'), approveNote: q('[data-approve-note]'), cartStatus: q('[data-cart-status]'),
        optionGroups: qa('[data-option-group]'), priceInline: q('[data-price-inline]'), printInfo: q('[data-print-info]'),
        sticky: q('[data-sticky]'), dialog: q('[data-editor-dialog]'), editorName: q('[data-editor-name]'),
        font: q('[data-font]'), fill: q('[data-fill]'), stroke: q('[data-stroke]'), nameSize: q('[data-name-size]'),
        gallery: q('[data-gallery]'), galleryMain: q('[data-gallery-main]'), galleryThumbs: q('[data-gallery-thumbs]'),
        thumbs: q('[data-thumbs]'), thumbDesign: q('[data-thumb-design]'), email: q('[data-email-input]'), consent: q('[data-marketing-consent]'),
        extras: qa('[data-extra]'), suggestions: qa('[data-suggest]'), styles: qa('[data-style]'),
        artStyles: qa('[data-art-style]'), scenes: qa('[data-scene]'), roomNav: q('[data-room-nav]'), roomName: q('[data-room-name]'),
        zoomDialog: q('[data-zoom-dialog]'), zoomImg: q('[data-zoom-img]'), memorialOnly: qa('[data-memorial-only]'),
        approvedBadge: q('[data-approved]'), frameHint: q('[data-frame-hint]'), digitalNote: q('[data-digital-note]')
      };
      this.P = window.MyPetMemoPortrait || null;
      this.state = {
        phase: 'empty',            // empty | generating | ready | error
        photo: null,               // { blob, hash, url }
        artwork: null,             // transparent canvas of the illustrated pet
        art: null,                 // { blob, sha256, w, h } exact PNG that is uploaded and approved
        background: { id: 'white', kind: 'solid', name: 'White', color: '#ffffff' },
        bgImage: null,
        pet: { cx: 0.5, cy: 0.6, w: 0.86, rot: 0 },
        name: { text: '', cx: 0.5, cy: 0.12, size: 0.13, rot: 0, font: 'fredoka', fill: '#ffffff', stroke: '#2a2230' },
        extra: { year: '', dates: '', message: '' },   // optional lines under the name (see captionLines)
        style: 'below',            // mug layout (see placeMug)
        artStyle: 'modern',        // portrait artwork style (pet-portrait.js STYLES)
        baseArt: null,             // portraits: { img, art } the unstyled AI portrait; styles are derived from it
        scene: 'design',           // portraits: design | close | room | compare
        roomIndex: 0,
        compareX: 0.5,
        approvedKey: null,         // portraits: the design the shopper approved (any change clears it)
        selected: null,
        adjustOpen: false,
        editorOpen: false,
        variant: null,
        addedId: null,
        galleryOpen: false,
        galleryIndex: 0
      };
      this.templates = new Map();
      this.svgCache = new Map();
      this.styleCache = new Map();
      this.decorCache = new Map();
      this.generationId = 0;
      this.measureCtx = createCanvas(4, 4).getContext('2d');

      this.initBackgrounds();
      this.initVariants();
      this.bindUI();
      this.setStyle(this.state.style, { silent: true });
      this.initGallery();
      this.initReviews();
      this.initSticky();
      if (this.isPortrait()) this.initPortrait();
      this.views = [new View(this, root.querySelector('[data-canvas]'), { interactive: () => this.state.adjustOpen, scene: true })];
      if (this.el.dialog) this.editorView = new View(this, root.querySelector('[data-editor-canvas]'), { interactive: () => this.state.editorOpen });
      this.loadFonts();
      this.updateUI();
      this.restore();
    }

    /* ----- setup ----- */
    loadFonts() {
      if (!document.fonts || !document.fonts.load) return;
      const loads = Object.values(FONTS).map(f => document.fonts.load(`${f.weight} 48px "${f.family}"${f.fallback ? `, "${f.fallback}"` : ''}`, 'AaÀéąčęėįšųūž'));
      Promise.all(loads).then(() => this.changed({ fonts: true })).catch(() => {});
    }
    fontsReady() {
      if (!document.fonts || !document.fonts.load) return Promise.resolve();
      const f = FONTS[this.state.name.font] || FONTS.fredoka;
      return document.fonts.load(`${f.weight} 48px "${f.family}"${f.fallback ? `, "${f.fallback}"` : ''}`, this.state.name.text || 'A').catch(() => {});
    }

    bindUI() {
      const { el } = this;
      el.fileInput.addEventListener('change', () => {
        const file = el.fileInput.files && el.fileInput.files[0];
        el.fileInput.value = '';
        if (file) this.handleFile(file);
      });
      el.primaries.forEach(b => b.addEventListener('click', () => this.primaryAction()));
      el.retry.addEventListener('click', () => this.retry());
      this.root.querySelectorAll('[data-new-photo], [data-error-new-photo], [data-replace]').forEach(b => b.addEventListener('click', () => el.fileInput.click()));
      const onName = input => {
        const wasDefault = this.isDefaultLayout(), hadName = !!this.state.name.text;
        this.state.name.text = input.value.replace(/\s+/g, ' ').replace(/^\s+/, '');
        // Adding or removing the name re-flows a layout the shopper has not moved yet.
        if (this.reflow(wasDefault, hadName !== !!this.state.name.text)) this.placeDefault();
        [el.nameInput, el.editorName].forEach(i => { if (i && i !== input) i.value = input.value; });
        this.changed({ design: true });
      };
      el.nameInput.addEventListener('input', () => onName(el.nameInput));
      const onExtra = (key, value) => {
        const wasDefault = this.isDefaultLayout(), before = this.captionLines().length;
        this.state.extra[key] = value.replace(/\s+/g, ' ').replace(/^\s+/, '');
        if (this.reflow(wasDefault, before !== this.captionLines().length)) this.placeDefault();
        el.extras.forEach(i => { if (i.dataset.extra === key && i.value !== value) i.value = value; });
        el.suggestions.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.suggest === this.state.extra.message)));
        this.changed({ design: true });
      };
      el.extras.forEach(i => i.addEventListener('input', () => onExtra(i.dataset.extra, i.value)));
      el.suggestions.forEach(b => b.addEventListener('click', () => {
        onExtra('message', this.state.extra.message === b.dataset.suggest ? '' : b.dataset.suggest);
      }));
      if (el.editorName) el.editorName.addEventListener('input', () => onName(el.editorName));
      el.styles.forEach(b => {
        b.addEventListener('click', () => this.setStyle(b.dataset.style));
        b.addEventListener('keydown', e => this.radioKeys(e, b.parentElement, '[data-style]'));
      });
      el.adjustBtn.addEventListener('click', () => (this.state.adjustOpen ? this.closeAdjust() : this.openAdjust('pet')));
      this.root.querySelector('[data-adjust-save]').addEventListener('click', () => this.closeAdjust());
      this.root.querySelectorAll('[data-reset]').forEach(b => b.addEventListener('click', () => { this.placeDefault(); this.changed({ placement: true, commit: true }); }));
      this.root.querySelectorAll('[data-target]').forEach(b => b.addEventListener('click', () => this.select(b.dataset.target)));
      const nudges = { up: { dy: -0.02 }, down: { dy: 0.02 }, left: { dx: -0.02 }, right: { dx: 0.02 }, bigger: { scale: 1.06 }, smaller: { scale: 1 / 1.06 }, cw: { rot: 5 }, ccw: { rot: -5 } };
      this.root.querySelectorAll('[data-nudge]').forEach(b => b.addEventListener('click', () => {
        if (!this.state.selected) this.select('pet');
        this.nudge(nudges[b.dataset.nudge]);
      }));
      this.root.querySelector('[data-open-editor]').addEventListener('click', () => this.openEditor());
      if (el.dialog) {
        this.root.querySelectorAll('[data-editor-done]').forEach(b => b.addEventListener('click', () => this.closeEditor()));
        el.dialog.addEventListener('close', () => this.closeEditor());
        this.root.querySelector('[data-editor-revert]').addEventListener('click', () => this.revertEditor());
        el.font.addEventListener('change', () => { const wasDefault = this.isDefaultLayout(); this.state.name.font = el.font.value; this.fontsReady().then(() => { if (this.reflow(wasDefault, false)) this.placeDefault(); this.changed({ design: true }); }); });
        el.fill.addEventListener('input', () => { this.state.name.fill = el.fill.value; this.changed({ design: true }); });
        el.stroke.addEventListener('input', () => { this.state.name.stroke = el.stroke.value; this.changed({ design: true }); });
        el.nameSize.addEventListener('input', () => { this.state.name.size = Number(el.nameSize.value); this.changed({ design: true }); });
      }
      el.seeAll.addEventListener('click', () => {
        const collapsed = el.swatches.dataset.collapsed === 'true';
        el.swatches.dataset.collapsed = String(!collapsed);
        el.seeAll.textContent = collapsed ? T('Show fewer backgrounds') : T('See all backgrounds');
        el.seeAll.setAttribute('aria-expanded', String(collapsed));
      });
      // drag & drop on the stage and on the upload box
      this.root.querySelectorAll('[data-dropzone]').forEach(zone => {
        zone.addEventListener('dragover', e => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); zone.classList.add('is-dragover'); if (zone === el.stage) el.dropHint.hidden = false; } });
        zone.addEventListener('dragleave', () => { zone.classList.remove('is-dragover'); el.dropHint.hidden = true; });
        zone.addEventListener('drop', e => {
          e.preventDefault(); zone.classList.remove('is-dragover'); el.dropHint.hidden = true;
          const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
          if (file) this.handleFile(file);
        });
      });
    }

    /** Mug style: re-places the pet and name (an adjusted layout is replaced, like Reset). */
    setStyle(style, opts = {}) {
      this.state.style = style;
      this.el.styles.forEach(b => { const on = b.dataset.style === style; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
      if (opts.silent) return;
      this.placeDefault();
      this.changed({ design: true });
    }

    /* ----- backgrounds ----- */
    initBackgrounds() {
      const B = this.B;
      const ids = String(this.config.patterns || '').split(',').map(s => s.trim()).filter(Boolean);
      const builtIn = (ids.length ? ids : B.list.map(b => b.id)).map(id => B.byId[id]).filter(Boolean)
        .map(b => ({ id: b.id, kind: b.kind, name: b.name, color: b.color, swatch: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(B.swatchSvg(b.id)) }));
      const tpl = this.root.querySelector('[data-image-backgrounds]');
      const images = tpl ? Array.from(tpl.content.querySelectorAll('i')).map(i => ({
        id: i.dataset.id, kind: 'image', name: i.dataset.name, color: i.dataset.color || '#ffffff',
        image: i.dataset.image, preview: i.dataset.preview, swatch: i.dataset.thumb
      })) : [];
      this.backgrounds = builtIn.concat(images);
      const visible = Number(this.el.swatches.dataset.visible) || 11;
      const build = (container, small) => {
        if (!container) return [];
        const buttons = this.backgrounds.map((bg, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'mps__swatch' + (!small && i >= visible ? ' is-extra' : '');
          b.setAttribute('role', 'radio');
          b.setAttribute('aria-checked', 'false');
          b.setAttribute('aria-label', T(bg.name));
          b.title = T(bg.name);
          b.dataset.bg = bg.id;
          b.style.backgroundColor = bg.color;
          if (bg.swatch) b.style.backgroundImage = `url("${bg.swatch}")`;
          b.addEventListener('click', () => this.selectBackground(bg));
          b.addEventListener('keydown', e => this.radioKeys(e, container, '.mps__swatch'));
          return b;
        });
        const picker = document.createElement('label');
        picker.className = 'mps__swatch mps__swatch--picker';
        picker.title = T('Pick any color');
        picker.innerHTML = `<input type="color" value="#f9c9d8" aria-label="${T('Pick any background color')}">`;
        picker.dataset.bg = 'custom';
        const input = picker.querySelector('input');
        const pick = () => this.selectBackground({ id: 'custom', kind: 'solid', name: input.value.toUpperCase(), color: input.value });
        input.addEventListener('input', pick);
        input.addEventListener('click', pick);
        buttons.splice(small ? buttons.length : Math.min(visible, buttons.length), 0, picker);
        container.replaceChildren(...buttons);
        return buttons;
      };
      this.swatchButtons = build(this.el.swatches, false).concat(build(this.el.editorSwatches, true));
      this.el.swatches.dataset.collapsed = 'true';
      this.el.seeAll.hidden = this.backgrounds.length <= visible;

      const param = new URLSearchParams(window.location.search).get('bg');
      const match = v => v && this.backgrounds.find(b => b.id === v || v.endsWith('-' + b.id) || v.endsWith('/' + b.id));
      // ?bg=color/f4d9de: the swatch with that colour, or that exact colour as a custom background
      const hex = /^colou?r\/#?([0-9a-f]{6})$/i.exec(param || '');
      const byColor = hex && (this.backgrounds.find(b => b.kind === 'solid' && b.color.toLowerCase() === `#${hex[1].toLowerCase()}`)
        || { id: 'custom', kind: 'solid', name: `#${hex[1].toUpperCase()}`, color: `#${hex[1].toLowerCase()}` });
      const initial = byColor || match(param) || match(this.config.defaultBackground) || this.backgrounds[0];
      if (initial) this.selectBackground(initial, { silent: true });
    }
    selectBackground(bg, opts = {}) {
      const s = this.state;
      s.background = { id: bg.id, kind: bg.kind, name: bg.name, color: bg.color, image: bg.image, preview: bg.preview };
      s.bgImage = null;
      this.swatchButtons.forEach(b => {
        const on = b.dataset.bg === bg.id;
        b.setAttribute('aria-checked', String(on));
        if (b.tagName === 'BUTTON') b.tabIndex = on ? 0 : -1;
        if (on && b.classList.contains('is-extra')) this.el.swatches.dataset.collapsed = 'false';
      });
      this.el.bgNames.forEach(n => { n.textContent = T(bg.name); });
      if (this.isPortrait()) this.applyStyleText();
      // The preview area takes the chosen background color itself, so the design and the page match.
      this.el.stage.style.setProperty('--mps-stage', bg.color);
      if (this.el.dialog) this.el.dialog.style.setProperty('--mps-stage', bg.color);
      if (bg.kind === 'image') {
        loadImage(bg.preview || bg.image).then(img => {
          if (this.state.background.id === bg.id) { this.state.bgImage = img; this.renderAll(); }
        }).catch(() => {});
      }
      if (!opts.silent && bg.id !== 'custom') {
        const url = new URL(window.location.href);
        url.searchParams.set('bg', bg.id);
        window.history.replaceState(window.history.state, '', url);
      }
      this.changed({ design: !opts.silent });
    }
    radioKeys(e, group, selector) {
      const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      const items = Array.from(group.querySelectorAll(selector)).filter(b => !b.disabled && b.tagName === 'BUTTON' && b.offsetParent);
      const i = items.indexOf(e.currentTarget);
      const next = items[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      next.focus(); next.click();
    }
    /** Pattern backgrounds are SVG rendered at the device size of the box (cached). */
    patternImage(w, h) {
      const bg = this.state.background;
      const key = `${bg.id}|${bg.color}|${w}x${h}`;
      let entry = this.svgCache.get(key);
      if (!entry) {
        entry = { img: null };
        this.svgCache.set(key, entry);
        if (this.svgCache.size > 12) this.svgCache.delete(this.svgCache.keys().next().value);
        const svg = this.B.svg(bg, w, h);
        this.pendingLoads = (this.pendingLoads || 0) + 1;
        loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)).then(img => { entry.img = img; this.renderAll(); }).catch(() => {})
          .finally(() => { this.pendingLoads--; });
      }
      return entry.img;
    }

    /* ----- variants & print size ----- */
    initVariants() {
      const { config } = this;
      const initial = config.variants.find(v => v.id === config.currentVariantId) || config.variants.find(v => v.available) || config.variants[0];
      this.selectedOptions = initial ? initial.options.slice() : [];
      this.el.optionGroups.forEach(group => {
        const index = Number(group.dataset.optionGroup) - 1;
        const heading = group.closest('.mps__group') && group.closest('.mps__group').querySelector('.mps__label');
        if (heading) heading.textContent = T(heading.textContent.trim());
        group.querySelectorAll('[data-option-value]').forEach(button => {
          const inches = parseInches(button.dataset.optionValue);
          const oz = /^(\d+(?:\.\d+)?)\s*oz$/i.exec(button.dataset.optionValue.trim());
          if (oz) {
            button.querySelector('[data-size-main]').textContent = `${oz[1]} oz`;
            button.querySelector('[data-size-sub]').textContent = `${Math.round(Number(oz[1]) * 29.574 / 5) * 5} ml`;
          } else if (inches) {
            const inText = `${inches.w} × ${inches.h} in`, cmText = `${Math.round(inches.w * 2.54)} × ${Math.round(inches.h * 2.54)} cm`;
            button.querySelector('[data-size-main]').textContent = METRIC ? cmText : inText;
            button.querySelector('[data-size-sub]').textContent = METRIC ? inText : cmText;
          } else {
            // Option values stay in English (the studio logic reads them); only the label is translated.
            const main = button.querySelector('[data-size-main]');
            main.textContent = button.dataset.optionValue.split(' / ').map(x => T(x.trim())).join(' / ');
          }
          const hex = /colou?r/i.test((config.optionNames || [])[index] || '') && colorHex(button.dataset.optionValue);
          if (hex) {
            const dot = document.createElement('span');
            dot.className = 'mps__color-dot';
            dot.style.backgroundColor = hex;
            dot.setAttribute('aria-hidden', 'true');
            button.prepend(dot);
            button.classList.add('mps__option--color');
          }
          const frame = this.isPortrait() && this.P.frameKind(button.dataset.optionValue);
          if (frame && /frame|finish|format/i.test((config.optionNames || [])[index] || '')) {
            const chip = document.createElement('span');
            chip.className = `mps__frame-chip mps__frame-chip--${frame}`;
            chip.setAttribute('aria-hidden', 'true');
            button.prepend(chip);
            button.classList.add('mps__option--frame');
          }
          button.addEventListener('click', () => { this.selectedOptions[index] = button.dataset.optionValue; this.resolveVariant(index); });
          button.addEventListener('keydown', e => this.radioKeys(e, group, '[data-option-value]'));
        });
      });
      this.resolveVariant(-1, { silent: true });
    }
    resolveVariant(changedIndex, opts = {}) {
      const { config } = this;
      const match = o => config.variants.find(v => v.options.every((x, i) => x === o[i]));
      let variant = match(this.selectedOptions);
      if (!variant || !variant.available) {
        const candidates = config.variants.filter(v => v.available && (changedIndex < 0 || v.options[changedIndex] === this.selectedOptions[changedIndex]));
        const score = v => v.options.reduce((s, o, i) => s + (o === this.selectedOptions[i] ? 1 : 0), 0);
        candidates.sort((a, b) => score(b) - score(a));
        variant = candidates[0] || variant || config.variants[0];
      }
      const before = this.state.variant ? this.printSize() : null;
      const shapeBefore = this.shape();
      this.state.variant = variant;
      this.selectedOptions = variant.options.slice();
      this.el.optionGroups.forEach(group => {
        const index = Number(group.dataset.optionGroup) - 1;
        group.querySelectorAll('[data-option-value]').forEach(button => {
          const value = button.dataset.optionValue;
          const selected = this.selectedOptions[index] === value;
          const possible = config.variants.some(v => v.available && v.options[index] === value);
          button.setAttribute('aria-checked', String(selected));
          button.tabIndex = selected ? 0 : -1;
          button.disabled = !possible && !selected;
        });
      });
      if (!opts.silent) {
        const url = new URL(window.location.href);
        url.searchParams.set('variant', variant.id);
        window.history.replaceState(window.history.state, '', url);
      }
      if (this.isPortrait()) this.portraitOptions();
      if (before && (shapeBefore !== this.shape() || this.isPortrait()) && this.isDefaultLayout()) { this.placeDefault(); }
      else if (before) this.keepPetAnchored(before);
      this.fetchTemplate(variant);
      this.changed({ design: !opts.silent, price: true });
    }
    /** The design area. Mugs: one side, half of the Printify wrap (the same side is printed on both halves). */
    printSize(variant = this.state.variant) {
      const full = this.wrapSize(variant);
      return this.isMug() ? { width: Math.round(full.width / 2), height: full.height, source: full.source } : full;
    }
    /** The whole Printify print area. */
    wrapSize(variant = this.state.variant) {
      if (this.isPortrait() && this.isDigital(variant)) {
        const d = this.config.digitalPrint || {};
        return { width: d.width || 4800, height: d.height || 6000, source: 'digital' };
      }
      const fromPrintify = variant && this.templates.get(variant.id);
      if (fromPrintify) return fromPrintify;
      const inches = !this.isMug() && variant && parseInches(variant.options[0] || variant.title);
      const dpi = this.config.printDpi || 150;
      if (inches) return { width: Math.round(inches.w * dpi), height: Math.round(inches.h * dpi), source: 'size' };
      const f = this.config.fallbackPrint;
      return f && f.width > 0 && f.height > 0 ? { width: f.width, height: f.height, source: 'default' } : { width: 5000, height: 6000, source: 'default' };
    }
    async fetchTemplate(variant) {
      const endpoint = this.config.templateEndpoint;
      if (!endpoint || !variant || !variant.sku || this.templates.has(variant.id) || (this.isPortrait() && this.isDigital(variant))) return;
      this.templates.set(variant.id, null);
      try {
        const url = new URL(endpoint);
        url.searchParams.set('sku', variant.sku);
        const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('template');
        const json = await res.json();
        if (json.width > 0 && json.height > 0) {
          const before = this.printSize(variant);
          this.templates.set(variant.id, { width: Math.round(json.width), height: Math.round(json.height), source: 'printify' });
          if (variant === this.state.variant) {
            if (this.isDefaultLayout()) this.placeDefault(); else this.keepPetAnchored(before);
            this.changed({ price: true });
          }
        }
      } catch (e) { this.templates.delete(variant.id); }
    }
    /** When the print proportions change, keep a pet that sits on the bottom edge on the bottom edge. */
    keepPetAnchored(before) {
      if (!this.state.artwork) return;
      const now = this.printSize();
      if (before.width / before.height === now.width / now.height) return;
      const pet = this.state.pet;
      const hBefore = this.petHeightFrac(pet.w, before), hNow = this.petHeightFrac(pet.w, now);
      const bottom = pet.cy + hBefore / 2;
      if (bottom >= 0.97) pet.cy = bottom - hNow / 2;
      this.clampAll();
    }
    updatePrice() {
      const v = this.state.variant;
      if (!v) return;
      const money = c => formatMoney(c, this.config.moneyFormat);
      this.root.querySelectorAll('[data-price]').forEach(n => { n.textContent = money(v.price); });
      this.root.querySelectorAll('[data-compare-price]').forEach(n => { n.textContent = v.compareAtPrice > v.price ? money(v.compareAtPrice) : ''; });
      if (this.el.priceInline) this.el.priceInline.textContent = money(v.price);
      if (this.el.printInfo) {
        this.el.printInfo.textContent = v.available ? '' : T('Sold out');
        this.el.printInfo.hidden = v.available;
      }
    }

    /* ----- gallery: "Your design" plus product photos as thumbnails under the preview ----- */
    initGallery() {
      const { el, config } = this;
      if (!el.thumbs || !config.media.length) return;
      config.media.forEach((m, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'mps__thumb-btn';
        b.setAttribute('aria-label', T('Product photo {n}', { n: i + 1 }));
        b.setAttribute('aria-current', 'false');
        const img = document.createElement('img');
        img.src = m.thumb; img.alt = ''; img.loading = 'lazy'; img.width = 64; img.height = 64;
        b.appendChild(img);
        b.addEventListener('click', () => { this.toggleGallery(true); this.showGalleryImage(i); });
        el.thumbs.appendChild(b);
      });
      el.thumbDesign.addEventListener('click', () => this.toggleGallery(false));
      this.root.querySelector('[data-gallery-prev]').addEventListener('click', () => this.stepGallery(-1));
      this.root.querySelector('[data-gallery-next]').addEventListener('click', () => this.stepGallery(1));
      if (config.galleryLarge) {
        // Large photo gallery: open on the first photo until the shopper has a design; swipe the main photo on phones.
        this.root.dataset.galleryStyle = 'large';
        this.toggleGallery(true);
        let x0 = null;
        el.gallery.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse') x0 = e.clientX; });
        el.gallery.addEventListener('pointerup', e => {
          if (x0 === null) return;
          const dx = e.clientX - x0; x0 = null;
          if (Math.abs(dx) > 40) this.stepGallery(dx < 0 ? 1 : -1);
        });
        el.gallery.addEventListener('pointercancel', () => { x0 = null; });
      }
      el.gallery.addEventListener('keydown', e => {
        if (e.key === 'ArrowLeft') this.showGalleryImage(this.state.galleryIndex - 1);
        if (e.key === 'ArrowRight') this.showGalleryImage(this.state.galleryIndex + 1);
        if (e.key === 'Escape') this.toggleGallery(false);
      });
    }
    toggleGallery(force) {
      const open = typeof force === 'boolean' ? force : !this.state.galleryOpen;
      this.state.galleryOpen = open;
      this.el.gallery.hidden = !open;
      if (open) this.showGalleryImage(this.state.galleryIndex);
      else this.markThumb(-1);
    }
    markThumb(i) {
      if (!this.el.thumbs) return;
      Array.from(this.el.thumbs.children).forEach((b, j) => {
        const on = j === i + 1;
        b.setAttribute('aria-current', String(on));
        if (on && this.config.galleryLarge) {
          // Keep the selected thumbnail in view without scrolling the page.
          const row = this.el.thumbs, left = b.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft, right = left + b.offsetWidth;
          if (left < row.scrollLeft) row.scrollTo({ left: left - 8, behavior: 'smooth' });
          else if (right > row.scrollLeft + row.clientWidth) row.scrollTo({ left: right - row.clientWidth + 8, behavior: 'smooth' });
        }
      });
    }
    /** Previous / next. With a design, "Your design" sits before the first photo. */
    stepGallery(dir) {
      const n = this.config.media.length;
      if (!n) return;
      const withDesign = !!this.state.artwork;
      const pos = this.state.galleryOpen ? this.state.galleryIndex + (withDesign ? 1 : 0) : 0;
      const total = n + (withDesign ? 1 : 0);
      const next = (pos + dir + total) % total;
      if (withDesign && next === 0) { this.toggleGallery(false); return; }
      if (!this.state.galleryOpen) this.toggleGallery(true);
      this.showGalleryImage(next - (withDesign ? 1 : 0));
    }
    showGalleryImage(index) {
      const media = this.config.media;
      if (!media.length) return;
      const i = (index + media.length) % media.length;
      this.state.galleryIndex = i;
      const img = document.createElement('img');
      img.src = media[i].src; img.alt = media[i].alt || '';
      this.el.galleryMain.replaceChildren(img);
      this.markThumb(i);
    }

    /* ----- upload & generation ----- */
    primaryAction() {
      const s = this.state;
      if (s.phase === 'generating' || this.adding) return;
      if (!s.artwork) { this.el.fileInput.click(); return; }
      this.approveAndAdd();
    }
    async handleFile(file) {
      this.clearError();
      if (this.state.galleryOpen) this.toggleGallery(false);
      const maxMb = this.config.maxUploadMb || 20;
      const type = (file.type || '').toLowerCase();
      if (!(ACCEPTED.includes(type) || isHeic(file) || /\.(jpe?g|png|webp)$/i.test(file.name || ''))) {
        return this.showError(new StudioError('type', T('Please choose a photo in JPG, PNG, WebP or HEIC format.'), false));
      }
      if (file.size > maxMb * 1024 * 1024) {
        return this.showError(new StudioError('size', T('That photo is larger than {mb} MB. Please choose a smaller one.', { mb: maxMb }), false));
      }
      this.setPhotoStatus(T('Checking your photo…'));
      let hash;
      try { hash = await sha256Hex(file); } catch (e) { hash = `${file.name}|${file.size}|${file.lastModified}`; }
      let bitmap;
      try {
        bitmap = await decodeFile(file);
      } catch (e) {
        if (isHeic(file)) {
          try { bitmap = await decodeFile(await heicToJpeg(file)); } catch (err) { /* handled below */ }
        }
        if (!bitmap) return this.showError(new StudioError('decode', isHeic(file)
          ? T('We couldn’t convert this HEIC photo. Please choose a JPG or PNG version (on iPhone: Share › Save as JPEG, or take a screenshot).')
          : T('We couldn’t read that file. Please try a different photo.'), false));
      }
      const minSide = this.config.minPhotoSide || 500;
      if (Math.min(bitmap.width, bitmap.height) < minSide) {
        if (bitmap.close) bitmap.close();
        return this.showError(new StudioError('small', T('This photo is too small to print well ({w} × {h} px). Please use one at least {min} px on its shortest side.', { w: bitmap.width, h: bitmap.height, min: minSide }), false));
      }
      let blob;
      try { blob = await normalizePhoto(bitmap); }
      catch (e) { return this.showError(new StudioError('decode', T('We couldn’t prepare that photo. Please try a different one.'), false)); }
      finally { if (bitmap.close) bitmap.close(); }
      if (this.state.photo && this.state.photo.url) URL.revokeObjectURL(this.state.photo.url);
      this.state.photo = { blob, hash, url: URL.createObjectURL(blob) };
      kv.set(`photo:${this.config.productId}`, { blob, hash, at: Date.now() });
      this.generate();
    }
    retry() {
      if (this.state.photo) this.generate();
      else this.el.fileInput.click();
    }
    /** "Regenerate artwork": a fresh AI portrait from the same photo (counts towards the daily limit). */
    regenerate() {
      if (!this.state.photo || this.state.phase === 'generating') return;
      this.generate({ force: true });
    }
    generationsToday() {
      try {
        const list = JSON.parse(localStorage.getItem('mps-generations') || '[]').filter(t => Date.now() - t < 864e5);
        return list;
      } catch (e) { return []; }
    }
    async generate({ force = false } = {}) {
      const id = ++this.generationId;
      if (this.abortController) this.abortController.abort();
      const controller = new AbortController();
      this.abortController = controller;
      const timeout = setTimeout(() => controller.abort('timeout'), GENERATION_TIMEOUT_MS);
      const photo = this.state.photo;
      this.clearError();
      this.setPhase('generating');
      this.startProgress();
      const started = performance.now();
      try {
        // With an AI service that paints each style itself, every style is its own (cached) portrait.
        const artKey = this.isPortrait() && this.config.aiStyles ? `art:${photo.hash}:${this.state.artStyle}` : `art:${photo.hash}`;
        let art = force ? null : await kv.get(artKey);
        let fromCache = !!(art && art.blob);
        if (!fromCache) {
          const used = this.generationsToday();
          if (used.length >= (this.config.generationLimit || 8)) {
            throw new StudioError('limit', T('You’ve reached today’s limit for new portraits. Your earlier photos still work, or come back tomorrow.'), false);
          }
          if (!this.config.aiEndpoint) throw new StudioError('not_configured', T('Our portrait service isn’t connected yet. Please try again later.'), false);
          const canvas = await this.requestPortrait(controller.signal);
          try { localStorage.setItem('mps-generations', JSON.stringify(used.concat(Date.now()))); } catch (e) { /* private mode */ }
          const blob = await canvasToBlob(canvas, 'image/png');
          art = { blob, sha256: await sha256Hex(blob), w: canvas.width, h: canvas.height };
          kv.set(artKey, { ...art, at: Date.now() });
        }
        if (id !== this.generationId) return;
        const img = await loadImage(URL.createObjectURL(art.blob));
        const hadArtwork = !!this.state.artwork;
        if (this.isPortrait()) {
          await this.setBaseArt(img, { blob: art.blob, sha256: art.sha256, w: art.w, h: art.h });
          if (id !== this.generationId) return;
        } else {
          this.state.artwork = img;
          this.state.art = { blob: art.blob, sha256: art.sha256, w: art.w, h: art.h };
        }
        if (!hadArtwork || SHAPE_FIT[this.shape()] || this.isMug() || this.isPortrait()) this.placeDefault(); else { this.placePet(); this.clampAll(); }
        this.stopProgress();
        this.setPhase('ready');
        this.setPhotoStatus(fromCache ? T('Portrait ready (saved from before)') : T('Portrait ready'));
        const ms = Math.round(performance.now() - started);
        if (!fromCache) this.root.dispatchEvent(new CustomEvent('pet-studio:generated', { bubbles: true, detail: { ms } }));
        this.changed({ design: true, commit: true });
      } catch (err) {
        if (id !== this.generationId) return;
        this.stopProgress();
        let error = err;
        // fetch rejects with the abort reason itself ('timeout' / 'cancel') in current browsers, so check the signal.
        if (controller.signal.aborted || (err && err.name === 'AbortError')) {
          const reason = controller.signal.reason;
          if (reason === 'timeout') error = new StudioError('timeout', T('This is taking longer than usual. Please try again. Your photo and choices are saved.'));
          else if (reason === 'cancel') error = new StudioError('cancelled', T('Stopped. Your photo and choices are saved. Try again whenever you’re ready.'));
          else error = null;
        } else if (!(err instanceof StudioError)) {
          error = new StudioError('network', T('We couldn’t reach our portrait service. Check your connection and try again. Your photo and choices are saved.'));
        }
        this.setPhase(this.state.artwork ? 'ready' : 'error');
        if (error) this.showError(error);
      } finally {
        clearTimeout(timeout);
      }
    }
    async requestPortrait(signal) {
      const form = new FormData();
      form.append('image', this.state.photo.blob, 'pet.jpg');
      form.append('product', String(this.config.productId));
      form.append('shape', 'blanket');
      if (this.isPortrait() && this.config.aiStyles) form.append('style', this.state.artStyle);
      this.setProgress(0.06, T('Uploading your photo and creating your portrait…'));
      const res = await fetch(this.config.aiEndpoint, { method: 'POST', body: form, signal, headers: { Accept: 'application/json, image/png' } });
      if (!res.ok) {
        let info = {};
        try { info = await res.json(); } catch (e) { /* ignore */ }
        const messages = {
          400: T('That photo couldn’t be processed. Please try a different one.'),
          413: T('That photo is too large. Please choose a smaller one.'),
          422: T('We couldn’t find a pet in that photo. Please use a clear photo with one pet and its face visible.'),
          429: T('Lots of people are designing right now. Please wait a minute and try again.')
        };
        throw new StudioError(info.code || `http_${res.status}`, info.message || messages[res.status] || T('Our portrait service had a hiccup. Please try again.'), res.status !== 422 && res.status !== 413);
      }
      this.setProgress(0.8, T('Cutting out your pet…'));
      let image, background = 'chroma';
      const type = res.headers.get('content-type') || '';
      if (type.includes('application/json')) {
        const json = await res.json();
        if (!json.image) throw new StudioError('bad_response', T('Our portrait service returned an empty result. Please try again.'));
        background = json.background || 'chroma';
        image = await loadImage(json.image);
      } else {
        background = res.headers.get('x-background') || 'chroma';
        image = await loadImage(URL.createObjectURL(await res.blob()));
      }
      if (background === 'transparent') {
        const c = createCanvas(image.width, image.height);
        c.getContext('2d').drawImage(image, 0, 0);
        return trimTransparent(c);
      }
      const { canvas, removedRatio } = removeFlatBackground(image);
      if (removedRatio > 0.97 || removedRatio === 0) throw new StudioError('no_subject', T('We couldn’t separate your pet from the background. Please try again or use a different photo.'));
      return canvas;
    }
    /* ----- generation progress (inline in the personalization column) -----
     * Real stages come from requestPortrait(); between them the bar creeps towards 92% on an
     * estimated curve and is labelled as an estimate. It only completes when the artwork is ready. */
    startProgress() {
      const { el } = this;
      const start = performance.now();
      const expected = this.config.progressSeconds || 60;
      const steps = [[0, T('Uploading your photo and creating your portrait…')]];
      this.progressFloor = 0;
      this.progressLocked = false;
      el.gen.hidden = false;
      el.genFill.style.width = '0%';
      el.genStatus.textContent = steps[0][1];
      el.genTime.textContent = '';
      cancelAnimationFrame(this.progressTimer);
      clearInterval(this.progressClock);
      const tick = () => {
        const t = (performance.now() - start) / 1000;
        const value = Math.min(0.92, Math.max(this.progressFloor, 0.92 * (1 - Math.exp(-t / (expected / 2.2)))));
        el.genFill.style.width = `${(value * 100).toFixed(1)}%`;
        el.genBar.setAttribute('aria-valuenow', String(Math.round(value * 100)));
        if (!this.progressLocked) {
          const label = steps.filter(x => value >= x[0]).pop()[1];
          if (el.genStatus.textContent !== label) el.genStatus.textContent = label;
        }
        this.progressTimer = requestAnimationFrame(tick);
      };
      const clock = () => {
        const elapsed = Math.floor((performance.now() - start) / 1000);
        el.genTime.textContent = elapsed < expected
          ? T('Working for {s} s. This usually takes up to {max} s.', { s: elapsed, max: expected })
          : T('Your portrait is taking a little longer. We’re still working on it.');
        el.genTime.classList.toggle('is-late', elapsed >= expected);
      };
      tick(); clock();
      this.progressClock = setInterval(clock, 1000);
      this.carousel && this.carousel.start();
      if (window.matchMedia('(max-width: 899px)').matches) requestAnimationFrame(() => el.gen.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
    setProgress(value, label) {
      this.progressFloor = Math.max(this.progressFloor || 0, value);
      if (label) { this.el.genStatus.textContent = label; this.progressLocked = value > 0.5; }
    }
    stopProgress() {
      cancelAnimationFrame(this.progressTimer);
      clearInterval(this.progressClock);
      this.carousel && this.carousel.stop();
      this.el.gen.hidden = true;
    }
    cancelGeneration() {
      if (this.state.phase !== 'generating' || !this.abortController) return;
      this.abortController.abort('cancel');
    }
    initReviews() {
      const { el } = this;
      const link = this.root.querySelector('[data-reviews-link]');
      if (link) link.addEventListener('click', e => {
        const target = document.getElementById(link.getAttribute('href').slice(1));
        if (!target) return;
        e.preventDefault();
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
        target.focus({ preventScroll: true });
      });
      if (el.genCancel) el.genCancel.addEventListener('click', () => this.cancelGeneration());
      const box = this.root.querySelector('[data-carousel]');
      const json = this.root.querySelector('[data-gen-reviews-json]');
      let reviews = [];
      try { reviews = JSON.parse(json ? json.textContent : '[]').filter(r => r && r.name && r.text); } catch (e) { reviews = []; }
      if (box && reviews.length) this.carousel = new ReviewCarousel(box, reviews);
    }
    showError(err) {
      this.el.errorText.textContent = err.message;
      this.el.retry.hidden = !(err.retryable && this.state.photo);
      this.el.error.hidden = false;
      if (!this.state.artwork && this.state.phase !== 'generating') this.setPhase(this.state.photo ? 'error' : 'empty');
      this.setPhotoStatus(this.state.photo ? T('Your photo') : '');
    }
    clearError() { this.el.error.hidden = true; }
    setPhotoStatus(text) { if (this.el.photoStatus) this.el.photoStatus.textContent = text; }

    /* ----- geometry (all positions are fractions of the print area) ----- */
    petHeightFrac(w, size = this.printSize()) {
      const a = this.state.artwork;
      if (!a) return 0;
      return (w * size.width * (a.height / a.width)) / size.height;
    }
    safe() { return clamp(this.config.safeInset || 0.05, 0, 0.2); }
    shape() { return this.config.family === 'ornament' ? shapeFromOptions(this.state.variant && this.state.variant.options) || 'circle' : null; }
    isMug() { return this.config.family === 'mug'; }
    isPortrait() { return this.config.family === 'portrait' && !!this.P; }
    familyKey() { return ['ornament', 'mug', 'portrait'].includes(this.config.family) ? this.config.family : 'blanket'; }
    /** Accent colour of the selected mug (handle and inside), from its colour option; white when it has none. */
    mugColor() {
      const v = this.state.variant;
      if (!v) return MUG_COLORS.white;
      const names = this.config.optionNames || [];
      const i = names.findIndex(n => /colou?r/i.test(n));
      return (i >= 0 && colorHex(v.options[i])) || v.options.map(colorHex).find(Boolean) || MUG_COLORS.white;
    }
    /** Where the design area sits inside a W x H view: real proportions, centred (mugs leave room for the handle and rim). */
    fitBox(W, H) {
      const { width, height } = this.printSize();
      const mug = this.isMug();
      const inset = Math.min(W, H) * (mug ? 0.09 : 0.07);
      const availW = W - inset * 2, availH = H - inset * 2;
      const scale = mug
        ? Math.min(availW / (width * (1 + MUG_HANDLE)), availH / (height + 3.2 * MUG_RIM * width))
        : Math.min(availW / width, availH / height);
      const w = width * scale, h = height * scale;
      return { x: (W - w * (mug ? 1 + MUG_HANDLE : 1)) / 2, y: (H - h) / 2 + (mug ? MUG_RIM * w * 0.5 : 0), w, h };
    }
    /** Default placement. Blankets: name on top, pet on the bottom edge. Ornaments: pet on the bottom edge
     *  (the outline hides where the portrait ends) with the name across its chest, inside the shape. */
    layout() {
      const shape = this.shape();
      if (!shape) return null;
      const named = !!this.state.name.text;
      if (this.captionLines().length) {
        // Name plus a year, dates or message: a smaller pet and the text block a little higher.
        const C = {
          circle: { pet: 0.74, name: [0.71, 0.13] },
          snowflake: { pet: 0.7, name: [0.66, 0.115] },
          heart: { pet: 0.7, name: [0.57, 0.115] },
          star: { pet: 0.64, name: [0.62, 0.09] }
        };
        return C[shape] || C.circle;
      }
      const L = {
        circle: { pet: named ? 0.84 : 0.9, name: [0.8, 0.15] },
        snowflake: { pet: named ? 0.8 : 0.86, name: [0.72, 0.13] },
        heart: { pet: named ? 0.8 : 0.86, name: [0.66, 0.13] },
        star: { pet: named ? 0.72 : 0.8, name: [0.7, 0.1] }
      };
      return L[shape] || L.circle;
    }
    isDefaultLayout() {
      return !!this.defaultLayout && this.defaultLayout === this.layoutKey();
    }
    /** Whether a text edit re-flows the layout: star and heart layouts re-fit on every edit until the shopper moves something. */
    reflow(wasDefault, linesChanged) {
      if (SHAPE_FIT[this.shape()] || this.isMug() || this.isPortrait()) return wasDefault || !this.state.artwork;
      return wasDefault && linesChanged;
    }
    layoutKey() {
      const n = this.state.name;
      return JSON.stringify([this.state.pet, n.cx, n.cy, n.size, n.rot, n.cap || 0, n.breaks || []]);
    }
    font(px, key = this.state.name.font) {
      const f = FONTS[key] || FONTS.fredoka;
      return `${f.weight} ${px}px "${f.family}",${f.fallback ? ` "${f.fallback}",` : ''} "Arial Rounded MT Bold", Arial, sans-serif`;
    }
    /** The part of the print area that is seen from the front (portraits on canvas: the wrapped edges are not). */
    faceRect() {
      if (!this.isPortrait()) return { x: 0, y: 0, w: 1, h: 1 };
      const p = this.printSize(), inches = this.sizeInches();
      if (!inches || p.source !== 'printify' || this.isDigital()) return { x: 0, y: 0, w: 1, h: 1 };
      // Printify canvas print areas include the wrap: (W + 2b) x (H + 2b) inches at one dpi. Solve for b.
      const { w: W, h: H } = inches, PW = p.width, PH = p.height;
      if (Math.abs(PW - PH) < 1) return { x: 0, y: 0, w: 1, h: 1 };
      const b = (PH * W - PW * H) / (2 * (PW - PH));
      if (!(b > 0.05 && b < 4)) return { x: 0, y: 0, w: 1, h: 1 };
      const fx = b / (W + 2 * b), fy = b / (H + 2 * b);
      return { x: fx, y: fy, w: 1 - 2 * fx, h: 1 - 2 * fy };
    }
    /** Where the pet's head and the text may go, in print fractions (the face inset by the safe margin). */
    safeRect() {
      const p = this.printSize(), f = this.faceRect();
      const sx = this.safe(), sy = sx * (p.width * f.w) / (p.height * f.h);
      return { x0: f.x + sx * f.w, y0: f.y + sy * f.h, x1: f.x + f.w * (1 - sx), y1: f.y + f.h * (1 - sy) };
    }
    /** Name font size (fraction of print width) after shrinking it to fit inside the safe area. */
    nameSize() {
      const n = this.state.name;
      if (!n.text) return n.size;
      const ctx = this.measureCtx;
      ctx.font = this.font(100);
      const w = ctx.measureText(n.text).width / 100; // width per unit font size
      const r = this.safeRect(), maxW = r.x1 - r.x0;
      return Math.min(n.size, maxW / Math.max(w, 0.01) * 0.98);
    }
    /** Optional lines under the name, from the year / dates / message fields this product offers. */
    captionLines() {
      const e = this.state.extra, clean = t => String(t || '').replace(/\s+/g, ' ').trim();
      if (this.config.extraFields === 'year') return [clean(e.year)].filter(Boolean);
      if (this.config.extraFields === 'memorial') return [clean(e.dates), clean(e.message)].filter(Boolean);
      if (this.config.extraFields === 'line') return [clean(e.message)].filter(Boolean);
      if (this.config.extraFields === 'portrait') return [this.state.artStyle === 'memorial' ? clean(e.dates) : '', clean(e.message)].filter(Boolean);
      return [];
    }
    /** The name or its caption lines exist (both are moved together as one "name" element). */
    hasLabel() { return !!this.state.name.text || this.captionLines().length > 0; }
    /** Caption placement in print fractions: centred under the name and rotated with it.
     *  The backend draws exactly these numbers (backend/lib/render.js captionLayer). */
    caption(p = this.printSize()) {
      const n = this.state.name, W = p.width, H = p.height;
      const ctx = this.measureCtx;
      ctx.font = this.font(100);
      let lines = this.captionLines();
      if (!lines.length) return null;
      // Star and heart layouts may wrap a line (n.breaks) and set their own caption size (n.cap, relative to the name).
      if (n.breaks && n.breaks.length) {
        const measure = t => ctx.measureText(t).width;
        lines = lines.flatMap((l, i) => (n.breaks.includes(i) ? splitLine(l, measure) : [l]));
      }
      const ns = n.text ? this.nameSize() : 0;
      const widest = Math.max(...lines.map(l => ctx.measureText(l).width / 100), 0.01);
      const sr = this.safeRect();
      const maxW = n.cap ? 0.9 : (this.shape() ? 0.62 : sr.x1 - sr.x0);
      const base = n.text ? ns * (n.cap || CAPTION_RATIO) : n.size * (n.cap || 0.6);
      const size = Math.min(base, (maxW / widest) * 0.98, 0.3);
      const k = lines.length;
      // distance (px) from the name centre to the caption block centre
      const dy = n.text ? (0.62 * ns + 0.5 * size + ((k - 1) / 2) * CAPTION_LINE * size) * W : 0;
      const a = n.rot * DEG;
      return {
        lines, size, rot: n.rot, font: n.font, fill: n.fill, stroke: n.stroke,
        cx: n.cx + (-Math.sin(a) * dy) / W, cy: n.cy + (Math.cos(a) * dy) / H
      };
    }
    /** Object box in pixels inside a `box` drawn at x/y/w/h. */
    geometry(which, box) {
      const s = this.state;
      if (which === 'pet') {
        if (!s.artwork) return null;
        const w = s.pet.w * box.w, h = w * (s.artwork.height / s.artwork.width);
        return { x: box.x + s.pet.cx * box.w, y: box.y + s.pet.cy * box.h, w, h, rot: s.pet.rot };
      }
      if (!this.hasLabel()) return null;
      // Box in the name's own (rotated) frame, origin at the name centre: name line plus caption lines.
      let top = Infinity, bottom = -Infinity, half = 0;
      const size = this.nameSize() * box.w;
      if (s.name.text) {
        this.measureCtx.font = this.font(size);
        half = (this.measureCtx.measureText(s.name.text).width + size * 0.3) / 2;
        top = -size * 0.6; bottom = size * 0.6;
      }
      const c = this.caption({ width: box.w, height: box.h });
      if (c) {
        const cs = c.size * box.w, a = s.name.rot * DEG;
        // caption centre relative to the name centre, back in the unrotated frame
        const ox = (c.cx - s.name.cx) * box.w, oy = (c.cy - s.name.cy) * box.h;
        const ly = ox * Math.sin(a) + oy * Math.cos(a);
        this.measureCtx.font = this.font(cs);
        c.lines.forEach(l => { half = Math.max(half, (this.measureCtx.measureText(l).width + cs * 0.3) / 2); });
        const blockHalf = ((c.lines.length - 1) * CAPTION_LINE * cs) / 2 + cs * 0.6;
        top = Math.min(top, ly - blockHalf); bottom = Math.max(bottom, ly + blockHalf);
      }
      const mid = (top + bottom) / 2, a = s.name.rot * DEG;
      return {
        x: box.x + s.name.cx * box.w - Math.sin(a) * mid, y: box.y + s.name.cy * box.h + Math.cos(a) * mid,
        w: half * 2, h: bottom - top, rot: s.name.rot, size
      };
    }
    halfExtents(which) {
      const p = this.printSize();
      const box = { x: 0, y: 0, w: p.width, h: p.height };
      const g = this.geometry(which, box);
      if (!g) return null;
      const c = Math.abs(Math.cos(g.rot * DEG)), sn = Math.abs(Math.sin(g.rot * DEG));
      return { hx: (g.w * c + g.h * sn) / 2 / p.width, hy: (g.w * sn + g.h * c) / 2 / p.height };
    }
    /** Keeps the name inside the safe area and the pet's top and sides inside it (the pet may run off the bottom edge). */
    clampAll() {
      const p = this.printSize();
      const r = this.safeRect();
      const pet = this.state.pet, e = this.halfExtents('pet');
      if (e) {
        // A pet wider than the safe area may shift a little but never far off centre.
        pet.cx = e.hx * 2 <= r.x1 - r.x0 ? clamp(pet.cx, r.x0 + e.hx, r.x1 - e.hx) : clamp(pet.cx, 0.4, 0.6);
        const low = SHAPE_FIT[this.shape()] ? 0.95 : 0.6;
        pet.cy = clamp(pet.cy, r.y0 + e.hy, Math.max(r.y0 + e.hy, low + e.hy));
      }
      const name = this.state.name, n = this.halfExtents('name');
      if (n) {
        // clamp the centre of the name + caption block, then move the name by the same amount
        const g = this.geometry('name', { x: 0, y: 0, w: p.width, h: p.height });
        const ox = g.x / p.width - name.cx, oy = g.y / p.height - name.cy;
        const bx = name.cx + ox, by = name.cy + oy;
        name.cx = (n.hx * 2 <= r.x1 - r.x0 ? clamp(bx, r.x0 + n.hx, r.x1 - n.hx) : 0.5) - ox;
        name.cy = (n.hy * 2 <= r.y1 - r.y0 ? clamp(by, r.y0 + n.hy, r.y1 - n.hy) : 0.5) - oy;
      }
    }
    placePet() {
      const s = this.state;
      if (!s.artwork) return;
      const p = this.printSize();
      const L = this.layout();
      if (L) {
        let w = (L.pet * p.height) / (p.width * (s.artwork.height / s.artwork.width));
        w = Math.min(w, 0.86);
        const h = this.petHeightFrac(w);
        s.pet = { cx: 0.5, cy: round4(1 - h / 2), w: round4(w), rot: 0 };
        return;
      }
      const top = this.hasLabel() ? 0.24 : 0.1;
      const aspect = s.artwork.height / s.artwork.width;
      let w = ((1 - top) * p.height) / (p.width * aspect);
      w = Math.min(w, 0.88);
      const h = this.petHeightFrac(w);
      s.pet = { cx: 0.5, cy: 1 - h / 2, w: round4(w), rot: 0 };
    }
    placeDefault() {
      const s = this.state;
      if (this.isMug() || this.isPortrait()) {
        if (this.isMug()) this.placeMug(); else this.placePortrait();
        this.clampAll();
        this.defaultLayout = s.artwork ? this.layoutKey() : null;
        return;
      }
      if (SHAPE_FIT[this.shape()]) {
        this.solveShapeLayout();
        this.clampAll();
        this.defaultLayout = s.artwork ? this.layoutKey() : null;
        return;
      }
      delete s.name.cap; delete s.name.breaks;
      const L = this.layout();
      Object.assign(s.name, L ? { cx: 0.5, cy: L.name[0], size: L.name[1], rot: 0 } : { cx: 0.5, cy: 0.115, size: 0.13, rot: 0 });
      if (L && this.captionLines().length) {
        const p = this.printSize(), g = this.geometry('name', { x: 0, y: 0, w: p.width, h: p.height });
        if (g) s.name.cy = round4(s.name.cy - (g.y / p.height - s.name.cy));
      }
      this.placePet();
      this.clampAll();
      this.defaultLayout = s.artwork ? this.layoutKey() : null;
    }
    /** Mug styles (one side of the mug): "below" = pet with the name and text under it, "above" = name on top and the
     *  pet below, "big" = a large pet on the bottom edge with the name across its chest. */
    placeMug() {
      const s = this.state, p = this.printSize();
      const sx = this.safe(), sy = sx * p.width / p.height, gap = 0.03;
      const style = ['below', 'above', 'big'].includes(s.style) ? s.style : 'below';
      delete s.name.cap; delete s.name.breaks;
      Object.assign(s.name, { cx: 0.5, cy: style === 'above' ? 0.16 : 0.84, size: style === 'big' ? 0.15 : 0.13, rot: 0 });
      // Label block (name + text) edges in print fractions, and a move that puts its top or bottom edge at y.
      const block = () => { const g = this.geometry('name', { x: 0, y: 0, w: p.width, h: p.height }); return g ? { top: (g.y - g.h / 2) / p.height, bottom: (g.y + g.h / 2) / p.height } : null; };
      let b = block();
      if (b && style === 'above') { s.name.cy += sy + 0.01 - b.top; b = block(); }
      if (b && style === 'below') { s.name.cy += 1 - sy - 0.01 - b.bottom; b = block(); }
      if (!s.artwork) return;
      const aspect = s.artwork.height / s.artwork.width;
      const fit = (top, bottom, maxW) => {
        const w = Math.min(((bottom - top) * p.height) / (p.width * aspect), maxW);
        return { cx: 0.5, cy: round4(bottom - this.petHeightFrac(w) / 2), w: round4(w), rot: 0 };
      };
      if (style === 'big' || !b) {
        s.pet = fit(sy + 0.02, 1, 0.98);
        if (b) { s.name.cy += 0.93 - sy - b.bottom; }
      } else if (style === 'above') {
        s.pet = fit(b.bottom + gap, 1, 0.9);
      } else {
        s.pet = fit(sy + 0.01, b.top - gap, 0.9);
      }
    }
    /** Head outline of the portrait (cached per artwork): rows from the top of the ears down to the chin, each with
     *  the left and right edge of the opaque pixels, as fractions of the artwork width and height. */
    headProfile() {
      const art = this.state.artwork;
      if (!art) return null;
      if (this.headCache && this.headCache.art === art) return this.headCache.profile;
      const SW = 160, SH = Math.max(1, Math.round((SW * art.height) / art.width));
      const c = createCanvas(SW, SH), cx = c.getContext('2d');
      cx.drawImage(art, 0, 0, SW, SH);
      const data = cx.getImageData(0, 0, SW, SH).data;
      const rows = [];
      let top = -1, bottom = -1, minX = SW, maxX = -1;
      for (let y = 0; y < SH; y++) {
        let l = -1, r = -1;
        for (let x = 0; x < SW; x++) if (data[(y * SW + x) * 4 + 3] > 32) { if (l < 0) l = x; r = x; }
        rows.push(l < 0 ? null : [l, r]);
        if (l >= 0) { if (top < 0) top = y; bottom = y; minX = Math.min(minX, l); maxX = Math.max(maxX, r); }
      }
      let profile = null;
      if (top >= 0) {
        const opaqueW = maxX - minX + 1, opaqueH = bottom - top + 1;
        const headH = Math.max(4, Math.round(Math.min(0.6 * opaqueH, 0.95 * opaqueW)));
        const pts = [];
        let l0 = SW, r0 = -1;
        for (let y = top; y < Math.min(SH, top + headH); y++) {
          const row = rows[y];
          if (!row) continue;
          pts.push([(y + 0.5) / SH, row[0] / SW, (row[1] + 1) / SW]);
          l0 = Math.min(l0, row[0]); r0 = Math.max(r0, row[1] + 1);
        }
        profile = { top: top / SH, height: headH / SH, left: l0 / SW, right: r0 / SW, pts };
      }
      this.headCache = { art, profile };
      return profile;
    }
    /** Text rows of the name + caption block for a layout candidate, relative to the name centre (print-width units). */
    labelRows(nameText, s, c, lines) {
      const ctx = this.measureCtx, rows = [];
      ctx.font = this.font(100);
      const box = (text, size, base) => ({
        w: (ctx.measureText(text).width / 100) * size + NAME_STROKE * size,
        top: base - 0.78 * size - (NAME_STROKE / 2) * size, bottom: base + 0.25 * size + (NAME_STROKE / 2) * size
      });
      if (nameText) rows.push(box(nameText, s, NAME_BASELINE * s));
      const k = lines.length;
      const dy = nameText ? 0.62 * s + 0.5 * c + ((k - 1) / 2) * CAPTION_LINE * c : 0;
      lines.forEach((l, i) => rows.push(box(l, c, dy + (i - (k - 1) / 2) * CAPTION_LINE * c + NAME_BASELINE * c)));
      return rows;
    }
    /** Separate star and heart layouts: sizes and places the name, dates, message and the portrait so the whole head
     *  and all text stay inside the ornament with a safe margin (see SHAPE_FIT). */
    solveShapeLayout() {
      const s = this.state, shape = this.shape(), F = SHAPE_FIT[shape];
      const p = this.printSize(), aspect = p.height / p.width;
      const grid = depthGrid(shape, aspect);
      const name = s.name.text.trim(), raw = this.captionLines();
      const ctx = this.measureCtx;
      ctx.font = this.font(100);
      const measure = t => ctx.measureText(t).width;
      // Line-break options: none first, then each splittable line, then all of them.
      const splittable = raw.map((l, i) => (l.includes(' ') ? i : -1)).filter(i => i >= 0);
      const options = [[]];
      splittable.forEach(i => options.push([i]));
      if (splittable.length > 1) options.push(splittable.slice());
      const head = this.headProfile(), art = s.artwork;
      const holeBottom = F.hole[1] + F.hole[2] / aspect + HOLE_CLEAR / aspect;
      const capRatio = name ? CAPTION_RATIO : 0.6;
      const minS = name ? NAME_MIN : CAPTION_MIN / capRatio;
      let best = null;
      for (let size = F.nameMax; size >= minS - 1e-9; size -= 0.004) {
        const c = Math.max(size * capRatio, CAPTION_MIN);
        for (const breaks of raw.length ? options : [[]]) {
          const lines = raw.flatMap((l, i) => (breaks.includes(i) ? splitLine(l, measure) : [l]));
          const rows = this.labelRows(name, size, c, lines);
          const text = rows.length ? this.fitText(grid, F, rows, aspect) : { cy: F.textFirst ? F.text[0] : F.text[1], top: F.text[1], bottom: F.text[0] };
          if (!text) continue;
          // Room left for the head: below the text on the star, between the hanging hole and the text on the heart.
          const zone = F.textFirst ? [Math.max(text.bottom + FIT_GAP / aspect, holeBottom), F.petEnd] : [holeBottom, rows.length ? text.top - FIT_GAP / aspect : F.petEnd];
          const pet = head ? this.fitHead(grid, F, head, art, zone, aspect) : null;
          const headW = pet ? pet.headW : 0;
          const score = Math.min(headW, F.headMin) * 4 + size + (head ? 0 : 1) - breaks.length * 0.004;
          const cand = { size, cap: c / size, breaks, cy: text.cy, pet, score };
          if (!best || score > best.score + 1e-9) best = cand;
          if (!head || headW >= F.headMin - 1e-6) { best = cand; break; }
        }
        if (best && (!head || (best.pet && best.pet.headW >= F.headMin - 1e-6))) break;
      }
      Object.assign(s.name, { cx: 0.5, rot: 0 });
      if (best) {
        s.name.size = round4(best.size);
        s.name.cap = round4(best.cap);
        s.name.breaks = best.breaks;
        s.name.cy = round4(best.cy);
        if (best.pet) s.pet = best.pet.pet;
      } else {
        Object.assign(s.name, { cy: 0.5, size: F.nameMax, cap: capRatio, breaks: [] });
      }
      if (art && !(best && best.pet)) {
        // No room was found (very long text): smallest readable portrait in the middle of its zone.
        const w = 0.3 / Math.max(0.1, (head ? head.right - head.left : 0.6));
        s.pet = { cx: 0.5, cy: round4(0.62 + this.petHeightFrac(w) / 2 - 0.1), w: round4(w), rot: 0 };
      }
      if (art && head) {
        // Where the portrait's bottom edge lands inside the ornament, fade the chest out instead of a hard cut.
        const ph = this.petHeightFrac(s.pet.w), bottom = s.pet.cy + ph / 2;
        let inside = false;
        for (let k = 0; k <= 10; k++) if (grid.depth(s.pet.cx - s.pet.w * 0.4 + (s.pet.w * 0.8 * k) / 10, bottom - 0.01) > 0) inside = true;
        if (inside) s.pet.fade = round4(clamp(1 - head.top - head.height, 0.12, 0.4));
      }
    }
    /** Highest (star) or lowest (heart) name position where every text row keeps the safe margin. */
    fitText(grid, F, rows, aspect) {
      const top = Math.min(...rows.map(r => r.top)), bottom = Math.max(...rows.map(r => r.bottom));
      const lo = F.text[0] - top / aspect, hi = F.text[1] - bottom / aspect;
      if (hi < lo) return null;
      const steps = Math.max(1, Math.ceil((hi - lo) / 0.004));
      for (let k = 0; k <= steps; k++) {
        const cy = F.textFirst ? lo + ((hi - lo) * k) / steps : hi - ((hi - lo) * k) / steps;
        if (rows.every(r => grid.rect(0.5 - r.w / 2, cy + r.top / aspect, 0.5 + r.w / 2, cy + r.bottom / aspect) >= FIT_MARGIN)) {
          return { cy, top: cy + top / aspect, bottom: cy + bottom / aspect };
        }
      }
      return null;
    }
    /** Largest portrait whose whole head (ears to chin) fits inside the zone with the safe margin. */
    fitHead(grid, F, head, art, zone, aspect) {
      const ratio = art.height / art.width;
      const headCx = (head.left + head.right) / 2;
      const place = w => {
        const hTop = head.top * w * ratio / aspect, hH = head.height * w * ratio / aspect;
        if (zone[0] + hH > zone[1]) return null;
        const cx = 0.5 + (0.5 - headCx) * w;
        for (let y0 = zone[0]; y0 + hH <= zone[1] + 1e-9; y0 += 0.004) {
          const ok = head.pts.every(([py, l, r]) => {
            const y = y0 + (py - head.top) * w * ratio / aspect;
            return grid.depth(cx - w / 2 + l * w, y) >= FIT_MARGIN && grid.depth(cx - w / 2 + r * w, y) >= FIT_MARGIN;
          }) && grid.depth(cx - w / 2 + headCx * w, y0) >= FIT_MARGIN;
          if (ok) return { pet: { cx: round4(cx), cy: round4(y0 - hTop + (w * ratio) / aspect / 2), w: round4(w), rot: 0 }, headW: (head.right - head.left) * w, top: y0, bottom: y0 + hH };
        }
        return null;
      };
      const hw = head.right - head.left;
      let lo = 0.05 / hw, hi = F.headMax / hw, found = place(lo);
      if (!found) return null;
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2, r = place(mid);
        if (r) { lo = mid; found = r; } else hi = mid;
      }
      return found;
    }
    /** Checks a star or heart layout (used by the tests): all text and the whole head inside the safe margin. */
    fitAudit() {
      const s = this.state, shape = this.shape(), F = SHAPE_FIT[shape];
      if (!F) return null;
      const p = this.printSize(), aspect = p.height / p.width, grid = depthGrid(shape, aspect);
      const c = this.caption(p), name = s.name.text.trim();
      const ns = name ? this.nameSize() : 0;
      const rows = this.labelRows(name, ns, c ? c.size : 0, c ? c.lines : []);
      const textDepth = Math.min(...rows.map(r => grid.rect(s.name.cx - r.w / 2, s.name.cy + r.top / aspect, s.name.cx + r.w / 2, s.name.cy + r.bottom / aspect)));
      const head = this.headProfile();
      let headDepth = Infinity, headTop = null, headW = 0;
      if (head && s.artwork) {
        const w = s.pet.w, ratio = s.artwork.height / s.artwork.width, x0 = s.pet.cx - w / 2, y0 = s.pet.cy - (w * ratio) / aspect / 2;
        head.pts.forEach(([py, l, r]) => {
          const y = y0 + py * w * ratio / aspect;
          headDepth = Math.min(headDepth, grid.depth(x0 + l * w, y), grid.depth(x0 + r * w, y));
        });
        headTop = y0 + head.top * w * ratio / aspect;
        headW = (head.right - head.left) * w;
      }
      // Point sizes on a 3 inch wide ornament (cap height is about 0.7 of the font size).
      const pt = f => f * 3 * 72;
      const sizes = [name ? ns : null, c ? c.size : null].filter(Boolean);
      const holeBottom = F.hole[1] + F.hole[2] / aspect;
      return {
        shape, lines: c ? c.lines : [], nameSize: ns, captionSize: c ? c.size : 0, headW: round4(headW),
        textDepth: round4(textDepth), headDepth: round4(headDepth), headTop: headTop == null ? null : round4(headTop),
        textOk: textDepth >= FIT_MARGIN - 0.004, headOk: !s.artwork || (headDepth >= FIT_MARGIN - 0.004 && headTop >= holeBottom + HOLE_CLEAR / aspect - 0.004),
        minPt: Math.min(...sizes.map(pt)), minAllowedPt: 8
      };
    }
    /** The portrait with its bottom `fade` (fraction of the height) fading out, so a chest that ends inside the
     *  ornament has no hard edge (backend/lib/render.js petLayer applies the same gradient). */
    fadedArtwork(fade) {
      const art = this.state.artwork;
      if (this.fadeCache && this.fadeCache.art === art && this.fadeCache.fade === fade) return this.fadeCache.canvas;
      const c = createCanvas(art.width, art.height), cx = c.getContext('2d');
      cx.drawImage(art, 0, 0);
      const g = cx.createLinearGradient(0, 0, 0, art.height);
      g.addColorStop(1 - fade, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      cx.globalCompositeOperation = 'destination-in';
      cx.fillStyle = g; cx.fillRect(0, 0, art.width, art.height);
      this.fadeCache = { art, fade, canvas: c };
      return c;
    }
    /** Hanging hole of a star or heart ornament (shown on the stage and the cart preview, never printed). */
    drawHole(ctx, x, y, W, H) {
      const F = SHAPE_FIT[this.shape()];
      if (!F) return;
      ctx.save();
      ctx.beginPath(); ctx.arc(x + F.hole[0] * W, y + F.hole[1] * H, F.hole[2] * W, 0, TAU);
      ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.lineWidth = Math.max(1, W * 0.006); ctx.strokeStyle = 'rgba(27, 42, 78, 0.35)'; ctx.stroke();
      ctx.restore();
    }
    /** A white mug with a coloured handle and inside; the design is one side of it, drawn in `b` (the design area). */
    drawMug(ctx, b, { dpr = 1, editing = false, placeholder = false } = {}) {
      const accent = this.mugColor();
      // The rim sits just above the design area, so the whole design shows on the mug's face.
      const ry = b.w * MUG_RIM, cx = b.x + b.w / 2, right = b.x + b.w, hw = b.w * MUG_HANDLE, top = b.y - ry * 0.95;
      const outline = 'rgba(27, 42, 78, 0.22)';
      ctx.save();
      // soft shadow
      const sh = ctx.createRadialGradient(cx + b.w * 0.08, b.y + b.h + ry, 0, cx + b.w * 0.08, b.y + b.h + ry, b.w * 0.7);
      sh.addColorStop(0, 'rgba(27, 42, 78, 0.22)'); sh.addColorStop(1, 'rgba(27, 42, 78, 0)');
      ctx.fillStyle = sh;
      ctx.beginPath(); ctx.ellipse(cx + b.w * 0.08, b.y + b.h + ry, b.w * 0.62, ry * 1.1, 0, 0, TAU); ctx.fill();
      // handle (behind the body)
      const handle = () => {
        ctx.beginPath();
        ctx.moveTo(right - b.w * 0.03, b.y + b.h * 0.18);
        ctx.bezierCurveTo(right + hw * 1.1, b.y + b.h * 0.08, right + hw * 1.1, b.y + b.h * 0.8, right - b.w * 0.03, b.y + b.h * 0.72);
      };
      ctx.lineCap = 'round';
      handle(); ctx.lineWidth = b.w * 0.085; ctx.strokeStyle = outline; ctx.stroke();
      handle(); ctx.lineWidth = b.w * 0.075; ctx.strokeStyle = accent; ctx.stroke();
      // body
      const body = () => {
        ctx.beginPath();
        ctx.moveTo(b.x, top);
        ctx.lineTo(b.x, b.y + b.h);
        ctx.ellipse(cx, b.y + b.h, b.w / 2, ry, 0, Math.PI, 0, true);
        ctx.lineTo(right, top);
        ctx.closePath();
      };
      body(); ctx.fillStyle = '#ffffff'; ctx.fill();
      ctx.save();
      body(); ctx.clip();
      this.drawDesign(ctx, b.x, b.y, b.w, b.h, { dpr, placeholder });
      if (!editing) {
        // curved surface: darker edges, a soft highlight on the left
        const g = ctx.createLinearGradient(b.x, 0, right, 0);
        g.addColorStop(0, 'rgba(0, 0, 0, 0.22)'); g.addColorStop(0.1, 'rgba(0, 0, 0, 0.06)');
        g.addColorStop(0.2, 'rgba(255, 255, 255, 0.22)'); g.addColorStop(0.3, 'rgba(255, 255, 255, 0)');
        g.addColorStop(0.75, 'rgba(0, 0, 0, 0)'); g.addColorStop(1, 'rgba(0, 0, 0, 0.26)');
        ctx.fillStyle = g; ctx.fillRect(b.x, top - ry, b.w, b.h + ry * 3);
      }
      ctx.restore();
      body(); ctx.lineWidth = Math.max(1, b.w * 0.005); ctx.strokeStyle = outline; ctx.stroke();
      // rim and coloured inside
      ctx.beginPath(); ctx.ellipse(cx, top, b.w / 2, ry, 0, 0, TAU);
      ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(cx, top + ry * 0.08, b.w / 2 * 0.93, ry * 0.78, 0, 0, TAU);
      ctx.fillStyle = accent; ctx.fill();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      ctx.beginPath(); ctx.ellipse(cx, top + ry * 0.2, b.w / 2 * 0.9, ry * 0.62, 0, Math.PI, TAU); ctx.fill();
      ctx.restore();
    }
    applyScale(target, start, scale) {
      if (target === 'pet') this.state.pet.w = clamp(start.w * scale, 0.15, 1.6);
      else this.state.name.size = clamp(start.size * scale, 0.04, 0.3);
    }
    snapAngle(a) {
      let r = ((a % 360) + 360) % 360;
      for (const t of [0, 90, 180, 270, 360]) if (Math.abs(r - t) < 3) r = t % 360;
      return r > 180 ? r - 360 : r;
    }
    nudge({ dx = 0, dy = 0, scale = 1, rot = 0 }) {
      const target = this.state.selected || 'pet';
      if (target === 'name' && !this.hasLabel()) return;
      const obj = this.state[target];
      obj.cx += dx; obj.cy += dy;
      if (scale !== 1) this.applyScale(target, { ...obj }, scale);
      if (rot) obj.rot = this.snapAngle(obj.rot + rot);
      this.changed({ placement: true, commit: true });
    }
    select(target) {
      if (target === 'name' && !this.hasLabel()) target = 'pet';
      this.state.selected = target;
      this.root.querySelectorAll('[data-target]').forEach(b => {
        b.setAttribute('aria-checked', String(b.dataset.target === target));
        if (b.dataset.target === 'name') b.disabled = !this.hasLabel();
      });
      this.renderAll();
    }


    /* ----- portraits: artwork styles, frames, room and close-up scenes, before/after, zoom, approval -----
     * The AI portrait is generated once per photo. Styles are derived from it in the browser (pet-portrait.js), so
     * changing the background, frame, size or text never calls the AI again, and the approved PNG is what is printed. */
    initPortrait() {
      const { el } = this;
      el.artStyles.forEach(b => {
        b.addEventListener('click', () => this.setArtStyle(b.dataset.artStyle));
        b.addEventListener('keydown', e => this.radioKeys(e, b.parentElement, '[data-art-style]'));
      });
      el.scenes.forEach(b => b.addEventListener('click', () => this.setScene(b.dataset.scene)));
      this.root.querySelectorAll('[data-room-step]').forEach(b => b.addEventListener('click', () => {
        const n = this.P.ROOMS.length;
        this.state.roomIndex = (this.state.roomIndex + Number(b.dataset.roomStep) + n) % n;
        this.setScene('room');
      }));
      this.root.querySelectorAll('[data-regenerate]').forEach(b => b.addEventListener('click', () => this.regenerate()));
      this.root.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => this.openZoom()));
      this.root.querySelectorAll('[data-zoom-close]').forEach(b => b.addEventListener('click', () => el.zoomDialog && el.zoomDialog.close()));
      this.root.querySelectorAll('[data-zoom-level]').forEach(b => b.addEventListener('click', () => this.setZoom(Number(b.dataset.zoomLevel))));
      const wanted = new URLSearchParams(window.location.search).get('style');
      this.setArtStyle(this.P.STYLES[wanted] ? wanted : (this.config.defaultStyle || 'modern'), { silent: true });
      this.setScene(this.config.defaultScene || 'design', { silent: true });
    }
    /** Artwork style. Re-styles the cached AI portrait (or asks the AI for that style when it paints styles itself). */
    async setArtStyle(style, opts = {}) {
      const { P } = this, s = this.state;
      if (!P.STYLES[style]) style = 'modern';
      const prev = s.artStyle, wasDefault = this.isDefaultLayout();
      s.artStyle = style;
      this.el.artStyles.forEach(b => { const on = b.dataset.artStyle === style; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
      this.el.memorialOnly.forEach(n => { n.hidden = style !== 'memorial'; });
      this.applyStyleText();
      if (opts.silent || prev === style) { if (!opts.silent) this.changed({ design: true }); return; }
      if (s.baseArt && this.config.aiStyles) { this.generate(); return; }
      if (s.baseArt) await this.restyle();
      if (wasDefault || !s.artwork) this.placeDefault();
      else this.applyStyleFade();
      this.changed({ design: true });
    }
    /** Name font and colours follow the style and the background (text stays readable on dark colours). */
    applyStyleText() {
      if (!this.isPortrait()) return;
      const s = this.state, st = this.P.STYLES[s.artStyle], bg = s.background.color || '#ffffff';
      s.name.font = st.font;
      s.name.fill = this.P.textColor(s.artStyle, bg);
      s.name.stroke = /^#[0-9a-f]{6}$/i.test(bg) ? bg.toLowerCase() : '#ffffff';
      if (this.el.font) { this.el.font.value = s.name.font; this.el.fill.value = s.name.fill; this.el.stroke.value = s.name.stroke; }
    }
    applyStyleFade() {
      const s = this.state, st = this.P.STYLES[s.artStyle];
      const fade = this.hasLabel() ? Math.max(st.fade, 0.16) : st.fade;
      if (fade) s.pet.fade = fade; else delete s.pet.fade;
    }
    async setBaseArt(img, art) {
      this.state.baseArt = { img, art };
      await this.restyle();
    }
    async restyle() {
      const s = this.state, base = s.baseArt;
      if (!base) return;
      const style = this.config.aiStyles ? 'modern' : s.artStyle;
      const key = `${base.art.sha256}:${style}`;
      let entry = this.styleCache.get(key);
      if (!entry) {
        const canvas = this.P.stylize(base.img, style);
        if (!canvas) entry = { img: base.img, art: base.art };
        else {
          const blob = await canvasToBlob(canvas, 'image/png');
          entry = { img: canvas, art: { blob, sha256: await sha256Hex(blob), w: canvas.width, h: canvas.height } };
        }
        this.styleCache.set(key, entry);
      }
      s.artwork = entry.img;
      s.art = entry.art;
      this.fadeCache = null;
    }
    /** Default portrait layout: name and text at the bottom of the visible face, the pet above them (its lower edge
     *  softly faded), or, without text, the pet standing on the bottom edge. */
    placePortrait() {
      const s = this.state, p = this.printSize(), r = this.safeRect(), f = this.faceRect();
      const st = this.P.STYLES[s.artStyle] || this.P.STYLES.modern;
      delete s.name.cap; delete s.name.breaks;
      Object.assign(s.name, { cx: 0.5, cy: r.y1 - 0.06, size: round4(st.nameSize * f.w), rot: 0 });
      const block = () => { const g = this.geometry('name', { x: 0, y: 0, w: p.width, h: p.height }); return g ? { top: (g.y - g.h / 2) / p.height, bottom: (g.y + g.h / 2) / p.height } : null; };
      let b = block();
      if (b) { s.name.cy = round4(s.name.cy + (r.y1 - 0.005) - b.bottom); b = block(); }
      if (!s.artwork) return;
      const aspect = s.artwork.height / s.artwork.width;
      const top = r.y0 + 0.02 * f.h;
      const bottom = b ? b.top - 0.02 * f.h : f.y + f.h;
      const w = Math.max(0.2, Math.min(((bottom - top) * p.height) / (p.width * aspect), (r.x1 - r.x0) * 0.94));
      const h = this.petHeightFrac(w);
      s.pet = { cx: 0.5, cy: round4(bottom - h / 2), w: round4(w), rot: 0 };
      this.applyStyleFade();
    }
    /** Style decoration (watercolor wash, classic oval, memorial glow) placed behind the pet's head. */
    decor() {
      if (!this.isPortrait() || !this.state.artwork) return null;
      const s = this.state, st = this.P.STYLES[s.artStyle];
      if (!st || !st.decor) return null;
      const ph = this.petHeightFrac(s.pet.w);
      const lift = { wash: 0.06, vignette: 0.1, halo: 0.24 }[st.decor];
      const k = { wash: 0.66, vignette: 0.56, halo: 0.6 }[st.decor];
      return { kind: st.decor, cx: round4(s.pet.cx), cy: round4(s.pet.cy - ph * lift), r: round4(s.pet.w * k), color: this.P.decorColor(st.decor, s.background.color || '#ffffff') };
    }
    decorImage(d, w, h) {
      const key = `${JSON.stringify(d)}|${w}x${h}`;
      let entry = this.decorCache.get(key);
      if (!entry) {
        entry = { img: null };
        this.decorCache.set(key, entry);
        if (this.decorCache.size > 16) this.decorCache.delete(this.decorCache.keys().next().value);
        this.pendingLoads = (this.pendingLoads || 0) + 1;
        loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(this.B.decorSvg(d, w, h)))
          .then(img => { entry.img = img; this.renderAll(); })
          .catch(() => {})
          .finally(() => { this.pendingLoads--; });
      }
      return entry.img;
    }
    /** Runs a drawing function, waits for pattern and decor images it asked for, and draws again. */
    async drawWhenReady(fn) {
      fn();
      for (let n = 0; n < 60 && (this.pendingLoads || 0) > 0; n++) await new Promise(r => setTimeout(r, 50));
      fn();
    }
    frameKind(variant = this.state.variant) {
      if (!variant) return 'black';
      for (const o of variant.options) { const k = this.P.frameKind(o); if (k) return k; }
      return /^MPM-DIGITAL/i.test(variant.sku || '') ? 'digital' : 'canvas';
    }
    isDigital(variant = this.state.variant) {
      return !!variant && (/^MPM-DIGITAL/i.test(variant.sku || '') || (!!this.P && variant.options.some(o => this.P.frameKind(o) === 'digital')));
    }
    sizeInches(variant = this.state.variant) {
      if (!variant) return null;
      for (const o of variant.options) { const i = parseInches(o); if (i && i.w >= 4 && i.h >= 4) return i; }
      return null;
    }
    /** Size buttons: only sizes this frame comes in, each with its price; digital hides the size choice. */
    portraitOptions() {
      const { config, el } = this, names = config.optionNames || [];
      const si = names.findIndex(n => /size/i.test(n)), fi = names.findIndex(n => /frame|finish|format/i.test(n));
      const v = this.state.variant, digital = this.isDigital();
      const money = c => formatMoney(c, config.moneyFormat);
      el.optionGroups.forEach(group => {
        const index = Number(group.dataset.optionGroup) - 1;
        if (index !== si) return;
        const wrap = group.closest('.mps__group');
        if (wrap) wrap.hidden = digital;
        group.querySelectorAll('[data-option-value]').forEach(btn => {
          const val = btn.dataset.optionValue;
          const all = config.variants.filter(x => x.options[si] === val);
          btn.hidden = all.length > 0 && all.every(x => this.isDigital(x));
          const match = all.find(x => x.available && (fi < 0 || x.options[fi] === v.options[fi]));
          btn.disabled = !match && val !== v.options[si];
          const sub = btn.querySelector('[data-size-sub]');
          if (sub) sub.textContent = match ? money(match.price) : T('Other frames');
        });
      });
      if (el.frameHint) {
        const sizes = config.variants.filter(x => x.available && fi >= 0 && x.options[fi] === v.options[fi] && !this.isDigital(x)).map(x => this.sizeInches(x)).filter(Boolean);
        const all = new Set(config.variants.filter(x => !this.isDigital(x)).map(x => x.options[si]));
        el.frameHint.textContent = !digital && sizes.length && sizes.length < all.size ? T('{frame} comes in {sizes}.', { frame: T(this.P.FRAMES[this.frameKind()].label), sizes: sizes.map(i => METRIC ? `${Math.round(i.w * 2.54)} × ${Math.round(i.h * 2.54)} cm` : `${i.w} × ${i.h} in`).join(T(' and ')) }) : '';
        el.frameHint.hidden = !el.frameHint.textContent;
      }
      if (el.digitalNote) el.digitalNote.hidden = !digital;
      this.updateSceneButtons();
    }
    sceneMode() {
      const m = this.state.scene;
      if (m === 'room' && this.isDigital()) return 'close';
      if (m === 'compare' && !(this.photoImg && this.state.artwork)) return 'close';
      return m;
    }
    setScene(mode, opts = {}) {
      this.state.scene = mode;
      this.updateSceneButtons();
      if (!opts.silent) { this.renderAll(); this.persistSoon(); }
    }
    updateSceneButtons() {
      const { el } = this, mode = this.sceneMode();
      el.scenes.forEach(b => {
        b.setAttribute('aria-pressed', String(b.dataset.scene === mode));
        b.disabled = (b.dataset.scene === 'room' && this.isDigital()) || (b.dataset.scene === 'compare' && !(this.state.photo && this.state.artwork));
      });
      if (el.roomNav) el.roomNav.hidden = mode !== 'room';
      if (el.roomName) el.roomName.textContent = T(this.P.ROOMS[this.state.roomIndex % this.P.ROOMS.length].label);
    }
    /** The visible face of the print (wrapped edges cropped) drawn into x/y/w/h. */
    drawFace(ctx, x, y, w, h, dpr = 1) {
      const f = this.faceRect(), FW = w / f.w, FH = h / f.h;
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      this.drawDesign(ctx, x - f.x * FW, y - f.y * FH, FW, FH, { dpr, placeholder: !this.state.artwork });
      ctx.restore();
    }
    /** Inches of the visible face (digital files: the file's proportions at 8 inches wide). */
    faceInches() {
      const i = this.sizeInches();
      if (i && !this.isDigital()) return i;
      const p = this.printSize();
      return { w: 8, h: 8 * p.height / p.width };
    }
    /** Main preview: the framed portrait close up, in a room at true scale, or before/after. */
    drawScene(ctx, W, H, { dpr = 1, mode = this.sceneMode(), exporting = false } = {}) {
      const { P } = this, s = this.state, kind = this.frameKind(), inches = this.faceInches();
      const bg = s.background.color || '#ffffff', edge = P.shade(bg, -0.12);
      const art = (c, x, y, w, h) => this.drawFace(c, x, y, w, h, dpr);
      if (mode === 'design') {
        // The artwork itself, unframed and as large as possible, on its own background color.
        ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
        const top = exporting ? 0.04 : 0.1, pad = 0.04, room = H * (1 - top - pad);
        const k = Math.min((W * (1 - 2 * pad)) / inches.w, room / inches.h);
        const fw = inches.w * k, fh = inches.h * k;
        art(ctx, (W - fw) / 2, H * top + (room - fh) / 2, fw, fh);
        return;
      }
      if (mode === 'room') {
        const room = P.ROOMS[s.roomIndex % P.ROOMS.length], ppi = H / P.ROOM_H;
        ctx.save();
        const a = room.draw(ctx, W, H, ppi);
        ctx.restore();
        const fw = inches.w * ppi, fh = inches.h * ppi, o = P.outerInches(kind) * ppi;
        P.drawFramed(ctx, W * a.cx - fw / 2, a.bottom - o - fh, fw, fh, kind, ppi, art, { edgeColor: edge });
        return;
      }
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#f7f2eb'); g.addColorStop(1, '#ece4d8');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      const o = P.outerInches(kind), d = kind === 'canvas' ? 0.5 : 0;
      // On the page the view buttons cover the top of the stage, so the piece sits a little lower there.
      const top = exporting ? 0.08 : 0.13, bottom = exporting ? 0.08 : 0.05, room = H * (1 - top - bottom);
      const ppi = Math.min((W * 0.84) / (inches.w + 2 * o + d), room / (inches.h + 2 * o + d));
      const fw = inches.w * ppi, fh = inches.h * ppi, x = (W - fw) / 2, y = H * top + (room - fh) / 2;
      P.drawFramed(ctx, x, y, fw, fh, kind, ppi, art, { edgeColor: edge });
      if (mode === 'compare') this.drawCompare(ctx, x, y, fw, fh);
      else if (kind === 'digital' && s.artwork) {
        const p = this.printSize(), label = T('Digital file · {w} × {h} px', { w: p.width, h: p.height });
        ctx.save();
        ctx.font = `600 ${Math.max(11, Math.round(W * 0.026))}px Montserrat, Arial, sans-serif`;
        ctx.fillStyle = 'rgba(27, 42, 78, 0.75)'; ctx.textAlign = 'center';
        ctx.fillText(label, W / 2, Math.min(H - 8, y + fh + (H - y - fh) / 2 + 4));
        ctx.restore();
      }
    }
    drawCompare(ctx, x, y, w, h) {
      const img = this.photoImg;
      if (!img) return;
      const cx = x + w * this.state.compareX;
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, cx - x, h); ctx.clip();
      const k = Math.max(w / img.width, h / img.height);
      ctx.drawImage(img, x + (w - img.width * k) / 2, y + (h - img.height * k) / 2, img.width * k, img.height * k);
      ctx.restore();
      ctx.save();
      ctx.fillStyle = '#ffffff'; ctx.fillRect(cx - 1.5, y, 3, h);
      ctx.beginPath(); ctx.arc(cx, y + h / 2, 16, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(27, 42, 78, 0.35)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#1b2a4e'; ctx.font = '700 13px Montserrat, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('‹ ›', cx, y + h / 2 + 1);
      const tag = (text, tx, align) => {
        ctx.font = '700 12px Montserrat, Arial, sans-serif';
        const tw = ctx.measureText(text).width + 16, bx = align === 'left' ? tx : tx - tw;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'; ctx.fillRect(bx, y + 10, tw, 24);
        ctx.fillStyle = '#1b2a4e'; ctx.textAlign = 'center'; ctx.fillText(text, bx + tw / 2, y + 22);
      };
      if (cx - x > 70) tag(T('Your photo'), x + 10, 'left');
      if (x + w - cx > 80) tag(T('Your portrait'), x + w - 10, 'right');
      ctx.restore();
    }
    /** Edges of a canvas print that wrap around the frame, dimmed in the Adjust view. */
    drawBleed(ctx, box) {
      const f = this.faceRect();
      if (f.w >= 1 && f.h >= 1) return;
      const fx = box.x + f.x * box.w, fy = box.y + f.y * box.h, fw = f.w * box.w, fh = f.h * box.h;
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.rect(fx, fy, fw, fh); ctx.fill('evenodd');
      ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(27, 42, 78, 0.45)'; ctx.strokeRect(fx, fy, fw, fh);
      ctx.restore();
    }
    /** Large close-up of the artwork with zoom levels (rendered at print-like resolution). */
    async openZoom() {
      const { el } = this;
      if (!el.zoomDialog || !this.state.artwork) return;
      const inches = this.faceInches(), long = 2000;
      const W = inches.w >= inches.h ? long : Math.round(long * inches.w / inches.h), H = Math.round(W * inches.h / inches.w);
      const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
      await this.drawWhenReady(() => this.drawFace(ctx, 0, 0, W, H, 1));
      el.zoomImg.src = canvas.toDataURL('image/jpeg', 0.9);
      if (el.zoomDialog.showModal) el.zoomDialog.showModal(); else el.zoomDialog.setAttribute('open', '');
      this.setZoom(1);
    }
    setZoom(z) {
      const { el } = this;
      el.zoomImg.style.width = `${z * 100}%`;
      this.root.querySelectorAll('[data-zoom-level]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.zoomLevel) === z)));
    }
    designKey() {
      const s = this.state, p = this.printSize();
      return JSON.stringify([this.layoutKey(), s.artStyle, s.background.id, s.background.color, s.variant && s.variant.id, s.name.text, s.name.font, s.name.fill, this.captionLines(), s.art && s.art.sha256, p.width, p.height]);
    }
    isApproved() { return !!this.state.approvedKey && this.state.approvedKey === this.designKey(); }
    /** Approval of this exact version; "Add to cart" approves and adds in one click. */
    approveDesign() {
      if (!this.state.artwork) return;
      if (!this.validateName()) { this.el.nameInput.focus(); return; }
      this.state.approvedKey = this.designKey();
      this.el.cartStatus.textContent = '';
      this.root.dispatchEvent(new CustomEvent('pet-studio:approved', { bubbles: true }));
      this.updateUI();
      this.persistSoon();
    }

    /* ----- drawing (keep identical to backend/lib/render.js) ----- */
    drawDesign(ctx, x, y, W, H, { dpr = 1, placeholder = false } = {}) {
      const s = this.state, bg = s.background;
      ctx.save();
      ctx.beginPath(); ctx.rect(x, y, W, H); ctx.clip();
      ctx.fillStyle = bg.color || '#ffffff';
      ctx.fillRect(x, y, W, H);
      if (bg.kind === 'image') {
        const img = s.bgImage;
        if (img) {
          const k = Math.max(W / img.width, H / img.height);
          ctx.drawImage(img, x + (W - img.width * k) / 2, y + (H - img.height * k) / 2, img.width * k, img.height * k);
        }
      } else if (bg.kind !== 'solid') {
        const pw = Math.round(W * dpr / 50) * 50 || 50;
        const img = this.patternImage(pw, Math.round(pw * H / W));
        if (img) ctx.drawImage(img, x, y, W, H);
      }
      const decor = this.decor();
      if (decor) {
        const dw = Math.round(W * dpr / 50) * 50 || 50;
        const img = this.decorImage(decor, dw, Math.round(dw * H / W));
        if (img) ctx.drawImage(img, x, y, W, H);
      }
      if (s.artwork) {
        const pw = s.pet.w * W, ph = pw * s.artwork.height / s.artwork.width;
        ctx.save();
        ctx.translate(x + s.pet.cx * W, y + s.pet.cy * H);
        ctx.rotate(s.pet.rot * DEG);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(s.pet.fade ? this.fadedArtwork(s.pet.fade) : s.artwork, -pw / 2, -ph / 2, pw, ph);
        ctx.restore();
      } else if (placeholder) {
        this.drawPlaceholder(ctx, x, y, W, H);
      }
      if (s.name.text) {
        const n = s.name, size = this.nameSize() * W;
        const cx = x + n.cx * W, cy = y + n.cy * H;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(n.rot * DEG);
        ctx.font = this.font(size);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.lineWidth = NAME_STROKE * size;
        ctx.strokeStyle = n.stroke;
        ctx.strokeText(n.text, 0, NAME_BASELINE * size);
        ctx.fillStyle = n.fill;
        ctx.fillText(n.text, 0, NAME_BASELINE * size);
        ctx.restore();
      }
      const c = this.caption();
      if (c) {
        const size = c.size * W, k = c.lines.length;
        ctx.save();
        ctx.translate(x + c.cx * W, y + c.cy * H);
        ctx.rotate(c.rot * DEG);
        ctx.font = this.font(size, c.font);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.lineWidth = NAME_STROKE * size;
        ctx.strokeStyle = c.stroke;
        ctx.fillStyle = c.fill;
        c.lines.forEach((line, i) => {
          const ly = (i - (k - 1) / 2) * CAPTION_LINE * size + NAME_BASELINE * size;
          ctx.strokeText(line, 0, ly);
          ctx.fillText(line, 0, ly);
        });
        ctx.restore();
      }
      ctx.restore();
    }
    drawPlaceholder(ctx, x, y, W, H) {
      const cx = x + W / 2, cy = y + H * 0.6, r = W * 0.17;
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.25, r * 0.85, r * 0.7, 0, 0, TAU); ctx.fill();
      [[-0.75, -0.55], [-0.27, -0.95], [0.27, -0.95], [0.75, -0.55]].forEach(([dx, dy]) => {
        ctx.beginPath(); ctx.ellipse(cx + dx * r, cy + dy * r, r * 0.26, r * 0.34, dx * 0.4, 0, TAU); ctx.fill();
      });
      const label = this.state.phase === 'generating' ? T('Creating your portrait…') : T('Your pet here');
      const fontPx = Math.round(W * 0.05);
      ctx.font = `700 ${fontPx}px Montserrat, Arial, sans-serif`;
      const tw = ctx.measureText(label).width;
      const ly = y + H * 0.88;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(cx - tw / 2 - fontPx * 0.7, ly - fontPx * 0.95, tw + fontPx * 1.4, fontPx * 1.7, fontPx * 0.85);
      else ctx.rect(cx - tw / 2 - fontPx * 0.7, ly - fontPx * 0.95, tw + fontPx * 1.4, fontPx * 1.7);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#1b2a4e';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, ly - fontPx * 0.1);
      ctx.restore();
    }
    drawSafeArea(ctx, box) {
      const shape = this.shape();
      if (shape) {
        ctx.save();
        shapePath(ctx, shape, box.x, box.y, box.w, box.h, 1 - 2 * this.safe());
        ctx.setLineDash([8, 6]); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(214, 69, 69, 0.6)'; ctx.stroke();
        ctx.restore();
        return;
      }
      const r = this.safeRect();
      ctx.save();
      ctx.setLineDash([8, 6]); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(214, 69, 69, 0.6)';
      ctx.strokeRect(box.x + r.x0 * box.w, box.y + r.y0 * box.h, (r.x1 - r.x0) * box.w, (r.y1 - r.y0) * box.h);
      ctx.restore();
    }
    renderAll() {
      (this.views || []).forEach(v => v.render());
      if (this.editorView && this.state.editorOpen) this.editorView.render();
    }

    /* ----- state changes ----- */
    /** Any change to the design withdraws an earlier approval: the next add needs a new approval. */
    changed({ design = false, placement = false, price = false, commit = false } = {}) {
      if (this.isPortrait() && this.state.approvedKey && !this.isApproved()) {
        this.state.approvedKey = null;
        this.el.cartStatus.textContent = '';
      }
      if (design || placement) {
        this.clampAll();
        if (this.state.addedId) {
          this.state.addedId = null;
          this.el.cartStatus.textContent = T('You changed the design. Add this new version to your cart when you’re ready.');
        }
        this.validateName();
      }
      if (price) this.updatePrice();
      this.renderAll();
      this.updateUI();
      if (design || commit || price) this.persistSoon();
    }
    validateName() {
      const text = [this.state.name.text].concat(this.captionLines()).join(' ');
      let msg = '';
      if (text && /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) msg = T('Emoji can’t be printed. Please use letters and numbers.');
      this.el.nameErrors.forEach(n => { n.textContent = msg; n.hidden = !msg; });
      return !msg;
    }
    setPhase(phase) {
      this.state.phase = phase;
      this.updateUI();
      this.renderAll();
    }
    openAdjust(target) {
      if (!this.state.artwork) return;
      this.state.adjustOpen = true;
      this.root.dataset.adjusting = 'true';
      this.el.adjustPanel.hidden = false;
      // On phones the preview pins to the top while adjusting, so keep the controls in view below it.
      if (window.matchMedia('(max-width: 899px)').matches) requestAnimationFrame(() => this.el.adjustPanel.scrollIntoView({ block: 'end', behavior: 'smooth' }));
      this.el.adjustBtn.setAttribute('aria-expanded', 'true');
      this.select(target || 'pet');
    }
    closeAdjust() {
      this.state.adjustOpen = false;
      delete this.root.dataset.adjusting;
      this.el.adjustPanel.hidden = true;
      this.el.adjustBtn.setAttribute('aria-expanded', 'false');
      if (!this.state.editorOpen) this.state.selected = null;
      this.changed({ commit: true });
    }
    openEditor() {
      const { el } = this;
      if (!el.dialog || !this.state.artwork) return;
      this.editorSnapshot = JSON.stringify({ pet: this.state.pet, name: this.state.name, background: this.state.background });
      this.state.editorOpen = true;
      el.editorName.value = this.state.name.text;
      el.font.value = this.state.name.font;
      el.fill.value = this.state.name.fill;
      el.stroke.value = this.state.name.stroke;
      el.nameSize.value = String(this.state.name.size);
      if (el.dialog.showModal) el.dialog.showModal(); else el.dialog.setAttribute('open', '');
      this.editorView.resize();
      this.select(this.state.selected || 'pet');
    }
    closeEditor() {
      if (!this.state.editorOpen) return;
      this.state.editorOpen = false;
      if (this.el.dialog.open) this.el.dialog.close();
      this.el.nameInput.value = this.state.name.text;
      if (!this.state.adjustOpen) this.state.selected = null;
      this.changed({ commit: true });
    }
    revertEditor() {
      if (!this.editorSnapshot) return;
      const snap = JSON.parse(this.editorSnapshot);
      this.state.pet = snap.pet;
      this.state.name = snap.name;
      const bg = this.backgrounds.find(b => b.id === snap.background.id) || snap.background;
      this.selectBackground({ ...bg, color: snap.background.color, name: snap.background.name });
      this.el.editorName.value = this.el.nameInput.value = snap.name.text;
      this.el.font.value = snap.name.font; this.el.fill.value = snap.name.fill; this.el.stroke.value = snap.name.stroke; this.el.nameSize.value = String(snap.name.size);
      this.changed({ design: true });
    }
    updateUI() {
      const s = this.state, { el } = this;
      const has = !!s.artwork;
      const v = s.variant;
      const available = !!(v && v.available);
      let label;
      if (this.adding) label = T('Adding to cart…');
      else if (s.phase === 'generating') label = T('Creating your design…');
      else if (!has) label = s.photo ? T('Upload a different photo') : T('Upload your pet’s photo');
      else if (!available) label = T('Sold out');
      else if (this.isPortrait()) label = T('Add to cart');
      else label = T('Approve & add to cart');
      el.primaries.forEach(b => {
        b.querySelector('[data-primary-label]').textContent = label;
        const price = b.querySelector('[data-primary-price]');
        if (price) price.hidden = !(has && available && !this.adding);
        b.disabled = s.phase === 'generating' || !!this.adding || (has && !available);
        b.classList.toggle('is-busy', !!this.adding);
      });
      el.uploadPanel.hidden = has || s.phase === 'generating';
      if (el.uploadNote) el.uploadNote.hidden = has || s.phase === 'generating';
      el.photoRow.hidden = !s.photo;
      if (s.photo && el.thumb.src !== s.photo.url) el.thumb.src = s.photo.url;
      el.editRow.hidden = !has;
      el.approveNote.hidden = !has || s.phase === 'generating';
      this.root.querySelectorAll('[data-target="name"]').forEach(b => { b.disabled = !this.hasLabel(); });
      if (s.selected === 'name' && !this.hasLabel()) s.selected = 'pet';
      if (this.isPortrait()) {
        if (el.approvedBadge) el.approvedBadge.hidden = !(has && this.isApproved());
        this.root.querySelectorAll('[data-regenerate]').forEach(b => { b.disabled = s.phase === 'generating' || !s.photo; b.hidden = !has; });
        this.root.querySelectorAll('[data-zoom]').forEach(b => { b.hidden = !has; });
        this.root.querySelectorAll('[data-has-art]').forEach(n => { n.hidden = !has; });
        if (s.photo && this.photoImgUrl !== s.photo.url) {
          const url = s.photo.url;
          this.photoImgUrl = url;
          loadImage(url).then(img => { if (this.photoImgUrl === url) { this.photoImg = img; this.updateSceneButtons(); this.renderAll(); } }).catch(() => {});
        }
        this.updateSceneButtons();
      }
    }

    /* ----- persistence (refresh recovery) ----- */
    persistSoon() {
      clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => this.persist(), 350);
    }
    persist() {
      const s = this.state;
      kv.set(`state:${this.config.productId}`, {
        at: Date.now(), photoHash: s.photo && s.photo.hash, pet: s.pet, name: s.name, extra: s.extra, style: s.style, addedId: s.addedId, isDefault: this.isDefaultLayout(),
        artStyle: s.artStyle, scene: s.scene, approvedKey: s.approvedKey,
        background: { id: s.background.id, color: s.background.color, name: s.background.name },
        variantId: s.variant && s.variant.id
      });
    }
    async restore() {
      const saved = await kv.get(`state:${this.config.productId}`);
      if (!saved || Date.now() - saved.at > STORE_TTL_MS) return;
      const urlBg = new URLSearchParams(window.location.search).get('bg');
      const urlVariant = new URLSearchParams(window.location.search).get('variant');
      if (!urlBg && saved.background) {
        const bg = saved.background.id === 'custom' ? { id: 'custom', kind: 'solid', name: saved.background.name, color: saved.background.color } : this.backgrounds.find(b => b.id === saved.background.id);
        if (bg) this.selectBackground(bg, { silent: true });
      }
      if (!urlVariant && saved.variantId) {
        const v = this.config.variants.find(x => x.id === saved.variantId);
        if (v) { this.selectedOptions = v.options.slice(); this.resolveVariant(-1, { silent: true }); }
      }
      Object.assign(this.state.name, saved.name || {});
      Object.assign(this.state.extra, saved.extra || {});
      if (saved.style) this.setStyle(saved.style, { silent: true });
      if (this.isPortrait() && saved.artStyle) { await this.setArtStyle(saved.artStyle, { silent: true }); this.state.scene = saved.scene || this.state.scene; }
      this.el.nameInput.value = this.state.name.text || '';
      this.el.extras.forEach(i => { i.value = this.state.extra[i.dataset.extra] || ''; });
      this.el.suggestions.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.suggest === this.state.extra.message)));
      const photo = await kv.get(`photo:${this.config.productId}`);
      const art = saved.photoHash ? await kv.get(this.isPortrait() && this.config.aiStyles ? `art:${saved.photoHash}:${this.state.artStyle}` : `art:${saved.photoHash}`) : null;
      if (photo && photo.blob) {
        this.state.photo = { blob: photo.blob, hash: photo.hash, url: URL.createObjectURL(photo.blob) };
        this.setPhotoStatus(T('Your photo'));
      }
      if (art && art.blob && photo && photo.hash === saved.photoHash) {
        try {
          const img = await loadImage(URL.createObjectURL(art.blob));
          if (this.isPortrait()) await this.setBaseArt(img, { blob: art.blob, sha256: art.sha256, w: art.w, h: art.h });
          else {
            this.state.artwork = img;
            this.state.art = { blob: art.blob, sha256: art.sha256, w: art.w, h: art.h };
          }
          this.state.pet = saved.pet || this.state.pet;
          if (this.state.galleryOpen) this.toggleGallery(false);
          if (saved.isDefault) this.defaultLayout = this.layoutKey();
          if (this.isPortrait() && saved.approvedKey) this.state.approvedKey = saved.approvedKey;
          this.state.addedId = saved.addedId || null;
          this.state.phase = 'ready';
          this.setPhotoStatus(T('Your design was restored'));
          if (this.state.addedId) this.el.cartStatus.textContent = T('This design ({id}) is in your cart.', { id: this.state.addedId });
        } catch (e) { /* start over */ }
      }
      this.clampAll();
      this.updatePrice();
      this.renderAll();
      this.updateUI();
    }

    /* ----- approval & cart ----- */
    designData() {
      const s = this.state, p = this.printSize(), full = this.wrapSize();
      const bg = s.background;
      return {
        family: this.familyKey(),
        shape: this.shape() || undefined,
        ...(this.isPortrait() ? { style: s.artStyle, frame: this.frameKind(), decor: this.decor() || undefined } : {}),
        product_id: String(this.config.productId),
        variant_id: String(s.variant.id),
        sku: s.variant.sku || '',
        print: { w: full.width, h: full.height },
        background: bg.kind === 'image'
          ? { id: bg.id, kind: 'image', name: bg.name, color: bg.color, image_url: bg.image }
          : { id: bg.id, kind: bg.kind, name: bg.name, color: bg.color },
        pet: { cx: round4(s.pet.cx), cy: round4(s.pet.cy), w: round4(s.pet.w), rot: round4(s.pet.rot), ...(s.pet.fade ? { fade: round4(s.pet.fade) } : {}) },
        name: s.name.text.trim() ? {
          text: s.name.text.trim(), cx: round4(s.name.cx), cy: round4(s.name.cy), size: round4(this.nameSize()), rot: round4(s.name.rot),
          font: s.name.font, fill: s.name.fill, stroke: s.name.stroke
        } : null,
        caption: (() => {
          const c = this.caption(p);
          return c ? { lines: c.lines, cx: round4(c.cx), cy: round4(c.cy), size: round4(c.size), rot: round4(c.rot), font: c.font, fill: c.fill, stroke: c.stroke } : undefined;
        })(),
        artwork: { sha256: s.art.sha256, w: s.art.w, h: s.art.h }
      };
    }
    async approve(design) {
      const endpoint = this.config.approveEndpoint;
      if (endpoint) {
        let res;
        try {
          res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ design }) });
        } catch (e) { res = null; }
        if (res && res.ok) { const json = await res.json(); return { id: json.id, token: json.token }; }
        if (res && res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 429) {
          const json = await res.json().catch(() => ({}));
          throw new StudioError(json.error || 'invalid', json.message ? T('We couldn’t approve this design: {reason}', { reason: json.message }) : T('We couldn’t approve this design. Please check the name and try again.'), false);
        }
      }
      // Approval service unreachable: keep selling. The order is held for a manual check (design_unsigned).
      const id = 'MPM-' + (await sha256Hex(new TextEncoder().encode(JSON.stringify(design)))).slice(0, 10).toUpperCase();
      return { id, unsigned: JSON.stringify(design) };
    }
    async exportPreview() {
      if (this.isPortrait()) {
        // Cart image: the framed portrait close up (digital files: the artwork itself).
        const W = PREVIEW_EXPORT, i = this.faceInches(), H = this.isDigital() ? Math.round(W * i.h / i.w) : Math.round(W * 1.2);
        const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
        await this.drawWhenReady(() => (this.isDigital() ? this.drawFace(ctx, 0, 0, W, H, 1) : this.drawScene(ctx, W, H, { dpr: 1, mode: 'close', exporting: true })));
        return canvasToBlob(canvas, 'image/jpeg', 0.88);
      }
      const p = this.printSize();
      const W = PREVIEW_EXPORT, H = this.isMug() ? Math.round(PREVIEW_EXPORT * 0.8) : Math.round(PREVIEW_EXPORT * p.height / p.width);
      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext('2d');
      // Mugs: the cart image is the mug itself; the design area is the mug's front.
      const box = this.isMug() ? this.fitBox(W, H) : { x: 0, y: 0, w: W, h: H };
      if (this.state.background.kind !== 'solid' && this.state.background.kind !== 'image') {
        // make sure the pattern exists at the size drawDesign() asks for before drawing
        const pw = Math.round(box.w / 50) * 50 || 50, ph = Math.round(pw * box.h / box.w);
        await new Promise(resolve => {
          const tryDraw = n => { if (this.patternImage(pw, ph) || n > 40) resolve(); else setTimeout(() => tryDraw(n + 1), 50); };
          tryDraw(0);
        });
      }
      const shape = this.shape();
      if (this.isMug()) {
        ctx.fillStyle = '#f6f3ee'; ctx.fillRect(0, 0, W, H);
        this.drawMug(ctx, box, { dpr: 1 });
      } else if (shape) {
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
        ctx.save(); shapePath(ctx, shape, 0, 0, W, H); ctx.clip();
        this.drawDesign(ctx, 0, 0, W, H, { dpr: 1 });
        ctx.restore();
        this.drawHole(ctx, 0, 0, W, H);
      } else {
        this.drawDesign(ctx, 0, 0, W, H, { dpr: 1 });
      }
      return canvasToBlob(canvas, 'image/jpeg', 0.88);
    }
    async inCart(id) {
      try {
        const res = await fetch(this.config.cartJsUrl, { headers: { Accept: 'application/json' } });
        const cart = await res.json();
        return (cart.items || []).some(i => i.properties && i.properties['Design ID'] === id);
      } catch (e) { return false; }
    }
    async approveAndAdd() {
      const s = this.state;
      if (this.adding) return;
      if (!s.artwork || !s.art) { this.el.fileInput.click(); return; }
      if (!s.variant || !s.variant.available) { this.el.cartStatus.textContent = T('This option is sold out. Please choose another one.'); return; }
      // Portraits: adding to the cart approves this exact version (one click, like the other products).
      if (this.isPortrait() && !this.isApproved()) { this.approveDesign(); if (!this.isApproved()) return; }
      if (!this.validateName()) { this.el.nameInput.focus(); return; }
      this.adding = true;
      this.updateUI();
      this.el.cartStatus.textContent = T('Saving your approved design…');
      try {
        await this.fontsReady();
        this.clampAll();
        const design = this.designData();
        const approval = await this.approve(design);
        if (await this.inCart(approval.id)) {
          s.addedId = approval.id;
          this.persist();
          this.el.cartStatus.textContent = T('This exact design is already in your cart.');
          if (this.config.redirectToCart) window.location.href = this.config.cartUrl;
          return;
        }
        const preview = await this.exportPreview();
        const form = this.cartForm(design, approval, preview);
        const res = await fetch(this.config.cartAddUrl, { method: 'POST', body: form, headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new StudioError('cart', json.description || json.message || T('We couldn’t add this to your cart. Please try again.'));
        s.addedId = approval.id;
        this.persist();
        this.saveHandoff(design, approval.id);
        await this.captureEmail();
        this.el.cartStatus.textContent = T('Added to your cart (design {id}).', { id: approval.id });
        this.root.dispatchEvent(new CustomEvent('pet-studio:added', { bubbles: true, detail: { item: json, design, id: approval.id, signed: !!approval.token } }));
        if (this.config.redirectToCart) window.location.href = this.config.cartUrl;
      } catch (err) {
        this.el.cartStatus.textContent = err.message || T('We couldn’t add this to your cart. Please try again.');
      } finally {
        this.adding = false;
        this.updateUI();
      }
    }
    /** Cart line for an approved design: what the shopper sees (name, text, background, preview) and what the
     *  backend needs (signed design, artwork, original photo). Product page and matching add-ons use the same. */
    cartForm(design, approval, preview, more = {}) {
      const s = this.state;
      const form = new FormData();
      form.append('id', String(s.variant.id));
      form.append('quantity', '1');
      if (design.name) form.append('properties[Pet name]', design.name.text);
      const extra = this.state.extra, clean = t => String(t || '').replace(/\s+/g, ' ').trim();
      if (this.config.extraFields === 'year' && clean(extra.year)) form.append('properties[Year]', clean(extra.year));
      if (this.config.extraFields === 'memorial' && clean(extra.dates)) form.append('properties[Dates]', clean(extra.dates));
      if (this.config.extraFields === 'memorial' && clean(extra.message)) form.append('properties[Message]', clean(extra.message));
      if (this.config.extraFields === 'line' && clean(extra.message)) form.append('properties[Text]', clean(extra.message));
      if (this.isMug()) form.append('properties[Printed on]', 'Both sides');
      if (this.isPortrait()) {
        form.append('properties[Style]', this.P.STYLES[s.artStyle].label);
        if (clean(extra.message)) form.append('properties[Custom text]', clean(extra.message));
        if (s.artStyle === 'memorial' && clean(extra.dates)) form.append('properties[Dates]', clean(extra.dates));
        if (this.isDigital()) form.append('properties[Delivery]', 'Digital download, emailed after payment');
      }
      form.append('properties[Background]', design.background.name);
      form.append('properties[Design ID]', approval.id);
      form.append('properties[Design preview]', preview, `${approval.id}-preview.jpg`);
      if (approval.token) form.append('properties[_design]', approval.token);
      else form.append('properties[_design_unsigned]', approval.unsigned);
      form.append('properties[_artwork]', s.art.blob, `${approval.id}-artwork.png`);
      form.append('properties[_Original photo]', s.photo.blob, `${approval.id}-original.jpg`);
      form.append('properties[_MyPetMemo family]', this.familyKey());
      Object.entries(more).forEach(([k, v]) => { if (v) form.append(`properties[${k}]`, v); });
      return form;
    }
    /** Keeps the approved pet (artwork, photo, name and lettering, background, style) in this browser so the cart
     *  can offer a matching ornament or mug made from it without a second upload (assets/pet-upsell.js). */
    saveHandoff(design, id) {
      const s = this.state, bg = s.background;
      kv.set(`handoff:${id}`, {
        at: Date.now(), id, family: this.familyKey(), productId: this.config.productId,
        art: s.art, photo: s.photo && s.photo.blob,
        name: { text: s.name.text, font: s.name.font, fill: s.name.fill, stroke: s.name.stroke },
        background: { id: bg.id, kind: bg.kind, name: bg.name, color: bg.color, image: bg.image, preview: bg.preview },
        artStyle: this.isPortrait() ? s.artStyle : null, extra: { ...s.extra }
      });
    }
    async captureEmail() {
      const email = this.el.email && this.el.email.value.trim();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
      try {
        await fetch(this.config.cartUpdateUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attributes: { 'Design email': email } }) });
        if (this.el.consent && this.el.consent.checked) {
          const body = new URLSearchParams({ form_type: 'customer', utf8: '✓', 'contact[email]': email, 'contact[tags]': 'newsletter,pet-studio' });
          await fetch('/contact', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        }
      } catch (e) { /* optional */ }
    }

    /* ----- sticky mobile bar ----- */
    initSticky() {
      const bar = this.el.sticky;
      if (!bar || !('IntersectionObserver' in window)) return;
      const visible = new Set();
      const io = new IntersectionObserver(entries => {
        entries.forEach(en => (en.isIntersecting ? visible.add(en.target) : visible.delete(en.target)));
        bar.hidden = visible.size > 0 || this.state.editorOpen;
      });
      this.el.primaries.filter(b => !b.hasAttribute('data-sticky-button')).forEach(b => io.observe(b));
    }
  }

  /* ---------- matching add-ons (cart upsell) ----------
   * Builds an ornament or mug from a design the shopper already approved: the same artwork, background, name and
   * lettering, placed by that product's own default layout, signed by the backend and added to the cart with the
   * same properties as the product page. No second upload and no second AI request. */
  const quiet = new Proxy(function () {}, {
    get: (t, k) => (k === Symbol.iterator ? [][Symbol.iterator].bind([]) : k === 'length' ? 0 : quiet),
    set: () => true,
    apply: () => quiet
  });
  async function makeAddon(config, source) {
    const d = Object.create(PetStudio.prototype);
    Object.assign(d, {
      headless: true, root: document.createElement('div'), config, el: quiet,
      B: window.MyPetMemoBackgrounds, P: window.MyPetMemoPortrait || null,
      templates: new Map(), svgCache: new Map(), styleCache: new Map(), decorCache: new Map(),
      generationId: 0, measureCtx: createCanvas(4, 4).getContext('2d')
    });
    ['changed', 'renderAll', 'updateUI', 'persistSoon', 'persist'].forEach(m => { d[m] = () => {}; });
    const variant = config.variants.find(v => v.id === config.variantId && v.available) || config.variants.find(v => v.available) || config.variants[0];
    const n = source.name || {};
    d.state = {
      phase: 'ready', photo: { blob: source.photo, hash: '' }, artwork: await loadImage(URL.createObjectURL(source.art.blob)),
      art: { blob: source.art.blob, sha256: source.art.sha256, w: source.art.w, h: source.art.h },
      background: { ...source.background }, bgImage: null,
      pet: { cx: 0.5, cy: 0.6, w: 0.86, rot: 0 },
      name: { text: Array.from(String(n.text || '').trim()).slice(0, config.nameMax || 24).join(''), cx: 0.5, cy: 0.12, size: 0.13, rot: 0, font: n.font || 'fredoka', fill: n.fill || '#ffffff', stroke: n.stroke || '#2a2230' },
      extra: { year: '', dates: '', message: '', ...(config.extra || {}) },
      style: config.style || 'below', artStyle: 'modern', variant, selected: null, adjustOpen: false, editorOpen: false, addedId: null
    };
    d.selectedOptions = variant.options.slice();
    if (d.state.background.kind === 'image') {
      d.state.bgImage = await loadImage(d.state.background.preview || d.state.background.image).catch(() => null);
    }
    await d.fetchTemplate(variant);
    await d.fontsReady();
    d.placeDefault();
    return d;
  }
  Object.assign(PetStudio.prototype, {
    /** Add-ons: the cart image of this product with the shopper's pet. */
    async addonPreview() {
      const blob = await this.exportPreview();
      this.previewBlob = blob;
      return blob;
    },
    /** Add-ons: sign the design and add it to the cart. `more` adds visible or hidden line properties. */
    async addonAdd(more = {}) {
      this.clampAll();
      const design = this.designData();
      const approval = await this.approve(design);
      const preview = this.previewBlob || await this.exportPreview();
      const res = await fetch(this.config.cartAddUrl, { method: 'POST', body: this.cartForm(design, approval, preview, more), headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new StudioError('cart', json.description || json.message || T('We couldn’t add this to your cart.'));
      return { id: approval.id, item: json, signed: !!approval.token };
    }
  });

  const init = (scope = document) => {
    scope.querySelectorAll('[data-pet-studio]').forEach(root => {
      if (root.__petStudio) return;
      if (!window.MyPetMemoBackgrounds) { window.addEventListener('load', () => init(scope), { once: true }); return; }
      root.__petStudio = new PetStudio(root);
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init());
  else init();
  document.addEventListener('shopify:section:load', e => init(e.target));

  // Customer events for analytics: a custom pixel can subscribe to mpm_preview_ready and mpm_design_added.
  const track = (name, root, data) => {
    const studio = root && root.__petStudio;
    const a = window.Shopify && window.Shopify.analytics;
    if (!studio || !a || typeof a.publish !== 'function') return;
    try {
      a.publish(name, Object.assign({ family: studio.familyKey(), locale: document.documentElement.lang || '' }, data));
    } catch (_) { /* analytics must never break the studio */ }
  };
  document.addEventListener('pet-studio:generated', e => track('mpm_preview_ready', e.target, { ms: e.detail.ms }));
  document.addEventListener('pet-studio:added', e => track('mpm_design_added', e.target, { design_id: e.detail.id }));

  window.MyPetMemoStudio = {
    formatMoney, parseInches, removeFlatBackground, NAME_BASELINE, NAME_STROKE, CAPTION_LINE,
    makeAddon, handoff: id => kv.get(`handoff:${id}`), loadImage, sha256Hex
  };
})();
