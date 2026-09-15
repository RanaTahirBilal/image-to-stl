// Height map -> watertight indexed relief mesh, plus validation. Units: mm.
// X = image columns, Y = image rows (flipped so the image reads upright from above), Z = height.

export const RESOLUTION_SAMPLES = { low: 150, medium: 300, high: 600 };

export function gridSize(imgW, imgH, resolution) {
  const maxSide = RESOLUTION_SAMPLES[resolution] || RESOLUTION_SAMPLES.medium;
  const scale = Math.min(1, maxSide / Math.max(imgW, imgH));
  return {
    cols: Math.max(2, Math.round(imgW * scale)),
    rows: Math.max(2, Math.round(imgH * scale)),
  };
}

// RGBA -> grayscale 0..1. Transparent pixels count as black (low).
export function toGray(rgba, cols, rows, invert) {
  const g = new Float32Array(cols * rows);
  let min = Infinity, max = -Infinity;
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    const a = rgba[p + 3] / 255;
    let v = ((0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) / 255) * a;
    if (invert) v = 1 - v;
    g[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { gray: g, min: min, max: max };
}

// Vertex layout: top grid, then bottom perimeter ring, then one bottom centre vertex.
export function buildMesh(gray, cols, rows, opts) {
  const step = opts.widthMm / (cols - 1);
  const perim = [];
  // Counter-clockwise seen from +Z.
  for (let c = 0; c < cols - 1; c++) perim.push((rows - 1) * cols + c);
  for (let r = rows - 1; r > 0; r--) perim.push(r * cols + cols - 1);
  for (let c = cols - 1; c > 0; c--) perim.push(c);
  for (let r = 0; r < rows - 1; r++) perim.push(r * cols);

  const nTop = cols * rows;
  const nP = perim.length;
  const nVerts = nTop + nP + 1;
  const pos = new Float32Array(nVerts * 3);

  for (let r = 0; r < rows; r++) {
    const y = (rows - 1 - r) * step;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c, o = i * 3;
      pos[o] = c * step;
      pos[o + 1] = y;
      pos[o + 2] = opts.baseMm + gray[i] * opts.reliefMm;
    }
  }
  for (let k = 0; k < nP; k++) {
    const src = perim[k] * 3, o = (nTop + k) * 3;
    pos[o] = pos[src];
    pos[o + 1] = pos[src + 1];
    pos[o + 2] = 0;
  }
  const centre = nTop + nP;
  pos[centre * 3] = ((cols - 1) * step) / 2;
  pos[centre * 3 + 1] = ((rows - 1) * step) / 2;
  pos[centre * 3 + 2] = 0;

  const nTris = 2 * (cols - 1) * (rows - 1) + 3 * nP;
  const IndexArr = nVerts > 65535 ? Uint32Array : Uint16Array;
  const idx = new IndexArr(nTris * 3);
  let t = 0;
  // Top surface, normals +Z.
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, cc = a + cols, d = cc + 1;
      idx[t++] = a; idx[t++] = cc; idx[t++] = b;
      idx[t++] = b; idx[t++] = cc; idx[t++] = d;
    }
  }
  // Side walls, normals outward.
  for (let k = 0; k < nP; k++) {
    const k1 = (k + 1) % nP;
    const ti = perim[k], ti1 = perim[k1];
    const bi = nTop + k, bi1 = nTop + k1;
    idx[t++] = bi; idx[t++] = bi1; idx[t++] = ti1;
    idx[t++] = bi; idx[t++] = ti1; idx[t++] = ti;
  }
  // Bottom fan, normals -Z.
  for (let k = 0; k < nP; k++) {
    idx[t++] = centre; idx[t++] = nTop + ((k + 1) % nP); idx[t++] = nTop + k;
  }
  return { positions: pos, indices: idx, dims: { x: (cols - 1) * step, y: (rows - 1) * step } };
}

// Returns { ok, errors, stats }.
export function validateMesh(mesh) {
  const positions = mesh.positions, indices = mesh.indices;
  const errors = [];
  const nV = positions.length / 3;
  const nT = indices.length / 3;
  if (nT === 0) errors.push('Mesh has no triangles.');

  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const v = positions[i];
    if (!Number.isFinite(v)) { errors.push('Mesh has NaN or infinite coordinates.'); break; }
    const a = i % 3;
    if (v < lo[a]) lo[a] = v;
    if (v > hi[a]) hi[a] = v;
  }
  const size = hi.map(function (h, a) { return h - lo[a]; });
  if (!size.every(function (s) { return s > 0; })) errors.push('Model has zero size on at least one axis.');

  // Duplicate vertices, quantised to 1 micron.
  const seen = new Set();
  let dupes = 0;
  for (let i = 0; i < nV; i++) {
    const o = i * 3;
    const key = Math.round(positions[o] * 1000) + ',' + Math.round(positions[o + 1] * 1000) + ',' + Math.round(positions[o + 2] * 1000);
    if (seen.has(key)) dupes++; else seen.add(key);
  }
  if (dupes) errors.push('Mesh has ' + dupes + ' duplicate vertices.');

  // Degenerate triangles, index range, signed volume.
  let degenerate = 0, badIndex = 0, vol = 0;
  for (let t = 0; t < nT; t++) {
    const i0 = indices[t * 3], i1 = indices[t * 3 + 1], i2 = indices[t * 3 + 2];
    if (i0 >= nV || i1 >= nV || i2 >= nV) { badIndex++; continue; }
    if (i0 === i1 || i1 === i2 || i0 === i2) { degenerate++; continue; }
    const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
    const ux = positions[i1 * 3] - ax, uy = positions[i1 * 3 + 1] - ay, uz = positions[i1 * 3 + 2] - az;
    const vx = positions[i2 * 3] - ax, vy = positions[i2 * 3 + 1] - ay, vz = positions[i2 * 3 + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-12) degenerate++;
    vol += (ax * cx + ay * cy + az * cz) / 6;
  }
  if (badIndex) errors.push('Mesh has ' + badIndex + ' faces pointing at missing vertices.');
  if (degenerate) errors.push('Mesh has ' + degenerate + ' degenerate triangles.');

  // Watertight and consistently wound: every directed edge is unique and its
  // reverse exists, so the sorted directed keys equal the sorted reversed keys.
  const fwd = new Float64Array(nT * 3), rev = new Float64Array(nT * 3);
  for (let t = 0, e = 0; t < nT; t++) {
    for (let j = 0; j < 3; j++, e++) {
      const a = indices[t * 3 + j], b = indices[t * 3 + ((j + 1) % 3)];
      fwd[e] = a * nV + b;
      rev[e] = b * nV + a;
    }
  }
  fwd.sort(); rev.sort();
  let repeated = 0, unmatched = 0;
  for (let e = 0; e < fwd.length; e++) {
    if (e && fwd[e] === fwd[e - 1]) repeated++;
    if (fwd[e] !== rev[e]) unmatched++;
  }
  if (repeated) errors.push('Mesh has ' + repeated + ' non-manifold or flipped edges.');
  if (unmatched) errors.push('Mesh is not closed (' + unmatched + ' open edge mismatches).');
  if (vol <= 0) errors.push('Mesh faces point inward (negative volume).');

  return {
    ok: errors.length === 0,
    errors: errors,
    stats: { vertices: nV, triangles: nT, size: size, volume: vol },
  };
}
