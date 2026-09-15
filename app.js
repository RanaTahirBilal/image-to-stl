import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { gridSize, toGray, buildMesh, validateMesh } from './mesh.js';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 12000;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const EXT = /\.(png|jpe?g|webp)$/i;
const FILENAME = 'image-to-stl.stl';

const $ = function (id) { return document.getElementById(id); };
const els = {
  input: $('file-input'), pick: $('pick-btn'), drop: $('dropzone'),
  work: $('workspace'), img: $('preview-img'), name: $('file-name'),
  dims: $('file-dims'), size: $('file-size'), replace: $('replace-btn'), remove: $('remove-btn'),
  width: $('opt-width'), base: $('opt-base'), relief: $('opt-relief'), invert: $('opt-invert'),
  invertLabel: $('invert-label'), gen: $('gen-btn'), status: $('status'),
  viewer: $('viewer'), viewerEmpty: $('viewer-empty'), reset: $('reset-btn'),
  dl: $('dl-btn'), stats: $('model-stats'), stale: $('stale-note'), outSize: $('out-size'),
};

let image = null;      // { bitmap, w, h, file }
let stlBuffer = null;  // ArrayBuffer of the last valid STL
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
function resolution() { return document.querySelector('input[name="resolution"]:checked').value; }

/* upload */
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
  if (image) { image.bitmap.close(); URL.revokeObjectURL(els.img.src); }
  image = { bitmap: bitmap, w: bitmap.width, h: bitmap.height, file: file };
  els.img.src = URL.createObjectURL(file);
  els.img.alt = 'Uploaded image: ' + file.name;
  els.name.textContent = file.name;
  els.dims.textContent = image.w + ' × ' + image.h + ' px';
  els.size.textContent = fmtBytes(file.size);
  els.work.hidden = false;
  document.body.classList.add('has-image');
  clearModel();
  updateOutSize();
  say('');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  els.work.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

function clearImage() {
  if (busy) return;
  if (image) { image.bitmap.close(); URL.revokeObjectURL(els.img.src); }
  image = null;
  els.img.removeAttribute('src');
  els.work.hidden = true;
  document.body.classList.remove('has-image');
  clearModel();
  say('');
}

/* settings */
function readSettings() {
  function num(el, lo, hi, label) {
    const v = parseFloat(el.value);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new UserError(label + ' must be between ' + lo + ' and ' + hi + ' mm.');
    return v;
  }
  return {
    widthMm: num(els.width, 10, 500, 'Model width'),
    baseMm: num(els.base, 0.5, 20, 'Base thickness'),
    reliefMm: num(els.relief, 0, 50, 'Relief height'),
    resolution: resolution(),
    invert: els.invert.checked,
  };
}

function updateOutSize() {
  if (!image) return;
  const w = parseFloat(els.width.value), b = parseFloat(els.base.value), r = parseFloat(els.relief.value);
  if (![w, b, r].every(Number.isFinite)) { els.outSize.textContent = '—'; return; }
  const g = gridSize(image.w, image.h, resolution());
  const depth = w * (g.rows - 1) / (g.cols - 1);
  const tris = 2 * (g.cols - 1) * (g.rows - 1) + 6 * (g.cols + g.rows - 2);
  els.outSize.textContent = fmtMm(w) + ' × ' + fmtMm(depth) + ' × up to ' + fmtMm(b + r) +
    ' · ' + g.cols + ' × ' + g.rows + ' grid · ≈' + fmtBytes(84 + tris * 50);
}
function updateInvertLabel() {
  els.invertLabel.textContent = els.invert.checked ? 'Dark areas high' : 'Light areas high';
}
document.querySelectorAll('#settings input').forEach(function (el) {
  el.addEventListener('input', function () {
    updateOutSize();
    updateInvertLabel();
    if (stlBuffer) els.stale.hidden = false;
  });
});
updateInvertLabel();

/* generate */
els.gen.addEventListener('click', generate);

async function generate() {
  if (busy || !image) return;
  let s;
  try { s = readSettings(); } catch (e) { return say(e.message, 'error'); }
  busy = true;
  els.gen.disabled = true;
  els.gen.textContent = 'Generating…';
  say('Reading pixels and building the mesh…', 'info');
  await new Promise(function (r) { setTimeout(r, 30); });

  try {
    const g = gridSize(image.w, image.h, s.resolution);
    const canvas = document.createElement('canvas');
    canvas.width = g.cols; canvas.height = g.rows;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image.bitmap, 0, 0, g.cols, g.rows);
    const rgba = ctx.getImageData(0, 0, g.cols, g.rows).data;

    let alphaSum = 0;
    for (let p = 3; p < rgba.length; p += 4) alphaSum += rgba[p];
    if (alphaSum === 0) throw new UserError('This image is fully transparent, so there is nothing to raise. Choose a different image.');

    const gr = toGray(rgba, g.cols, g.rows, s.invert);
    const flat = gr.max - gr.min < 1 / 255;

    const mesh = buildMesh(gr.gray, g.cols, g.rows, s);
    const check = validateMesh(mesh);
    if (!check.ok) {
      console.warn('Mesh validation failed:', check.errors);
      throw new UserError('The generated model didn’t pass the printability checks. Try a different image or lower the resolution.');
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    geom.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    const buf = new STLExporter().parse(new THREE.Mesh(geom), { binary: true }).buffer;
    const count = new DataView(buf).getUint32(80, true);
    if (count !== check.stats.triangles || buf.byteLength !== 84 + 50 * count) throw new Error('STL size mismatch');
    stlBuffer = buf;

    showModel(geom, mesh.dims);
    const sz = check.stats.size;
    els.stats.innerHTML =
      '<div><dt>Size</dt><dd>' + fmtMm(sz[0]) + ' × ' + fmtMm(sz[1]) + ' × ' + fmtMm(sz[2]) + '</dd></div>' +
      '<div><dt>Triangles</dt><dd>' + check.stats.triangles.toLocaleString() + '</dd></div>' +
      '<div><dt>Volume</dt><dd>' + (check.stats.volume / 1000).toFixed(1) + ' cm³</dd></div>' +
      '<div><dt>File</dt><dd>' + fmtBytes(buf.byteLength) + '</dd></div>';
    els.stats.hidden = false;
    els.dl.disabled = false;
    els.stale.hidden = true;
    if (flat) say('Done, but the image is one flat color, so the model is a plain plate with no relief.', 'warn');
    else say('Checks passed: closed, watertight, no invalid faces. Ready to download.', 'ok');
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
    els.gen.disabled = false;
    els.gen.textContent = 'Generate STL';
  }
}

/* download */
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

/* 3D viewer */
let renderer = null, scene, camera, controls, modelGroup, fitState;

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
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  camera.up.set(0, 0, 1);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.screenSpacePanning = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(-1.2, -0.8, 0.9);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.6);
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
}

function cssColor(name, fallback) {
  return new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback);
}

function showModel(geom, dims) {
  if (!initViewer()) {
    els.viewerEmpty.hidden = false;
    els.viewerEmpty.textContent = 'Your browser can’t show 3D previews (WebGL is off). The STL is still ready to download.';
    return;
  }
  disposeGroup();
  const g = geom.clone();
  g.translate(-dims.x / 2, -dims.y / 2, 0);
  g.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: cssColor('--model', '#e4dccb'), roughness: 0.62, metalness: 0.02 });
  const model = new THREE.Mesh(g, mat);
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
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.05;
  fitState = { centre: centre, pos: centre.clone().add(new THREE.Vector3(0, -0.75, 0.66).normalize().multiplyScalar(dist)) };
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

window.__appReady = true;
els.pick.disabled = false;
