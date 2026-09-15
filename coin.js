// Round coin mesh: concentric rings with evenly spaced vertices, zipped
// together, a vertical outer wall and a flat bottom. Units: mm, centre at 0,0.

// heightAt(x, y) must return the top height in mm (> 0) for any point in the disc.
export function buildCoinMesh(heightAt, opts) {
  const R = opts.diameterMm / 2;
  const step = opts.diameterMm / opts.samples;
  const K = Math.max(2, Math.ceil(R / step));

  // Ring radii: uniform, plus exact extra radii (rim edges), without near-duplicates.
  const extras = (opts.extraRadii || []).filter(function (r) { return r > 0 && r < R; });
  let radii = [];
  for (let k = 1; k <= K; k++) {
    const r = (R * k) / K;
    const near = extras.some(function (e) { return Math.abs(e - r) < step * 0.5; });
    if (!near || k === K) radii.push(r);
  }
  radii = radii.concat(extras).sort(function (a, b) { return a - b; });

  const counts = radii.map(function (r) { return Math.max(8, Math.ceil((2 * Math.PI * r) / step)); });
  const nOuter = counts[counts.length - 1];
  let nVerts = 1 + nOuter + 1;
  for (let i = 0; i < counts.length; i++) nVerts += counts[i];

  const pos = new Float32Array(nVerts * 3);
  let v = 0;
  function add(x, y, z) { pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z; return v++; }

  const centre = add(0, 0, heightAt(0, 0));
  const starts = [];
  for (let i = 0; i < radii.length; i++) {
    starts.push(v);
    const r = radii[i], n = counts[i];
    for (let j = 0; j < n; j++) {
      const a = (2 * Math.PI * j) / n;
      const x = r * Math.cos(a), y = r * Math.sin(a);
      add(x, y, heightAt(x, y));
    }
  }
  const outer = starts[starts.length - 1];
  const bottomStart = v;
  for (let j = 0; j < nOuter; j++) add(pos[(outer + j) * 3], pos[(outer + j) * 3 + 1], 0);
  const bottomCentre = add(0, 0, 0);

  let nTris = counts[0] + 2 * nOuter + nOuter;
  for (let i = 1; i < counts.length; i++) nTris += counts[i - 1] + counts[i];
  const idx = new Uint32Array(nTris * 3);
  let t = 0;
  function tri(a, b, c) { idx[t++] = a; idx[t++] = b; idx[t++] = c; }

  // Centre fan, normals +Z.
  const n0 = counts[0], s0 = starts[0];
  for (let j = 0; j < n0; j++) tri(centre, s0 + j, s0 + ((j + 1) % n0));

  // Zip each ring to the next one out.
  for (let i = 1; i < counts.length; i++) {
    const na = counts[i - 1], nb = counts[i], sa = starts[i - 1], sb = starts[i];
    let a = 0, b = 0;
    while (a < na || b < nb) {
      const ta = (a + 1) / na, tb = (b + 1) / nb;
      if (a < na && (b >= nb || ta <= tb)) {
        tri(sa + (a % na), sb + (b % nb), sa + ((a + 1) % na));
        a++;
      } else {
        tri(sa + (a % na), sb + (b % nb), sb + ((b + 1) % nb));
        b++;
      }
    }
  }

  // Outer wall, normals outward.
  for (let j = 0; j < nOuter; j++) {
    const j1 = (j + 1) % nOuter;
    tri(bottomStart + j, bottomStart + j1, outer + j1);
    tri(bottomStart + j, outer + j1, outer + j);
  }
  // Bottom fan, normals -Z.
  for (let j = 0; j < nOuter; j++) tri(bottomCentre, bottomStart + ((j + 1) % nOuter), bottomStart + j);

  if (t !== idx.length || v !== nVerts) throw new Error('coin mesh size mismatch');
  return { positions: pos, indices: idx, dims: { x: 2 * R, y: 2 * R }, centred: true };
}
