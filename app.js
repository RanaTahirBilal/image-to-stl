import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { gridSize, buildMesh, validateMesh } from './mesh.js';
import { buildCoinMesh } from './coin.js';
import { resample, photoRelief, artRelief, hillshade } from './heights.js';
import { analysePhoto } from './depth.js';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 12000;
const WORK_SIDE = 1024;
const PREVIEW = 320;
const COIN_SAMPLES = { low: 200, medium: 350, high: 500 };
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const EXT = /\.(png|jpe?g|webp)$/i;
const FILENAME = 'image-to-stl.stl';

const $ = function (id) { return document.getElementById(id); };
const els = {
  input: $('file-input'), pick: $('pick-btn'), drop: $('dropzone'), work: $('workspace'),
  canvas: $('preview-canvas'), name: $('file-name'), dims: $('file-dims'), size: $('file-size'),
  replace: $('replace-btn'), remove: $('remove-btn'), frame: $('frame-controls'),
  photoOpts: $('photo-opts'), artOpts: $('art-opts'), coinSize: $('coin-size'), plaqueSize: $('plaque-size'),
  aiBox: $('ai-box'), aiLabel: $('ai-label'), aiBar: $('ai-bar'), aiRetry: $('ai-retry'),
  gen: $('gen-btn'), status: $('status'), outSize: $('out-size'), resHint: $('res-hint'),
  viewer: $('viewer'), viewerEmpty: $('viewer-empty'), reset: $('reset-btn'),
  dl: $('dl-btn'), stats: $('model-stats'), stale: $('stale-note'),
};

let image = null;     // { bitmap, w, h, file }
let work = null;      // { w, h, lum, alpha, canvas } image scaled to WORK_SIDE
let ai = null;        // { depth, mask } at work size
let aiRunning = false;
let stlBuffer = null;
let busy = false;

class UserError extends Error {}

function say(text, kind) {
  els.status.textContent = text;
  els.status.dataset.kind = kind || 'info';
  els.status.hidden = !text;
}
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function fmtMm(v) { return (Math.round(v * 10) / 10).toLocaleString() + ' mm'; }
function radio(name) { return document.querySelector('input[name="' + name + '"]:checked').value; }
function num(id) { return parseFloat($(id).value); }
function shape() { return radio('shape'); }
function kind() { return radio('kind'); }

/* ---------- upload ---------- */
els.pick.addEventListener('click', function () { els.input.click(); });
els.replace.addEventListener('click', function () { els.input.click(); });
els.input.addEventListener('change', function () {
  const f = els.input.files && els.input.files[0];
  els.input.value = '';
  if (f) loadFile(f);
});
['dragenter', 'dragover'].forEach(function (ev) {
  els.drop.addEventListener(ev, function (e) { e.preventDefault(); els.drop.classList.add('over'); });
});
['dragleave', 'drop'].forEach(function (ev) {
  els.drop.addEventListener(ev, function (e) { e.preventDefault(); els.drop.classList.remove('over'); });
});
els.drop.addEventListener('drop', function (e) {
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) loadFile(f);
});
els.remove.addEventListener('click', clearImage);

async function loadFile(file) {
  if (busy) return;
  if (TYPES.indexOf(file.type) < 0 && !EXT.test(file.name)) {
    return say('That file type isn’t supported. Upload a PNG, JPG or WEBP image.', 'error');
  }
  if (file.size === 0) return say('That file is empty. Choose a different image.', 'error');
  if (file.size > MAX_BYTES) {
    return say('That image is ' + fmtBytes(file.size) + '. The limit is ' + fmtBytes(MAX_BYTES) + ' — export a smaller copy and try again.', 'error');
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (e) {
    return say('This image couldn’t be read. It may be corrupt or not really a PNG, JPG or WEBP file.', 'error');
  }
  if (!bitmap.width || !bitmap.height) {
    bitmap.close();
    return say('This image has no pixels. Choose a different image.', 'error');
  }
  if (bitmap.width > MAX_PIXELS || bitmap.height > MAX_PIXELS) {
    const d = bitmap.width + ' × ' + bitmap.height;
    bitmap.close();
    return say('This image is ' + d + ' px. The limit is ' + MAX_PIXELS + ' px on each side — resize it and try again.', 'error');
  }
  if (image) image.bitmap.close();
  image = { bitmap: bitmap, w: bitmap.width, h: bitmap.height, file: file };
  work = makeWork(bitmap);
  if (!work.hasContent) {
    image = null; work = null;
    return say('This image is fully transparent, so there is nothing to raise. Choose a different image.', 'error');
  }
  ai = null;
  els.name.textContent = file.name;
  els.dims.textContent = image.w + ' × ' + image.h + ' px';
  els.size.textContent = fmtBytes(file.size);
  $('zoom').value = 1; $('panx').value = 0; $('pany').value = 0;
  els.work.hidden = false;
  document.body.classList.add('has-image');
  clearModel();
  say('');
  syncUI();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  els.work.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  if (kind() === 'photo') runAI();
}

function makeWork(bitmap) {
  const s = Math.min(1, WORK_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(2, Math.round(bitmap.width * s)), h = Math.max(2, Math.round(bitmap.height * s));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h), alpha = new Float32Array(w * h);
  let content = false;
  for (let i = 0; i < w * h; i++) {
    const a = px[i * 4 + 3] / 255;
    alpha[i] = a;
    lum[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
    if (a > 0) content = true;
  }
  // The AI sees transparent areas as white.
  const flat = document.createElement('canvas');
  flat.width = w; flat.height = h;
  const fctx = flat.getContext('2d');
  fctx.fillStyle = '#ffffff';
  fctx.fillRect(0, 0, w, h);
  fctx.drawImage(canvas, 0, 0);
  return { w: w, h: h, lum: lum, alpha: alpha, canvas: flat, hasContent: content };
}

function clearImage() {
  if (busy) return;
  if (image) image.bitmap.close();
  image = null; work = null; ai = null;
  els.work.hidden = true;
  document.body.classList.remove('has-image');
  clearModel();
  say('');
}

/* ---------- free AI ---------- */
async function runAI() {
  if (!work || ai || aiRunning) return;
  aiRunning = true;
  const forWork = work;
  els.aiBox.hidden = false;
  els.aiRetry.hidden = true;
  els.aiBox.dataset.state = 'busy';
  els.aiBar.style.width = '2%';
  els.aiLabel.textContent = 'Loading the free AI…';
  syncUI();
  try {
    const r = await analysePhoto(forWork.canvas, function (p, label) {
      els.aiBar.style.width = Math.round(p * 100) + '%';
      els.aiLabel.textContent = label;
    });
    if (forWork !== work) return;
    ai = { depth: r.depth, mask: r.mask };
    els.aiBox.dataset.state = 'done';
    els.aiLabel.textContent = 'Depth ready' + (r.mask ? ', background found' : '') + ' · ran on your ' + (r.device === 'webgpu' ? 'graphics card' : 'processor');
    els.aiBar.style.width = '100%';
  } catch (e) {
    console.error(e);
    if (forWork !== work) return;
    els.aiBox.dataset.state = 'error';
    els.aiLabel.textContent = 'The free AI couldn’t run here. Check your connection and retry, or switch Image type to Logo / art.';
    els.aiRetry.hidden = false;
  } finally {
    aiRunning = false;
    syncUI();
    // A different image was loaded while this one was being read.
    if (forWork !== work && work && kind() === 'photo') runAI();
  }
}
els.aiRetry.addEventListener('click', runAI);

/* ---------- relief maps ---------- */
function coinCrop() {
  const side = Math.min(work.w, work.h) / num('zoom');
  const x = (work.w - side) / 2 + num('panx') * (work.w - side) / 2;
  const y = (work.h - side) / 2 + num('pany') * (work.h - side) / 2;
  return { x: x, y: y, size: side };
}

// Height map 0..1 of outW x outH for the current settings, or null if the AI isn't ready.
function reliefMap(outW, outH) {
  const crop = shape() === 'coin' ? coinCrop() : null;
  const scale = outW / 400;
  function take(map) { return resample(map, work.w, work.h, crop, outW, outH); }
  if (kind() === 'photo') {
    if (!ai) return null;
    const useMask = $('opt-bg').checked && ai.mask;
    return photoRelief({ depth: take(ai.depth), mask: useMask ? take(ai.mask) : null, lum: take(work.lum) }, outW, outH, {
      flatten: num('opt-flatten'), detail: num('opt-detail'), smooth: num('opt-smooth') * scale, lift: 0.15,
    });
  }
  return artRelief({ lum: take(work.lum), alpha: take(work.alpha) }, outW, outH, {
    invert: $('opt-invert').checked, smooth: num('opt-art-smooth') * scale, gamma: num('opt-gamma'),
  });
}

function previewSize() {
  if (shape() === 'coin') return { w: PREVIEW, h: PREVIEW };
  const g = gridSize(work.w, work.h, 'low');
  const s = PREVIEW / Math.max(g.cols, g.rows);
  return { w: Math.round(g.cols * s), h: Math.round(g.rows * s) };
}

let previewQueued = false;
function drawPreview() {
  if (previewQueued) return;
  previewQueued = true;
  requestAnimationFrame(function () {
    previewQueued = false;
    if (!work) return;
    const ctx = els.canvas.getContext('2d');
    const view = radio('view');
    const ps = previewSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    els.canvas.width = ps.w * dpr; els.canvas.height = ps.h * dpr;
    els.canvas.style.aspectRatio = ps.w + ' / ' + ps.h;
    ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
    const coin = shape() === 'coin';
    if (view === 'relief') {
      const map = reliefMap(ps.w, ps.h);
      if (map) {
        const img = ctx.createImageData(ps.w, ps.h);
        hillshade(map, ps.w, ps.h, img.data, coin);
        const tmp = document.createElement('canvas');
        tmp.width = ps.w; tmp.height = ps.h;
        tmp.getContext('2d').putImageData(img, 0, 0);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(tmp, 0, 0, els.canvas.width, els.canvas.height);
        if (coin && num('coin-rim') > 0) {
          const R = els.canvas.width / 2;
          const inner = R * (1 - (2 * num('coin-rim')) / num('coin-diameter'));
          ctx.fillStyle = 'rgb(222,220,206)';
          ctx.beginPath();
          ctx.arc(R, R, R, 0, Math.PI * 2);
          ctx.arc(R, R, Math.max(0, inner), 0, Math.PI * 2, true);
          ctx.fill();
        }
        return;
      }
    }
    // Photo view (also shown while the AI is still working).
    if (coin) {
      const c = coinCrop();
      ctx.drawImage(work.canvas, c.x, c.y, c.size, c.size, 0, 0, els.canvas.width, els.canvas.height);
      const R = els.canvas.width / 2;
      ctx.save();
      ctx.fillStyle = 'rgba(10,12,14,0.55)';
      ctx.beginPath();
      ctx.rect(0, 0, els.canvas.width, els.canvas.height);
      ctx.arc(R, R, R - 1, 0, Math.PI * 2, true);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.arc(R, R, R - dpr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.drawImage(work.canvas, 0, 0, els.canvas.width, els.canvas.height);
    }
  });
}

/* ---------- settings ---------- */
function syncUI() {
  const coin = shape() === 'coin', photo = kind() === 'photo';
  els.frame.hidden = !coin;
  els.coinSize.hidden = !coin;
  els.plaqueSize.hidden = coin;
  els.photoOpts.hidden = !photo;
  els.artOpts.hidden = photo;
  els.aiBox.hidden = !photo || (!ai && !aiRunning && els.aiBox.dataset.state !== 'error');
  els.gen.disabled = busy || !work || (photo && !ai);
  els.gen.textContent = busy ? 'Generating…' : photo && !ai ? (aiRunning ? 'Waiting for the AI…' : 'Generate STL') : 'Generate STL';
  const res = radio('resolution');
  els.resHint.textContent = res === 'high' ? 'Finest detail. Best for resin printers; large file.' :
    res === 'medium' ? 'Good for fine filament nozzles (0.2–0.4 mm) and resin.' : 'Fast. Enough for a standard 0.4 mm filament nozzle.';
  document.querySelectorAll('output[data-for]').forEach(function (o) {
    const el = $(o.dataset.for);
    const v = parseFloat(el.value);
    o.textContent = o.dataset.pct ? Math.round(v * 100) + '%' : o.dataset.x ? v.toFixed(2) + '×' : v.toFixed(1);
  });
  updateOutSize();
  if (work) drawPreview();
}

function updateOutSize() {
  if (!work) return;
  const res = radio('resolution');
  if (shape() === 'coin') {
    const d = num('coin-diameter'), b = num('coin-base'), r = num('coin-relief');
    if (![d, b, r].every(Number.isFinite)) { els.outSize.textContent = '—'; return; }
    const K = COIN_SAMPLES[res] / 2;
    const tris = 2 * Math.PI * K * K;
    els.outSize.textContent = 'Ø ' + fmtMm(d) + ' × ' + fmtMm(b + r) + ' thick · detail every ' + (d / COIN_SAMPLES[res]).toFixed(2) + ' mm · ≈' + fmtBytes(84 + tris * 50);
  } else {
    const w = num('plaque-width'), b = num('plaque-base'), r = num('plaque-relief');
    if (![w, b, r].every(Number.isFinite)) { els.outSize.textContent = '—'; return; }
    const g = gridSize(work.w, work.h, res);
    const depth = w * (g.rows - 1) / (g.cols - 1);
    const tris = 2 * (g.cols - 1) * (g.rows - 1) + 6 * (g.cols + g.rows - 2);
    els.outSize.textContent = fmtMm(w) + ' × ' + fmtMm(depth) + ' × up to ' + fmtMm(b + r) + ' · ≈' + fmtBytes(84 + tris * 50);
  }
}

document.querySelectorAll('#design input, #frame-controls input, #size-panel input, #view-toggle input').forEach(function (el) {
  el.addEventListener('input', function () {
    syncUI();
    if (stlBuffer && el.name !== 'view') els.stale.hidden = false;
  });
});
document.querySelectorAll('input[name="kind"]').forEach(function (el) {
  el.addEventListener('change', function () { if (kind() === 'photo') runAI(); });
});

function readSize() {
  function check(id, lo, hi, label) {
    const v = num(id);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new UserError(label + ' must be between ' + lo + ' and ' + hi + ' mm.');
    return v;
  }
  if (shape() === 'coin') {
    const s = {
      diameterMm: check('coin-diameter', 10, 200, 'Coin diameter'),
      baseMm: check('coin-base', 0.5, 10, 'Base thickness'),
      reliefMm: check('coin-relief', 0.2, 10, 'Relief height'),
      rimMm: check('coin-rim', 0, 20, 'Rim width'),
    };
    if (s.rimMm * 2 >= s.diameterMm * 0.8) throw new UserError('The rim is too wide for this coin. Make it narrower than ' + fmtMm(s.diameterMm * 0.4) + '.');
    return s;
  }
  return {
    widthMm: check('plaque-width', 10, 500, 'Plaque width'),
    baseMm: check('plaque-base', 0.5, 20, 'Base thickness'),
    reliefMm: check('plaque-relief', 0.2, 50, 'Relief height'),
  };
}

/* ---------- generate ---------- */
els.gen.addEventListener('click', generate);

async function generate() {
  if (busy || !work) return;
  let s;
  try { s = readSize(); } catch (e) { return say(e.message, 'error'); }
  busy = true;
  syncUI();
  say('Building the relief and checking the mesh…', 'info');
  await new Promise(function (r) { setTimeout(r, 30); });

  try {
    const res = radio('resolution');
    let mesh;
    if (shape() === 'coin') {
      const G = COIN_SAMPLES[res] + 1;
      const map = reliefMap(G, G);
      if (!map) throw new UserError('The AI hasn’t finished reading this photo yet.');
      const R = s.diameterMm / 2, inner = R - s.rimMm, top = s.baseMm + s.reliefMm;
      const heightAt = function (x, y) {
        if (s.rimMm > 0 && Math.hypot(x, y) > inner + 1e-6) return top;
        const u = Math.max(0, Math.min(G - 1, ((x + R) / (2 * R)) * (G - 1)));
        const v = Math.max(0, Math.min(G - 1, ((R - y) / (2 * R)) * (G - 1)));
        const x0 = Math.min(G - 2, Math.floor(u)), y0 = Math.min(G - 2, Math.floor(v));
        const tx = u - x0, ty = v - y0;
        const a = map[y0 * G + x0] * (1 - tx) + map[y0 * G + x0 + 1] * tx;
        const b = map[(y0 + 1) * G + x0] * (1 - tx) + map[(y0 + 1) * G + x0 + 1] * tx;
        return s.baseMm + s.reliefMm * (a * (1 - ty) + b * ty);
      };
      const step = s.diameterMm / COIN_SAMPLES[res];
      mesh = buildCoinMesh(heightAt, {
        diameterMm: s.diameterMm, samples: COIN_SAMPLES[res],
        extraRadii: s.rimMm > 0 ? [inner, inner + Math.min(0.05, step * 0.4)] : [],
      });
    } else {
      const g = gridSize(work.w, work.h, res);
      const map = reliefMap(g.cols, g.rows);
      if (!map) throw new UserError('The AI hasn’t finished reading this photo yet.');
      mesh = buildMesh(map, g.cols, g.rows, s);
    }

    const check = validateMesh(mesh);
    if (!check.ok) {
      console.warn('Mesh validation failed:', check.errors);
      throw new UserError('The generated model didn’t pass the printability checks. Try different settings or a lower resolution.');
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geom.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    const buf = new STLExporter().parse(new THREE.Mesh(geom), { binary: true }).buffer;
    const count = new DataView(buf).getUint32(80, true);
    if (count !== check.stats.triangles || buf.byteLength !== 84 + 50 * count) throw new Error('STL size mismatch');
    stlBuffer = buf;

    showModel(geom, mesh);
    const sz = check.stats.size;
    els.stats.innerHTML =
      '<div><dt>Size</dt><dd>' + fmtMm(sz[0]) + ' × ' + fmtMm(sz[1]) + ' × ' + fmtMm(sz[2]) + '</dd></div>' +
      '<div><dt>Triangles</dt><dd>' + check.stats.triangles.toLocaleString() + '</dd></div>' +
      '<div><dt>Volume</dt><dd>' + (check.stats.volume / 1000).toFixed(2) + ' cm³</dd></div>' +
      '<div><dt>File</dt><dd>' + fmtBytes(buf.byteLength) + '</dd></div>';
    els.stats.hidden = false;
    els.dl.disabled = false;
    els.stale.hidden = true;
    say('Checks passed: closed, watertight, no invalid faces. Ready to download.', 'ok');
  } catch (e) {
    clearModel();
    if (e instanceof UserError) say(e.message, 'error');
    else if (e instanceof RangeError || /memory|allocation/i.test(String(e && e.message))) {
      say('Your browser ran out of memory building this model. Lower the resolution and try again.', 'error');
    } else {
      console.error(e);
      say('Could not generate the STL. Try a smaller image or lower the resolution.', 'error');
    }
  } finally {
    busy = false;
    syncUI();
  }
}

/* ---------- download ---------- */
els.dl.addEventListener('click', function () {
  if (!stlBuffer) return;
  try {
    const url = URL.createObjectURL(new Blob([stlBuffer], { type: 'model/stl' }));
    const a = document.createElement('a');
    a.href = url; a.download = FILENAME;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    say('Downloading ' + FILENAME + '.', 'ok');
  } catch (e) {
    console.error(e);
    say('The download couldn’t start. Try again, or generate at a lower resolution.', 'error');
  }
});

/* ---------- 3D viewer ---------- */
let renderer = null, scene, camera, controls, modelGroup, fitState, material;

const FINISHES = {
  filament: { color: '#d9d1bf', metalness: 0.02, roughness: 0.7, env: 0.12 },
  silver: { color: '#d4d7dc', metalness: 1, roughness: 0.32, env: 0.9 },
  gold: { color: '#e2b857', metalness: 1, roughness: 0.3, env: 0.9 },
};

function initViewer() {
  if (renderer) return true;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) {
    renderer = null;
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  els.viewer.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  camera.up.set(0, 0, 1);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.screenSpacePanning = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 2.8);
  key.position.set(-1.2, -0.8, 0.9);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.5);
  rim.position.set(1.5, 1, 0.8);
  scene.add(rim);
  modelGroup = new THREE.Group();
  scene.add(modelGroup);
  new ResizeObserver(resize).observe(els.viewer);
  resize();
  renderer.setAnimationLoop(function () { controls.update(); renderer.render(scene, camera); });
  return true;
}

function resize() {
  const w = els.viewer.clientWidth, h = els.viewer.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function disposeGroup() {
  if (!modelGroup) return;
  modelGroup.traverse(function (o) {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  modelGroup.clear();
  material = null;
}

function cssColor(name, fallback) {
  return new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
}

function applyFinish() {
  if (!material) return;
  const f = FINISHES[radio('finish')] || FINISHES.filament;
  material.color.set(f.color);
  material.metalness = f.metalness;
  material.roughness = f.roughness;
  scene.environmentIntensity = f.env;
}
document.querySelectorAll('input[name="finish"]').forEach(function (el) { el.addEventListener('change', applyFinish); });

function showModel(geom, mesh) {
  if (!initViewer()) {
    els.viewerEmpty.hidden = false;
    els.viewerEmpty.textContent = 'Your browser can’t show 3D previews (WebGL is off). The STL is still ready to download.';
    return;
  }
  disposeGroup();
  const dims = mesh.dims;
  const g = geom.clone();
  if (!mesh.centred) g.translate(-dims.x / 2, -dims.y / 2, 0);
  g.computeVertexNormals();
  material = new THREE.MeshStandardMaterial();
  applyFinish();
  const model = new THREE.Mesh(g, material);
  modelGroup.add(model);

  const span = Math.max(dims.x, dims.y);
  const cell = span > 200 ? 20 : span > 60 ? 10 : 5;
  const gridMm = Math.ceil((span * 1.3) / cell) * cell;
  const grid = new THREE.GridHelper(gridMm, gridMm / cell, cssColor('--grid-major', '#a3aba1'), cssColor('--grid', '#c6ccc4'));
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -0.01;
  modelGroup.add(grid);

  const box = new THREE.Box3().setFromObject(model);
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * (mesh.centred ? 0.8 : 1.02);
  const dir = mesh.centred ? new THREE.Vector3(0, -0.5, 0.87) : new THREE.Vector3(0, -0.75, 0.66);
  fitState = { centre: centre, pos: centre.clone().add(dir.normalize().multiplyScalar(dist)) };
  camera.near = dist / 100; camera.far = dist * 20; camera.updateProjectionMatrix();
  controls.minDistance = dist / 20; controls.maxDistance = dist * 6;
  resetCamera();
  els.viewerEmpty.hidden = true;
  els.reset.disabled = false;
  document.body.classList.add('has-model');
}

function resetCamera() {
  if (!fitState) return;
  controls.target.copy(fitState.centre);
  camera.position.copy(fitState.pos);
  controls.update();
}
els.reset.addEventListener('click', resetCamera);

function clearModel() {
  stlBuffer = null;
  fitState = null;
  disposeGroup();
  els.dl.disabled = true;
  els.reset.disabled = true;
  els.stats.hidden = true;
  els.stale.hidden = true;
  els.viewerEmpty.hidden = false;
  els.viewerEmpty.textContent = 'Your model appears here after you generate it.';
  document.body.classList.remove('has-model');
}

window.addEventListener('error', function (e) {
  console.error(e.error || e.message);
  say('Something went wrong. Reload the page and try again.', 'error');
});

syncUI();
window.__appReady = true;
els.pick.disabled = false;
