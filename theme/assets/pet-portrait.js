/* MyPetMemo portrait helpers (Personalized Pet Portrait page).
 * Pure drawing helpers used by pet-studio.js when the section's product type is "portrait":
 *   - artwork styles: deterministic pixel treatments of the AI portrait (the styled PNG is what gets approved,
 *     uploaded and printed, so the print file always matches the preview),
 *   - style decorations (drawn from the shared SVG in pet-backgrounds.js, so the print renderer draws the same),
 *   - frames (black, white, natural wood, gallery canvas, digital) and simple illustrated rooms drawn to real scale.
 * Nothing here is sent to the AI service or the backend except the styled PNG and the decor numbers.
 */
(() => {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ---------- styles ---------- */
  const STYLES = {
    modern: { label: 'Modern Minimalist', font: 'montserrat', ink: '#2c2a29', decor: null, fade: 0, nameSize: 0.085 },
    watercolor: { label: 'Watercolor', font: 'playfair', ink: '#5a4a52', decor: 'wash', fade: 0, nameSize: 0.09 },
    classic: { label: 'Classic Portrait', font: 'playfair', ink: '#4a3a2c', decor: 'vignette', fade: 0, nameSize: 0.09 },
    memorial: { label: 'Memorial Portrait', font: 'playfair', ink: '#4f453f', decor: 'halo', fade: 0.2, nameSize: 0.09 }
  };

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    const n = m ? parseInt(m[1], 16) : 0xffffff;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const toHex = rgb => '#' + rgb.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  const lum = hex => { const [r, g, b] = hexToRgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
  /** Moves a colour towards black (amount < 0) or white (amount > 0). */
  function shade(hex, amount) {
    const c = hexToRgb(hex);
    return toHex(c.map(v => (amount < 0 ? v * (1 + amount) : v + (255 - v) * amount)));
  }
  function saturate(hex, k) {
    const c = hexToRgb(hex), m = (c[0] + c[1] + c[2]) / 3;
    return toHex(c.map(v => m + (v - m) * k));
  }
  const isDark = hex => lum(hex) < 0.42;

  /** Text colour for a style on a background: the style's ink, or warm white on dark colours. */
  function textColor(style, bgColor) {
    return isDark(bgColor) ? '#fbf7f1' : (STYLES[style] || STYLES.modern).ink;
  }
  /** Decor colour for a style on a background. Depends on the background only, never on the artwork. */
  function decorColor(style, bgColor) {
    const dark = isDark(bgColor), light = lum(bgColor) > 0.93;
    if (style === 'wash') return dark ? shade(bgColor, 0.22) : light ? '#e9c9bd' : saturate(shade(bgColor, -0.16), 1.35);
    if (style === 'vignette') return dark ? shade(bgColor, 0.16) : light ? '#e6dccd' : shade(bgColor, -0.2);
    if (style === 'halo') return dark ? shade(bgColor, 0.35) : light ? '#f1e6d8' : '#ffffff';
    return '#ffffff';
  }

  /* Deterministic noise in 0..1 (same result on every device). */
  function noise(x, y) {
    let h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    return c;
  }
  /** Box blur by down- and up-scaling (cheap, smooth). Returns ImageData of the same size. */
  function blurred(src, factor) {
    const w = src.width, h = src.height;
    const small = makeCanvas(Math.max(8, w / factor), Math.max(8, h / factor));
    const sctx = small.getContext('2d');
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(src, 0, 0, small.width, small.height);
    const big = makeCanvas(w, h);
    const bctx = big.getContext('2d', { willReadFrequently: true });
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(small, 0, 0, w, h);
    return bctx.getImageData(0, 0, w, h);
  }

  /**
   * The styled artwork for a style, as a new canvas the size of the source. "modern" returns the source unchanged.
   * The pet's features are never moved or redrawn: only colour, edges and texture change, so markings stay accurate.
   */
  function stylize(source, style) {
    if (!STYLES[style] || style === 'modern') return null;
    const w = source.width, h = source.height;
    const out = makeCanvas(w, h);
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    const img = ctx.getImageData(0, 0, w, h), px = img.data;
    const soft = blurred(source, style === 'watercolor' ? 5 : 3).data;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        const a = px[i + 3];
        if (!a) continue;
        let r = px[i], g = px[i + 1], b = px[i + 2];
        const sr = soft[i], sg = soft[i + 1], sb = soft[i + 2], sa = soft[i + 3];
        if (style === 'watercolor') {
          // soft pigment: blend with the blurred copy, lift and lightly desaturate, paper grain
          const k = 0.5;
          r = r * (1 - k) + (sa ? sr * 255 / sa : r) * k; g = g * (1 - k) + (sa ? sg * 255 / sa : g) * k; b = b * (1 - k) + (sa ? sb * 255 / sa : b) * k;
          const m = (r + g + b) / 3;
          r = m + (r - m) * 0.86; g = m + (g - m) * 0.86; b = m + (b - m) * 0.86;
          r = r + (255 - r) * 0.07; g = g + (255 - g) * 0.07; b = b + (255 - b) * 0.07;
          const grain = 0.955 + 0.045 * noise(x, y);
          r *= grain; g *= grain; b *= grain;
          // bleeding edges: the outline follows the blurred alpha with a little paper texture
          if (a < 255 || sa < 250) {
            const n = noise(x >> 1, y >> 1);
            px[i + 3] = clamp(Math.min(a, sa * 1.15) * (0.78 + 0.22 * n), 0, 255);
          }
        } else if (style === 'classic') {
          // fine detail: unsharp mask, gentle contrast and a warm, slightly antique tone
          r = r + (r - sr) * 0.7; g = g + (g - sg) * 0.7; b = b + (b - sb) * 0.7;
          r = (r - 128) * 1.08 + 128; g = (g - 128) * 1.08 + 128; b = (b - 128) * 1.08 + 128;
          const sep = [r * 0.393 + g * 0.769 + b * 0.189, r * 0.349 + g * 0.686 + b * 0.168, r * 0.272 + g * 0.534 + b * 0.131];
          r = r * 0.9 + sep[0] * 0.1; g = g * 0.9 + sep[1] * 0.1; b = b * 0.9 + sep[2] * 0.1;
          r *= 1.03; b *= 0.95;
        } else if (style === 'memorial') {
          // soft and warm
          r = r * 0.8 + sr * 0.2; g = g * 0.8 + sg * 0.2; b = b * 0.8 + sb * 0.2;
          const m = (r + g + b) / 3;
          r = m + (r - m) * 0.9; g = m + (g - m) * 0.9; b = m + (b - m) * 0.9;
          r = r + (255 - r) * 0.04; g = g + (255 - g) * 0.03; b *= 0.98;
        }
        px[i] = clamp(r, 0, 255); px[i + 1] = clamp(g, 0, 255); px[i + 2] = clamp(b, 0, 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    return out;
  }

  /* ---------- frames ---------- */
  const FRAMES = {
    black: { label: 'Black frame', color: '#1f1e1d', light: '#4a4744', dark: '#0b0b0a', gap: '#141312' },
    white: { label: 'White frame', color: '#f6f4ef', light: '#ffffff', dark: '#d8d3c9', gap: '#cfc9bf' },
    wood: { label: 'Natural wood frame', color: '#b9895a', light: '#d4ab7d', dark: '#8a5f37', gap: '#3a2c20' },
    canvas: { label: 'Canvas, no frame' },
    digital: { label: 'Digital download' }
  };
  const MOLDING_IN = 0.85;   // visible frame width, inches
  const FLOAT_IN = 0.28;     // gap between a float frame and the canvas, inches
  const DEPTH_IN = 1.25;     // canvas depth, inches

  /** Frame kind from a variant option value such as "Black frame" or "Digital download". */
  function frameKind(value) {
    const v = String(value || '').toLowerCase();
    if (/digital|download|file|skaitmen/.test(v)) return 'digital';
    if (/black|juod/.test(v)) return 'black';
    if (/white|balt/.test(v)) return 'white';
    if (/wood|oak|natural|walnut|medž/.test(v)) return 'wood';
    if (/canvas|unframed|no frame|wrap|drob/.test(v)) return 'canvas';
    return null;
  }
  /** Outer size of a framed piece in inches around a w x h face. */
  function outerInches(kind) { return ['black', 'white', 'wood'].includes(kind) ? MOLDING_IN + FLOAT_IN : 0; }

  /**
   * Draws the frame around the face rectangle (x, y, w, h in pixels; ppi = pixels per inch) and calls drawArt()
   * to paint the artwork into the face. Shadows fall down-right like daylight from a window.
   */
  function drawFramed(ctx, x, y, w, h, kind, ppi, drawArt, { shadow = true, edgeColor = '#cccccc' } = {}) {
    const f = FRAMES[kind];
    const m = MOLDING_IN * ppi, g = FLOAT_IN * ppi;
    ctx.save();
    if (kind === 'black' || kind === 'white' || kind === 'wood') {
      const ox = x - g - m, oy = y - g - m, ow = w + 2 * (g + m), oh = h + 2 * (g + m);
      if (shadow) {
        ctx.save();
        ctx.shadowColor = 'rgba(40, 28, 18, 0.32)'; ctx.shadowBlur = Math.max(6, 1.4 * ppi); ctx.shadowOffsetX = 0.25 * ppi; ctx.shadowOffsetY = 0.6 * ppi;
        ctx.fillStyle = f.color; ctx.fillRect(ox, oy, ow, oh);
        ctx.restore();
      }
      if (kind === 'wood') {
        const grad = ctx.createLinearGradient(ox, oy, ox + ow, oy + oh);
        grad.addColorStop(0, '#c99d6d'); grad.addColorStop(0.5, '#b4844f'); grad.addColorStop(1, '#c69a68');
        ctx.fillStyle = grad;
      } else ctx.fillStyle = f.color;
      ctx.fillRect(ox, oy, ow, oh);
      if (kind === 'wood') {
        // grain along each side of the molding
        ctx.save();
        ctx.beginPath(); ctx.rect(ox, oy, ow, oh); ctx.rect(x - g, y - g, w + 2 * g, h + 2 * g); ctx.clip('evenodd');
        ctx.globalAlpha = 0.22; ctx.strokeStyle = '#7a5230'; ctx.lineWidth = Math.max(0.6, ppi * 0.03);
        const step = Math.max(2, ppi * 0.12);
        for (let k = 0, t = 0; t < ow + oh; k++, t += step) {
          const wob = Math.sin(k * 1.7) * step * 0.6;
          ctx.beginPath(); ctx.moveTo(ox, oy + t + wob); ctx.lineTo(ox + ow, oy + t - wob); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(ox + t + wob, oy); ctx.lineTo(ox + t - wob, oy + oh); ctx.stroke();
        }
        ctx.restore();
      }
      // bevel: light on top and left, dark on bottom and right
      const bw = Math.max(1, m * 0.14);
      ctx.fillStyle = f.light; ctx.globalAlpha = 0.65;
      ctx.fillRect(ox, oy, ow, bw); ctx.fillRect(ox, oy, bw, oh);
      ctx.fillStyle = f.dark; ctx.globalAlpha = 0.6;
      ctx.fillRect(ox, oy + oh - bw, ow, bw); ctx.fillRect(ox + ow - bw, oy, bw, oh);
      ctx.globalAlpha = 1;
      // float gap
      ctx.fillStyle = f.gap; ctx.fillRect(x - g, y - g, w + 2 * g, h + 2 * g);
      drawArt(ctx, x, y, w, h);
      // the frame's inner lip casts a soft shadow onto the canvas
      const s = Math.max(2, g * 1.1);
      const edge = (x0, y0, x1, y1, rx, ry, rw, rh) => { const gr = ctx.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, 'rgba(0,0,0,0.28)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = gr; ctx.fillRect(rx, ry, rw, rh); };
      edge(x, y, x, y + s, x, y, w, s);
      edge(x, y, x + s, y, x, y, s, h);
    } else if (kind === 'canvas') {
      const d = Math.max(2, DEPTH_IN * ppi * 0.22);
      if (shadow) {
        ctx.save();
        ctx.shadowColor = 'rgba(40, 28, 18, 0.3)'; ctx.shadowBlur = Math.max(6, 1.2 * ppi); ctx.shadowOffsetX = 0.35 * ppi; ctx.shadowOffsetY = 0.55 * ppi;
        ctx.fillStyle = '#ddd'; ctx.fillRect(x, y, w + d, h + d);
        ctx.restore();
      }
      drawArt(ctx, x, y, w, h);
      // wrapped edge on the right and bottom, a little darker
      ctx.save();
      ctx.beginPath(); ctx.moveTo(x + w, y); ctx.lineTo(x + w + d, y + d); ctx.lineTo(x + w + d, y + h + d); ctx.lineTo(x + w, y + h); ctx.closePath(); ctx.clip();
      ctx.fillStyle = edgeColor; ctx.fillRect(x + w, y, d, h + d);
      ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(x + w, y, d, h + d);
      ctx.restore();
      ctx.save();
      ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w + d, y + h + d); ctx.lineTo(x + d, y + h + d); ctx.closePath(); ctx.clip();
      ctx.fillStyle = edgeColor; ctx.fillRect(x, y + h, w + d, d);
      ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.fillRect(x, y + h, w + d, d);
      ctx.restore();
    } else {
      // print or digital file: paper with a soft shadow
      if (shadow) {
        ctx.save();
        ctx.shadowColor = 'rgba(40, 28, 18, 0.22)'; ctx.shadowBlur = Math.max(6, 0.8 * ppi); ctx.shadowOffsetY = 0.3 * ppi;
        ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h);
        ctx.restore();
      }
      drawArt(ctx, x, y, w, h);
    }
    ctx.restore();
  }

  /* ---------- rooms (illustrated, drawn to scale: the scene is ROOM_H inches tall) ---------- */
  const ROOM_H = 108;
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  }
  function floor(ctx, W, H, ppi, y0, base, line) {
    const g = ctx.createLinearGradient(0, y0, 0, H);
    g.addColorStop(0, shade(base, 0.06)); g.addColorStop(1, shade(base, -0.08));
    ctx.fillStyle = g; ctx.fillRect(0, y0, W, H - y0);
    ctx.strokeStyle = line; ctx.globalAlpha = 0.35; ctx.lineWidth = Math.max(1, ppi * 0.12);
    for (let x = -W; x < W * 2; x += ppi * 7) { ctx.beginPath(); ctx.moveTo(W / 2 + (x - W / 2) * 0.6, y0); ctx.lineTo(x, H); ctx.stroke(); }
    ctx.globalAlpha = 1;
    ctx.fillStyle = shade(base, 0.25); ctx.fillRect(0, y0 - ppi * 3, W, ppi * 3);
  }
  function wall(ctx, W, H, top, bottom) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, top); g.addColorStop(1, bottom);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // window light from the left
    const l = ctx.createRadialGradient(-W * 0.1, H * 0.2, 0, -W * 0.1, H * 0.2, W * 0.9);
    l.addColorStop(0, 'rgba(255, 252, 240, 0.45)'); l.addColorStop(1, 'rgba(255, 252, 240, 0)');
    ctx.fillStyle = l; ctx.fillRect(0, 0, W, H);
  }
  function plant(ctx, x, y, ppi) {
    ctx.fillStyle = '#d9cfc2'; rr(ctx, x - 5 * ppi, y - 11 * ppi, 10 * ppi, 11 * ppi, 2 * ppi); ctx.fill();
    const leaves = [[-6, -24, -40], [5, -27, 35], [-2, -33, -8], [9, -19, 60], [-9, -17, -65], [2, -21, 12]];
    leaves.forEach(([dx, dy, a], i) => {
      ctx.save(); ctx.translate(x + dx * ppi * 0.7, y - 11 * ppi + dy * ppi * 0.55); ctx.rotate(a * Math.PI / 180);
      ctx.fillStyle = i % 2 ? '#5f8a5a' : '#4d7a4c';
      ctx.beginPath(); ctx.ellipse(0, 0, 2.6 * ppi, 8 * ppi, 0, 0, TAU); ctx.fill(); ctx.restore();
    });
  }
  function lamp(ctx, x, y, ppi, h) {
    ctx.fillStyle = '#c8b9a6'; ctx.fillRect(x - 0.5 * ppi, y - h * ppi, ppi, h * ppi);
    ctx.fillStyle = '#efe4d2';
    ctx.beginPath(); ctx.moveTo(x - 6 * ppi, y - h * ppi); ctx.lineTo(x + 6 * ppi, y - h * ppi); ctx.lineTo(x + 4 * ppi, y - (h + 9) * ppi); ctx.lineTo(x - 4 * ppi, y - (h + 9) * ppi); ctx.closePath(); ctx.fill();
    const glow = ctx.createRadialGradient(x, y - (h + 2) * ppi, 0, x, y - (h + 2) * ppi, 22 * ppi);
    glow.addColorStop(0, 'rgba(255, 236, 190, 0.35)'); glow.addColorStop(1, 'rgba(255, 236, 190, 0)');
    ctx.fillStyle = glow; ctx.fillRect(x - 22 * ppi, y - (h + 24) * ppi, 44 * ppi, 44 * ppi);
  }

  const ROOMS = [
    {
      id: 'living', label: 'Living room',
      draw(ctx, W, H, ppi) {
        const floorY = 92 * ppi;
        wall(ctx, W, H, '#f1ebe1', '#e5dccd');
        floor(ctx, W, H, ppi, floorY, '#c9ad8c', '#a98c6b');
        const cx = W / 2, sw = 84 * ppi, top = floorY - 34 * ppi;
        ctx.save();
        ctx.shadowColor = 'rgba(60, 45, 30, 0.25)'; ctx.shadowBlur = 4 * ppi; ctx.shadowOffsetY = 1.5 * ppi;
        ctx.fillStyle = '#a7b3a3'; rr(ctx, cx - sw / 2, top, sw, 22 * ppi, 4 * ppi); ctx.fill();   // back
        ctx.restore();
        ctx.fillStyle = '#9aa797'; rr(ctx, cx - sw / 2 - 4 * ppi, floorY - 22 * ppi, sw + 8 * ppi, 16 * ppi, 3 * ppi); ctx.fill(); // seat
        ctx.fillStyle = '#8e9b8b';
        rr(ctx, cx - sw / 2 - 6 * ppi, floorY - 27 * ppi, 8 * ppi, 22 * ppi, 3 * ppi); ctx.fill();
        rr(ctx, cx + sw / 2 - 2 * ppi, floorY - 27 * ppi, 8 * ppi, 22 * ppi, 3 * ppi); ctx.fill();
        ctx.fillStyle = '#efe6d8'; rr(ctx, cx - 30 * ppi, floorY - 30 * ppi, 16 * ppi, 13 * ppi, 3 * ppi); ctx.fill();
        ctx.fillStyle = '#e3c7bf'; rr(ctx, cx + 14 * ppi, floorY - 30 * ppi, 16 * ppi, 13 * ppi, 3 * ppi); ctx.fill();
        ctx.fillStyle = '#6d5b49'; ctx.fillRect(cx - sw / 2, floorY - 6 * ppi, 2 * ppi, 6 * ppi); ctx.fillRect(cx + sw / 2 - 2 * ppi, floorY - 6 * ppi, 2 * ppi, 6 * ppi);
        plant(ctx, cx + sw / 2 + 18 * ppi, floorY, ppi);
        lamp(ctx, cx - sw / 2 - 16 * ppi, floorY, ppi, 44);
        return { cx: 0.5, bottom: top - 9 * ppi };
      }
    },
    {
      id: 'bedroom', label: 'Bedroom',
      draw(ctx, W, H, ppi) {
        const floorY = 94 * ppi;
        wall(ctx, W, H, '#eee6ea', '#e2d6dc');
        floor(ctx, W, H, ppi, floorY, '#bfa489', '#9c8166');
        const cx = W / 2, bw = 64 * ppi, top = floorY - 50 * ppi;
        ctx.fillStyle = '#d9c9bc'; rr(ctx, cx - bw / 2, top, bw, 30 * ppi, 6 * ppi); ctx.fill();          // headboard
        ctx.fillStyle = '#fbf8f3'; rr(ctx, cx - bw / 2 - 2 * ppi, floorY - 24 * ppi, bw + 4 * ppi, 20 * ppi, 3 * ppi); ctx.fill(); // duvet
        ctx.fillStyle = '#efe3d6'; rr(ctx, cx - bw / 2 - 2 * ppi, floorY - 24 * ppi, bw + 4 * ppi, 5 * ppi, 2 * ppi); ctx.fill();
        ctx.fillStyle = '#ffffff';
        rr(ctx, cx - 28 * ppi, floorY - 31 * ppi, 24 * ppi, 9 * ppi, 4 * ppi); ctx.fill();
        rr(ctx, cx + 4 * ppi, floorY - 31 * ppi, 24 * ppi, 9 * ppi, 4 * ppi); ctx.fill();
        ctx.fillStyle = '#c8a99a'; rr(ctx, cx - 8 * ppi, floorY - 28 * ppi, 16 * ppi, 7 * ppi, 3 * ppi); ctx.fill();
        ctx.fillStyle = '#b39b84';
        [-1, 1].forEach(sd => {
          const nx = cx + sd * (bw / 2 + 13 * ppi);
          rr(ctx, nx - 9 * ppi, floorY - 24 * ppi, 18 * ppi, 24 * ppi, 1.5 * ppi); ctx.fill();
          lamp(ctx, nx, floorY - 24 * ppi, ppi, 12);
          ctx.fillStyle = '#b39b84';
        });
        return { cx: 0.5, bottom: top - 8 * ppi };
      }
    },
    {
      id: 'hallway', label: 'Entryway',
      draw(ctx, W, H, ppi) {
        const floorY = 93 * ppi;
        wall(ctx, W, H, '#e3e7df', '#d5dbd0');
        floor(ctx, W, H, ppi, floorY, '#cbb79e', '#a99479');
        const cx = W / 2, tw = 48 * ppi, top = floorY - 32 * ppi;
        ctx.fillStyle = '#8a6a4c'; ctx.fillRect(cx - tw / 2, top, tw, 2.5 * ppi);
        ctx.fillRect(cx - tw / 2 + 2 * ppi, top, 1.6 * ppi, 32 * ppi); ctx.fillRect(cx + tw / 2 - 3.6 * ppi, top, 1.6 * ppi, 32 * ppi);
        ctx.fillRect(cx - tw / 2 + 2 * ppi, floorY - 8 * ppi, tw - 4 * ppi, 1.4 * ppi);
        ctx.fillStyle = '#e9e1d3'; rr(ctx, cx + 8 * ppi, top - 13 * ppi, 7 * ppi, 13 * ppi, 3 * ppi); ctx.fill();
        ctx.fillStyle = '#7f9a77';
        [[-1.5, -18], [1.2, -20], [0, -22]].forEach(([dx, dy]) => { ctx.beginPath(); ctx.ellipse(cx + 11.5 * ppi + dx * ppi, top + dy * ppi, 1.5 * ppi, 5 * ppi, dx * 0.2, 0, TAU); ctx.fill(); });
        [['#c98f78', 10], ['#d9c3a5', 8], ['#8fa3b5', 9]].forEach(([c, w], i) => { ctx.fillStyle = c; ctx.fillRect(cx - 18 * ppi, top - (i + 1) * 1.8 * ppi, w * ppi, 1.8 * ppi); });
        return { cx: 0.5, bottom: top - 10 * ppi };
      }
    }
  ];

  window.MyPetMemoPortrait = { STYLES, FRAMES, ROOMS, ROOM_H, stylize, frameKind, outerInches, drawFramed, textColor, decorColor, shade, isDark };
})();
