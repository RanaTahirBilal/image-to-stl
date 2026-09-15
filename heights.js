// Height-map processing. All maps are Float32Array rows-first, values 0..1.

// One box-blur pass (running sum, clamped edges) along rows or columns.
function boxPass(src, out, w, h, r, horizontal) {
  const len = horizontal ? w : h, lines = horizontal ? h : w;
  const norm = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const at = horizontal ? function (i) { return l * w + i; } : function (i) { return i * w + l; };
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[at(Math.min(len - 1, Math.max(0, i)))];
    for (let i = 0; i < len; i++) {
      out[at(i)] = s * norm;
      s += src[at(Math.min(len - 1, i + r + 1))] - src[at(Math.max(0, i - r))];
    }
  }
}

export function blur(src, w, h, sigma) {
  if (!(sigma > 0.25)) return Float32Array.from(src);
  if (sigma > 3) {
    // Three box passes approximate a Gaussian.
    const r = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
    let a = Float32Array.from(src), b = new Float32Array(src.length);
    for (let p = 0; p < 3; p++) {
      boxPass(a, b, w, h, r, true);
      boxPass(b, a, w, h, r, false);
    }
    return a;
  }
  const rad = Math.min(Math.ceil(sigma * 3), Math.max(w, h));
  const k = new Float32Array(rad * 2 + 1);
  let sum = 0;
  for (let i = -rad; i <= rad; i++) { k[i + rad] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + rad]; }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) {
        let xx = x + i;
        if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
        s += src[row + xx] * k[i + rad];
      }
      tmp[row + x] = s;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let i = -rad; i <= rad; i++) {
        let yy = y + i;
        if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
        s += tmp[yy * w + x] * k[i + rad];
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

// Value at fraction p of the values where weight > 0.5 (all values if no weight).
export function percentile(arr, weight, p) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (weight && weight[i] <= 0.5) continue;
    if (arr[i] < lo) lo = arr[i];
    if (arr[i] > hi) hi = arr[i];
  }
  if (!(hi > lo)) return lo === Infinity ? 0 : lo;
  const bins = 2048, hist = new Uint32Array(bins);
  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    if (weight && weight[i] <= 0.5) continue;
    hist[Math.min(bins - 1, Math.floor(((arr[i] - lo) / (hi - lo)) * bins))]++;
    n++;
  }
  const target = p * n;
  let acc = 0;
  for (let b = 0; b < bins; b++) {
    acc += hist[b];
    if (acc >= target) return lo + ((b + 0.5) / bins) * (hi - lo);
  }
  return hi;
}

function stretch(arr, weight, pLo, pHi) {
  const lo = percentile(arr, weight, pLo), hi = percentile(arr, weight, pHi);
  const out = new Float32Array(arr.length);
  const span = hi - lo > 1e-6 ? hi - lo : 1;
  for (let i = 0; i < arr.length; i++) {
    const v = (arr[i] - lo) / span;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

// Bilinear resample of a region of a map. crop = { x, y, size } in source pixels (square),
// or null for the whole map. Returns a map of outW x outH.
export function resample(src, sw, sh, crop, outW, outH) {
  const out = new Float32Array(outW * outH);
  const cx = crop ? crop.x : 0, cy = crop ? crop.y : 0;
  const cw = crop ? crop.size : sw, ch = crop ? crop.size : sh;
  for (let y = 0; y < outH; y++) {
    const fy = cy + ((y + 0.5) / outH) * ch - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = Math.max(0, Math.min(1, fy - y0));
    for (let x = 0; x < outW; x++) {
      const fx = cx + ((x + 0.5) / outW) * cw - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = Math.max(0, Math.min(1, fx - x0));
      const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * outW + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

// Photo -> bas-relief. maps: { depth, mask|null, lum } (same size w x h).
// opts: { flatten 0..1, detail 0..1, smooth px, lift 0..1 }
export function photoRelief(maps, w, h, opts) {
  const mask = maps.mask;
  const soft = mask ? blur(mask, w, h, Math.max(0.6, w / 400)) : null;

  let d = stretch(maps.depth, mask, 0.02, 0.99);

  // Bas-relief: keep local shape, flatten the overall slope.
  if (opts.flatten > 0) {
    const big = blur(d, w, h, w / 10);
    for (let i = 0; i < d.length; i++) d[i] -= opts.flatten * big[i];
  }

  // Fine detail from the photo itself (hair, eyes, lips).
  if (opts.detail > 0) {
    const lum = maps.lum;
    const low = blur(lum, w, h, Math.max(1, w / 250));
    const amt = opts.detail * 0.6;
    for (let i = 0; i < d.length; i++) d[i] += amt * (lum[i] - low[i]);
  }

  d = blur(d, w, h, opts.smooth);
  d = stretch(d, mask, 0.01, 0.995);

  if (soft) {
    const lift = opts.lift;
    for (let i = 0; i < d.length; i++) d[i] = soft[i] * (lift + (1 - lift) * d[i]);
  }
  return d;
}

// Logo / artwork -> relief from brightness. maps: { lum, alpha }.
// opts: { invert, smooth px, gamma }
export function artRelief(maps, w, h, opts) {
  const n = w * h;
  const g = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = maps.lum[i];
    if (opts.invert) v = 1 - v;
    g[i] = v * maps.alpha[i];
  }
  let d = stretch(g, null, 0.005, 0.995);
  d = blur(d, w, h, opts.smooth);
  const gm = opts.gamma || 1;
  if (gm !== 1) for (let i = 0; i < n; i++) d[i] = Math.pow(d[i], gm);
  return d;
}

// Shaded preview of a height map into ImageData-style RGBA.
export function hillshade(hm, w, h, out, circle) {
  const lx = -0.55, ly = -0.55, lz = 0.63;
  const k = w * 1.2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const xl = x > 0 ? hm[i - 1] : hm[i], xr = x < w - 1 ? hm[i + 1] : hm[i];
      const yu = y > 0 ? hm[i - w] : hm[i], yd = y < h - 1 ? hm[i + w] : hm[i];
      const nx = (xl - xr) * k * 0.05, ny = (yu - yd) * k * 0.05, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      let s = (nx * lx + ny * ly + nz * lz) / len;
      s = 0.25 + 0.75 * Math.max(0, s);
      let c = Math.round(255 * Math.min(1, s * (0.85 + 0.15 * hm[i])));
      let a = 255;
      if (circle) {
        const dx = (x + 0.5) / w - 0.5, dy = (y + 0.5) / h - 0.5;
        if (dx * dx + dy * dy > 0.25) a = 0;
      }
      out[i * 4] = c; out[i * 4 + 1] = c; out[i * 4 + 2] = Math.round(c * 0.93); out[i * 4 + 3] = a;
    }
  }
}
