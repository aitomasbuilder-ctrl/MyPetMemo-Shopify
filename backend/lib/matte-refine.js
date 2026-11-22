'use strict';
// Full-resolution edge pass. The cut-out network runs at 320 px, so its mask is
// soft and can keep a halo of the backdrop. A square erosion pulls that halo
// back, then a guided filter (He, Sun, Tang) snaps the alpha to the photo's
// own edges. Decontamination uses the backdrop colour beside each fringe pixel.

function integral(src, w, h) {
  const I = new Float64Array((w + 1) * (h + 1));
  const stride = w + 1;
  for (let y = 0; y < h; y++) {
    let row = 0;
    const sy = y * w;
    const dy = (y + 1) * stride;
    const py = y * stride;
    for (let x = 0; x < w; x++) {
      row += src[sy + x];
      I[dy + x + 1] = I[py + x + 1] + row;
    }
  }
  return I;
}

function boxMean(I, w, h, r, out) {
  const stride = w + 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      const sum = I[(y1 + 1) * stride + (x1 + 1)] - I[y0 * stride + (x1 + 1)] - I[(y1 + 1) * stride + x0] + I[y0 * stride + x0];
      out[row + x] = sum / ((y1 - y0 + 1) * (x1 - x0 + 1));
    }
  }
}

function erode(src, w, h, r) {
  if (r < 1) return Float32Array.from(src);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 1;
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let xx = x0; xx <= x1; xx++) if (src[row + xx] < m) m = src[row + xx];
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 1;
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let yy = y0; yy <= y1; yy++) if (tmp[yy * w + x] < m) m = tmp[yy * w + x];
      out[y * w + x] = m;
    }
  }
  return out;
}

function guidedFilter(guide, alpha, w, h, radius, eps) {
  const n = w * h;
  const II = new Float32Array(n);
  const IP = new Float32Array(n);
  for (let i = 0; i < n; i++) { II[i] = guide[i] * guide[i]; IP[i] = guide[i] * alpha[i]; }
  const meanI = new Float32Array(n), meanP = new Float32Array(n), meanII = new Float32Array(n), meanIP = new Float32Array(n);
  boxMean(integral(guide, w, h), w, h, radius, meanI);
  boxMean(integral(alpha, w, h), w, h, radius, meanP);
  boxMean(integral(II, w, h), w, h, radius, meanII);
  boxMean(integral(IP, w, h), w, h, radius, meanIP);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = meanIP[i] - meanI[i] * meanP[i];
    const ai = cov / (meanII[i] - meanI[i] * meanI[i] + eps);
    a[i] = ai;
    b[i] = meanP[i] - ai * meanI[i];
  }
  const meanA = new Float32Array(n), meanB = new Float32Array(n);
  boxMean(integral(a, w, h), w, h, radius, meanA);
  boxMean(integral(b, w, h), w, h, radius, meanB);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = meanA[i] * guide[i] + meanB[i];
    // The filter feathers a pale halo. Crush that band so the edge stays on the fur.
    v = (v - 0.55) / 0.16;
    q[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return q;
}

/**
 * Soft matte (0..1, length w*h) plus the photo's RGB buffer -> a tighter matte.
 * `radius` is the guided-filter window. The erosion is about a third of that,
 * enough to drop a backdrop halo without eating the ears.
 */
function refineMatte(rgb, w, h, soft, { radius } = {}) {
  const n = w * h;
  const guide = new Float32Array(n);
  for (let i = 0; i < n; i++) guide[i] = (0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]) / 255;
  const rad = radius || Math.max(5, Math.min(18, Math.round(Math.max(w, h) / 140)));
  const eroded = erode(soft, w, h, Math.max(4, Math.round(rad * 0.85)));
  return guidedFilter(guide, eroded, w, h, rad, 1.2e-3);
}

module.exports = { refineMatte, guidedFilter, erode };
