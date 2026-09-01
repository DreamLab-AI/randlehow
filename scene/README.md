# site/scene — Randlehow 3D architect's model

The Three.js scene island. Implements **contracts.md §5** exactly. No npm, no
build step: `scene.js` + `vendor/*` are served as-is.

## Files

| File | Purpose | Size (raw / gz) |
|------|---------|-----------------|
| `scene.js` | the module — `initScene()` + handle (contracts §5) | 42 KB / 11.8 KB |
| `vendor/three.module.js` | three.js r185 entry (re-exports core) | 635 KB / 127 KB |
| `vendor/three.core.js` | three.js r185 engine | 1409 KB / 278 KB |
| `vendor/OrbitControls.js` | orbit camera (import patched → `./three.module.js`) | 40 KB / 8 KB |
| `dev.html` | standalone test harness (no Leptos) | 8 KB |
| `fixtures/` | generated valley terrain + buildings + road + issues | — |

Three.js version pinned in `vendor/VERSION.txt` (r185 / npm 0.185.1).

## Public API (contracts §5)

```js
import { initScene } from './scene.js';
const handle = await initScene(canvas, { terrainUrl, buildings, roadMesh });
//   buildings / roadMesh are PARSED objects; scene.js fetches+parses terrain.bin itself.
handle.setIssues(issues);          // SceneIssue[]; full replace, idempotent
handle.setTimeRange(fromMs, toMs); // null,null = show all
handle.focus(entityId);            // building id | issue id → smooth camera tween
handle.setHighlight(entityId|null);
handle.setPickMode(bool);          // clicks on terrain/road → onPick
handle.onHover(cb);  // {type,id,name,meta,screenX,screenY} | null
handle.onSelect(cb); // {type,id}
handle.onPick(cb);   // {local:[x,y,z], wgs84:[lon,lat]}
handle.resize();     // debounced
handle.dispose();    // full teardown (geometries, materials, renderer, listeners)

// §5 rev 3 — geo helpers + ghost pin (phone GPS "report here" flow)
handle.terrainHeightAt(x, z);        // bilinear grid height | null outside
handle.snapToRoad(x, z, maxDist);    // {local:[x,y,z], snapped} | null (>maxDist)
                                     //   inside outline → snapped:false; else nearest
                                     //   point on outline/corridor within maxDist
handle.showGhostPin(local | null);   // amber draggable provisional pin (drag on terrain)
handle.onGhostMoved(cb);             // cb({local:[x,y,z], wgs84:[lon,lat]}) on drag end
handle.setLabels(bool);              // §5 rev 4 — billboard name labels on/off (default on)
handle.localToWgs84(x, z);           // convenience (also used internally by onPick)
handle.wgs84ToLocal(lon, lat);       // inverse; on the handle and module-exported

// module-level export (needs initScene to have set the origin):
import { initScene, wgs84ToLocal } from './scene.js';
```

Road: contracts §2.3 v1 (single ribbon) **and** v2 (`groups:[{start,count,kind}]`,
kind ∈ randlehow|public|track|path) both supported — one mesh, per-kind material
tint via `addGroup` + material array. v1 files render all as `randlehow`.

## Running the dev harness

```bash
cd site/scene
python3 fixtures/make-fixtures.py     # (re)generate fixtures — pure stdlib
python3 -m http.server 8199           # any static server; needs http for fetch()
# open http://localhost:8199/dev.html
```

The harness exposes the live handle as `window.__scene` for automated drivers.
Every API method has a button; events log to the on-canvas console; hover shows a
tooltip. `fixtures/make-fixtures.py` builds a plausible 800×500 m Cumbrian valley
(origin BNG 314200,500600 ≈ Eskdale Green) with 4 labelled + 2 context buildings,
a draped road ribbon, and 7 issues spanning 2024–2026.

**Data source toggle:** the harness has *fixtures* (self-contained) and *real
assets-src* (the baked `../assets-src/{terrain.bin,buildings.json,road-mesh.json}`).
For the real mode the server must be rooted at `site/` so `../assets-src/`
resolves: `cd site && python3 -m http.server 8200`, open
`http://localhost:8200/scene/dev.html`. Real mode synthesises 6 issues on the
road (no seed issues baked yet). Verified end-to-end on the real 262×300 LiDAR
grid + 20 labelled/28 context buildings: correct outward-facing walls on the
concave OSM footprints (no winding flip needed), origin → `-3.3225, 54.3883`
(≈ KML centre `-3.3245, 54.3889`).

**⚠ Canvas reuse:** `dispose()` calls `renderer.forceContextLoss()` to free the
GPU context immediately (matters on mobile — limited live contexts). A
force-lost `<canvas>` **cannot** acquire a new WebGL context, so to
re-initialise you must pass a **fresh `<canvas>` element** (the harness swaps one
in on every boot via `freshCanvas()`). The Leptos island already does this
naturally — it creates the canvas node on mount and disposes on unmount. If the
island is ever changed to re-init on the same node, create a new `<canvas>`
first.

## Notes / contract clarifications

- **Shadows:** three r185 deprecated `PCFSoftShadowMap` (falls back to hard PCF).
  Uses `VSMShadowMap` + blur for the genuinely soft shadows the brief asks for.
- **WGS84 in `onPick`:** the terrain header carries only BNG `originE/originN`,
  so `local→wgs84` is `inverse-§1 (→ BNG E/N)` then an Ordnance Survey reverse
  transverse-Mercator (Airy 1830) + Helmert OSGB36→WGS84. Accuracy ≈ few metres.
  Verified: origin → `-3.3229, 54.3936` (Fairfield/Eskdale).
- **Building intersection:** bases sink into the terrain — `base y = min(vertex+
  centroid terrain samples) − 2.0 m`, `top y = mean(samples) + height` — so
  buildings read as glued into the hill with no floating downhill edges, eaves
  still correct against the ground.
- **Billboard labels (§5 rev 4):** the 20 *labelled* buildings get a paper-card
  name (#faf8f3 / #c9c2b2 hairline / #1a2b1e ink) on a stem from the roof
  centroid, canvas-texture Sprite (DPR-crisp, one per label). Constant on-screen
  size (world scale clamped by camera distance); **close-range only** — fully
  visible ≲120 m, faded out by 180 m, so overview shots stay calm. Stems stagger
  by cluster proximity (dense south-end group). Labels never intercept
  raycasts (no-op raycast + absent from target arrays); building hover passes
  through. `setLabels(false)` hides them. Context buildings get no label.
- **Transform iteration caps:** all three OSGB↔WGS84 convergence loops are capped
  at 30 iterations. Without the cap a pathological input (e.g. a NaN/edge point
  from a drag) can infinite-loop and hang the tab — caught in live testing when a
  ghost drag froze the page. Never remove the caps.
- **`setTimeRange` lower bound:** `to` semantics are per contract (reported ≤ to;
  fixed only if fixedAtMs ≤ to; reported-after-to hidden). `from`, when non-null,
  additionally recedes issues fixed before it (history replay). Pass `null` to
  ignore the lower bound.
