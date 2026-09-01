#!/usr/bin/env python3
"""Generate dev fixtures for scene.js — a plausible Cumbrian valley.

Emits (all in fixtures/):
  fixture-terrain.bin    RLHT binary (contracts §2.1)
  fixture-buildings.json (contracts §2.2)
  fixture-road.json      (contracts §2.3)
  fixture-issues.json    array of SceneIssue (contracts §5)

Run:  python3 make-fixtures.py
Pure stdlib + math (no numpy needed).
"""
import json, math, struct, os

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- origin (Eskdale Green-ish BNG) + grid --------------------------------
originE, originN = 314200, 500600
cell = 2.0
width, height = 400, 250          # 798 × 498 m ⇒ 100k cells
minE = originE - (width - 1) * cell / 2
maxN = originN + (height - 1) * cell / 2

# scene-coord helpers (contracts §1)
x0 = minE - originE               # west edge in scene x
z0 = -(maxN - originN)            # north edge in scene z
spanX = (width - 1) * cell
spanZ = (height - 1) * cell

def scene_x(c): return x0 + c * cell
def scene_z(r): return z0 + r * cell

# valley centreline (scene z as a function of scene x), gently meandering
def centreline_z(x):
    t = (x - x0) / spanX
    return z0 + spanZ * (0.5 + 0.18 * math.sin(t * 2 * math.pi))

def elevation(x, z):
    t = (x - x0) / spanX
    along = 100.0 - t * 12.0                      # 100 → 88 m west→east
    zc = centreline_z(x)
    d = (z - zc) / (spanZ * 0.5)
    cross = (d * d) * 42.0                         # parabolic valley sides
    ripple = 1.2 * math.sin(x / 37.0) + 0.8 * math.cos(z / 29.0)
    return along + cross + ripple

# ---- build height grid ----------------------------------------------------
heights = [[0.0] * width for _ in range(height)]
zmin, zmax = float('inf'), float('-inf')
for r in range(height):
    for c in range(width):
        e = elevation(scene_x(c), scene_z(r))
        heights[r][c] = e
        zmin = min(zmin, e); zmax = max(zmax, e)

zMin = math.floor(zmin * 10) / 10
zMax = math.ceil(zmax * 10) / 10
span = zMax - zMin

header = {
    "version": 1, "originE": originE, "originN": originN, "cell": cell,
    "width": width, "height": height,
    "minE": minE, "maxN": maxN,
    "zMin": zMin, "zMax": zMax, "nodata": None,
}
hjson = json.dumps(header, separators=(",", ":")).encode("utf-8")

with open(os.path.join(HERE, "fixture-terrain.bin"), "wb") as f:
    f.write(b"RLHT")
    f.write(struct.pack("<I", len(hjson)))
    f.write(hjson)
    for r in range(height):
        row = bytearray()
        for c in range(width):
            v = int(round((heights[r][c] - zMin) / span * 65535))
            v = max(0, min(65534, v))              # keep 65535 reserved for nodata
            row += struct.pack("<H", v)
        f.write(row)

# bilinear sampler matching what scene.js reconstructs (quantised)
def sample_h(x, z):
    fc = (x - x0) / cell
    fr = (z - z0) / cell
    fc = max(0, min(width - 1, fc)); fr = max(0, min(height - 1, fr))
    c0, r0 = int(math.floor(fc)), int(math.floor(fr))
    c1, r1 = min(c0 + 1, width - 1), min(r0 + 1, height - 1)
    tx, tz = fc - c0, fr - r0
    def q(r, c):  # dequantised value as scene.js sees it
        v = int(round((heights[r][c] - zMin) / span * 65535))
        return zMin + (v / 65535) * span
    h00, h10 = q(r0, c0), q(r0, c1)
    h01, h11 = q(r1, c0), q(r1, c1)
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz

# ---- road ribbon v2 (drape a 4 m strip; grouped by kind for tinting) ------
# Terrain is nominally pre-carved in production; the fixture just drapes +0.05.
positions, indices, outline_left, outline_right = [], [], [], []
seg_kind = []            # kind for each 6-index triangle block
samples = 90
half_w = 2.0
prev = None
def kind_at(f):
    if f < 0.15: return "path"
    if f < 0.35: return "track"
    if f < 0.80: return "randlehow"   # hero central stretch
    return "public"
for i in range(samples + 1):
    x = x0 + spanX * (0.08 + 0.84 * i / samples)
    zc = centreline_z(x)
    dx = 1.0
    dz = (centreline_z(x + 1) - centreline_z(x - 1)) / 2.0
    L = math.hypot(dx, dz)
    nx, nz = -dz / L, dx / L
    lx, lz = x + nx * half_w, zc + nz * half_w
    rx, rz = x - nx * half_w, zc - nz * half_w
    ly = sample_h(lx, lz) + 0.05
    ry = sample_h(rx, rz) + 0.05
    base = len(positions) // 3
    positions += [lx, ly, lz, rx, ry, rz]
    outline_left.append([round(lx, 2), round(lz, 2)])
    outline_right.append([round(rx, 2), round(rz, 2)])
    if prev is not None:
        a, b = prev
        c, d = base, base + 1
        indices += [a, b, c, b, d, c]
        seg_kind.append(kind_at(i / samples))
    prev = (base, base + 1)

# coalesce contiguous same-kind segments into {start,count,kind} index groups
groups = []
for s, k in enumerate(seg_kind):
    start = s * 6
    if groups and groups[-1]["kind"] == k:
        groups[-1]["count"] += 6
    else:
        groups.append({"start": start, "count": 6, "kind": k})

outline = outline_left + list(reversed(outline_right))
road = {
    "version": 2,
    "positions": [round(v, 3) for v in positions],
    "indices": indices,
    "groups": groups,
    "outline": outline,
}
with open(os.path.join(HERE, "fixture-road.json"), "w") as f:
    json.dump(road, f)

# ---- buildings (~6, beside the road) --------------------------------------
def rect_footprint(cx, cz, w, d, rot=0.0):
    # CCW, scene-local metres, not closed
    hw, hd = w / 2, d / 2
    pts = [(-hw, -hd), (hw, -hd), (hw, hd), (-hw, hd)]
    out = []
    for (px, pz) in pts:
        rx = px * math.cos(rot) - pz * math.sin(rot)
        rz = px * math.sin(rot) + pz * math.cos(rot)
        out.append([round(cx + rx, 2), round(cz + rz, 2)])
    return out

def place(t_along, side, w, d, rot):
    x = x0 + spanX * t_along
    zc = centreline_z(x)
    return x, zc + side * (half_w + 12)  # set back from the road

blds = []
labelled = [
    ("osm-w101", "p01", "Fairfield Cottage", 6.2),
    ("osm-w102", "p04", "Holly Garth", 5.4),
    ("osm-w103", "p07", "Beckside", 7.1),
    ("osm-w104", "p11", "Randle How", 5.0),
]
for i, (bid, pid, name, h) in enumerate(labelled):
    side = -1 if i % 2 == 0 else 1
    cx, cz = place(0.15 + i * 0.2, side, 14, 10, 0.15 * (i - 1.5))
    blds.append({
        "id": bid, "propertyId": pid, "label": name,
        "height": h, "heightSource": "dsm",
        "footprint": rect_footprint(cx, cz, 14, 10, 0.15 * (i - 1.5)),
    })

context = []
for j, (bid, cx_t, side, w, d) in enumerate([
    ("osm-w201", 0.35, 1, 9, 7),
    ("osm-w202", 0.62, -1, 11, 8),
]):
    cx, cz = place(cx_t, side, w, d, 0.1)
    context.append({
        "id": bid, "propertyId": None, "label": None,
        "height": 4.2 + j, "heightSource": "default",
        "footprint": rect_footprint(cx, cz, w, d, 0.1),
    })

buildings = {"version": 1, "originE": originE, "originN": originN,
             "buildings": blds, "context": context}
with open(os.path.join(HERE, "fixture-buildings.json"), "w") as f:
    json.dump(buildings, f)

# ---- issues (SceneIssue) --------------------------------------------------
def ms(iso):
    # naive ISO date → epoch ms (UTC midnight)
    y, m, d = (int(x) for x in iso.split("-"))
    import datetime
    return int(datetime.datetime(y, m, d, tzinfo=datetime.timezone.utc).timestamp() * 1000)

def on_road(t_along, off=0.0):
    x = x0 + spanX * t_along
    zc = centreline_z(x) + off
    return [round(x, 2), round(sample_h(x, zc) + 0.05, 2), round(zc, 2)]

issues = [
    dict(id="iss-1", category="surface", severity="high", status="reported",
         title="Deep pothole cluster by the ford", local=on_road(0.20),
         reportedAtMs=ms("2026-09-01"), fixedAtMs=None),
    dict(id="iss-2", category="surface", severity="medium", status="in-progress",
         title="Edge break-up near Holly Garth", local=on_road(0.34, 1.0),
         reportedAtMs=ms("2026-06-12"), fixedAtMs=None),
    dict(id="iss-3", category="drainage-vegetation", severity="high", status="monitoring",
         title="Blocked culvert flooding the carriageway", local=on_road(0.47, -1.2),
         reportedAtMs=ms("2025-11-03"), fixedAtMs=None),
    dict(id="iss-4", category="drainage-vegetation", severity="low", status="fixed",
         title="Overgrown hedge cleared", local=on_road(0.58, 1.4),
         reportedAtMs=ms("2025-03-20"), fixedAtMs=ms("2025-05-10")),
    dict(id="iss-5", category="winter-access", severity="medium", status="planned",
         title="Grit bin needed at the rise", local=on_road(0.70, -1.0),
         reportedAtMs=ms("2025-01-15"), fixedAtMs=None),
    dict(id="iss-6", category="surface", severity="low", status="closed",
         title="Minor rutting smoothed over", local=on_road(0.80),
         reportedAtMs=ms("2024-08-01"), fixedAtMs=ms("2024-09-14")),
    dict(id="iss-7", category="winter-access", severity="high", status="acknowledged",
         title="Ice sheet at shaded bend", local=on_road(0.88, 0.8),
         reportedAtMs=ms("2026-02-02"), fixedAtMs=None),
]
issues[0]["openCountsForBuilding"] = {"p01": 2, "p04": 1, "p07": 0, "p11": 1}

with open(os.path.join(HERE, "fixture-issues.json"), "w") as f:
    json.dump(issues, f)

print("fixtures written:")
print(f"  terrain: {width}x{height} cells, z {zMin}..{zMax} m")
print(f"  buildings: {len(blds)} labelled + {len(context)} context")
print(f"  road: {len(positions)//3} verts, {len(indices)//3} tris, {len(groups)} groups ({','.join(sorted(set(g['kind'] for g in groups)))})")
print(f"  issues: {len(issues)}")
