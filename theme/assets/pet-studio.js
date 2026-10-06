/* MyPetMemo pet studio (personalized blankets and ornaments)
 * Upload → AI portrait (transparent) → background, name, placement → approve & add to cart.
 * The approved design is signed by the MyPetMemo backend and travels with the cart line; the print
 * file is rendered server side after payment from the same design data (see backend/lib/render.js).
 * drawDesign() below and renderDesign() on the server must stay geometrically identical.
 */
(() => {
  'use strict';

  const DEG = Math.PI / 180;
  const TAU = Math.PI * 2;
  const NAME_BASELINE = 0.35;          // baseline offset from the name centre, in font sizes
  const NAME_STROKE = 0.16;            // outline width, in font sizes
  const MAX_SOURCE_EDGE = 1536;
  const GENERATION_TIMEOUT_MS = 180000;
  const PREVIEW_EXPORT = 1200;
  const HANDLE_COLOR = '#3b8beb';
  const STORE_TTL_MS = 14 * 24 * 3600 * 1000;
  const HEIC_LIB = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
  const FONTS = {
    fredoka: { family: 'Fredoka', weight: 600 },
    pacifico: { family: 'Pacifico', weight: 400 },
    montserrat: { family: 'Montserrat', weight: 800 },
    playfair: { family: 'Playfair Display', weight: 700 }
  };
  const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

  /* ---------- helpers ---------- */
  /** Ornament outline from a variant option such as "Heart / One Size". Blankets have none. */
  function shapeFromOptions(options) {
    for (const o of options || []) {
      const v = String(o).toLowerCase();
      if (/snow/.test(v)) return 'snowflake';
      if (/star/.test(v)) return 'star';
      if (/heart/.test(v)) return 'heart';
      if (/circle|round/.test(v)) return 'circle';
    }
    return null;
  }
  /** Traces an ornament outline inside the box x/y/w/h (scaled by k around its centre). */
  function shapePath(ctx, shape, x, y, w, h, k = 1) {
    const cx = x + w / 2, cy = y + h / 2, rx = (w / 2) * k, ry = (h / 2) * k;
    ctx.beginPath();
    if (shape === 'circle') { ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU); return; }
    if (shape === 'heart') {
      const X = u => cx + u * rx, Y = v => cy + v * ry;
      ctx.moveTo(X(0), Y(-0.55));
      ctx.bezierCurveTo(X(0.12), Y(-1.02), X(1.02), Y(-1.02), X(1), Y(-0.4));
      ctx.bezierCurveTo(X(0.98), Y(0.12), X(0.45), Y(0.55), X(0), Y(1));
      ctx.bezierCurveTo(X(-0.45), Y(0.55), X(-0.98), Y(0.12), X(-1), Y(-0.4));
      ctx.bezierCurveTo(X(-1.02), Y(-1.02), X(-0.12), Y(-1.02), X(0), Y(-0.55));
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
    const top = -Math.PI / 2;
    for (let i = 0; i < 10; i++) {
      const a = top + (i * Math.PI) / 5, r = i % 2 ? 0.52 : 1;
      const px = cx + Math.cos(a) * r * rx, py = cy + (Math.sin(a) * r + 0.095) * ry * 1.05;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath();
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
  function tint(hex, amount) {
    const { r, g, b } = hexToRgb(hex);
    const m = c => Math.round(c + (255 - c) * amount);
    return `rgb(${m(r)}, ${m(g)}, ${m(b)})`;
  }
  /** "50" × 60"" → { w: 50, h: 60 } (inches) */
  function parseInches(text) {
    const m = /(\d+(?:\.\d+)?)\D{1,6}?(\d+(?:\.\d+)?)/.exec(String(text || ''));
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
    const w = image.width, h = image.height;
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, w, h);
    const px = data.data;
    const samples = [[], [], []];
    const step = Math.max(1, Math.floor((w + h) / 200));
    const push = (x, y) => { const i = (y * w + x) * 4; samples[0].push(px[i]); samples[1].push(px[i + 1]); samples[2].push(px[i + 2]); };
    for (let x = 0; x < w; x += step) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y += step) { push(0, y); push(w - 1, y); }
    const median = arr => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    const key = [median(samples[0]), median(samples[1]), median(samples[2])];
    const keyIsGreen = key[1] > 140 && key[1] > key[0] + 60 && key[1] > key[2] + 60;
    const hard = 70, soft = 140;
    const distTo = i => Math.sqrt((px[i] - key[0]) ** 2 + (px[i + 1] - key[1]) ** 2 + (px[i + 2] - key[2]) ** 2);
    const removed = new Uint8Array(w * h);
    const queue = new Int32Array(w * h);
    let head = 0, tail = 0;
    const tryPush = p => { if (!removed[p] && distTo(p * 4) < hard) { removed[p] = 1; queue[tail++] = p; } };
    for (let x = 0; x < w; x++) { tryPush(x); tryPush((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { tryPush(y * w); tryPush(y * w + w - 1); }
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
    constructor(studio, canvas, { interactive }) {
      this.studio = studio;
      this.canvas = canvas;
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
    box() {
      const { width, height } = this.studio.printSize();
      const inset = Math.min(this.w, this.h) * 0.07;
      const availW = this.w - inset * 2, availH = this.h - inset * 2;
      const scale = Math.min(availW / width, availH / height);
      const w = width * scale, h = height * scale;
      return { x: (this.w - w) / 2, y: (this.h - h) / 2, w, h };
    }
    render() {
      if (!this.w) return;
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      const box = this.box();
      const s = this.studio;
      const shape = s.shape();
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
      } else {
        s.drawDesign(ctx, box.x, box.y, box.w, box.h, { dpr: this.dpr, placeholder: !s.state.artwork });
      }
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
    key(e) {
      const s = this.studio;
      if (!this.isEditing()) return;
      if (e.key === 'Tab') return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const order = ['pet'].concat(s.state.name.text ? ['name'] : []);
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
        progress: q('[data-progress]'), progressTitle: q('[data-progress-title]'), progressStep: q('[data-progress-step]'), progressBar: q('[data-progress-bar]'),
        dropHint: q('[data-drop-hint]'), swatches: q('[data-swatches]'), editorSwatches: q('[data-editor-swatches]'), seeAll: q('[data-see-all]'),
        bgNames: qa('[data-bg-name]'), nameInput: q('[data-name-input]'), nameErrors: qa('[data-name-error]'),
        editRow: q('[data-edit-row]'), adjustBtn: q('[data-adjust]'), adjustPanel: q('[data-adjust-panel]'),
        primaries: qa('[data-primary]'), approveNote: q('[data-approve-note]'), cartStatus: q('[data-cart-status]'),
        optionGroups: qa('[data-option-group]'), priceInline: q('[data-price-inline]'), printInfo: q('[data-print-info]'),
        sticky: q('[data-sticky]'), dialog: q('[data-editor-dialog]'), editorName: q('[data-editor-name]'),
        font: q('[data-font]'), fill: q('[data-fill]'), stroke: q('[data-stroke]'), nameSize: q('[data-name-size]'),
        gallery: q('[data-gallery]'), galleryMain: q('[data-gallery-main]'), galleryThumbs: q('[data-gallery-thumbs]'),
        galleryToggle: q('[data-gallery-toggle]'), email: q('[data-email-input]'), consent: q('[data-marketing-consent]')
      };
      this.state = {
        phase: 'empty',            // empty | generating | ready | error
        photo: null,               // { blob, hash, url }
        artwork: null,             // transparent canvas of the illustrated pet
        art: null,                 // { blob, sha256, w, h } exact PNG that is uploaded and approved
        background: { id: 'white', kind: 'solid', name: 'White', color: '#ffffff' },
        bgImage: null,
        pet: { cx: 0.5, cy: 0.6, w: 0.86, rot: 0 },
        name: { text: '', cx: 0.5, cy: 0.12, size: 0.13, rot: 0, font: 'fredoka', fill: '#ffffff', stroke: '#2a2230' },
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
      this.generationId = 0;
      this.measureCtx = createCanvas(4, 4).getContext('2d');

      this.initBackgrounds();
      this.initVariants();
      this.bindUI();
      this.initGallery();
      this.initSticky();
      this.views = [new View(this, root.querySelector('[data-canvas]'), { interactive: () => this.state.adjustOpen })];
      if (this.el.dialog) this.editorView = new View(this, root.querySelector('[data-editor-canvas]'), { interactive: () => this.state.editorOpen });
      this.loadFonts();
      this.updateUI();
      this.restore();
    }

    /* ----- setup ----- */
    loadFonts() {
      if (!document.fonts || !document.fonts.load) return;
      const loads = Object.values(FONTS).map(f => document.fonts.load(`${f.weight} 48px "${f.family}"`, 'AaÀé'));
      Promise.all(loads).then(() => this.changed({ fonts: true })).catch(() => {});
    }
    fontsReady() {
      if (!document.fonts || !document.fonts.load) return Promise.resolve();
      const f = FONTS[this.state.name.font] || FONTS.fredoka;
      return document.fonts.load(`${f.weight} 48px "${f.family}"`, this.state.name.text || 'A').catch(() => {});
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
        if (wasDefault && hadName !== !!this.state.name.text) this.placeDefault();
        [el.nameInput, el.editorName].forEach(i => { if (i && i !== input) i.value = input.value; });
        this.changed({ design: true });
      };
      el.nameInput.addEventListener('input', () => onName(el.nameInput));
      if (el.editorName) el.editorName.addEventListener('input', () => onName(el.editorName));
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
        el.font.addEventListener('change', () => { this.state.name.font = el.font.value; this.fontsReady().then(() => this.changed({ design: true })); });
        el.fill.addEventListener('input', () => { this.state.name.fill = el.fill.value; this.changed({ design: true }); });
        el.stroke.addEventListener('input', () => { this.state.name.stroke = el.stroke.value; this.changed({ design: true }); });
        el.nameSize.addEventListener('input', () => { this.state.name.size = Number(el.nameSize.value); this.changed({ design: true }); });
      }
      el.seeAll.addEventListener('click', () => {
        const collapsed = el.swatches.dataset.collapsed === 'true';
        el.swatches.dataset.collapsed = String(!collapsed);
        el.seeAll.textContent = collapsed ? 'Show fewer backgrounds' : 'See all backgrounds';
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
          b.setAttribute('aria-label', bg.name);
          b.title = bg.name;
          b.dataset.bg = bg.id;
          b.style.backgroundColor = bg.color;
          if (bg.swatch) b.style.backgroundImage = `url("${bg.swatch}")`;
          b.addEventListener('click', () => this.selectBackground(bg));
          b.addEventListener('keydown', e => this.radioKeys(e, container, '.mps__swatch'));
          return b;
        });
        const picker = document.createElement('label');
        picker.className = 'mps__swatch mps__swatch--picker';
        picker.title = 'Pick any color';
        picker.innerHTML = '<input type="color" value="#f9c9d8" aria-label="Pick any background color">';
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
      const initial = match(param) || match(this.config.defaultBackground) || this.backgrounds[0];
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
      this.el.bgNames.forEach(n => { n.textContent = bg.name; });
      this.el.stage.style.setProperty('--mps-stage', tint(bg.color, 0.6));
      if (this.el.dialog) this.el.dialog.style.setProperty('--mps-stage', tint(bg.color, 0.6));
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
        loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)).then(img => { entry.img = img; this.renderAll(); }).catch(() => {});
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
        group.querySelectorAll('[data-option-value]').forEach(button => {
          const inches = parseInches(button.dataset.optionValue);
          if (inches) {
            button.querySelector('[data-size-main]').textContent = `${inches.w} × ${inches.h} in`;
            button.querySelector('[data-size-sub]').textContent = `${Math.round(inches.w * 2.54)} × ${Math.round(inches.h * 2.54)} cm`;
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
      if (before && shapeBefore !== this.shape() && this.isDefaultLayout()) { this.placeDefault(); }
      else if (before) this.keepPetAnchored(before);
      this.fetchTemplate(variant);
      this.changed({ design: !opts.silent, price: true });
    }
    printSize(variant = this.state.variant) {
      const fromPrintify = variant && this.templates.get(variant.id);
      if (fromPrintify) return fromPrintify;
      const inches = variant && parseInches(variant.options[0] || variant.title);
      const dpi = this.config.printDpi || 150;
      if (inches) return { width: Math.round(inches.w * dpi), height: Math.round(inches.h * dpi), source: 'size' };
      const f = this.config.fallbackPrint;
      return f && f.width > 0 && f.height > 0 ? { width: f.width, height: f.height, source: 'default' } : { width: 5000, height: 6000, source: 'default' };
    }
    async fetchTemplate(variant) {
      const endpoint = this.config.templateEndpoint;
      if (!endpoint || !variant || !variant.sku || this.templates.has(variant.id)) return;
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
        this.el.printInfo.textContent = v.available ? '' : 'Sold out';
        this.el.printInfo.hidden = v.available;
      }
    }

    /* ----- gallery ----- */
    initGallery() {
      const { el, config } = this;
      if (!el.galleryToggle || !config.media.length) return;
      config.media.forEach((m, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', `Show photo ${i + 1}`);
        const img = document.createElement('img');
        img.src = m.thumb; img.alt = ''; img.loading = 'lazy';
        b.appendChild(img);
        b.addEventListener('click', () => this.showGalleryImage(i));
        el.galleryThumbs.appendChild(b);
      });
      el.galleryToggle.addEventListener('click', () => this.toggleGallery());
      this.root.querySelector('[data-gallery-prev]').addEventListener('click', () => this.showGalleryImage(this.state.galleryIndex - 1));
      this.root.querySelector('[data-gallery-next]').addEventListener('click', () => this.showGalleryImage(this.state.galleryIndex + 1));
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
      const t = this.el.galleryToggle;
      if (t) { t.textContent = open ? t.dataset.labelDesign : t.dataset.labelPhotos; t.setAttribute('aria-pressed', String(open)); }
      if (open) this.showGalleryImage(this.state.galleryIndex);
    }
    showGalleryImage(index) {
      const media = this.config.media;
      if (!media.length) return;
      const i = (index + media.length) % media.length;
      this.state.galleryIndex = i;
      const img = document.createElement('img');
      img.src = media[i].src; img.alt = media[i].alt || '';
      this.el.galleryMain.replaceChildren(img);
      Array.from(this.el.galleryThumbs.children).forEach((b, j) => b.setAttribute('aria-current', String(i === j)));
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
        return this.showError(new StudioError('type', 'Please choose a photo in JPG, PNG, WebP or HEIC format.', false));
      }
      if (file.size > maxMb * 1024 * 1024) {
        return this.showError(new StudioError('size', `That photo is larger than ${maxMb} MB. Please choose a smaller one.`, false));
      }
      this.setPhotoStatus('Checking your photo…');
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
          ? 'We couldn’t convert this HEIC photo. Please choose a JPG or PNG version (on iPhone: Share › Save as JPEG, or take a screenshot).'
          : 'We couldn’t read that file. Please try a different photo.', false));
      }
      const minSide = this.config.minPhotoSide || 500;
      if (Math.min(bitmap.width, bitmap.height) < minSide) {
        if (bitmap.close) bitmap.close();
        return this.showError(new StudioError('small', `This photo is too small to print well (${bitmap.width} × ${bitmap.height} px). Please use one at least ${minSide} px on its shortest side.`, false));
      }
      let blob;
      try { blob = await normalizePhoto(bitmap); }
      catch (e) { return this.showError(new StudioError('decode', 'We couldn’t prepare that photo. Please try a different one.', false)); }
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
    generationsToday() {
      try {
        const list = JSON.parse(localStorage.getItem('mps-generations') || '[]').filter(t => Date.now() - t < 864e5);
        return list;
      } catch (e) { return []; }
    }
    async generate() {
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
        let art = await kv.get(`art:${photo.hash}`);
        let fromCache = !!(art && art.blob);
        if (!fromCache) {
          const used = this.generationsToday();
          if (used.length >= (this.config.generationLimit || 8)) {
            throw new StudioError('limit', 'You’ve reached today’s limit for new portraits. Your earlier photos still work, or come back tomorrow.', false);
          }
          if (!this.config.aiEndpoint) throw new StudioError('not_configured', 'Our portrait service isn’t connected yet. Please try again later.', false);
          const canvas = await this.requestPortrait(controller.signal);
          try { localStorage.setItem('mps-generations', JSON.stringify(used.concat(Date.now()))); } catch (e) { /* private mode */ }
          const blob = await canvasToBlob(canvas, 'image/png');
          art = { blob, sha256: await sha256Hex(blob), w: canvas.width, h: canvas.height };
          kv.set(`art:${photo.hash}`, { ...art, at: Date.now() });
        }
        if (id !== this.generationId) return;
        const img = await loadImage(URL.createObjectURL(art.blob));
        const hadArtwork = !!this.state.artwork;
        this.state.artwork = img;
        this.state.art = { blob: art.blob, sha256: art.sha256, w: art.w, h: art.h };
        if (!hadArtwork) this.placeDefault(); else { this.placePet(); this.clampAll(); }
        this.stopProgress();
        this.setPhase('ready');
        this.setPhotoStatus(fromCache ? 'Portrait ready (saved from before)' : 'Portrait ready');
        const ms = Math.round(performance.now() - started);
        if (!fromCache) this.root.dispatchEvent(new CustomEvent('pet-studio:generated', { bubbles: true, detail: { ms } }));
        this.changed({ design: true, commit: true });
      } catch (err) {
        if (id !== this.generationId) return;
        this.stopProgress();
        let error = err;
        if (err && err.name === 'AbortError') {
          error = controller.signal.reason === 'timeout' ? new StudioError('timeout', 'This is taking longer than usual. Please try again.') : null;
        } else if (!(err instanceof StudioError)) {
          error = new StudioError('network', 'We couldn’t reach our portrait service. Check your connection and try again.');
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
      this.setProgress(0.06, 'Uploading your photo…');
      const res = await fetch(this.config.aiEndpoint, { method: 'POST', body: form, signal, headers: { Accept: 'application/json, image/png' } });
      if (!res.ok) {
        let info = {};
        try { info = await res.json(); } catch (e) { /* ignore */ }
        const messages = {
          400: 'That photo couldn’t be processed. Please try a different one.',
          413: 'That photo is too large. Please choose a smaller one.',
          422: 'We couldn’t find a pet in that photo. Please use a clear photo with one pet and its face visible.',
          429: 'Lots of people are designing right now. Please wait a minute and try again.'
        };
        throw new StudioError(info.code || `http_${res.status}`, info.message || messages[res.status] || 'Our portrait service had a hiccup. Please try again.', res.status !== 422 && res.status !== 413);
      }
      this.setProgress(0.8, 'Cutting out your pet…');
      let image, background = 'chroma';
      const type = res.headers.get('content-type') || '';
      if (type.includes('application/json')) {
        const json = await res.json();
        if (!json.image) throw new StudioError('bad_response', 'Our portrait service returned an empty result. Please try again.');
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
      if (removedRatio > 0.97 || removedRatio === 0) throw new StudioError('no_subject', 'We couldn’t separate your pet from the background. Please try again or use a different photo.');
      return canvas;
    }
    startProgress() {
      const start = performance.now();
      const expected = this.config.progressSeconds || 45;
      const steps = [[0, 'Uploading your photo…'], [0.08, 'Illustrating your pet…'], [0.45, 'Keeping every marking and color…'], [0.72, 'Almost there…']];
      this.el.progress.hidden = false;
      this.el.progressTitle.textContent = this.config.progressSeconds ? `Creating your design… usually about ${this.config.progressSeconds} seconds` : 'Creating your design…';
      this.progressFloor = 0;
      this.progressLocked = false;
      const tick = () => {
        const t = (performance.now() - start) / 1000;
        const value = Math.max(this.progressFloor, 0.92 * (1 - Math.exp(-t / (expected / 2.5))));
        this.el.progressBar.style.width = `${Math.round(value * 100)}%`;
        if (!this.progressLocked) this.el.progressStep.textContent = steps.filter(s => value >= s[0]).pop()[1];
        this.progressTimer = requestAnimationFrame(tick);
      };
      cancelAnimationFrame(this.progressTimer);
      tick();
    }
    setProgress(value, label) {
      this.progressFloor = Math.max(this.progressFloor || 0, value);
      if (label) { this.el.progressStep.textContent = label; this.progressLocked = value > 0.5; }
    }
    stopProgress() {
      cancelAnimationFrame(this.progressTimer);
      this.el.progress.hidden = true;
    }
    showError(err) {
      this.el.errorText.textContent = err.message;
      this.el.retry.hidden = !(err.retryable && this.state.photo);
      this.el.error.hidden = false;
      if (!this.state.artwork && this.state.phase !== 'generating') this.setPhase(this.state.photo ? 'error' : 'empty');
      this.setPhotoStatus(this.state.photo ? 'Your photo' : '');
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
    /** Default placement. Blankets: name on top, pet on the bottom edge. Ornaments: pet on the bottom edge
     *  (the outline hides where the portrait ends) with the name across its chest, inside the shape. */
    layout() {
      const shape = this.shape();
      if (!shape) return null;
      const named = !!this.state.name.text;
      const L = {
        circle: { pet: named ? 0.84 : 0.9, name: [0.8, 0.15] },
        snowflake: { pet: named ? 0.8 : 0.86, name: [0.72, 0.13] },
        heart: { pet: named ? 0.8 : 0.86, name: [0.66, 0.13] },
        star: { pet: named ? 0.72 : 0.8, name: [0.7, 0.1] }
      };
      return L[shape] || L.circle;
    }
    isDefaultLayout() {
      return !!this.defaultLayout && this.defaultLayout === JSON.stringify([this.state.pet, this.state.name.cx, this.state.name.cy, this.state.name.size, this.state.name.rot]);
    }
    font(px, key = this.state.name.font) {
      const f = FONTS[key] || FONTS.fredoka;
      return `${f.weight} ${px}px "${f.family}", "Arial Rounded MT Bold", Arial, sans-serif`;
    }
    /** Name font size (fraction of print width) after shrinking it to fit inside the safe area. */
    nameSize() {
      const n = this.state.name;
      if (!n.text) return n.size;
      const ctx = this.measureCtx;
      ctx.font = this.font(100);
      const w = ctx.measureText(n.text).width / 100; // width per unit font size
      const maxW = 1 - 2 * this.safe();
      return Math.min(n.size, maxW / Math.max(w, 0.01) * 0.98);
    }
    /** Object box in pixels inside a `box` drawn at x/y/w/h. */
    geometry(which, box) {
      const s = this.state;
      if (which === 'pet') {
        if (!s.artwork) return null;
        const w = s.pet.w * box.w, h = w * (s.artwork.height / s.artwork.width);
        return { x: box.x + s.pet.cx * box.w, y: box.y + s.pet.cy * box.h, w, h, rot: s.pet.rot };
      }
      if (!s.name.text) return null;
      const size = this.nameSize() * box.w;
      this.measureCtx.font = this.font(size);
      const tw = this.measureCtx.measureText(s.name.text).width;
      return { x: box.x + s.name.cx * box.w, y: box.y + s.name.cy * box.h, w: tw + size * 0.3, h: size * 1.2, rot: s.name.rot, size };
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
      const sx = this.safe(), sy = sx * p.width / p.height;
      const pet = this.state.pet, e = this.halfExtents('pet');
      if (e) {
        // A pet wider than the safe area may shift a little but never far off centre.
        pet.cx = e.hx * 2 <= 1 - 2 * sx ? clamp(pet.cx, sx + e.hx, 1 - sx - e.hx) : clamp(pet.cx, 0.4, 0.6);
        pet.cy = clamp(pet.cy, sy + e.hy, Math.max(sy + e.hy, 0.6 + e.hy));
      }
      const name = this.state.name, n = this.halfExtents('name');
      if (n) {
        name.cx = n.hx * 2 <= 1 - 2 * sx ? clamp(name.cx, sx + n.hx, 1 - sx - n.hx) : 0.5;
        name.cy = n.hy * 2 <= 1 - 2 * sy ? clamp(name.cy, sy + n.hy, 1 - sy - n.hy) : 0.5;
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
      const top = s.name.text ? 0.24 : 0.1;
      const aspect = s.artwork.height / s.artwork.width;
      let w = ((1 - top) * p.height) / (p.width * aspect);
      w = Math.min(w, 0.88);
      const h = this.petHeightFrac(w);
      s.pet = { cx: 0.5, cy: 1 - h / 2, w: round4(w), rot: 0 };
    }
    placeDefault() {
      const s = this.state;
      const L = this.layout();
      Object.assign(s.name, L ? { cx: 0.5, cy: L.name[0], size: L.name[1], rot: 0 } : { cx: 0.5, cy: 0.115, size: 0.13, rot: 0 });
      this.placePet();
      this.clampAll();
      this.defaultLayout = s.artwork ? JSON.stringify([s.pet, s.name.cx, s.name.cy, s.name.size, s.name.rot]) : null;
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
      if (target === 'name' && !this.state.name.text) return;
      const obj = this.state[target];
      obj.cx += dx; obj.cy += dy;
      if (scale !== 1) this.applyScale(target, { ...obj }, scale);
      if (rot) obj.rot = this.snapAngle(obj.rot + rot);
      this.changed({ placement: true, commit: true });
    }
    select(target) {
      if (target === 'name' && !this.state.name.text) target = 'pet';
      this.state.selected = target;
      this.root.querySelectorAll('[data-target]').forEach(b => {
        b.setAttribute('aria-checked', String(b.dataset.target === target));
        if (b.dataset.target === 'name') b.disabled = !this.state.name.text;
      });
      this.renderAll();
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
      if (s.artwork) {
        const pw = s.pet.w * W, ph = pw * s.artwork.height / s.artwork.width;
        ctx.save();
        ctx.translate(x + s.pet.cx * W, y + s.pet.cy * H);
        ctx.rotate(s.pet.rot * DEG);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(s.artwork, -pw / 2, -ph / 2, pw, ph);
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
      const label = this.state.phase === 'generating' ? 'Creating your portrait…' : 'Your pet here';
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
      const p = this.printSize();
      const ix = this.safe() * box.w, iy = this.safe() * p.width / p.height * box.h;
      ctx.save();
      ctx.setLineDash([8, 6]); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(214, 69, 69, 0.6)';
      ctx.strokeRect(box.x + ix, box.y + iy, box.w - ix * 2, box.h - iy * 2);
      ctx.restore();
    }
    renderAll() {
      (this.views || []).forEach(v => v.render());
      if (this.editorView && this.state.editorOpen) this.editorView.render();
    }

    /* ----- state changes ----- */
    /** Any change to the design withdraws an earlier approval: the next add needs a new approval. */
    changed({ design = false, placement = false, price = false, commit = false } = {}) {
      if (design || placement) {
        this.clampAll();
        if (this.state.addedId) {
          this.state.addedId = null;
          this.el.cartStatus.textContent = 'You changed the design. Approve it again to add this new version.';
        }
        this.validateName();
      }
      if (price) this.updatePrice();
      this.renderAll();
      this.updateUI();
      if (design || commit || price) this.persistSoon();
    }
    validateName() {
      const text = this.state.name.text;
      let msg = '';
      if (text && /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) msg = 'Emoji can’t be printed. Please use letters and numbers.';
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
      if (this.adding) label = 'Adding to cart…';
      else if (s.phase === 'generating') label = 'Creating your design…';
      else if (!has) label = s.photo ? 'Upload a different photo' : 'Upload your pet’s photo';
      else if (!available) label = 'Sold out';
      else label = 'Approve & add to cart';
      el.primaries.forEach(b => {
        b.querySelector('[data-primary-label]').textContent = label;
        const price = b.querySelector('[data-primary-price]');
        if (price) price.hidden = !(has && available && !this.adding);
        b.disabled = s.phase === 'generating' || !!this.adding || (has && !available);
        b.classList.toggle('is-busy', !!this.adding);
      });
      el.uploadPanel.hidden = has || s.phase === 'generating';
      el.photoRow.hidden = !s.photo;
      if (s.photo && el.thumb.src !== s.photo.url) el.thumb.src = s.photo.url;
      el.editRow.hidden = !has;
      el.approveNote.hidden = !has || s.phase === 'generating';
      this.root.querySelectorAll('[data-target="name"]').forEach(b => { b.disabled = !s.name.text; });
      if (s.selected === 'name' && !s.name.text) s.selected = 'pet';
    }

    /* ----- persistence (refresh recovery) ----- */
    persistSoon() {
      clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => this.persist(), 350);
    }
    persist() {
      const s = this.state;
      kv.set(`state:${this.config.productId}`, {
        at: Date.now(), photoHash: s.photo && s.photo.hash, pet: s.pet, name: s.name, addedId: s.addedId,
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
      this.el.nameInput.value = this.state.name.text || '';
      const photo = await kv.get(`photo:${this.config.productId}`);
      const art = saved.photoHash ? await kv.get(`art:${saved.photoHash}`) : null;
      if (photo && photo.blob) {
        this.state.photo = { blob: photo.blob, hash: photo.hash, url: URL.createObjectURL(photo.blob) };
        this.setPhotoStatus('Your photo');
      }
      if (art && art.blob && photo && photo.hash === saved.photoHash) {
        try {
          this.state.artwork = await loadImage(URL.createObjectURL(art.blob));
          this.state.art = { blob: art.blob, sha256: art.sha256, w: art.w, h: art.h };
          this.state.pet = saved.pet || this.state.pet;
          this.state.addedId = saved.addedId || null;
          this.state.phase = 'ready';
          this.setPhotoStatus('Your design was restored');
          if (this.state.addedId) this.el.cartStatus.textContent = `This design (${this.state.addedId}) is in your cart.`;
        } catch (e) { /* start over */ }
      }
      this.clampAll();
      this.updatePrice();
      this.renderAll();
      this.updateUI();
    }

    /* ----- approval & cart ----- */
    designData() {
      const s = this.state, p = this.printSize();
      const bg = s.background;
      return {
        family: this.config.family === 'ornament' ? 'ornament' : 'blanket',
        shape: this.shape() || undefined,
        product_id: String(this.config.productId),
        variant_id: String(s.variant.id),
        sku: s.variant.sku || '',
        print: { w: p.width, h: p.height },
        background: bg.kind === 'image'
          ? { id: bg.id, kind: 'image', name: bg.name, color: bg.color, image_url: bg.image }
          : { id: bg.id, kind: bg.kind, name: bg.name, color: bg.color },
        pet: { cx: round4(s.pet.cx), cy: round4(s.pet.cy), w: round4(s.pet.w), rot: round4(s.pet.rot) },
        name: s.name.text.trim() ? {
          text: s.name.text.trim(), cx: round4(s.name.cx), cy: round4(s.name.cy), size: round4(this.nameSize()), rot: round4(s.name.rot),
          font: s.name.font, fill: s.name.fill, stroke: s.name.stroke
        } : null,
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
          throw new StudioError(json.error || 'invalid', json.message ? `We couldn’t approve this design: ${json.message}` : 'We couldn’t approve this design. Please check the name and try again.', false);
        }
      }
      // Approval service unreachable: keep selling. The order is held for a manual check (design_unsigned).
      const id = 'MPM-' + (await sha256Hex(new TextEncoder().encode(JSON.stringify(design)))).slice(0, 10).toUpperCase();
      return { id, unsigned: JSON.stringify(design) };
    }
    async exportPreview() {
      const p = this.printSize();
      const W = PREVIEW_EXPORT, H = Math.round(PREVIEW_EXPORT * p.height / p.width);
      const canvas = createCanvas(W, H);
      const ctx = canvas.getContext('2d');
      if (this.state.background.kind !== 'solid' && this.state.background.kind !== 'image') {
        // make sure the pattern exists at export size before drawing
        await new Promise(resolve => {
          const tryDraw = n => { if (this.patternImage(W, H) || n > 40) resolve(); else setTimeout(() => tryDraw(n + 1), 50); };
          tryDraw(0);
        });
      }
      const shape = this.shape();
      if (shape) {
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
        ctx.save(); shapePath(ctx, shape, 0, 0, W, H); ctx.clip();
        this.drawDesign(ctx, 0, 0, W, H, { dpr: 1 });
        ctx.restore();
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
      if (!s.variant || !s.variant.available) { this.el.cartStatus.textContent = 'This option is sold out. Please choose another one.'; return; }
      if (!this.validateName()) { this.el.nameInput.focus(); return; }
      this.adding = true;
      this.updateUI();
      this.el.cartStatus.textContent = 'Saving your approved design…';
      try {
        await this.fontsReady();
        this.clampAll();
        const design = this.designData();
        const approval = await this.approve(design);
        if (await this.inCart(approval.id)) {
          s.addedId = approval.id;
          this.persist();
          this.el.cartStatus.textContent = 'This exact design is already in your cart.';
          if (this.config.redirectToCart) window.location.href = this.config.cartUrl;
          return;
        }
        const preview = await this.exportPreview();
        const form = new FormData();
        form.append('id', String(s.variant.id));
        form.append('quantity', '1');
        if (design.name) form.append('properties[Pet name]', design.name.text);
        form.append('properties[Background]', design.background.name);
        form.append('properties[Design ID]', approval.id);
        form.append('properties[Design preview]', preview, `${approval.id}-preview.jpg`);
        if (approval.token) form.append('properties[_design]', approval.token);
        else form.append('properties[_design_unsigned]', approval.unsigned);
        form.append('properties[_artwork]', s.art.blob, `${approval.id}-artwork.png`);
        form.append('properties[_Original photo]', s.photo.blob, `${approval.id}-original.jpg`);
        form.append('properties[_MyPetMemo family]', this.config.family === 'ornament' ? 'ornament' : 'blanket');
        const res = await fetch(this.config.cartAddUrl, { method: 'POST', body: form, headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new StudioError('cart', json.description || json.message || 'We couldn’t add this to your cart. Please try again.');
        s.addedId = approval.id;
        this.persist();
        await this.captureEmail();
        this.el.cartStatus.textContent = `Added to your cart (design ${approval.id}).`;
        this.root.dispatchEvent(new CustomEvent('pet-studio:added', { bubbles: true, detail: { item: json, design, id: approval.id, signed: !!approval.token } }));
        if (this.config.redirectToCart) window.location.href = this.config.cartUrl;
      } catch (err) {
        this.el.cartStatus.textContent = err.message || 'We couldn’t add this to your cart. Please try again.';
      } finally {
        this.adding = false;
        this.updateUI();
      }
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

  window.MyPetMemoStudio = { formatMoney, parseInches, removeFlatBackground, NAME_BASELINE, NAME_STROKE };
})();
