"""The roof surface and roof colours of the landmarks modelled from the survey, for landmarks.js: a 1 m grid of the
PNOA-LiDAR 2023 surface (CC BY 4.0 scne.es) inside each outline (height above ground, 0.2 m steps; ground, noise and
water classes out; each cell's highest point, a 3 x 3 median against antennas and birds), the PNOA orthophoto's colour
on a 2 m grid (IGN WMS pnoa-ma, PNOA cedido por © Instituto Geográfico Nacional, CC BY 4.0), and the domes and towers
found round given seeds (peak, the radius where the surface drops to the roof round it, the crown).

Writes the LANDMARK_SHAPES export of js/vlc-landmark-heights.js (its LANDMARK_HEIGHTS line, from landmark-heights.py,
is kept).

usage: python -I landmark-shapes.py sites.json lidar_dir osm.pbf cache_dir js/vlc-landmark-heights.js
  sites.json: { frame: GEO.frame, sites: GEO.landmarks }  (node: import GEO from js/bcn-geodata.js)
"""
import base64
import io
import json
import math
import os
import re
import sys
import urllib.request

import numpy as np
import pdal
from PIL import Image
from pyproj import Transformer
from scipy import ndimage
from shapely import contains_xy
from shapely.geometry import Polygon

sites_path, lidar_dir, pbf, cache, out = sys.argv[1:6]
os.makedirs(cache, exist_ok=True)
J = json.load(open(sites_path))
fr = J['frame']
TH = math.radians(fr['bearingDeg'])
C, S = math.cos(TH), math.sin(TH)
to_utm = Transformer.from_crs(4326, 25830, always_xy=True)
to_ll = Transformer.from_crs(25830, 4326, always_xy=True)


def w2ll(x, z):
    e = np.asarray(x) * C - np.asarray(z) * S
    n = -np.asarray(x) * S - np.asarray(z) * C
    return fr['lon0'] + e / fr['kx'], fr['lat0'] + n / fr['ky']


def ll2w(lon, lat):
    e = (np.asarray(lon) - fr['lon0']) * fr['kx']
    n = (np.asarray(lat) - fr['lat0']) * fr['ky']
    return e * C - n * S, -e * S - n * C


def osm_ring(osm_id):
    import pyogrio
    g = pyogrio.read_dataframe(pbf, layer='multipolygons', where=f"osm_id = '{osm_id}'")
    geom = g.geometry.iloc[0]
    poly = max(geom.geoms, key=lambda p: p.area) if geom.geom_type == 'MultiPolygon' else geom
    x, z = ll2w(*np.array(poly.exterior.coords[:-1]).T)
    return [[round(float(a), 2), round(float(b), 2)] for a, b in zip(x, z)], g['name'].iloc[0]


# name: ring source, dome / tower seeds (world x, z)
TODO = {
    'Mercat Central': {'site': 'Mercat Central', 'seeds': {'dome': (17, -467), 'fishDome': (8, -509), 'towerS': (-50, -445), 'towerN': (-55, -465)}},
    'Sant Valer': {'osm': '9498243', 'seeds': {'tower': (-56, 880), 'dome': (-66, 862), 'chapelDome': (-51, 852)}},
    'Mercat de Colón': {'site': 'Mercat de Colón', 'seeds': {}},
}


def lidar_points(ex0, ex1, ny0, ny1):
    tiles = {os.path.join(lidar_dir, f'PNOA_2023_VAL_{int(ex // 1000)}-{int(ny // 1000) + 1}_H30_NPC02.laz')
             for ex in (ex0, ex1) for ny in (ny0, ny1)}
    arrs = []
    for t in sorted(tiles):
        if not os.path.exists(t):
            continue
        p = pdal.Pipeline(json.dumps({'pipeline': [t, {'type': 'filters.crop', 'bounds': f'([{ex0},{ex1}],[{ny0},{ny1}])'},
                                                   {'type': 'filters.hag_nn'}]}))
        p.execute()
        arrs.append(p.arrays[0])
    a = np.concatenate(arrs)
    return a[~np.isin(a['Classification'], [7, 9, 18])]


def ortho(ex0, ex1, ny0, ny1, res=0.25):
    key = os.path.join(cache, f'pnoa_{int(ex0)}_{int(ny0)}_{int(ex1)}_{int(ny1)}_{res}.jpg')
    if not os.path.exists(key):
        w, h = int((ex1 - ex0) / res), int((ny1 - ny0) / res)
        url = ('https://www.ign.es/wms-inspire/pnoa-ma?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=OI.OrthoimageCoverage'
               f'&STYLES=&CRS=EPSG:25830&BBOX={ex0},{ny0},{ex1},{ny1}&WIDTH={w}&HEIGHT={h}&FORMAT=image/jpeg')
        req = urllib.request.Request(url, headers={'User-Agent': 'slop-valencia-landmarks/0.1 (hobby open-source project)'})
        open(key, 'wb').write(urllib.request.urlopen(req, timeout=120).read())
    return np.asarray(Image.open(key).convert('RGB'), np.float32), res


b64 = lambda arr: base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode()
shapes = {}
for name, cfg in TODO.items():
    if 'site' in cfg:
        r = J['sites'][cfg['site']]['ring']
        ring = [[r[i], r[i + 1]] for i in range(0, len(r), 2)]
        src = 'OpenStreetMap outline (city-config.js LANDMARK_SITES)'
    else:
        ring, osm_name = osm_ring(cfg['osm'])
        src = f'OpenStreetMap relation {cfg["osm"]} ({osm_name})'
    poly = Polygon(ring).buffer(0)
    CELL = 1.0
    bx0, bz0, bx1, bz1 = poly.bounds
    x0, z0 = math.floor(bx0) - 2, math.floor(bz0) - 2
    nx, nz = int(math.ceil(bx1 - x0)) + 3, int(math.ceil(bz1 - z0)) + 3
    # the survey round the outline
    cx = np.array([x0, x0 + nx, x0, x0 + nx]); cz = np.array([z0, z0, z0 + nz, z0 + nz])
    E, N = to_utm.transform(*w2ll(cx, cz))
    ex0, ex1, ny0, ny1 = E.min() - 3, E.max() + 3, N.min() - 3, N.max() + 3
    a = lidar_points(ex0, ex1, ny0, ny1)
    wx, wz = ll2w(*to_ll.transform(a['X'], a['Y']))
    ix = np.floor((wx - x0) / CELL).astype(int); iz = np.floor((wz - z0) / CELL).astype(int)
    ok = (ix >= 0) & (ix < nx) & (iz >= 0) & (iz < nz)
    hag = np.where(a['Classification'] == 2, 0.0, a['HeightAboveGround'])
    g = np.full((nz, nx), np.nan, np.float32)
    np.fmax.at(g, (iz[ok], ix[ok]), hag[ok].astype(np.float32))
    for _ in range(3):
        m = np.isnan(g)
        if not m.any():
            break
        f = ndimage.maximum_filter(np.nan_to_num(g, nan=-1), 3)
        g[m] = np.where(f[m] >= 0, f[m], np.nan)
    g = ndimage.median_filter(np.nan_to_num(g), 3)
    XX, ZZ = np.meshgrid(x0 + (np.arange(nx) + 0.5) * CELL, z0 + (np.arange(nz) + 0.5) * CELL)
    inside = contains_xy(poly, XX, ZZ)
    raw = np.where(inside, g, 0)
    # cells outside the outline take their nearest inside cell's height (the model samples the grid bilinearly right up to
    # the outline: its wall tops then follow the roof edge, not the street)
    _, (jz, jx) = ndimage.distance_transform_edt(~inside, return_indices=True)
    filled = raw[jz, jx]
    Q = 0.2
    hq = np.clip(np.round(filled / Q), 0, 255).astype(np.uint8)
    # domes & towers: the peak near the seed, the radial profile, its radius where it drops to the roof round it
    feats = {}
    for k, (sx, sz) in cfg['seeds'].items():
        near = np.hypot(XX - sx, ZZ - sz) < 5
        i = int(np.argmax(np.where(near, raw, -1)))
        px, pz, top = float(XX.flat[i]), float(ZZ.flat[i]), float(raw.flat[i])
        R = np.hypot(XX - px, ZZ - pz)
        prof = [float(np.median(raw[(R >= r) & (R < r + 1)])) for r in range(0, 16)]
        # the roof round it: the median from 12 to 16 m out; the radius: the first ring below halfway from that to the top
        base = float(np.median(raw[(R >= 12) & (R < 16) & inside]))
        half = base + 0.35 * (top - base)
        rad = next((r for r, h in enumerate(prof) if h < half), 15)
        feats[k] = {'x': round(px, 1), 'z': round(pz, 1), 'top': round(top, 1), 'r': rad, 'base': round(base, 1),
                    'profile': [round(h, 1) for h in prof]}
        print(f'{name:16s} {k:10s} at ({px:.1f}, {pz:.1f}) top {top:.1f} r~{rad} base {base:.1f}  profile {feats[k]["profile"][:10]}')
    # roof colours from the orthophoto: 2 m cells, the brighter 70 % of the pixels (shadow out)
    img, res = ortho(ex0, ex1, ny0, ny1)
    CC = 2.0
    cnx, cnz = int(math.ceil(nx / CC)), int(math.ceil(nz / CC))
    rgb = np.zeros((cnz, cnx, 3), np.uint8)
    sub = np.linspace(0.125, 0.875, 4)
    for jz in range(cnz):
        for jx in range(cnx):
            sx = x0 + (jx + sub[None, :]) * CC + 0 * sub[:, None]
            sz = z0 + (jz + sub[:, None]) * CC + 0 * sub[None, :]
            E2, N2 = to_utm.transform(*w2ll(sx.ravel(), sz.ravel()))
            col = ((E2 - ex0) / res).astype(int).clip(0, img.shape[1] - 1)
            row = ((ny1 - N2) / res).astype(int).clip(0, img.shape[0] - 1)
            px = img[row, col]
            lum = px.sum(1)
            keep = lum >= np.percentile(lum, 30)
            rgb[jz, jx] = px[keep].mean(0).round().astype(np.uint8)
    shapes[name] = {
        'source': src,
        'ring': [v for p in ring for v in p] if 'osm' in cfg else None,
        'grid': {'x0': x0, 'z0': z0, 'nx': nx, 'nz': nz, 'cell': CELL, 'q': Q, 'h': b64(hq)},
        'rgb': {'cell': CC, 'nx': cnx, 'nz': cnz, 'data': b64(rgb)},
        'features': feats,
    }
    print(f'{name}: grid {nx}x{nz}, {int(inside.sum())} cells inside, top {raw.max():.1f} m; {src}')

js = open(out).read() if os.path.exists(out) else ''
js = re.sub(r'\n// LANDMARK_SHAPES[^\n]*\n(//[^\n]*\n)*export const LANDMARK_SHAPES = [^\n]*\n', '\n', js)
js = js.rstrip('\n') + '\n' + (
    '// LANDMARK_SHAPES: roof surfaces (1 m grid, height above ground in q-metre steps, u8 base64, row-major from x0, z0),\n'
    '// orthophoto roof colours (2 m grid, sRGB u8 base64; PNOA cedido por © IGN, CC BY 4.0) and the domes & towers found in\n'
    '// the survey. Generated by tools/realism/landmark-shapes.py.\n'
    f'export const LANDMARK_SHAPES = {json.dumps(shapes, ensure_ascii=False, separators=(",", ":"))};\n')
open(out, 'w').write(js)
print('wrote', out, len(js), 'bytes')
