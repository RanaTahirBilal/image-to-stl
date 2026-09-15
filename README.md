# Image to STL

Upload a PNG, JPG or WEBP image and turn it into a 3D-printable relief STL, entirely in the browser. Nothing is uploaded to a server.

## How it works

1. The image is scaled to a height-map grid (Low 150 / Medium 300 / High 600 samples on the long side, never upscaled).
2. Each sample becomes a vertex: height = base thickness + gray x relief height (light = high by default; transparent = low).
3. The mesh is the top surface, four side walls and a flat bottom at Z = 0, all sharing vertices.
4. Before download the mesh is checked: closed and watertight (every edge shared by exactly two faces with consistent winding), no NaN or infinite coordinates, no degenerate triangles, no duplicate vertices, non-zero size, positive volume.
5. Exported as binary STL with the three.js STLExporter and previewed with three.js and OrbitControls (three.js r169, loaded from jsDelivr).

## Files

- index.html: page and styles
- app.js: upload, settings, preview, download
- mesh.js: height map to watertight mesh, and mesh validation
