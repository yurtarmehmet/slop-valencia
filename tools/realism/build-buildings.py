"""Real buildings for the detailed city: Catastro footprints + PNOA-LiDAR heights -> js/vlc-buildings.bin.gz.

Sources (see docs/realism-plan.md):
  Catastro INSPIRE Buildings 46900 (D.G. del Catastro): BuildingPart footprints & floors, Building year & use
  PNOA-LiDAR 3rd coverage 2023 (CC BY 4.0, scne.es): class 6 (building) height above ground, 1 m cells

Each Catastro *building* (cadastral reference) becomes a group in its own frame, turned to the long axis of its
minimum-area bounding box; each of its *parts* is covered by up to 6 axis-aligned boxes in that frame, as tall as the
LiDAR says (90th percentile of the part's interior 1 m cells), or 2.85 m x floors + 5.9 m where LiDAR has no building
there. Every box wall is classed offline (WALL_KINDS: shop 0, entry 1, rear 2, lot line 3) by sampling outward: into
another part -> lot line; out to the roadway -> street front; otherwise a patio / court -> rear.

Heights are built from the even-numbered LiDAR points; the odd-numbered points are a held-out check (written to the
stats file). usage:
  python -I build-buildings.py engine.json parts.parquet buildings.parquet lidar_dir out.bin.gz stats.json
(engine.json: tools/realism/dump-engine.mjs output, for the world frame, curb blocks & land)
"""
import gzip
import json
import math
import os
import struct
import sys
import zlib

import geopandas as gpd
import numpy as np
import pdal
import rasterio.features
import shapely
from affine import Affine
from pyproj import Transformer
from shapely.geometry import Point, Polygon, box as sbox
from shapely.strtree import STRtree

engine_path, parts_path, bldg_path, lidar_dir, out_path, stats_path = sys.argv[1:]
E = json.load(open(engine_path))
fr = E['frame']
TH = math.radians(fr['bearingDeg'])
C, S = math.cos(TH), math.sin(TH)
to_ll = Transformer.from_crs(25830, 4326, always_xy=True)
to_utm = Transformer.from_crs(4326, 25830, always_xy=True)


def utm_to_world(xy):
    lon, lat = to_ll.transform(xy[:, 0], xy[:, 1])
    e = (lon - fr['lon0']) * fr['kx']
    n = (lat - fr['lat0']) * fr['ky']
    return np.column_stack([e * C - n * S, -(e * S + n * C)])


def world_to_utm(pts):
    x, z = pts[:, 0], pts[:, 1]
    e = x * C - z * S
    n = -x * S - z * C
    return np.column_stack(to_utm.transform(fr['lon0'] + e / fr['kx'], fr['lat0'] + n / fr['ky']))


D = fr['detail']
detail_world = sbox(D['x0'], D['z0'], D['x1'], D['z1'])
curbs = [Polygon(b['poly']).buffer(0) for b in E['blocks']]
curb_tree = STRtree(curbs)
barri_of_block = [b['district'] for b in E['blocks']]

# ---------------------------------------------------------------------------------------------------------------------
# 1. Catastro parts inside the detailed city, in world metres
# ---------------------------------------------------------------------------------------------------------------------
parts = gpd.read_parquet(parts_path)
parts = parts[parts.numberOfFloorsAboveGround.fillna(0) > 0].reset_index(drop=True)
bld = gpd.read_parquet(bldg_path)[['localId', 'beginning', 'currentUse']]
bld['year'] = bld.beginning.astype(str).str[:4].apply(lambda s: int(s) if s.isdigit() else 0)
meta = bld.set_index('localId')[['year', 'currentUse']].to_dict('index')
parts['ref'] = parts.localId.str.split('_part').str[0]

world_geoms = []
for g in parts.geometry:
    g = g if g.geom_type == 'Polygon' else max(g.geoms, key=lambda q: q.area)
    ext = utm_to_world(np.asarray(g.exterior.coords))
    holes = [utm_to_world(np.asarray(r.coords)) for r in g.interiors]
    world_geoms.append(Polygon(ext, holes).buffer(0))
parts['wgeom'] = world_geoms
parts = parts[[detail_world.contains(g.representative_point()) for g in parts.wgeom]].reset_index(drop=True)
parts['wgeom'] = [g.simplify(0.3) for g in parts.wgeom]
parts = parts[[g.area >= 6 and g.is_valid for g in parts.wgeom]].reset_index(drop=True)
print(f'{len(parts):,} Catastro parts in the detailed city, {parts.ref.nunique():,} buildings')

# ---------------------------------------------------------------------------------------------------------------------
# 2. LiDAR height per part (interior p90), from even points; odd points held out
# ---------------------------------------------------------------------------------------------------------------------
h_even = np.full(len(parts), np.nan)
h_odd = np.full(len(parts), np.nan)
h_small = np.full(len(parts), np.nan)  # small parts: median of all their cells (edges too)
roof_cells = {}  # part -> (x, y, z) of its interior 1 m cells (UTM, height above ground), for the roof fit
parts_utm = gpd.GeoSeries(parts.geometry.values, crs=25830)
pidx_by_tile = {}
for i, g in enumerate(parts_utm):
    c = g.representative_point()
    pidx_by_tile.setdefault((int(c.x // 1000), int(c.y // 1000) + 1), []).append(i)
tiles_used = 0
for (ek, nk), idxs in sorted(pidx_by_tile.items()):
    path = os.path.join(lidar_dir, f'PNOA_2023_VAL_{ek}-{nk}_H30_NPC02.laz')
    if not os.path.exists(path):
        continue
    tiles_used += 1
    x0, y1 = ek * 1000 - 100, nk * 1000 + 100  # 100 m margin for parts straddling the tile edge
    W = 1200
    pipe = pdal.Pipeline(json.dumps({'pipeline': [path, {'type': 'filters.hag_nn'}]}))
    pipe.execute()
    a = pipe.arrays[0]
    sel = a['Classification'] == 6
    X, Y, H = a['X'][sel], a['Y'][sel], a['HeightAboveGround'][sel]
    halves = []
    for half in (0, 1):
        m = (np.arange(X.size) % 2) == half
        ix = np.clip((X[m] - x0).astype(int), 0, W - 1)
        iy = np.clip((y1 - Y[m]).astype(int), 0, W - 1)
        flat = iy * W + ix
        o = np.argsort(flat)
        u, st = np.unique(flat[o], return_index=True)
        grid = np.full(W * W, np.nan, np.float32)
        grid[u] = np.maximum.reduceat(H[m][o], st)
        halves.append(grid.reshape(W, W))
    tr = Affine(1, 0, x0, 0, -1, y1)
    pid = rasterio.features.rasterize([(parts_utm[i], k + 1) for k, i in enumerate(idxs)], out_shape=(W, W), transform=tr, fill=0, dtype='int32')
    inner = pid.copy()
    for ax, sh in ((0, 1), (0, -1), (1, 1), (1, -1)):
        inner[np.roll(pid, sh, ax) != pid] = 0
    flat_id = inner.ravel()
    order = np.argsort(flat_id)
    ids_sorted = flat_id[order]
    bounds = np.searchsorted(ids_sorted, np.arange(1, len(idxs) + 2))
    # parts too small for interior cells: median over all their cells (even half)
    flat_all = pid.ravel()
    order_all = np.argsort(flat_all)
    bounds_all = np.searchsorted(flat_all[order_all], np.arange(1, len(idxs) + 2))
    vals_all = halves[0].ravel()[order_all]
    for k, i in enumerate(idxs):
        v = vals_all[bounds_all[k]:bounds_all[k + 1]]
        good = v[~np.isnan(v) & (v > 2.0)]
        if v.size >= 4 and good.size >= 0.6 * v.size:
            h_small[i] = float(np.median(good))
    full = np.fmax(halves[0], halves[1]).ravel()
    for k, i in enumerate(idxs):
        cells = order[bounds[k]:bounds[k + 1]]
        if cells.size >= 6:
            z = full[cells]
            ok = ~np.isnan(z) & (z > 2.0)
            iy, ix = np.divmod(cells[ok], W)
            roof_cells[i] = (x0 + ix + 0.5, y1 - iy - 0.5, z[ok].astype(np.float32), iy, ix)
    for half, grid in enumerate(halves):
        vals = grid.ravel()[order]
        for k, i in enumerate(idxs):
            v = vals[bounds[k]:bounds[k + 1]]
            if v.size < 6:
                continue
            good = v[~np.isnan(v) & (v > 2.0)]
            if good.size >= 0.5 * v.size and good.size >= 4:
                (h_even if half == 0 else h_odd)[i] = float(np.percentile(good, 90))
    print(f'  tile {ek}-{nk}: {len(idxs)} parts')
floors = parts.numberOfFloorsAboveGround.values.astype(float)
height = h_even.copy()
source = np.where(np.isnan(h_even), '', 'lidar').astype(object)
m = np.isnan(height) & ~np.isnan(h_small)
height[m] = h_small[m]
source[m] = 'lidar-small'
# still unknown: the same building's largest measured part, shifted by the floor difference (3 m a floor)
area = np.array([g.area for g in parts.geometry])
for ref, idxs in parts.groupby('ref').indices.items():
    known = [i for i in idxs if source[i] in ('lidar', 'lidar-small')]
    if not known:
        continue
    r = max(known, key=lambda i: area[i])
    for i in idxs:
        if not source[i]:
            height[i] = max(3.0, height[r] + (floors[i] - floors[r]) * 3.0)
            source[i] = 'same-building'
m = np.isnan(height)
height[m] = floors[m] * 2.85 + 5.9
source[m] = 'catastro-floors'
source = source.astype(str)
both = ~np.isnan(h_even) & ~np.isnan(h_odd)
err = np.abs(h_even[both] - h_odd[both])
print(f'heights: {np.mean(np.char.startswith(source, "lidar")):.1%} from LiDAR ({tiles_used} tiles); split-half check median {np.median(err):.2f} m, p95 {np.percentile(err, 95):.2f} m')

# ---------------------------------------------------------------------------------------------------------------------
# 3. Groups (buildings), frames, box covers
# ---------------------------------------------------------------------------------------------------------------------
def obb_angle(poly):
    r = poly.minimum_rotated_rectangle
    pts = np.asarray(r.exterior.coords)[:4]
    e = [pts[(k + 1) % 4] - pts[k] for k in range(4)]
    long = max(e, key=lambda v: np.hypot(*v))
    ux, uz = long / (np.hypot(*long) or 1)
    return math.atan2(-uz, ux)  # buildings.js frame turn: local +x along (ux, uz)


def to_local(pts, px, pz, th):
    c, s = math.cos(th), math.sin(th)
    dx, dz = pts[:, 0] - px, pts[:, 1] - pz
    return np.column_stack([px + c * dx - s * dz, pz + s * dx + c * dz])


def to_world(pts, px, pz, th):
    c, s = math.cos(th), math.sin(th)
    dx, dz = pts[:, 0] - px, pts[:, 1] - pz
    return np.column_stack([px + c * dx + s * dz, pz - s * dx + c * dz])


def cover(poly_local, max_boxes=6):
    """Axis-aligned rectangles covering a local-frame polygon: its bbox when nearly rectangular, else greedy maximal
    rectangles on a 0.5 m raster until 92% is covered."""
    x0, z0, x1, z1 = poly_local.bounds
    if poly_local.area >= 0.9 * (x1 - x0) * (z1 - z0):
        return [(x0, x1, z0, z1)]
    res = 0.5
    w, h = max(1, int(math.ceil((x1 - x0) / res))), max(1, int(math.ceil((z1 - z0) / res)))
    # rows run along +z (a positive-e transform: row r covers z0 + r*res .. z0 + (r+1)*res)
    m = rasterio.features.rasterize([(poly_local, 1)], out_shape=(h, w), transform=Affine(res, 0, x0, 0, res, z0),
                                    fill=0, dtype='uint8').astype(bool)
    total = m.sum()
    out = []
    while total and len(out) < max_boxes and (m.sum() > 0.08 * total):
        best = (0, None)
        hist = np.zeros(w, int)
        for r in range(h):
            hist = np.where(m[r], hist + 1, 0)
            stack = []
            for c in range(w + 1):
                cur = hist[c] if c < w else 0
                start = c
                while stack and stack[-1][1] >= cur:
                    s0, hh = stack.pop()
                    area = hh * (c - s0)
                    if area > best[0]:
                        best = (area, (r - hh + 1, r, s0, c - 1))
                    start = s0
                stack.append((start, cur))
        if not best[1] or best[0] * res * res < 6:
            break
        r0, r1, c0, c1 = best[1]
        m[r0:r1 + 1, c0:c1 + 1] = False
        out.append((x0 + c0 * res, x0 + (c1 + 1) * res, z0 + r0 * res, z0 + (r1 + 1) * res))
    return out or [(x0, x1, z0, z1)]


part_tree = STRtree(list(parts.wgeom))
groups = parts.groupby('ref').indices
records = []
for ref, idxs in groups.items():
    union = shapely.union_all([parts.wgeom[i] for i in idxs]).buffer(0)
    if union.is_empty:
        continue
    th = obb_angle(union)
    c = union.centroid
    px, pz = c.x, c.y
    md = meta.get(ref, {'year': 0, 'currentUse': ''})
    boxes = []
    for i in idxs:
        g = parts.wgeom[i]
        loc = Polygon(to_local(np.asarray(g.exterior.coords), px, pz, th)).buffer(0)
        if loc.is_empty:
            continue
        for (bx0, bx1, bz0, bz1) in cover(loc):
            if bx1 - bx0 < 1.0 or bz1 - bz0 < 1.0:
                continue
            boxes.append([bx0, bx1, bz0, bz1, float(height[i]), i])
    if boxes:
        use = md['currentUse'] if isinstance(md['currentUse'], str) else ''
        records.append({'ref': ref, 'px': px, 'pz': pz, 'th': th, 'year': md['year'], 'use': use, 'boxes': boxes})
print(f'{len(records):,} buildings, {sum(len(r["boxes"]) for r in records):,} boxes')

# ---------------------------------------------------------------------------------------------------------------------
# 3b. Roofs from the LiDAR cells: flat terrace (at its real level, a 0.9 m parapet) or a gable (ridge along the box's
#     x or z), and the stair / lift houses standing on the terraces (blobs 1.8-9 m above the roof plane)
# ---------------------------------------------------------------------------------------------------------------------
from scipy import ndimage  # noqa: E402

FLAT, GABLE_X, GABLE_Z = 0, 1, 2
roof_level = np.full(len(parts), np.nan)
part_top = np.full(len(parts), np.nan)  # highest point the game draws per part (box, ridge or roof house)
roof_kind_n = {FLAT: 0, GABLE_X: 0, GABLE_Z: 0}


def gable_fit(s, z):
    """z ~ r - k*|s - c| over ridge positions c across the middle of the span: (rmse, r, k, c)"""
    lo, hi = np.percentile(s, 20), np.percentile(s, 80)
    best = None
    for c in np.linspace(lo, hi, 9):
        A = np.column_stack([np.ones_like(s), -np.abs(s - c)])
        sol, *_ = np.linalg.lstsq(A, z, rcond=None)
        rmse = float(np.sqrt(np.mean((A @ sol - z) ** 2)))
        if best is None or rmse < best[0]:
            best = (rmse, float(sol[0]), float(sol[1]), float(c))
    return best


for r in records:
    px, pz, th = r['px'], r['pz'], r['th']
    cth, sth = math.cos(th), math.sin(th)
    nbox = {}
    for b in r['boxes']:
        nbox[b[5]] = nbox.get(b[5], 0) + 1
    houses = []
    done_parts = set()
    for b in r['boxes']:
        x0, x1, z0, z1, h, pi = b[:6]
        b.extend([FLAT, 0.0])  # roof kind, ridge rise (m)
        if pi not in roof_cells or source[pi] not in ('lidar', 'lidar-small'):
            continue
        X, Y, Z, IY, IX = roof_cells[pi]
        if Z.size < 8:
            continue
        w = utm_to_world(np.column_stack([X, Y]))
        lu = px + cth * (w[:, 0] - px) - sth * (w[:, 1] - pz)
        lv = pz + sth * (w[:, 0] - px) + cth * (w[:, 1] - pz)
        m = float(np.median(Z))
        near = np.abs(Z - m) < 0.7
        if near.mean() >= 0.6 or nbox[pi] > 1 or Z.size < 25:
            # flat terrace: the roof plane is the median of the cells near it, plus a parapet
            plane = float(np.median(Z[near])) if near.any() else m
            b[4] = plane + 0.9
            roof_level[pi] = plane
            roof_kind_n[FLAT] += 1
            if pi in done_parts:
                continue
            done_parts.add(pi)
            hi = (Z > plane + 1.8) & (Z < plane + 9.0)
            if hi.sum() >= 5:
                ry0, rx0 = IY.min(), IX.min()
                grid = np.zeros((IY.max() - ry0 + 1, IX.max() - rx0 + 1), bool)
                grid[IY[hi] - ry0, IX[hi] - rx0] = True
                lab, nlab = ndimage.label(grid)
                cell_lab = lab[IY - ry0, IX - rx0]
                comps = sorted(((cell_lab == c).sum(), c) for c in range(1, nlab + 1))[::-1][:4]
                for size, c in comps:
                    if size < 5 or size > 150:
                        continue
                    sel = (cell_lab == c) & hi
                    top = float(np.percentile(Z[sel], 85))
                    houses.append([float(lu[sel].min()) - 0.5, float(lu[sel].max()) + 0.5, float(lv[sel].min()) - 0.5,
                                   float(lv[sel].max()) + 0.5, plane, top - plane])
                    part_top[pi] = max(part_top[pi], top)
            part_top[pi] = max(b[4], part_top[pi]) if not np.isnan(part_top[pi]) else b[4]
            continue
        # a sloping roof on a single-box part: try a ridge along x (slopes fall across z) and along z
        cand = []
        for kind, s in ((GABLE_X, lv), (GABLE_Z, lu)):
            rmse, ridge, k, c = gable_fit(s, Z)
            slope = math.degrees(math.atan(max(k, 0)))
            if 12 <= slope <= 50 and rmse < 0.7:
                cand.append((rmse, kind, ridge, k))
        if cand:
            rmse, kind, ridge, k = min(cand)
            half_span = ((z1 - z0) if kind == GABLE_X else (x1 - x0)) * 0.5
            rise = min(k * half_span, 12.0)
            eave = max(2.5, ridge - rise)
            b[4] = eave
            b[6], b[7] = kind, ridge - eave
            roof_level[pi] = eave
            part_top[pi] = ridge
            roof_kind_n[kind] += 1
        else:
            b[4] = m + 0.9
            roof_level[pi] = m
            roof_kind_n[FLAT] += 1
    r['houses'] = houses[:8]
for r in records:
    for b in r['boxes']:
        if np.isnan(part_top[b[5]]):
            part_top[b[5]] = b[4]
        else:
            part_top[b[5]] = max(part_top[b[5]], b[4] + b[7])
print(f'roofs: {roof_kind_n[FLAT]:,} flat, {roof_kind_n[GABLE_X] + roof_kind_n[GABLE_Z]:,} pitched; '
      f'{sum(len(r["houses"]) for r in records):,} stair / lift houses from LiDAR')

# ---------------------------------------------------------------------------------------------------------------------
# 4. Wall kinds by outward sampling (vectorised)
# ---------------------------------------------------------------------------------------------------------------------
SHOP, ENTRY, REAR, LOT = 0, 1, 2, 3
# every box as a row: local bounds + its group's frame
BX = np.array([[b[0], b[1], b[2], b[3], r['px'], r['pz'], r['th'], bi, k] for bi, r in enumerate(records) for k, b in enumerate(r['boxes'])])
TS = np.array([0.3, 0.7])
DS = np.array([1.0, 3.0, 6.0, 12.0, 20.0])
kinds_arr = np.zeros((len(BX), 4), 'u1')
CH = 20000
for c0 in range(0, len(BX), CH):
    b = BX[c0:c0 + CH]
    n = len(b)
    x0, x1, z0, z1, px, pz, th = (b[:, j][:, None, None] for j in range(7))
    t = TS[None, :, None]
    d = DS[None, None, :]
    votes = np.zeros((n, 4, len(TS)), 'u1')
    for f in range(4):
        if f == 0:
            lx, lz = x0 - d + 0 * t, z0 + (z1 - z0) * t + 0 * d
        elif f == 1:
            lx, lz = x1 + d + 0 * t, z0 + (z1 - z0) * t + 0 * d
        elif f == 2:
            lx, lz = x0 + (x1 - x0) * t + 0 * d, z0 - d + 0 * t
        else:
            lx, lz = x0 + (x1 - x0) * t + 0 * d, z1 + d + 0 * t
        cs, sn = np.cos(th), np.sin(th)
        wx = px + cs * (lx - px) + sn * (lz - pz)
        wz = pz - sn * (lx - px) + cs * (lz - pz)
        pts = shapely.points(wx.ravel(), wz.ravel())
        ip = np.zeros(pts.size, bool)
        ip[part_tree.query(pts, predicate='within')[0]] = True
        ic = np.zeros(pts.size, bool)
        ic[curb_tree.query(pts, predicate='within')[0]] = True
        ip = ip.reshape(n, len(TS), len(DS))
        ic = ic.reshape(n, len(TS), len(DS))
        # A wall fronts the street when the probes reach the roadway before another building, or meet no building at all
        # within 20 m (squares & plazas paved inside a curb island, parks, the Turia); it's a court / patio wall when
        # another building closes the space first
        v = np.full((n, len(TS)), REAR, 'u1')
        road = ~ic & ~ip
        first_road = np.where(road.any(2), road.argmax(2), 99)
        first_part = np.where(ip[:, :, 1:].any(2), ip[:, :, 1:].argmax(2) + 1, 99)
        v[(first_road < first_part) | (first_part == 99)] = SHOP
        v[ip[:, :, 0]] = LOT
        votes[:, f] = v
    # majority of the samples along each wall (ties -> the lower kind, i.e. the more open one)
    for f in range(4):
        vv = votes[:, f]
        counts = np.stack([(vv == k).sum(1) for k in range(4)], 1)
        kinds_arr[c0:c0 + n, f] = counts.argmax(1)
kinds = {(int(r[7]), int(r[8]), f): [int(kinds_arr[i, f])] for i, r in enumerate(BX) for f in range(4)}

# shops vs entries: one roll per building, likelier in the dense centre
DENSE = {'gotic', 'raval', 'born', 'eixample'}
rng = np.random.default_rng(7)
for bi, r in enumerate(records):
    hits = [j for j in curb_tree.query(Point(r['px'], r['pz']), predicate='within')]
    dist = barri_of_block[hits[0]] if hits else ''
    shop_p = 0.75 if dist in DENSE else 0.45
    if r['use'] and not r['use'].startswith('1'):
        shop_p = 0.85
    r['shops'] = rng.random() < shop_p
    r['district'] = dist
    for k, b in enumerate(r['boxes']):
        faces = []
        for f in range(4):
            v = kinds[(bi, k, f)]
            vote = max(set(v), key=v.count)
            if vote == SHOP and not r['shops']:
                vote = ENTRY
            faces.append(vote)
        b.append(faces)

# ---------------------------------------------------------------------------------------------------------------------
# 5. Facade material by era, height & barri (buildings.js facades: 0 stone/cream, 1 ochre stucco, 2 old render &
#    brick, 3 teal glass, 4 bronze glass, 5 silver glass)
# ---------------------------------------------------------------------------------------------------------------------
def material(r):
    top = max(b[4] for b in r['boxes'])
    y, d, u = r['year'], r['district'], r['use']
    if top > 45 and (y >= 1990 or u.startswith('4')):
        return 5 if y >= 2000 else 3
    if d in ('gotic', 'raval', 'born') or (0 < y < 1900):
        return 2 if (zlib.crc32(r['ref'].encode()) % 3 == 0) else 1
    if 1900 <= y < 1945:
        return 0
    if 1945 <= y < 1985:
        return 2 if (zlib.crc32(r['ref'].encode()) % 2 == 0) else 1
    return 0 if (zlib.crc32(r['ref'].encode()) % 2 == 0) else 1


# ---------------------------------------------------------------------------------------------------------------------
# 6. Write VLB1: header + sections (buildings f32[px, pz, th], u8[mat, tone, decade, flags], u16 nboxes;
#    boxes i16[x0, x1, z0, z1 relative to (px, pz) in dm, height dm], u8 faces packed 2 bits each w|e<<2|n<<4|s<<6)
# ---------------------------------------------------------------------------------------------------------------------
nb = len(records)
bf = np.zeros((nb, 3), '<f4')
bu = np.zeros((nb, 4), 'u1')
bn = np.zeros(nb, '<u2')
bx, bfc, broof, brise, hn, hx = [], [], [], [], [], []
for i, r in enumerate(records):
    hn.append(len(r['houses']))
    for (hx0, hx1, hz0, hz1, hy0, hh) in r['houses']:
        hx.append([round((hx0 - r['px']) * 10), round((hx1 - r['px']) * 10), round((hz0 - r['pz']) * 10), round((hz1 - r['pz']) * 10), round(hy0 * 10), round(hh * 10)])
    bf[i] = (r['px'], r['pz'], r['th'])
    bu[i] = (material(r), (zlib.crc32(r['ref'].encode()) & 0xff), max(0, min(255, (r['year'] // 10) - 150)) if r['year'] else 0, 1 if r['shops'] else 0)
    bn[i] = len(r['boxes'])
    for (x0, x1, z0, z1, h, pi, rkind, rise, faces) in r['boxes']:
        bx.append([round((x0 - r['px']) * 10), round((x1 - r['px']) * 10), round((z0 - r['pz']) * 10), round((z1 - r['pz']) * 10), round(h * 10)])
        bfc.append(faces[0] | (faces[1] << 2) | (faces[2] << 4) | (faces[3] << 6))
        broof.append(rkind)
        brise.append(min(255, round(rise * 10)))
bx = np.clip(np.array(bx), -32768, 32767).astype('<i2')
bfc = np.array(bfc, 'u1')
hxa = np.clip(np.array(hx).reshape(-1, 6), -32768, 32767).astype('<i2')
secs = [bf.tobytes(), bu.tobytes(), bn.tobytes(), bx.tobytes(), bfc.tobytes(), np.array(broof, 'u1').tobytes(),
        np.array(brise, 'u1').tobytes(), np.array(hn, 'u1').tobytes(), hxa.tobytes()]
pad = lambda b: b + b'\0' * ((-len(b)) % 4)  # noqa: E731
secs = [pad(x) for x in secs]
header = struct.pack('<4sIII', b'VLB2', nb, len(bx), len(hxa)) + struct.pack('<9I', *[len(x) for x in secs])
raw = header + b''.join(secs)
with gzip.open(out_path, 'wb', compresslevel=9) as fh:
    fh.write(raw)
print(f'wrote {out_path}: {len(raw) / 1e6:.2f} MB raw, {os.path.getsize(out_path) / 1e6:.2f} MB gzipped')

# per-part heights for re-measuring, and the stats
json.dump({
    'parts': int(len(parts)), 'buildings': nb, 'boxes': int(len(bx)), 'lidar_tiles': tiles_used,
    'height_source_share': {k: round(float(np.mean(source == k)), 4) for k in ('lidar', 'lidar-small', 'same-building', 'catastro-floors')},
    'height_source_area_share': {k: round(float(area[source == k].sum() / area.sum()), 4) for k in ('lidar', 'lidar-small', 'same-building', 'catastro-floors')},
    'split_half_check': {'n': int(both.sum()), 'median_abs_m': round(float(np.median(err)), 2), 'p95_abs_m': round(float(np.percentile(err, 95)), 2)},
    'wall_kinds': {k: int(sum(1 for b in bfc for f in range(4) if ((b >> (2 * f)) & 3) == v)) for k, v in (('shop', 0), ('entry', 1), ('rear', 2), ('lot', 3))},
    'bytes': {'raw': len(raw), 'gzip': os.path.getsize(out_path)},
    'roofs': {'flat': roof_kind_n[FLAT], 'pitched': roof_kind_n[GABLE_X] + roof_kind_n[GABLE_Z], 'roof_houses': int(len(hxa))},
}, open(stats_path, 'w'), indent=1)
parts.assign(height=height, source=source, h_odd=h_odd, roof_level=roof_level, top=part_top)[['localId', 'ref', 'height', 'source', 'h_odd', 'roof_level', 'top']].to_csv(stats_path.replace('.json', '-parts.csv'), index=False)
