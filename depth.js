// Free, on-device AI: Depth Anything V2 Small (depth) and MODNet (portrait cutout).
// Both Apache-2.0. Loaded only when a photo is used; cached by the browser afterwards.

const LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';
const DEPTH_MODEL = 'onnx-community/depth-anything-v2-small';
const MASK_MODEL = 'Xenova/modnet';

let lib = null, depthPipe = null, maskPipe = null, device = null;

async function pickDevice() {
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch (e) { /* fall through */ }
  return 'wasm';
}

// onProgress(fraction 0..1, label)
async function load(onProgress) {
  if (depthPipe && maskPipe) return;
  if (!lib) lib = await import(LIB);
  if (!device) device = await pickDevice();
  const files = {};
  function progress(p) {
    if (!p || !p.file || p.status !== 'progress' && p.status !== 'done') return;
    files[p.file] = p.status === 'done' ? { loaded: 1, total: 1 } : { loaded: p.loaded || 0, total: p.total || 1 };
    let l = 0, t = 0;
    for (const k in files) { l += files[k].loaded; t += files[k].total; }
    if (onProgress && t > 0) onProgress(Math.min(0.99, l / t), 'Downloading the free AI models (one time)…');
  }
  const gpu = device === 'webgpu';
  const tasks = [];
  if (!depthPipe) {
    tasks.push(lib.pipeline('depth-estimation', DEPTH_MODEL, {
      device: device, dtype: gpu ? 'fp16' : 'q8', progress_callback: progress,
    }).then(function (p) { depthPipe = p; }));
  }
  if (!maskPipe) {
    tasks.push(lib.pipeline('background-removal', MASK_MODEL, {
      device: device, dtype: gpu ? 'fp16' : 'fp32', progress_callback: progress,
    }).then(function (p) { maskPipe = p; }));
  }
  await Promise.all(tasks);
}

function tensorToMap(tensor) {
  const dims = tensor.dims;
  const h = dims[dims.length - 2], w = dims[dims.length - 1];
  const data = tensor.data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Number(data[i]);
  return { map: out, w: w, h: h };
}

// canvas: the photo (already scaled). Returns { depth, mask, w, h, device }.
export async function analysePhoto(canvas, onProgress) {
  await load(onProgress);
  const image = lib.RawImage.fromCanvas(canvas);
  if (onProgress) onProgress(1, 'Estimating depth…');
  const d = await depthPipe(image);
  const depth = tensorToMap(d.predicted_depth);
  if (onProgress) onProgress(1, 'Separating the subject from the background…');
  const cut = await maskPipe(image);
  const w = canvas.width, h = canvas.height;
  let mask = null;
  if (cut && cut.data && cut.channels === 4 && cut.width === w && cut.height === h) {
    mask = new Float32Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = cut.data[i * 4 + 3] / 255;
  }
  if (depth.w !== w || depth.h !== h) throw new Error('depth size ' + depth.w + 'x' + depth.h + ' != ' + w + 'x' + h);
  return { depth: depth.map, mask: mask, w: w, h: h, device: device };
}

export function aiDevice() { return device; }
