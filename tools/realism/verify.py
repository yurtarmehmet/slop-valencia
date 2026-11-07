"""Checks for step 1 (docs/realism-plan.md section 5), against data the build did not use where it matters:

  heights     the built height of each Catastro part vs the independent PNOA-LiDAR 2015 VAL flight (0.5 pts/m², other
              sensor & year): 90th percentile of building-class height above ground inside the part (1 m in from its
              outline), parts >= 100 m² with >= 10 points. The old engine's heights are scored on the same parts.
  footprints  the boxes the game draws vs the Catastro parts they stand for (IoU, 1 m raster)
  placement   the boxes vs the 2023 LiDAR building mask: IoU and the shift that best aligns them (should be ~0)

usage: python -I verify.py engine.json parts.parquet parts-heights.csv vlc-buildings.bin.gz lidar2023_dir lidar2015_dir out.json
"""
import gzip
import json
import math
import os
import struct
import sys

import geopandas as gpd
import numpy as np
import pandas as pd
import pdal
import rasterio.features
from affine import Affine
from pyproj import Transformer
from shapely.geometry import Polygon
from shapely.strtree import STRtree

engine_path, parts_path, heights_csv, bin_path, l23, l15, out_path = sys.argv[1:]
E = json.load(open(engine_path))
fr = E['frame']
TH = math.radians(fr['bearingDeg'])
C, S = math.cos(TH), math.sin(TH)
to_utm = Transformer.from_crs(4326, 25830, always_xy=True)


def world_to_utm(pts):
    pts = np.asarray(pts, float)
    x, z = pts[:, 0], pts[:, 1]
    e = x * C - z * S
    n = -x * S - z * C
    return np.column_stack(to_utm.transform(fr['lon0'] + e / fr['kx'], fr['lat0'] + n / fr['ky']))


# --- the game's boxes, as UTM polygons -------------------------------------------------------------------------------
raw = gzip.open(bin_path).read()
nb, nx = struct.unpack('<II', raw[4:12])
if raw[:4] in (b'VLB2', b'VLB3'):
    ns = 10 if raw[:4] == b'VLB3' else 9
    lens = struct.unpack(f'<{ns}I', raw[16:16 + 4 * ns])
    at = 16 + 4 * ns
else:
    lens = struct.unpack('<5I', raw[12:32])
    at = 32
sec = []
for L in lens:
    sec.append(raw[at:at + L])
    at += L
frames = np.frombuffer(sec[0], '<f4').reshape(-1, 3)[:nb]
counts = np.frombuffer(sec[2], '<u2')[:nb]
boxes = np.frombuffer(sec[3], '<i2').reshape(-1, 5)[:nx] / 10.0
box_polys, box_h = [], []
k = 0
for i in range(nb):
    px, pz, th = frames[i]
    c, s = math.cos(th), math.sin(th)
    for _ in range(counts[i]):
        x0, x1, z0, z1, h = boxes[k]
        loc = np.array([[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) + [px, pz]
        dx, dz = loc[:, 0] - px, loc[:, 1] - pz
        w = np.column_stack([px + c * dx + s * dz, pz - s * dx + c * dz])
        box_polys.append(Polygon(world_to_utm(w)))
        box_h.append(h)
        k += 1
print(f'{len(box_polys):,} boxes')

parts = gpd.read_parquet(parts_path)
parts = parts[parts.numberOfFloorsAboveGround.fillna(0) > 0]
H = pd.read_csv(heights_csv)
parts = parts.merge(H, on='localId')
parts['area'] = parts.geometry.area

# old engine: expected storeys x 3.4 m of the curb block a part falls in (as in measure.py)
blocks = [(Polygon(world_to_utm(b['poly'])).buffer(0), b['expFloors']) for b in E['blocks']]
btree = STRtree([b[0] for b in blocks])


def engine_h(g):
    c = g.representative_point()
    hit = [j for j in btree.query(c) if blocks[j][0].contains(c)]
    return blocks[hit[0]][1] * 3.4 if hit else np.nan


res = {}
# --- 1. heights vs the 2015 flight ------------------------------------------------------------------------------------
rows = []
for f in sorted(os.listdir(l15)):
    if not f.endswith('.laz'):
        continue
    ek, nk = [int(v) for v in f.split('_')[3].split('-')]
    x0, y1, x1, y0 = ek * 1000, nk * 1000, ek * 1000 + 2000, nk * 1000 - 2000
    pipe = pdal.Pipeline(json.dumps({'pipeline': [os.path.join(l15, f), {'type': 'filters.hag_nn'}]}))
    pipe.execute()
    a = pipe.arrays[0]
    m = a['Classification'] == 6
    pts = gpd.GeoDataFrame({'h': a['HeightAboveGround'][m]}, geometry=gpd.points_from_xy(a['X'][m], a['Y'][m]), crs=25830)
    sub = parts.cx[x0:x1, y0:y1]
    sub = sub[sub.area >= 100].copy()
    sub['inner'] = sub.geometry.buffer(-1.0)
    sub = sub[~sub.inner.is_empty].set_geometry('inner')
    j = gpd.sjoin(pts, sub[['localId', 'inner']], predicate='within')
    agg = j.groupby('localId').h.agg(['count', lambda v: np.percentile(v, 90), 'median'])
    agg.columns = ['n', 'truth15', 'median15']
    agg = agg[agg.n >= 10]
    t = sub.set_index('localId').join(agg, how='inner')
    t['engine_old'] = [engine_h(g) for g in t.geometry]
    cols = ['height', 'source', 'truth15', 'median15', 'engine_old', 'area'] + [c for c in ('roof_level', 'top') if c in t]
    rows.append(t[cols])
    print(f'  2015 tile {ek}-{nk}: {len(t)} parts scored')
T = pd.concat(rows)


def summ(e):
    e = np.abs(np.asarray(e, float))
    e = e[~np.isnan(e)]
    return {'n': int(e.size), 'median_abs_m': round(float(np.median(e)), 2), 'p95_abs_m': round(float(np.percentile(e, 95)), 2),
            'within_1_5m': round(float(np.mean(e < 1.5)), 3)}


res['heights_vs_lidar2015'] = {
    'new_buildings': summ(T.height - T.truth15),
    'old_engine': summ(T.engine_old - T.truth15),
    'new_by_source': {s: summ(g.height - g.truth15) for s, g in T.groupby('source')},
    'note': '2015 vs 2023: real changes (new builds, demolitions, rooftop additions) count as error here',
}
if 'top' in T:
    # step 2: the highest thing drawn per part (box, ridge or roof house) vs the 2015 p90, and the roof plane vs the
    # 2015 median (the terrace itself, without stair houses & clutter)
    res['heights_vs_lidar2015']['drawn_top'] = summ(T.top - T.truth15)
    flat = T.dropna(subset=['roof_level'])
    res['heights_vs_lidar2015']['roof_level_vs_2015_median'] = summ(flat.roof_level - flat.median15)
# --- 2 & 3. footprints vs Catastro, placement vs 2023 LiDAR (on the 2015 tiles' area, 1 m) ----------------------------
fp = []
for f in sorted(os.listdir(l23)):
    if not f.endswith('.laz'):
        continue
    ek, nk = [int(v) for v in f.split('_')[3].split('-')]
    if not any(f'{a}-{b}' in ' '.join(os.listdir(l15)) for a in (ek, ek - 1) for b in (nk, nk + 1)):
        continue
    x0, y1 = ek * 1000, nk * 1000
    W = 1000
    tr = Affine(1, 0, x0, 0, -1, y1)
    from shapely.geometry import box as sbox
    tb = sbox(x0, y1 - 1000, x0 + 1000, y1)
    bm = rasterio.features.rasterize([(p, 1) for p in box_polys if p.intersects(tb)], out_shape=(W, W), transform=tr, fill=0, dtype='uint8').astype(bool)
    sub = parts.cx[x0:x0 + 1000, y1 - 1000:y1]
    cm = rasterio.features.rasterize([(g, 1) for g in sub.geometry], out_shape=(W, W), transform=tr, fill=0, dtype='uint8').astype(bool) if len(sub) else np.zeros((W, W), bool)
    pipe = pdal.Pipeline(json.dumps({'pipeline': [os.path.join(l23, f), {'type': 'filters.hag_nn'}]}))
    pipe.execute()
    a = pipe.arrays[0]
    m = (a['Classification'] == 6) & (a['HeightAboveGround'] > 2)
    lm = np.zeros((W, W), bool)
    lm[np.clip((y1 - a['Y'][m]).astype(int), 0, W - 1), np.clip((a['X'][m] - x0).astype(int), 0, W - 1)] = True
    iou = lambda p, q: float((p & q).sum() / max(1, (p | q).sum()))  # noqa: E731
    best = (iou(bm, lm), 0, 0)
    for dx in range(-3, 4):
        for dy in range(-3, 4):
            v = iou(np.roll(np.roll(bm, dy, 0), dx, 1), lm)
            if v > best[0]:
                best = (v, dx, -dy)
    fp.append({'tile': f'{ek}-{nk}', 'iou_boxes_catastro': round(iou(bm, cm), 3), 'iou_boxes_lidar': round(iou(bm, lm), 3),
               'iou_catastro_lidar': round(iou(cm, lm), 3), 'best_shift_m': [best[1], best[2]]})
    print('  ', fp[-1])
res['footprints'] = {'tiles': fp, 'median_iou_boxes_catastro': float(np.median([t['iou_boxes_catastro'] for t in fp])),
                     'median_iou_boxes_lidar': float(np.median([t['iou_boxes_lidar'] for t in fp]))}
json.dump(res, open(out_path, 'w'), indent=1)
print(json.dumps({k: v for k, v in res.items() if k != 'footprints'}, indent=1))
print('footprints', {k: v for k, v in res['footprints'].items() if k != 'tiles'})
