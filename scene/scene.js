// scene.js — Randlehow Road 3D architect's model (contracts.md §5, ADR-006)
//
// ES module, dependency-free besides ./vendor/*. Renders real Lake District
// terrain, OSM building massing, the road ribbon, and issue pins as a
// "lovingly made architect's model". Public API is exactly contracts §5.
//
// Coordinate system (contracts §1): three.js Y-up metres, local origin O.
//   x = easting  − originE   (+x east)
//   z = −(northing − originN) (+z south)
//   y = elevation (m AOD)
//
// Everything is module-scoped inside initScene — no globals leak.

import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';

// ────────────────────────────────────────────────────────────────────────
// Palette (architect's model)
// ────────────────────────────────────────────────────────────────────────
const PAL = {
  terrainCream:   0xf5f1e8,
  terrainSage:    0xd9ddc4, // subtle high-ground tint
  skirt:          0xcabfa8, // darker plinth
  skirtBottom:    0xb7ac95,
  roadGrey:       0xb8b0a0,
  buildingWall:   0xfaf8f3, // labelled
  buildingCtx:    0xe4ded0, // context (muted/desaturated)
  fog:            0xe0dcd1, // mid paper tone
  bgTop:          '#e8e4da',
  bgBottom:       '#d8d4c8',
  sun:            0xfff2d6, // warm directional
  hemiSky:        0xd6dcc6, // sage sky
  hemiGround:     0x8a7d68, // earth
  pinSurface:         0xc05b3c, // terracotta
  pinDrainage:        0x4a6b8a, // slate blue
  pinWinter:          0x6b5b8a, // cool violet
  highlight:      0xffd98a,
};

const CATEGORY_COLOR = {
  'surface':              PAL.pinSurface,
  'drainage-vegetation':  PAL.pinDrainage,
  'winter-access':        PAL.pinWinter,
};

const SEVERITY_SCALE = { low: 0.8, medium: 1.0, high: 1.25 };

// status → visual form bucket
function statusForm(status) {
  if (status === 'fixed' || status === 'closed') return 'sunken';
  if (status === 'monitoring' || status === 'planned' || status === 'in-progress') return 'ringed';
  return 'open'; // reported | acknowledged | anything else
}

// easing for camera tween
const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

// ════════════════════════════════════════════════════════════════════════
// BNG (EPSG:27700, OSGB36 / Airy 1830) → WGS84 lon/lat
// Ordnance Survey reverse transverse-Mercator + Helmert OSGB36→WGS84.
// Accuracy ≈ few metres (no OSTN grid) — ample for pin placement.
// ════════════════════════════════════════════════════════════════════════
function eastNorthToWgs84(E, N) {
  // Airy 1830 ellipsoid + National Grid true origin
  const a = 6377563.396, b = 6356256.909;
  const F0 = 0.9996012717;
  const lat0 = 49 * Math.PI / 180, lon0 = -2 * Math.PI / 180;
  const N0 = -100000, E0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);
  const n2 = n * n, n3 = n * n * n;

  let lat = lat0, M = 0, it = 0;
  do {
    lat = (N - N0 - M) / (a * F0) + lat;
    const dLat = lat - lat0, sLat = lat + lat0;
    const Ma = (1 + n + 1.25 * n2 + 1.25 * n3) * dLat;
    const Mb = (3 * n + 3 * n2 + 2.625 * n3) * Math.sin(dLat) * Math.cos(sLat);
    const Mc = (1.875 * n2 + 1.875 * n3) * Math.sin(2 * dLat) * Math.cos(2 * sLat);
    const Md = (35 / 24) * n3 * Math.sin(3 * dLat) * Math.cos(3 * sLat);
    M = b * F0 * (Ma - Mb + Mc - Md);
  } while (Math.abs(N - N0 - M) >= 0.00001 && ++it < 30); // iteration cap = no hang

  const sinLat = Math.sin(lat), cosLat = Math.cos(lat), tanLat = Math.tan(lat);
  const nu = a * F0 / Math.sqrt(1 - e2 * sinLat * sinLat);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * sinLat * sinLat, 1.5);
  const eta2 = nu / rho - 1;

  const tan2 = tanLat * tanLat, tan4 = tan2 * tan2, tan6 = tan4 * tan2;
  const secLat = 1 / cosLat;
  const nu3 = nu * nu * nu, nu5 = nu3 * nu * nu, nu7 = nu5 * nu * nu;

  const VII = tanLat / (2 * rho * nu);
  const VIII = tanLat / (24 * rho * nu3) * (5 + 3 * tan2 + eta2 - 9 * tan2 * eta2);
  const IX = tanLat / (720 * rho * nu5) * (61 + 90 * tan2 + 45 * tan4);
  const X = secLat / nu;
  const XI = secLat / (6 * nu3) * (nu / rho + 2 * tan2);
  const XII = secLat / (120 * nu5) * (5 + 28 * tan2 + 24 * tan4);
  const XIIA = secLat / (5040 * nu7) * (61 + 662 * tan2 + 1320 * tan4 + 720 * tan6);

  const dE = E - E0, dE2 = dE * dE, dE3 = dE2 * dE, dE4 = dE2 * dE2,
        dE5 = dE3 * dE2, dE6 = dE4 * dE2, dE7 = dE5 * dE2;

  let latA = lat - VII * dE2 + VIII * dE4 - IX * dE6;
  let lonA = lon0 + X * dE - XI * dE3 + XII * dE5 - XIIA * dE7;

  // OSGB36 (Airy) → WGS84 via Helmert. Convert to cartesian first.
  const H = 0;
  const sA = Math.sin(latA), cA = Math.cos(latA), sL = Math.sin(lonA), cL = Math.cos(lonA);
  const nuA = a / Math.sqrt(1 - e2 * sA * sA);
  const x1 = (nuA + H) * cA * cL;
  const y1 = (nuA + H) * cA * sL;
  const z1 = ((1 - e2) * nuA + H) * sA;

  // OSGB36 → WGS84 Helmert params
  const tx = 446.448, ty = -125.157, tz = 542.060;
  const s = -20.4894e-6;
  const rx = (0.1502 / 3600) * Math.PI / 180;
  const ry = (0.2470 / 3600) * Math.PI / 180;
  const rz = (0.8421 / 3600) * Math.PI / 180;
  const x2 = tx + (1 + s) * x1 - rz * y1 + ry * z1;
  const y2 = ty + rz * x1 + (1 + s) * y1 - rx * z1;
  const z2 = tz - ry * x1 + rx * y1 + (1 + s) * z1;

  // WGS84 ellipsoid
  const aW = 6378137.0, bW = 6356752.3142;
  const e2W = 1 - (bW * bW) / (aW * aW);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let latW = Math.atan2(z2, p * (1 - e2W));
  let latPrev, itW = 0;
  do {
    latPrev = latW;
    const sW = Math.sin(latW);
    const nuW = aW / Math.sqrt(1 - e2W * sW * sW);
    latW = Math.atan2(z2 + e2W * nuW * sW, p);
  } while (Math.abs(latW - latPrev) > 1e-11 && ++itW < 30);
  const lonW = Math.atan2(y2, x2);

  return [lonW * 180 / Math.PI, latW * 180 / Math.PI];
}

// ════════════════════════════════════════════════════════════════════════
// WGS84 lon/lat → BNG (EPSG:27700, OSGB36 / Airy 1830) E,N — mirror of the
// reverse above. WGS84 → cartesian → Helmert WGS84→OSGB36 → Airy lat/lon →
// forward transverse-Mercator → E,N.
// ════════════════════════════════════════════════════════════════════════
function wgs84ToEastNorth(lon, lat) {
  const phi = lat * Math.PI / 180, lam = lon * Math.PI / 180;
  // WGS84 ellipsoid → cartesian (H=0)
  const aW = 6378137.0, bW = 6356752.3142;
  const e2W = 1 - (bW * bW) / (aW * aW);
  const sP = Math.sin(phi), cP = Math.cos(phi);
  const nuW = aW / Math.sqrt(1 - e2W * sP * sP);
  const x1 = nuW * cP * Math.cos(lam);
  const y1 = nuW * cP * Math.sin(lam);
  const z1 = (1 - e2W) * nuW * sP;

  // Helmert WGS84 → OSGB36 (negated params of the reverse)
  const tx = -446.448, ty = 125.157, tz = -542.060;
  const s = 20.4894e-6;
  const rx = (-0.1502 / 3600) * Math.PI / 180;
  const ry = (-0.2470 / 3600) * Math.PI / 180;
  const rz = (-0.8421 / 3600) * Math.PI / 180;
  const x2 = tx + (1 + s) * x1 - rz * y1 + ry * z1;
  const y2 = ty + rz * x1 + (1 + s) * y1 - rx * z1;
  const z2 = tz - ry * x1 + rx * y1 + (1 + s) * z1;

  // OSGB36 cartesian → Airy lat/lon (iterative)
  const a = 6377563.396, b = 6356256.909;
  const e2 = 1 - (b * b) / (a * a);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let latA = Math.atan2(z2, p * (1 - e2)), prev, itA = 0;
  do {
    prev = latA;
    const sA = Math.sin(latA);
    const nuA = a / Math.sqrt(1 - e2 * sA * sA);
    latA = Math.atan2(z2 + e2 * nuA * sA, p);
  } while (Math.abs(latA - prev) > 1e-11 && ++itA < 30);
  const lonA = Math.atan2(y2, x2);

  // forward transverse-Mercator on Airy → E,N
  const F0 = 0.9996012717;
  const lat0 = 49 * Math.PI / 180, lon0 = -2 * Math.PI / 180;
  const N0 = -100000, E0 = 400000;
  const n = (a - b) / (a + b), n2 = n * n, n3 = n * n * n;
  const s2 = Math.sin(latA), c2 = Math.cos(latA), t2 = Math.tan(latA);
  const nu = a * F0 / Math.sqrt(1 - e2 * s2 * s2);
  const rho = a * F0 * (1 - e2) / Math.pow(1 - e2 * s2 * s2, 1.5);
  const eta2 = nu / rho - 1;
  const dLat = latA - lat0, sLat = latA + lat0;
  const M = b * F0 * (
    (1 + n + 1.25 * n2 + 1.25 * n3) * dLat
    - (3 * n + 3 * n2 + 2.625 * n3) * Math.sin(dLat) * Math.cos(sLat)
    + (1.875 * n2 + 1.875 * n3) * Math.sin(2 * dLat) * Math.cos(2 * sLat)
    - (35 / 24) * n3 * Math.sin(3 * dLat) * Math.cos(3 * sLat));
  const t2sq = t2 * t2, t2q = t2sq * t2sq;
  const I = M + N0;
  const II = (nu / 2) * s2 * c2;
  const III = (nu / 24) * s2 * c2 * c2 * c2 * (5 - t2sq + 9 * eta2);
  const IIIA = (nu / 720) * s2 * Math.pow(c2, 5) * (61 - 58 * t2sq + t2q);
  const IV = nu * c2;
  const V = (nu / 6) * c2 * c2 * c2 * (nu / rho - t2sq);
  const VI = (nu / 120) * Math.pow(c2, 5) * (5 - 18 * t2sq + t2q + 14 * eta2 - 58 * t2sq * eta2);
  const dL = lonA - lon0, dL2 = dL * dL;
  const N = I + II * dL2 + III * dL2 * dL2 + IIIA * dL2 * dL2 * dL2;
  const E = E0 + IV * dL + V * dL2 * dL + VI * dL2 * dL2 * dL;
  return [E, N];
}

// module-level scene origin (BNG), set by initScene so the exported
// wgs84ToLocal can convert without a handle. One scene per page.
let _originE = null, _originN = null;

/**
 * WGS84 lon/lat → scene-local [x, z] (contracts §1 + §5 rev 3).
 * Requires initScene to have run (origin comes from the terrain header).
 */
export function wgs84ToLocal(lon, lat) {
  if (_originE == null) throw new Error('wgs84ToLocal: initScene must run first (origin unset)');
  const [E, N] = wgs84ToEastNorth(lon, lat);
  return [E - _originE, -(N - _originN)];
}

// ════════════════════════════════════════════════════════════════════════
// initScene
// ════════════════════════════════════════════════════════════════════════
export async function initScene(canvas, { terrainUrl, buildings, roadMesh }) {
  // ---- resource bookkeeping (disposed in dispose()) --------------------
  const geometries = new Set();
  const materials = new Set();
  const trackGeo = g => { geometries.add(g); return g; };

  // ---- renderer --------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, alpha: true, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0); // transparent → CSS paper gradient shows through
  renderer.shadowMap.enabled = true;
  // r185 deprecated PCFSoftShadowMap (falls back to hard PCF); VSM is the
  // current path to genuinely soft, long shadows — the architect's-model look.
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  // paper gradient painted on the canvas element itself (no texture)
  canvas.style.background = `linear-gradient(${PAL.bgTop}, ${PAL.bgBottom})`;

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(45, 1, 1, 6000);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 0.7;

  // ---- parse + build terrain ------------------------------------------
  const terrain = await fetchTerrain(terrainUrl);
  const { header } = terrain;
  const originE = header.originE, originN = header.originN, cell = header.cell;
  _originE = originE; _originN = originN;   // enable exported wgs84ToLocal

  // model bounds in scene coords
  const x0 = header.minE - originE;                         // west edge (col 0)
  const z0 = -(header.maxN - originN);                      // north edge (row 0)
  const spanX = (header.width - 1) * cell;
  const spanZ = (header.height - 1) * cell;
  const xC = x0 + spanX / 2;
  const zC = z0 + spanZ / 2;
  const yC = (header.zMin + header.zMax) / 2;
  const modelSpan = Math.max(spanX, spanZ);
  const center = new THREE.Vector3(xC, yC, zC);

  const terrainMesh = buildTerrain(terrain, geometries, materials, roadMesh);
  scene.add(terrainMesh.mesh);
  scene.add(terrainMesh.skirt);
  if (terrainMesh.lodSkirt) scene.add(terrainMesh.lodSkirt);
  const sampleHeight = terrainMesh.sampleHeight;

  // ---- background fog blends model edge into paper ---------------------
  scene.fog = new THREE.Fog(PAL.fog, modelSpan * 0.55, modelSpan * 1.7);

  // ---- lighting --------------------------------------------------------
  const hemi = new THREE.HemisphereLight(PAL.hemiSky, PAL.hemiGround, 0.75);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(PAL.sun, 2.6);
  // NW, low: −x (west), +z? NW = west+north → −x, −z. low elevation.
  sun.position.set(xC - modelSpan * 0.5, yC + modelSpan * 0.45, zC - modelSpan * 0.55);
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  const half = modelSpan * 0.62;
  sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
  sc.near = 1; sc.far = modelSpan * 2.2;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  sun.shadow.radius = 5;        // VSM blur → soft penumbra
  sun.shadow.blurSamples = 16;
  scene.add(sun);
  scene.add(sun.target);

  const fill = new THREE.DirectionalLight(0xffffff, 0.25); // gentle SE fill, no shadow
  fill.position.set(xC + modelSpan * 0.4, yC + modelSpan * 0.3, zC + modelSpan * 0.4);
  scene.add(fill);

  // ---- buildings -------------------------------------------------------
  const buildingMeshes = [];            // pickable
  const buildingById = new Map();
  const labelAnchors = [];              // labelled buildings → billboard labels
  buildBuildings(buildings, { scene, sampleHeight, buildingMeshes, buildingById, geometries, materials, labelAnchors });

  // ---- billboard name labels (§5 rev 4) --------------------------------
  const labelsGroup = new THREE.Group();
  scene.add(labelsGroup);
  const labelSprites = [];              // {sprite, pos:Vector3, aspect}
  let labelsVisible = true;
  const LABEL_FADE_NEAR = 120, LABEL_FADE_FAR = 180; // camera dist metres (close-range only)
  buildLabels(labelAnchors);

  function buildLabels(anchors) {
    // stagger stem heights so cards in dense clusters don't overlap
    const R = 35, STEM0 = 3.0, STEP = 2.4;
    const levels = anchors.map(() => 0);
    for (let i = 0; i < anchors.length; i++) {
      for (let j = 0; j < i; j++) {
        const d = Math.hypot(anchors[i].cx - anchors[j].cx, anchors[i].cz - anchors[j].cz);
        if (d < R) levels[i] = Math.max(levels[i], levels[j] + 1);
      }
    }
    anchors.forEach((a, i) => {
      const tex = makeLabelTexture(a.name);
      const stemH = STEM0 + levels[i] * STEP;
      // stem: thin vertical post from roof centroid up to the card
      const stemGeo = trackGeo(new THREE.CylinderGeometry(0.09, 0.09, stemH, 6));
      const stemMat = new THREE.MeshStandardMaterial({ color: 0x6b6357, roughness: 0.8, metalness: 0 });
      materials.add(stemMat);
      const stem = new THREE.Mesh(stemGeo, stemMat);
      stem.position.set(a.cx, a.roofY + stemH / 2, a.cz);
      stem.castShadow = false; stem.receiveShadow = false;
      stem.raycast = () => {};
      labelsGroup.add(stem);

      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: true });
      materials.add(mat);
      const sprite = new THREE.Sprite(mat);
      sprite.center.set(0.5, 0);        // anchor card BOTTOM at the stem top
      sprite.position.set(a.cx, a.roofY + stemH, a.cz);
      sprite.raycast = () => {};        // never intercept picks
      labelsGroup.add(sprite);
      labelSprites.push({ sprite, pos: sprite.position.clone(), aspect: tex.image.width / tex.image.height });
    });
  }

  function updateLabels() {
    if (!labelsVisible || !labelSprites.length) return;
    const vh = (canvas.clientHeight || canvas.height || 1);
    const perPxPerM = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / vh;
    const TARGET_PX = 34;               // card height on screen (phone-legible)
    for (const L of labelSprites) {
      const d = camera.position.distanceTo(L.pos);
      const op = clamp((LABEL_FADE_FAR - d) / (LABEL_FADE_FAR - LABEL_FADE_NEAR), 0, 1);
      if (op <= 0.001) { L.sprite.visible = false; continue; }
      L.sprite.visible = true;
      L.sprite.material.opacity = op;
      // constant on-screen size; band chosen so no clamping across the
      // 72–180 m viewing range (labels only show inside that range anyway)
      const worldH = clamp(TARGET_PX * perPxPerM * d, 2.0, 9.0);
      L.sprite.scale.set(worldH * L.aspect, worldH, 1);
    }
  }

  // ---- road ribbon (contracts §2.3, v1 + v2 grouped) -------------------
  const pickTargetsTerrain = [terrainMesh.mesh];
  let roadOutline = null;           // polygon ring [x,z] for snapping
  let roadVerts = null;             // Float32 positions for corridor snapping
  if (roadMesh && roadMesh.positions && roadMesh.positions.length) {
    const roadObj = buildRoad(roadMesh, geometries, materials);
    scene.add(roadObj);
    pickTargetsTerrain.push(roadObj);
    roadOutline = Array.isArray(roadMesh.outline) ? roadMesh.outline : null;
    roadVerts = roadMesh.positions;
  }

  // ---- pins ------------------------------------------------------------
  const pinsGroup = new THREE.Group();
  scene.add(pinsGroup);
  const pinRecords = new Map();  // id → record
  const pinHitTargets = [];      // hit spheres (pickable)
  // shared pin geometries
  const pinGeo = {
    cone:   trackGeo(new THREE.ConeGeometry(0.9, 3.0, 18)),
    top:    trackGeo(new THREE.SphereGeometry(0.55, 16, 12)),
    ring:   trackGeo(new THREE.TorusGeometry(1.45, 0.16, 10, 28)),
    disc:   trackGeo(new THREE.CylinderGeometry(1.35, 1.35, 0.28, 24)),
    hit:    trackGeo(new THREE.SphereGeometry(2.8, 8, 6)),
  };

  // ---- state -----------------------------------------------------------
  let timeFrom = null, timeTo = null;         // ms
  let highlightId = null;
  let pickMode = false;
  let hoverId = null;
  const cbs = { hover: null, select: null, pick: null, ghostMoved: null };

  // ---- raycasting ------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let pendingHover = null;      // latest pointer event awaiting raycast
  let downPos = null;           // pointerdown position (click vs drag)
  let draggingGhost = false;    // ghost-pin drag in progress

  // ---- ghost pin (provisional "report here" marker, drag-on-terrain) ---
  let ghost = null;             // {group, hit, materials[]}
  function ensureGhost() {
    if (ghost) return ghost;
    const group = new THREE.Group();
    const mats = [];
    const amber = 0xffb300;
    const stemMat = new THREE.MeshStandardMaterial({ color: amber, emissive: amber, emissiveIntensity: 0.5, roughness: 0.4, transparent: true, opacity: 0.9 });
    const ringMat = new THREE.MeshBasicMaterial({ color: amber, transparent: true, opacity: 0.5, depthWrite: false });
    mats.push(stemMat, ringMat);
    materials.add(stemMat); materials.add(ringMat);
    const coneH = 4.0, floatGap = 0.8;
    const cone = new THREE.Mesh(pinGeo.cone, stemMat);
    cone.rotation.x = Math.PI; cone.position.y = floatGap + coneH / 2; cone.scale.setScalar(1.15);
    cone.raycast = () => {};
    const top = new THREE.Mesh(pinGeo.top, stemMat);
    top.position.y = floatGap + coneH + 0.15; top.scale.setScalar(1.3); top.raycast = () => {};
    const ring = new THREE.Mesh(pinGeo.ring, ringMat);
    ring.rotation.x = Math.PI / 2; ring.position.y = floatGap - 0.05; ring.scale.setScalar(1.4);
    ring.raycast = () => {};
    const hit = new THREE.Mesh(pinGeo.hit, hitMaterial());
    hit.position.y = 2.5; hit.scale.setScalar(1.4); hit.userData = { type: 'ghost' };
    group.add(cone, top, ring, hit);
    group.visible = false;
    scene.add(group);
    ghost = { group, hit, materials: mats, ring };
    return ghost;
  }
  function positionGhost(x, z) {
    const g = ensureGhost();
    g.group.position.set(x, groundYAt([x, 0, z]), z);
  }
  function updateGhost(time) {
    if (!ghost || !ghost.group.visible) return false;
    const s = 1 + 0.06 * Math.sin(time * 3.5);
    ghost.ring.scale.setScalar(1.4 * s);
    ghost.materials[1].opacity = 0.35 + 0.2 * (0.5 + 0.5 * Math.sin(time * 3.5));
    return true;
  }

  // ════════════════════════════════════════════════════════════════════
  // camera framing + tween
  // ════════════════════════════════════════════════════════════════════
  function frameWhole() {
    // whole road from SE, sun-lit
    const dist = modelSpan * 0.95;
    camera.position.set(xC + dist * 0.6, yC + dist * 0.55, zC + dist * 0.62);
    controls.target.copy(center);
    controls.minDistance = modelSpan * 0.12;
    controls.maxDistance = modelSpan * 2.0;
    controls.minPolarAngle = 0.12;
    controls.maxPolarAngle = 1.45; // stay above ground plane
    controls.update();
  }
  frameWhole();

  let tween = null;             // {t0, dur, fromPos, toPos, fromTgt, toTgt}
  function tweenTo(toPos, toTgt, dur = 850) {
    tween = {
      t0: now(), dur,
      fromPos: camera.position.clone(),
      toPos: toPos.clone(),
      fromTgt: controls.target.clone(),
      toTgt: toTgt.clone(),
    };
    requestRender();
  }

  // ════════════════════════════════════════════════════════════════════
  // pins: build / update
  // ════════════════════════════════════════════════════════════════════
  function disposePinRecord(rec) {
    rec.group.parent && rec.group.parent.remove(rec.group);
    rec.meshes.forEach(m => { if (m.geometry && !isSharedPinGeo(m.geometry)) m.geometry.dispose(); });
    rec.ownMaterials.forEach(m => { materials.delete(m); m.dispose(); });
    const hi = pinHitTargets.indexOf(rec.hit);
    if (hi >= 0) pinHitTargets.splice(hi, 1);
  }
  function isSharedPinGeo(g) { return Object.values(pinGeo).includes(g); }

  function buildPinVisual(rec) {
    // (re)build meshes for the current form; keep the group + hit sphere
    rec.meshes.forEach(m => rec.group.remove(m));
    rec.meshes.length = 0;
    rec.ownMaterials.forEach(m => { materials.delete(m); m.dispose(); });
    rec.ownMaterials.length = 0;

    const issue = rec.issue;
    const color = CATEGORY_COLOR[issue.category] || 0x888888;
    const sev = SEVERITY_SCALE[issue.severity] || 1.0;
    const muted = rec.form === 'sunken';
    const mat = new THREE.MeshStandardMaterial({
      color, roughness: 0.55, metalness: 0.0,
      emissive: color, emissiveIntensity: muted ? 0.03 : 0.18,
      transparent: true, opacity: rec.curOpa,
      depthWrite: !muted,
    });
    rec.ownMaterials.push(mat);
    materials.add(mat);

    const floatGap = 0.6;
    if (rec.form === 'sunken') {
      const disc = new THREE.Mesh(pinGeo.disc, mat);
      disc.position.y = -0.05;
      disc.raycast = () => {};
      disc.receiveShadow = true;
      rec.group.add(disc); rec.meshes.push(disc);
    } else {
      const coneH = 3.0;
      const cone = new THREE.Mesh(pinGeo.cone, mat);
      cone.rotation.x = Math.PI;                     // apex down
      cone.position.y = floatGap + coneH / 2;
      cone.castShadow = true;
      cone.raycast = () => {};
      rec.group.add(cone); rec.meshes.push(cone);

      const top = new THREE.Mesh(pinGeo.top, mat);
      top.position.y = floatGap + coneH + 0.1;
      top.castShadow = true;
      top.raycast = () => {};
      rec.group.add(top); rec.meshes.push(top);

      if (rec.form === 'ringed') {
        const ring = new THREE.Mesh(pinGeo.ring, mat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = floatGap - 0.05;
        ring.raycast = () => {};
        rec.group.add(ring); rec.meshes.push(ring);
      }
    }
    rec.baseScale = sev;
    rec.pulse = (rec.form === 'open' && issue.severity === 'high');
  }

  function makePinRecord(issue) {
    const group = new THREE.Group();
    const gy = groundYAt(issue.local);
    group.position.set(issue.local[0], gy, issue.local[2]);
    const hit = new THREE.Mesh(pinGeo.hit, hitMaterial());
    hit.position.y = 2.2;
    hit.userData = { type: 'issue', id: issue.id };
    group.add(hit);
    pinHitTargets.push(hit);
    const rec = {
      issue, group, hit, meshes: [], ownMaterials: [],
      form: statusForm(issue.status),
      curOpa: 0, tgtOpa: 1, curScale: 0.001, tgtScale: 1,
      baseScale: 1, pulse: false, visible: true,
    };
    buildPinVisual(rec);
    pinsGroup.add(group);
    pinRecords.set(issue.id, rec);
    return rec;
  }

  function groundYAt(local) {
    const s = sampleHeight(local[0], local[2]);
    return Number.isFinite(s) ? s : (Number.isFinite(local[1]) ? local[1] : yC);
  }

  let hitMat = null;
  function hitMaterial() {
    if (!hitMat) {
      hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, depthTest: false });
      materials.add(hitMat);
    }
    return hitMat;
  }

  function applyTimelineTo(rec) {
    const issue = rec.issue;
    // reported ≤ to ; issues reported after `to` hidden
    let visible = true;
    if (timeTo != null && issue.reportedAtMs > timeTo) visible = false;
    // lower bound: issues fixed before `from` recede out of the window
    if (visible && timeFrom != null && issue.fixedAtMs != null && issue.fixedAtMs < timeFrom) visible = false;

    // form: render as fixed only if fixedAtMs ≤ to
    let form;
    const fixedByTo = issue.fixedAtMs != null && (timeTo == null || issue.fixedAtMs <= timeTo);
    if (fixedByTo) form = 'sunken';
    else {
      const f = statusForm(issue.status);
      form = (f === 'sunken') ? 'open' : f; // final status is fixed but not yet fixed at `to`
    }
    if (form !== rec.form) { rec.form = form; buildPinVisual(rec); }

    rec.visible = visible;
    rec.tgtOpa = visible ? (form === 'sunken' ? 0.4 : 1.0) : 0.0;
    rec.tgtScale = visible ? 1.0 : 0.001;
    if (visible) rec.group.visible = true;
  }

  // ════════════════════════════════════════════════════════════════════
  // per-frame update of pins (fade / scale / pulse)
  // ════════════════════════════════════════════════════════════════════
  function updatePins(dt, time) {
    let active = false;
    const k = 1 - Math.pow(0.001, dt / 0.2); // ~200ms settle
    pinRecords.forEach(rec => {
      const before = rec.curOpa, beforeS = rec.curScale;
      rec.curOpa = lerp(rec.curOpa, rec.tgtOpa, k);
      rec.curScale = lerp(rec.curScale, rec.tgtScale, k);
      if (Math.abs(rec.curOpa - rec.tgtOpa) < 0.005) rec.curOpa = rec.tgtOpa;
      if (Math.abs(rec.curScale - rec.tgtScale) < 0.005) rec.curScale = rec.tgtScale;

      let s = rec.baseScale * rec.curScale;
      if (rec.pulse && rec.curOpa > 0.5) { s *= 1 + 0.05 * Math.sin(time * 3.2); active = true; }
      rec.group.scale.setScalar(Math.max(s, 0.0001));

      const baseOpa = rec.form === 'sunken' ? 0.4 : 1.0;
      const isHi = (rec.issue.id === highlightId) || (rec.issue.id === hoverId);
      rec.ownMaterials.forEach(m => {
        m.opacity = rec.curOpa;
        m.emissiveIntensity = (rec.form === 'sunken' ? 0.03 : 0.18) + (isHi ? 0.5 : 0);
      });

      if (rec.curOpa !== before || rec.curScale !== beforeS) active = true;
      if (rec.curOpa <= 0.001 && rec.tgtOpa === 0) rec.group.visible = false;
    });
    return active;
  }

  // ════════════════════════════════════════════════════════════════════
  // building highlight / hover styling
  // ════════════════════════════════════════════════════════════════════
  function styleBuildings() {
    buildingMeshes.forEach(m => {
      const isHi = (m.userData.id === highlightId);
      const isHover = (m.userData.id === hoverId);
      const boost = isHi ? 0.45 : (isHover ? 0.28 : 0.0);
      m.material.emissive.setHex(PAL.highlight);
      m.material.emissiveIntensity = boost * (m.userData.labelled ? 1 : 0.7);
    });
  }

  // ════════════════════════════════════════════════════════════════════
  // pointer handling
  // ════════════════════════════════════════════════════════════════════
  function setNdc(ev) {
    const r = canvas.getBoundingClientRect();
    ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  }
  function onPointerMove(ev) {
    if (draggingGhost) {
      setNdc(ev);
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObject(terrainMesh.mesh, false); // constrain to terrain surface
      if (hits.length) positionGhost(hits[0].point.x, hits[0].point.z);
      requestRender();
      return;
    }
    pendingHover = ev; requestRender();
  }
  function onPointerDown(ev) {
    downPos = { x: ev.clientX, y: ev.clientY };
    if (ghost && ghost.group.visible) {
      setNdc(ev);
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.intersectObject(ghost.hit, false).length) {
        draggingGhost = true;
        controls.enabled = false;   // freeze orbit during drag
      }
    }
  }
  function onPointerUp(ev) {
    if (draggingGhost) {
      draggingGhost = false;
      controls.enabled = true;
      downPos = null;
      const p = ghost.group.position;
      if (cbs.ghostMoved) cbs.ghostMoved({ local: [p.x, p.y, p.z], wgs84: eastNorthToWgs84(p.x + originE, originN - p.z) });
      return;
    }
    if (!downPos) return;
    const moved = Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y);
    downPos = null;
    if (moved > 5) return; // was a drag/orbit, not a click

    setNdc(ev);
    raycaster.setFromCamera(ndc, camera);

    if (pickMode) {
      const hits = raycaster.intersectObjects(pickTargetsTerrain, false);
      if (hits.length && cbs.pick) {
        const p = hits[0].point;
        // refine y from the FULL grid (render mesh is decimated)
        const gy = sampleHeight(p.x, p.z);
        const y = Number.isFinite(gy) ? gy : p.y;
        const E = p.x + originE, N = originN - p.z;
        cbs.pick({ local: [p.x, y, p.z], wgs84: eastNorthToWgs84(E, N) });
      }
      return;
    }
    // select: pins first (generous), then buildings
    const pinHits = raycaster.intersectObjects(pinHitTargets, false);
    if (pinHits.length) { cbs.select && cbs.select({ type: 'issue', id: pinHits[0].object.userData.id }); return; }
    const bHits = raycaster.intersectObjects(buildingMeshes, false);
    if (bHits.length) { cbs.select && cbs.select({ type: 'building', id: bHits[0].object.userData.id }); }
  }

  function processHover() {
    if (!pendingHover) return false;
    const ev = pendingHover; pendingHover = null;
    setNdc(ev);
    raycaster.setFromCamera(ndc, camera);

    let payload = null;
    const pinHits = raycaster.intersectObjects(pinHitTargets, false);
    if (pinHits.length) {
      const rec = pinRecords.get(pinHits[0].object.userData.id);
      if (rec && rec.group.visible && rec.curOpa > 0.05) {
        const issue = rec.issue;
        payload = {
          type: 'issue', id: issue.id, name: issue.title,
          meta: {
            title: issue.title, category: issue.category, severity: issue.severity,
            status: issue.status, ageDays: ageDays(issue.reportedAtMs),
          },
          screenX: ev.clientX, screenY: ev.clientY,
        };
      }
    }
    if (!payload) {
      const bHits = raycaster.intersectObjects(buildingMeshes, false);
      if (bHits.length) {
        const m = bHits[0].object;
        payload = {
          type: 'building', id: m.userData.id, name: m.userData.name,
          meta: { label: m.userData.name, openCount: m.userData.openCount | 0 },
          screenX: ev.clientX, screenY: ev.clientY,
        };
      }
    }

    const newId = payload ? payload.id : null;
    const changed = newId !== hoverId;
    hoverId = newId;
    if (changed) { styleBuildings(); requestRender(); }
    if (cbs.hover) cbs.hover(payload);
    return changed;
  }

  // ════════════════════════════════════════════════════════════════════
  // render loop (on-demand)
  // ════════════════════════════════════════════════════════════════════
  let rafId = 0, running = true, needsRender = true, lastT = now(), contextLost = false;

  function requestRender() {
    needsRender = true;
    if (!rafId && running && !contextLost) rafId = requestAnimationFrame(frame);
  }

  function frame() {
    rafId = 0;
    if (!running || contextLost) return;
    const t = now();
    const dt = Math.min((t - lastT) / 1000, 0.1);
    lastT = t;

    processHover();

    // camera tween
    let animating = false;
    if (tween) {
      const p = clamp((t - tween.t0) / tween.dur, 0, 1);
      const e = easeInOutCubic(p);
      camera.position.lerpVectors(tween.fromPos, tween.toPos, e);
      controls.target.lerpVectors(tween.fromTgt, tween.toTgt, e);
      if (p >= 1) tween = null; else animating = true;
    }

    const controlsChanged = controls.update();
    if (controlsChanged) animating = animating || false; // damping handled below

    const pinsActive = updatePins(dt, t / 1000);
    const ghostActive = updateGhost(t / 1000);
    updateLabels();   // distance-based scale + fade (no continuous render needed)

    renderer.render(scene, camera);

    // keep looping only while something is in motion
    if (tween || pinsActive || ghostActive || controlsChanged || animating) {
      rafId = requestAnimationFrame(frame);
    } else if (needsRender) {
      needsRender = false;
      // one settled frame already drawn
    }
  }
  // kick continuous frames while OrbitControls damping settles
  controls.addEventListener('change', requestRender);
  controls.addEventListener('start', requestRender);

  canvas.addEventListener('pointermove', onPointerMove, { passive: true });
  canvas.addEventListener('pointerdown', onPointerDown, { passive: true });
  canvas.addEventListener('pointerup', onPointerUp, { passive: true });

  // ---- context loss ----------------------------------------------------
  function onContextLost(e) { e.preventDefault(); contextLost = true; if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
  function onContextRestored() { contextLost = false; lastT = now(); requestRender(); }
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  // ---- resize (debounced) ---------------------------------------------
  let resizeTimer = 0;
  function doResize() {
    const w = canvas.clientWidth || canvas.width || 1;
    const h = canvas.clientHeight || canvas.height || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
  }
  doResize();
  requestRender();

  // ════════════════════════════════════════════════════════════════════
  // public handle (contracts §5)
  // ════════════════════════════════════════════════════════════════════
  const handle = {
    setIssues(issues) {
      // full replace, idempotent
      pinRecords.forEach(disposePinRecord);
      pinRecords.clear();
      pinHitTargets.length = 0;
      // rebuild open-count per building
      const openByProp = new Map();
      (issues || []).forEach(iss => {
        const rec = makePinRecord(iss);
        applyTimelineTo(rec);
        // fade in
        rec.curOpa = 0; rec.curScale = 0.001;
        if (iss.openCountsForBuilding && typeof iss.openCountsForBuilding === 'object') {
          for (const [pid, n] of Object.entries(iss.openCountsForBuilding)) openByProp.set(pid, n);
        }
      });
      // apply open counts to buildings (by propertyId or building id)
      buildingMeshes.forEach(m => {
        const pid = m.userData.propertyId;
        if (pid != null && openByProp.has(pid)) m.userData.openCount = openByProp.get(pid);
      });
      requestRender();
    },

    setTimeRange(fromMs, toMs) {
      timeFrom = (fromMs == null ? null : fromMs);
      timeTo = (toMs == null ? null : toMs);
      pinRecords.forEach(applyTimelineTo);
      requestRender();
    },

    focus(entityId) {
      // building or issue → smooth camera tween
      let target = null, radius = 30;
      const b = buildingById.get(entityId);
      if (b) {
        b.geometry.computeBoundingBox();
        const bb = b.geometry.boundingBox;
        target = new THREE.Vector3().addVectors(bb.min, bb.max).multiplyScalar(0.5);
        b.localToWorld(target);
        radius = Math.max(bb.max.distanceTo(bb.min) * 0.6, 20);
      } else {
        const rec = pinRecords.get(entityId);
        if (rec) { target = rec.group.position.clone(); target.y += 3; radius = 22; }
      }
      if (!target) return;
      const dist = radius * 3.2;
      const dir = new THREE.Vector3(0.6, 0.6, 0.62).normalize(); // from SE-up
      const pos = target.clone().add(dir.multiplyScalar(dist));
      tweenTo(pos, target);
    },

    setHighlight(entityId) {
      highlightId = entityId || null;
      styleBuildings();
      requestRender();
    },

    setPickMode(on) { pickMode = !!on; canvas.style.cursor = pickMode ? 'crosshair' : ''; },

    setLabels(on) { labelsVisible = !!on; labelsGroup.visible = labelsVisible; requestRender(); },

    onHover(cb) { cbs.hover = typeof cb === 'function' ? cb : null; },
    onSelect(cb) { cbs.select = typeof cb === 'function' ? cb : null; },
    onPick(cb) { cbs.pick = typeof cb === 'function' ? cb : null; },

    resize() { clearTimeout(resizeTimer); resizeTimer = setTimeout(doResize, 80); },

    // ---- §5 rev 3: geo helpers + ghost pin (phone GPS "report here") ----
    terrainHeightAt(x, z) { const y = sampleHeight(x, z); return Number.isFinite(y) ? y : null; },

    snapToRoad(x, z, maxDist) {
      const md = (maxDist == null ? Infinity : maxDist);
      // already inside the road polygon → on-road, no move needed
      if (roadOutline && pointInPolygon(x, z, roadOutline)) {
        return { local: [x, groundYAt([x, 0, z]), z], snapped: false };
      }
      // else nearest point on the outline edges and on any road-mesh vertex
      let bx = 0, bz = 0, bestD = Infinity;
      if (roadOutline) {
        for (let i = 0; i < roadOutline.length; i++) {
          const a = roadOutline[i], b = roadOutline[(i + 1) % roadOutline.length];
          const q = nearestOnSeg(x, z, a[0], a[1], b[0], b[1]);
          if (q.d < bestD) { bestD = q.d; bx = q.x; bz = q.z; }
        }
      }
      if (roadVerts) {
        for (let i = 0; i < roadVerts.length; i += 3) {
          const d = Math.hypot(x - roadVerts[i], z - roadVerts[i + 2]);
          if (d < bestD) { bestD = d; bx = roadVerts[i]; bz = roadVerts[i + 2]; }
        }
      }
      if (bestD > md || !Number.isFinite(bestD)) return null;
      return { local: [bx, groundYAt([bx, 0, bz]), bz], snapped: true };
    },

    showGhostPin(local) {
      if (local == null) { if (ghost) ghost.group.visible = false; requestRender(); return; }
      const g = ensureGhost();
      positionGhost(local[0], local[2]);
      g.group.visible = true;
      requestRender();
    },
    onGhostMoved(cb) { cbs.ghostMoved = typeof cb === 'function' ? cb : null; },

    // exposed for testing / bridge convenience
    localToWgs84(x, z) { return eastNorthToWgs84(x + originE, originN - z); },
    wgs84ToLocal(lon, lat) { const [E, N] = wgs84ToEastNorth(lon, lat); return [E - originE, -(N - originN)]; },

    dispose() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      clearTimeout(resizeTimer);
      controls.removeEventListener('change', requestRender);
      controls.removeEventListener('start', requestRender);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      controls.dispose();
      pinRecords.forEach(disposePinRecord);
      pinRecords.clear();
      if (ghost) { scene.remove(ghost.group); ghost = null; }
      scene.remove(labelsGroup);
      labelSprites.forEach(L => { if (L.sprite.material.map) L.sprite.material.map.dispose(); });
      labelSprites.length = 0;
      _originE = null; _originN = null;   // clear module origin on teardown
      scene.traverse(o => { if (o.geometry) geometries.add(o.geometry); });
      geometries.forEach(g => g.dispose());
      materials.forEach(m => {
        for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
        m.dispose();
      });
      geometries.clear(); materials.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.style.background = '';
      canvas.style.cursor = '';
    },
  };

  return handle;
}

// ════════════════════════════════════════════════════════════════════════
// helpers (module scope, pure)
// ════════════════════════════════════════════════════════════════════════
function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
function ageDays(reportedAtMs) {
  if (reportedAtMs == null) return 0;
  return Math.max(0, Math.floor((Date.now() - reportedAtMs) / 86400000));
}

async function fetchTerrain(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`terrain fetch failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  return parseTerrain(buf);
}

// contracts §2.1 — RLHT binary
function parseTerrain(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'RLHT') throw new Error(`bad terrain magic: ${magic}`);
  const H = dv.getUint32(4, true);
  const headerBytes = new Uint8Array(buf, 8, H);
  const header = JSON.parse(new TextDecoder('utf-8').decode(headerBytes));
  const width = header.width, height = header.height;
  const count = width * height;
  const off = 8 + H;
  const raw = new Uint16Array(buf, off, count); // LE assumed (spec: u16 LE, little-endian hosts)
  const zMin = header.zMin, zMax = header.zMax, span = zMax - zMin;
  const nodata = header.nodata;
  const heights = new Float32Array(count);
  let hasNo = false;
  for (let i = 0; i < count; i++) {
    const v = raw[i];
    if (nodata != null && v === nodata) { heights[i] = NaN; hasNo = true; }
    else heights[i] = zMin + (v / 65535) * span;
  }
  return { header, heights, width, height, hasNodata: hasNo };
}

// ────────────────────────────────────────────────────────────────────────
// terrain mesh + skirt + bilinear sampler
// ────────────────────────────────────────────────────────────────────────
function buildTerrain(terrain, geometries, materials, roadMesh) {
  const { header, heights, width, height } = terrain;
  const originE = header.originE, originN = header.originN, cell = header.cell;
  const x0 = header.minE - originE;
  const z0 = -(header.maxN - originN);

  // fill any nodata with nearest-ish (mean) so the surface stays continuous
  let sum = 0, n = 0;
  for (let i = 0; i < heights.length; i++) if (Number.isFinite(heights[i])) { sum += heights[i]; n++; }
  const mean = n ? sum / n : header.zMin;

  const sceneX = c => x0 + c * cell;
  const sceneZ = r => z0 + r * cell;
  const at = (r, c) => { const v = heights[r * width + c]; return Number.isFinite(v) ? v : mean; };

  // ---- adaptive (variance-decimated) surface geometry -----------------
  // Full 2 m grid stays authoritative for sampleHeight/pick/ghost; only the
  // RENDER mesh is decimated. Flat tiles → 2 triangles; detailed tiles keep
  // full res (via one level of 8×8 quadrant subdivision). Normals come from
  // the full grid so shading is identical across LOD levels. LOD skirts fill
  // T-junction cracks at mixed-res borders.
  const ERROR_T = 1.5;           // metres — open-fell flatness tolerance (tuned)
  const TILE = 16;               // cells per tile
  const HALF = TILE / 2;         // 8×8 quadrant
  const SKIRT_DEPTH = 0.30;      // LOD crack skirt

  // Recess-aware protection: a global flatness threshold cannot both decimate
  // the bumpy fell AND preserve the 0.2 m road recesses (their signal is below
  // any threshold big enough to flatten the fell). So mark grid cells the road
  // passes through (±1 halo) and force those tiles full-res — recesses stay
  // crisp while the open fell decimates hard. Buildings sink 2 m into terrain
  // (foundation rule) so their contact is buried and needs no protection.
  const prot = new Uint8Array(width * height);
  if (roadMesh && roadMesh.positions) {
    const P = roadMesh.positions;
    for (let i = 0; i < P.length; i += 3) {
      const c = Math.round((P[i] - x0) / cell), r = Math.round((P[i + 2] - z0) / cell);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < height && cc >= 0 && cc < width) prot[rr * width + cc] = 1;
      }
    }
  }
  function hasProt(r0, c0, r1, c1) {
    for (let r = r0; r <= r1; r++) { const base = r * width; for (let c = c0; c <= c1; c++) if (prot[base + c]) return true; }
    return false;
  }
  const cCream = new THREE.Color(PAL.terrainCream);
  const cSage = new THREE.Color(PAL.terrainSage);
  const span = Math.max(1e-6, header.zMax - header.zMin);

  const positions = [], normals = [], colors = [], indices = [];
  const vmap = new Map();        // grid node r*width+c → vertex index (dedup)
  const skirtPos = [], skirtNrm = [], skirtCol = [];

  const nodeColor = (y) => cCream.clone().lerp(cSage, clamp((y - header.zMin) / span, 0, 1) * 0.55);
  function gridNormal(r, c) {    // analytic normal from full grid (smooth, LOD-invariant)
    const cL = Math.max(0, c - 1), cR = Math.min(width - 1, c + 1);
    const rU = Math.max(0, r - 1), rD = Math.min(height - 1, r + 1);
    const hx = (at(r, cR) - at(r, cL)) / (cR - cL || 1);
    const hz = (at(rD, c) - at(rU, c)) / (rD - rU || 1);
    const nx = -hx, ny = cell, nz = -hz;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  }
  function addV(r, c) {
    const key = r * width + c;
    let vi = vmap.get(key);
    if (vi !== undefined) return vi;
    vi = positions.length / 3;
    const y = at(r, c);
    positions.push(sceneX(c), y, sceneZ(r));
    const nrm = gridNormal(r, c); normals.push(nrm[0], nrm[1], nrm[2]);
    const cc = nodeColor(y); colors.push(cc.r, cc.g, cc.b);
    vmap.set(key, vi);
    return vi;
  }
  function quad(r0, c0, r1, c1) {
    const a = addV(r0, c0), b = addV(r0, c1), d = addV(r1, c0), e = addV(r1, c1);
    indices.push(a, d, b, b, d, e);
  }
  function fullRes(r0, c0, r1, c1) {
    for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
      const a = addV(r, c), b = addV(r, c + 1), d = addV(r + 1, c), e = addV(r + 1, c + 1);
      indices.push(a, d, b, b, d, e);
    }
  }
  function regionError(r0, c0, r1, c1) {
    const dr = r1 - r0, dc = c1 - c0;
    if (dr <= 1 && dc <= 1) return 0;
    const h00 = at(r0, c0), h01 = at(r0, c1), h10 = at(r1, c0), h11 = at(r1, c1);
    let maxE = 0;
    for (let r = r0; r <= r1; r++) {
      const tz = (r - r0) / dr;
      for (let c = c0; c <= c1; c++) {
        const tx = (c - c0) / dc;
        const bil = (h00 * (1 - tx) + h01 * tx) * (1 - tz) + (h10 * (1 - tx) + h11 * tx) * tz;
        const e = Math.abs(at(r, c) - bil);
        if (e > maxE) maxE = e;
      }
    }
    return maxE;
  }
  function skirtEdge(ra, ca, rb, cb, ox, oz) {
    const ax = sceneX(ca), az = sceneZ(ra), ay = at(ra, ca);
    const bx = sceneX(cb), bz = sceneZ(rb), by = at(rb, cb);
    const cA = nodeColor(ay), cB = nodeColor(by);
    const P = (x, y, z, cc) => { skirtPos.push(x, y, z); skirtNrm.push(ox, 0, oz); skirtCol.push(cc.r, cc.g, cc.b); };
    P(ax, ay, az, cA); P(bx, by, bz, cB); P(ax, ay - SKIRT_DEPTH, az, cA);
    P(bx, by, bz, cB); P(bx, by - SKIRT_DEPTH, bz, cB); P(ax, ay - SKIRT_DEPTH, az, cA);
  }
  function decimate(r0, c0, r1, c1) {
    quad(r0, c0, r1, c1);
    skirtEdge(r0, c0, r0, c1, 0, -1);   // north
    skirtEdge(r1, c1, r1, c0, 0, 1);    // south
    skirtEdge(r1, c0, r0, c0, -1, 0);   // west
    skirtEdge(r0, c1, r1, c1, 1, 0);    // east
  }

  let nDec = 0, nFull = 0;
  for (let r0 = 0; r0 < height - 1; r0 += TILE) {
    const r1 = Math.min(r0 + TILE, height - 1);
    for (let c0 = 0; c0 < width - 1; c0 += TILE) {
      const c1 = Math.min(c0 + TILE, width - 1);
      if (!hasProt(r0, c0, r1, c1) && regionError(r0, c0, r1, c1) < ERROR_T) { decimate(r0, c0, r1, c1); nDec++; }
      else {
        const rM = Math.min(r0 + HALF, r1), cM = Math.min(c0 + HALF, c1);
        for (const q of [[r0, c0, rM, cM], [r0, cM, rM, c1], [rM, c0, r1, cM], [rM, cM, r1, c1]]) {
          const [qr0, qc0, qr1, qc1] = q;
          if (qr1 <= qr0 || qc1 <= qc0) continue;   // edge remainder
          if (!hasProt(qr0, qc0, qr1, qc1) && regionError(qr0, qc0, qr1, qc1) < ERROR_T) { decimate(qr0, qc0, qr1, qc1); nDec++; }
          else { fullRes(qr0, qc0, qr1, qc1); nFull++; }
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const vCount = positions.length / 3;
  geo.setIndex(vCount > 65535 ? new THREE.Uint32BufferAttribute(indices, 1) : new THREE.Uint16BufferAttribute(indices, 1));
  geometries.add(geo);

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.98, metalness: 0.0, flatShading: false,
  });
  materials.add(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  // LOD crack skirts (terrain-coloured curtains at decimated tile edges)
  let lodSkirt = null;
  if (skirtPos.length) {
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(skirtPos, 3));
    sg.setAttribute('normal', new THREE.Float32BufferAttribute(skirtNrm, 3));
    sg.setAttribute('color', new THREE.Float32BufferAttribute(skirtCol, 3));
    geometries.add(sg);
    const sm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.98, metalness: 0, side: THREE.DoubleSide });
    materials.add(sm);
    lodSkirt = new THREE.Mesh(sg, sm);
    lodSkirt.receiveShadow = true; lodSkirt.castShadow = false;
  }

  const fullTris = (width - 1) * (height - 1) * 2;
  const renderTris = indices.length / 3;
  const skirtTris = skirtPos.length / 9;
  if (typeof console !== 'undefined') {
    console.info(`[scene] terrain LOD: full=${fullTris} render=${renderTris} +skirt=${skirtTris} ` +
      `(${(100 * (1 - renderTris / fullTris)).toFixed(1)}% reduction) ERROR_T=${ERROR_T} decTiles=${nDec} fullTiles=${nFull}`);
  }

  // ---- skirt (plinth) : vertical walls around the boundary + bottom cap
  const baseY = header.zMin - Math.max(8, (header.zMax - header.zMin) * 0.4);
  const skirt = buildSkirt({ width, height, at, sceneX, sceneZ, baseY }, geometries, materials);

  // ---- bilinear sampler in scene coords ----
  function sampleHeight(x, z) {
    const fc = (x - x0) / cell;
    const fr = (z - z0) / cell;
    if (fc < 0 || fr < 0 || fc > width - 1 || fr > height - 1) return NaN;
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const c1 = Math.min(c0 + 1, width - 1), r1 = Math.min(r0 + 1, height - 1);
    const tx = fc - c0, tz = fr - r0;
    const h00 = at(r0, c0), h10 = at(r0, c1), h01 = at(r1, c0), h11 = at(r1, c1);
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  return { mesh, skirt, lodSkirt, sampleHeight };
}

function buildSkirt({ width, height, at, sceneX, sceneZ, baseY }, geometries, materials) {
  const positions = [];
  const colors = [];
  const cTop = new THREE.Color(PAL.skirt);
  const cBot = new THREE.Color(PAL.skirtBottom);
  function quad(x1, z1, y1, x2, z2, y2) {
    // wall quad from top edge (x,z,topY) down to baseY, two tris, CCW outward
    positions.push(x1, y1, z1, x2, y2, z2, x1, baseY, z1);
    positions.push(x2, y2, z2, x2, baseY, z2, x1, baseY, z1);
    for (let i = 0; i < 3; i++) { colors.push(cTop.r, cTop.g, cTop.b); }
    for (let i = 0; i < 3; i++) { colors.push(cBot.r, cBot.g, cBot.b); }
  }
  // north edge (r=0), south edge (r=height-1), west (c=0), east (c=width-1)
  for (let c = 0; c < width - 1; c++) {
    quad(sceneX(c), sceneZ(0), at(0, c), sceneX(c + 1), sceneZ(0), at(0, c + 1));           // north
    quad(sceneX(c + 1), sceneZ(height - 1), at(height - 1, c + 1), sceneX(c), sceneZ(height - 1), at(height - 1, c)); // south
  }
  for (let r = 0; r < height - 1; r++) {
    quad(sceneX(0), sceneZ(r + 1), at(r + 1, 0), sceneX(0), sceneZ(r), at(r, 0));           // west
    quad(sceneX(width - 1), sceneZ(r), at(r, width - 1), sceneX(width - 1), sceneZ(r + 1), at(r + 1, width - 1)); // east
  }
  // bottom cap (two tris of the base rectangle)
  const wx0 = sceneX(0), wx1 = sceneX(width - 1), nz = sceneZ(0), sz = sceneZ(height - 1);
  positions.push(wx0, baseY, nz, wx0, baseY, sz, wx1, baseY, nz);
  positions.push(wx1, baseY, nz, wx0, baseY, sz, wx1, baseY, sz);
  for (let i = 0; i < 6; i++) { colors.push(cBot.r, cBot.g, cBot.b); }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  geometries.add(g);
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1.0, metalness: 0, side: THREE.DoubleSide });
  materials.add(m);
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  return mesh;
}

// ────────────────────────────────────────────────────────────────────────
// buildings
// ────────────────────────────────────────────────────────────────────────
function buildBuildings(data, ctx) {
  if (!data) return;
  const { scene, sampleHeight, buildingMeshes, buildingById, geometries, materials, labelAnchors } = ctx;
  const make = (b, labelled) => {
    const fp = b.footprint;
    if (!fp || fp.length < 3) return;
    // sample ground at every footprint vertex + centroid (owner rule):
    //   base y = min(samples) − 2.0m  (foundation sink → glued into the hill)
    //   top  y = mean(samples) + height (eaves still read correctly vs ground)
    let cx = 0, cz = 0;
    const samples = [];
    for (const [px, pz] of fp) {
      const g = sampleHeight(px, pz);
      if (Number.isFinite(g)) samples.push(g);
      cx += px; cz += pz;
    }
    cx /= fp.length; cz /= fp.length;
    const cg = sampleHeight(cx, cz);
    if (Number.isFinite(cg)) samples.push(cg);
    if (!samples.length) samples.push(0);
    const minS = Math.min(...samples);
    const meanS = samples.reduce((a, v) => a + v, 0) / samples.length;
    const base = minS - 2.0;                     // foundation sink
    const top = meanS + (b.height || 5);         // eaves above mean ground
    const depth = Math.max(top - base, 1.0);

    const shape = new THREE.Shape();
    shape.moveTo(fp[0][0], -fp[0][1]);          // shape.y = −z so extrude preserves z
    for (let i = 1; i < fp.length; i++) shape.lineTo(fp[i][0], -fp[i][1]);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, steps: 1 });
    geo.rotateX(-Math.PI / 2);                  // shape plane → ground, extrude → +y
    geo.translate(0, base, 0);
    geometries.add(geo);

    const baseCol = new THREE.Color(labelled ? PAL.buildingWall : PAL.buildingCtx);
    // faint per-building tint variation via id hash
    const h = hashStr(b.id || '');
    baseCol.offsetHSL(((h % 20) - 10) / 900, labelled ? 0 : -0.03, ((h >> 3) % 10 - 5) / 800);
    const mat = new THREE.MeshStandardMaterial({
      color: baseCol, roughness: labelled ? 0.82 : 0.9, metalness: 0.0,
      flatShading: true, emissive: PAL.highlight, emissiveIntensity: 0.0,
    });
    materials.add(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = {
      type: 'building', id: b.id, name: b.label || null,
      propertyId: b.propertyId || null, labelled: !!labelled, openCount: 0,
    };
    scene.add(mesh);
    buildingMeshes.push(mesh);
    buildingById.set(b.id, mesh);
    if (labelled && b.label && labelAnchors) {
      labelAnchors.push({ id: b.id, name: b.label, cx, cz, roofY: top });
    }
  };
  (data.buildings || []).forEach(b => make(b, !!b.label));
  (data.context || []).forEach(b => make(b, false));
}

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return Math.abs(h); }

// paper-card label texture (architect's-model identity): #faf8f3 card, hairline
// #c9c2b2 border, ink #1a2b1e text. Crisp at devicePixelRatio, sized to text.
function makeLabelTexture(text) {
  const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
  const fontPx = 26, padX = 15, padY = 9, font = `600 ${fontPx}px system-ui, -apple-system, sans-serif`;
  const meas = document.createElement('canvas').getContext('2d');
  meas.font = font;
  const tw = Math.ceil(meas.measureText(text).width);
  const w = tw + padX * 2, h = fontPx + padY * 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * dpr); canvas.height = Math.ceil(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  roundRectPath(ctx, 0.75, 0.75, w - 1.5, h - 1.5, 7);
  ctx.fillStyle = '#faf8f3'; ctx.fill();
  ctx.strokeStyle = '#c9c2b2'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = '#1a2b1e'; ctx.font = font;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// point-in-polygon (ray casting) — poly = [[x,z],...]
function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1];
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

// nearest point on segment (ax,az)->(bx,bz) to (px,pz); returns {x,z,d}
function nearestOnSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, z = az + t * dz;
  return { x, z, d: Math.hypot(px - x, pz - z) };
}

// ────────────────────────────────────────────────────────────────────────
// road ribbon — contracts §2.3 v1 (single) + v2 (grouped, per-kind tint).
// Terrain arrives pre-carved (roads recessed ~0.2 m); no carving here. The
// ribbon sits ~0.02 m above the recess floor. One geometry, material array
// via addGroup so it stays a single draw-friendly mesh.
// ────────────────────────────────────────────────────────────────────────
const ROAD_KINDS = ['randlehow', 'public', 'track', 'path'];
const ROAD_TINT = {
  randlehow: 0xc4bca8, // hero — lighter/warmer than base grey
  public:    0xa9a89e, // a touch darker/cooler
  track:     0xa8977f, // muted earthy
  path:      0xbdb6a8, // faintest, near-terrain
};
function buildRoad(roadMesh, geometries, materials) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(roadMesh.positions, 3));
  const hasIdx = roadMesh.indices && roadMesh.indices.length;
  if (hasIdx) {
    const big = roadMesh.positions.length / 3 > 65535;
    geo.setIndex(big ? new THREE.Uint32BufferAttribute(roadMesh.indices, 1) : new THREE.Uint16BufferAttribute(roadMesh.indices, 1));
  }
  geo.computeVertexNormals();
  geometries.add(geo);

  // one material per kind (fixed order = material index)
  const matArray = ROAD_KINDS.map(kind => {
    const m = new THREE.MeshStandardMaterial({
      color: ROAD_TINT[kind], roughness: 0.95, metalness: 0.0,
      // gentle offset avoids z-fighting with the recess floor; kept small so
      // the ribbon does not poke through the recess lip walls.
      polygonOffset: true, polygonOffsetFactor: -0.5, polygonOffsetUnits: -0.5,
    });
    materials.add(m);
    return m;
  });

  const total = hasIdx ? roadMesh.indices.length : roadMesh.positions.length / 3;
  const groups = (roadMesh.version >= 2 && Array.isArray(roadMesh.groups) && roadMesh.groups.length)
    ? roadMesh.groups
    : [{ start: 0, count: total, kind: 'randlehow' }]; // v1 → all randlehow
  for (const g of groups) {
    const idx = Math.max(0, ROAD_KINDS.indexOf(g.kind));
    geo.addGroup(g.start, g.count, idx);
  }

  const mesh = new THREE.Mesh(geo, matArray);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.userData = { type: 'road' };
  return mesh;
}
