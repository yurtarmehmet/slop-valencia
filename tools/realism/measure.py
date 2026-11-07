"""Baseline measurement for slop-valencia's realism plan.

Ground truth: PNOA-LiDAR 3rd coverage (5 pts/m², classified; class 6 = building), height above ground from PDAL
filters.hag_nn, gridded at 1 m (cell max), per building part the 90th percentile of its building cells.

Compared against that truth, per Catastro building part (inside the sample tiles):
  - engine: what slop-valencia builds today (expected storeys of the block the part falls in, per buildings.js rules,
    x 3.4 m)
  - catastro: numberOfFloorsAboveGround x a + b, (a, b) fitted on even-indexed parts, scored on odd-indexed (held out)
And per tile, built-coverage IoU against the LiDAR building mask: Catastro footprints vs the engine's lots, plus the
Catastro-vs-LiDAR shift that maximises overlap (alignment check).

usage: python -I measure.py engine.json parts.parquet out_dir tile1.laz [tile2.laz ...]
"""
import json
import math
import os
import sys

import geopandas as gpd
import numpy as np
import pdal
import rasterio.features
from affine import Affine
from pyproj import Transformer
from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

engine_path, parts_path, out_dir, *tiles = sys.argv[1:]
os.makedirs(out_dir, exist_ok=True)
STOREY_ENGINE = 3.4

# --- engine blocks in UTM 30N ---------------------------------------------------------------------------------------
E = json.load(open(engine_path))
fr = E['frame']
th = math.radians(fr['bearingDeg'])
to_utm = Transformer.from_crs(4326, 25830, always_xy=True)


def world_to_utm(pts):
    out = []
    for x, z in pts:
        e = x * math.cos(th) - z * math.sin(th)
        n = -x * math.sin(th) - z * math.cos(th)
        lon, lat = fr['lon0'] + e / fr['kx'], fr['lat0'] + n / fr['ky']
        out.append(to_utm.transform(lon, lat))
    return out


blocks, block_polys, lot_polys = [], [], []
for b in E['blocks']:
    bp = Polygon(world_to_utm(b['poly'])).buffer(0)
    blocks.append(b)
    block_polys.append(bp)
    for lot in b['lots']:
        lot_polys.append(Polygon(world_to_utm(lot)).buffer(0))
    if b['ring']:
        lot_polys.append(Polygon(world_to_utm(b['ring']['outer']), [world_to_utm(b['ring']['inner'])]).buffer(0))
block_tree = STRtree(block_polys)
print(f'engine: {len(blocks)} blocks, {len(lot_polys)} lot polygons')

parts_all = gpd.read_parquet(parts_path)
parts_all = parts_all.set_crs(25830, allow_override=True) if parts_all.crs is None else parts_all.to_crs(25830)
parts_all['floors'] = parts_all['numberOfFloorsAboveGround'].fillna(0).astype(int)

rows, tile_stats = [], []
for path in tiles:
    name = os.path.basename(path)
    # 1 km tile: name ..._EEE-NNNN_... gives the upper-left corner in km
    ek, nk = [int(v) for v in name.split('_')[3].split('-')]
    x0, y1 = ek * 1000, nk * 1000
    x1, y0 = x0 + 1000, y1 - 1000
    pipe = pdal.Pipeline(json.dumps({'pipeline': [path, {'type': 'filters.hag_nn'}]}))
    pipe.execute()
    a = pipe.arrays[0]
    cls = a['Classification']
    b6 = cls == 6
    X, Y, H = a['X'][b6], a['Y'][b6], a['HeightAboveGround'][b6]
    W = 1000
    ix = np.clip(((X - x0)).astype(int), 0, W - 1)
    iy = np.clip(((y1 - Y)).astype(int), 0, W - 1)
    ndsm = np.full((W, W), np.nan, dtype=np.float32)
    flat = iy * W + ix
    order = np.argsort(flat)
    flat_s, h_s = flat[order], H[order]
    uniq, start = np.unique(flat_s, return_index=True)
    ndsm.ravel()[uniq] = np.maximum.reduceat(h_s, start)
    bmask = ~np.isnan(ndsm) & (ndsm > 2.0)
    transform = Affine(1, 0, x0, 0, -1, y1)

    sub = parts_all.cx[x0:x1, y0:y1]
    sub = sub[sub.floors > 0].reset_index(drop=True)
    shapes = [(g, i + 1) for i, g in enumerate(sub.geometry)]
    pid = rasterio.features.rasterize(shapes, out_shape=(W, W), transform=transform, fill=0, dtype='int32') if shapes else np.zeros((W, W), 'int32')
    lots_here = [p for p in lot_polys if p.intersects(Polygon([(x0, y0), (x1, y0), (x1, y1), (x0, y1)]))]
    emask = rasterio.features.rasterize([(p, 1) for p in lots_here], out_shape=(W, W), transform=transform, fill=0, dtype='uint8').astype(bool) if lots_here else np.zeros((W, W), bool)
    cmask = pid > 0
    # interior cells only (same part on all 4 sides): a part's edge cells catch its neighbours' walls in the cell max
    inner = pid.copy()
    for ax, sh in ((0, 1), (0, -1), (1, 1), (1, -1)):
        inner[np.roll(pid, sh, ax) != pid] = 0

    # per part truth & predictions
    for i, r in sub.iterrows():
        n = int((pid == i + 1).sum())
        cells = inner == i + 1
        if n < 10 or cells.sum() < 6:
            continue
        frac = float(bmask[cells].mean())
        hv = ndsm[cells & bmask]
        truth = float(np.percentile(hv, 90)) if frac >= 0.5 and hv.size >= 8 else None
        c = r.geometry.representative_point()
        hit = [j for j in block_tree.query(c) if block_polys[j].contains(c)]
        eng = blocks[hit[0]]['expFloors'] * STOREY_ENGINE if hit else None
        rows.append({'tile': name, 'id': r.localId, 'floors': int(r.floors), 'area': n, 'lidar_frac': frac, 'truth': truth,
                     'engine': eng, 'district': blocks[hit[0]]['district'] if hit else None})

    def iou(m1, m2):
        u = (m1 | m2).sum()
        return float((m1 & m2).sum() / u) if u else float('nan')
    # alignment: shift of the Catastro mask (±3 m) that best overlaps the LiDAR mask
    best = (iou(cmask, bmask), 0, 0)
    for dx in range(-3, 4):
        for dy in range(-3, 4):
            v = iou(np.roll(np.roll(cmask, dy, 0), dx, 1), bmask)
            if v > best[0]:
                best = (v, dx, dy)
    st = {'tile': name, 'lidar_building_cells': int(bmask.sum()), 'iou_catastro_lidar': iou(cmask, bmask),
          'iou_engine_lidar': iou(emask, bmask), 'iou_catastro_best_shift': best[0], 'best_shift_m': [best[1], -best[2]],
          'parts': int(len(sub))}
    tile_stats.append(st)
    print(json.dumps(st))

# --- scoring ---------------------------------------------------------------------------------------------------------
import pandas as pd  # noqa: E402

df = pd.DataFrame(rows)
df.to_csv(os.path.join(out_dir, 'parts.csv'), index=False)
ok = df.dropna(subset=['truth'])
train = ok.iloc[::2]
test = ok.iloc[1::2]
from scipy.stats import theilslopes  # noqa: E402
_sl, _ic, *_ = theilslopes(train.truth, train.floors)
coef = (_sl, _ic)


def summary(err):
    err = np.abs(np.asarray(err, float))
    err = err[~np.isnan(err)]
    return {'n': int(err.size), 'median_abs_m': round(float(np.median(err)), 2), 'p95_abs_m': round(float(np.percentile(err, 95)), 2),
            'mean_abs_m': round(float(err.mean()), 2)} if err.size else {'n': 0}


cat_pred = test.floors * coef[0] + coef[1]
eng_test = test.dropna(subset=['engine'])
res = {
    'tiles': tile_stats,
    'catastro_fit': {'storey_m': round(float(coef[0]), 3), 'offset_m': round(float(coef[1]), 3), 'train_n': int(len(train))},
    'heldout_catastro_vs_lidar': summary(cat_pred - test.truth),
    'heldout_engine_vs_lidar': summary(eng_test.engine - eng_test.truth),
    'engine_coverage_of_parts': round(float(df.engine.notna().mean()), 3),
    'parts_with_lidar_truth': round(float(df.truth.notna().mean()), 3),
}
ok = ok.assign(abs_engine=(ok.engine - ok.truth).abs(), abs_cat=(ok.floors * coef[0] + coef[1] - ok.truth).abs())
by = ok.dropna(subset=['district']).groupby('district').agg(parts=('id', 'count'), area=('area', 'sum'),
                                                            engine_mae=('abs_engine', 'mean'), catastro_mae=('abs_cat', 'mean'))
by['error_x_area'] = (by.engine_mae * by.area).round(0)
res['by_profile'] = by.sort_values('error_x_area', ascending=False).round(2).reset_index().to_dict('records')
json.dump(res, open(os.path.join(out_dir, 'baseline.json'), 'w'), indent=1)
print(json.dumps({k: v for k, v in res.items() if k != 'tiles'}, indent=1))
