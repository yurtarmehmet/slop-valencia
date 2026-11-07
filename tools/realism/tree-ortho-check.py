"""Crown sizes of the game's trees against the PNOA orthophoto (IGN, CC BY 4.0), top-down.

Samples N street trees (inventory 'Viario', in a pavement pit) at random (fixed seed); for each fetches the PNOA
orthophoto around it (WMTS, zoom 19, ~0.18 m/px here) and measures the crown seen from above: green pixels (excess
green above the window's Otsu threshold), inside the tree's own Voronoi cell among the living trees and within 10 m,
the connected part touching the point; diameter = 2 sqrt(area / pi). Writes the samples with their ortho diameter,
the baked crown diameter (vlc-trees.bin.gz) and every baked tree within 14 m (for a top-down game render, tree-lab).

usage: python -I tree-ortho-check.py vlc-trees.bin.gz tile_cache_dir out.json [N]
"""
import gzip
import io
import json
import math
import os
import struct
import sys
import time
import urllib.request

import numpy as np
from PIL import Image
from pyproj import Transformer
from scipy import ndimage
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vlci  # noqa: E402

bin_path, cache, out = sys.argv[1:4]
N = int(sys.argv[4]) if len(sys.argv) > 4 else 60
Z = 19
WMTS = ('https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0&layer=OI.OrthoimageCoverage'
        '&style=default&tilematrixset=GoogleMapsCompatible&tilematrix={z}&tilerow={y}&tilecol={x}&format=image/jpeg')
UA = {'User-Agent': 'slop-valencia-build/1.0 (tree crown check)'}

# baked trees
raw = gzip.open(bin_path).read()
assert raw[:4] == b'VLT2'
count, tl = struct.unpack_from('<IH', raw, 4)
kinds = json.loads(raw[10:10 + tl])
B = np.frombuffer(raw, dtype=np.dtype([('x', '<i2'), ('z', '<i2'), ('k', 'u1'), ('h', 'u1'), ('c', 'u1'), ('f', 'u1')]), count=count, offset=10 + tl)
bx, bz = B['x'] / 4.0, B['z'] / 4.0
baked = cKDTree(np.c_[bx, bz])

g = vlci.clip_detail(vlci.add_world(vlci.read('arbratge-arbolado')))
genus = g['nom_botani'].fillna('').str.split(' ').str[0]
live = ~genus.isin({'Falta', 'Tocón', 'Tocon', ''}) & ~g['grupo'].fillna('').str.startswith('Arbusto')
g = g[live].reset_index(drop=True)
seeds = cKDTree(np.c_[g['x'], g['z']])
street = g[(g['tipo_situa'] == 'Viario') & g['ubicación'].fillna('').str.startswith('Alcorque')]
rng = np.random.default_rng(20261105)
pick = street.iloc[rng.choice(len(street), size=N * 2, replace=False)]
to_ll = Transformer.from_crs(25830, 4326, always_xy=True)
to_utm = Transformer.from_crs(4326, 25830, always_xy=True)
os.makedirs(cache, exist_ok=True)


def tile(x, y):
    p = os.path.join(cache, f'{Z}_{x}_{y}.jpg')
    if not os.path.exists(p):
        for i in range(4):
            try:
                req = urllib.request.Request(WMTS.format(z=Z, x=x, y=y), headers=UA)
                open(p, 'wb').write(urllib.request.urlopen(req, timeout=60).read())
                break
            except Exception:
                time.sleep(2 * (i + 1))
        time.sleep(0.1)
    return np.asarray(Image.open(p).convert('RGB'), dtype=np.float32)


def merc(lon, lat):
    n = 2 ** Z * 256
    return (lon + 180) / 360 * n, (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n


def otsu(v):
    h, e = np.histogram(v, bins=64)
    c = (e[:-1] + e[1:]) / 2
    w0 = np.cumsum(h)
    w1 = w0[-1] - w0
    m0 = np.cumsum(h * c) / np.maximum(w0, 1)
    m1 = (np.sum(h * c) - np.cumsum(h * c)) / np.maximum(w1, 1)
    return c[np.argmax(w0 * w1 * (m0 - m1) ** 2)]


samples = []
for _, r in pick.iterrows():
    if len(samples) >= N:
        break
    lon, lat = to_ll.transform(r.geometry.x, r.geometry.y)
    px, py = merc(lon, lat)
    tx, ty = int(px // 256), int(py // 256)
    img = np.concatenate([np.concatenate([tile(tx + i, ty + j) for i in (-1, 0, 1)], axis=1) for j in (-1, 0, 1)], axis=0)
    cx, cy = px - (tx - 1) * 256, py - (ty - 1) * 256
    mpp = 156543.03392 * math.cos(math.radians(lat)) / 2 ** Z
    R = int(10 / mpp)
    i0, j0 = int(cx), int(cy)
    win = img[j0 - R:j0 + R + 1, i0 - R:i0 + R + 1]
    if win.shape[:2] != (2 * R + 1, 2 * R + 1):
        continue
    s = win.sum(axis=2) + 1
    exg = (2 * win[..., 1] - win[..., 0] - win[..., 2]) / s
    thr = max(0.02, otsu(exg))
    veg = exg > thr
    veg = ndimage.binary_opening(veg, iterations=1)
    veg = ndimage.binary_closing(veg, iterations=2)
    # pixel centres -> UTM -> world (via the trees' own UTM/world pairs: a local affine is plenty over 20 m)
    jj, ii = np.mgrid[-R:R + 1, -R:R + 1]
    plon = (px + ii) / (2 ** Z * 256) * 360 - 180
    plat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (py + jj) / (2 ** Z * 256)))))
    ue, un = to_utm.transform(plon.ravel(), plat.ravel())
    de, dn = ue - r.geometry.x, un - r.geometry.y
    d = np.hypot(de, dn).reshape(ii.shape)
    # world offsets: the frame's rotation (world x, z from easting/northing)
    th = math.radians(vlci.FRAME['bearingDeg'])
    wx = r['x'] + de * math.cos(th) - dn * math.sin(th)
    wz = r['z'] - (de * math.sin(th) + dn * math.cos(th))
    _, near = seeds.query(np.c_[wx, wz])
    me = seeds.query([r['x'], r['z']])[1]
    own = (near == me).reshape(ii.shape)
    m = veg & own & (d <= 10)
    lab, _ = ndimage.label(m)
    dd = np.where(m, d, 99.0)
    diam = 0.0
    if dd.min() <= 2.0:
        seed = lab.ravel()[dd.argmin()]
        diam = 2 * math.sqrt((lab == seed).sum() * mpp * mpp / math.pi)
    bi = baked.query([r['x'], r['z']])
    if bi[0] > 0.5:
        continue
    bk = B[bi[1]]
    nb = [dict(x=float(bx[j] - r['x']), z=float(bz[j] - r['z']), kind=kinds[B['k'][j]][0], species=kinds[B['k'][j]][1],
               h=B['h'][j] / 8, crown=B['c'][j] / 8) for j in baked.query_ball_point([r['x'], r['z']], 14)]
    samples.append(dict(objectid=int(r['objectid']), name=r['nom_botani'], x=float(r['x']), z=float(r['z']),
                        ortho_crown=round(diam, 2), baked_crown=bk['c'] / 8, baked_h=bk['h'] / 8,
                        measured=int(bk['f']) & 6, mpp=mpp, neighbours=nb))
json.dump(samples, open(out, 'w'), indent=0)
o = np.array([s['ortho_crown'] for s in samples])
b = np.array([s['baked_crown'] for s in samples])
ok = o > 0
print(f'{len(samples)} samples, {ok.sum()} with an ortho crown; median |baked - ortho| {np.median(np.abs(b[ok] - o[ok])):.2f} m, '
      f'median baked - ortho {np.median(b[ok] - o[ok]):+.2f} m, median ortho {np.median(o[ok]):.2f} m, baked {np.median(b[ok]):.2f} m')
