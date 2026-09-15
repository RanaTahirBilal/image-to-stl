# Relief STL Maker

Turn a photo or a logo into a 3D-printable coin or plaque STL. Free, no account, and everything runs in the browser: nothing is uploaded.

Live: https://ranatahirbilal.github.io/image-to-stl/

## How it works

- Photos: two free AI models run on your device through Transformers.js.
  - Depth Anything V2 Small (Apache-2.0) estimates depth, so faces come out as real 3D shapes instead of light and dark bumps.
  - MODNet (Apache-2.0) finds the person so the background can be made flat.
  - The depth is turned into a bas-relief: the overall slope is flattened, local shape is kept, and fine detail from the photo is added back.
- Logos and artwork: brightness becomes height (light high, or dark high), with contrast stretch, smoothing and a contrast curve.
- Coins are meshed as concentric rings with evenly spaced points, a raised rim, a vertical edge and a flat back. Plaques use a rectangular grid.
- Before download every mesh is checked: closed and watertight, consistent winding, no NaN or infinite coordinates, no degenerate triangles, no duplicate vertices, non-zero size, positive volume.
- Exported as binary STL with the three.js STLExporter and previewed with three.js.

The AI models (about 50 to 65 MB) download once on first use and are cached by the browser.

## Files

- index.html: page and styles
- app.js: upload, settings, previews, download
- depth.js: loads and runs the free AI models
- heights.js: height-map processing (bas-relief, detail, smoothing, shading)
- coin.js: round coin mesh
- mesh.js: rectangular plaque mesh and mesh validation
