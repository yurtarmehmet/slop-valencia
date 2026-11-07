"""Roof colours from the PNOA orthophoto (IGN WMTS pnoa-ma, CC BY 4.0 scne.es) for every real-building box.

Reads js/vlc-buildings.bin.gz (VLB2, from build-buildings.py), fetches the orthophoto tiles over the detailed city at
z17 (~0.9 m/px here) into a cache, and for each box takes the mean colour of the brighter half of the orthophoto pixels
on its roof (the darker half is shadow: the neighbours', the parapet's, the roof house's), its outline pulled in by a
pixel. Writes VLB3: VLB2 plus a section of sRGB roof colours, u8 [r, g, b] per box (0, 0, 0 when unknown).

usage: python -I roof-colors.py engine.json vlc-buildings.bin.gz tile_cache_dir out.bin.gz [overlay.jpg]
"""
import concurrent.futures as cf
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
import rasterio.features
from affine import Affine
from PIL import Image
from shapely.geometry import Polygon

engine_path, bin_path, cache, out_path = sys.argv[1:5]
os.makedirs(cache, exist_ok=True)
Z = 17
fr = json.load(open(engine_path))['frame']
TH = math.radians(fr['bearingDeg'])
C, S = math.cos(TH), math.sin(TH)
UA = {'User-Agent': 'slop-valencia-roof-colours/0.1 (hobby open-source project)'}


def world_to_lonlat(x, z):
    e = x * C - z * S
    n = -x * S - z * C
    return fr['lon0'] + e / fr['kx'], fr['lat0'] + n / fr['ky']


def lonlat_to_px(lon, lat):
    n = 256 * 2 ** Z
    lat_r = np.radians(lat)
    return (lon + 180) / 360 * n, (1 - np.log(np.tan(lat_r) + 1 / np.cos(lat_r)) / math.pi) / 2 * n


# --- the boxes in world coordinates ----------------------------------------------------------------------------------
raw = gzip.open(bin_path).read()
assert raw[:4] == b'VLB2', 'expects VLB2 from build-buildings.py'
nb, nx, nh = struct.unpack('<III', raw[4:16])
lens = struct.unpack('<9I', raw[16:52])
at = 52
sec = []
for L in lens:
    sec.append(raw[at:at + L])
    at += L
frames = np.frombuffer(sec[0], '<f4').reshape(-1, 3)[:nb]
counts = np.frombuffer(sec[2], '<u2')[:nb]
boxes = np.frombuffer(sec[3], '<i2').reshape(-1, 5)[:nx] / 10.0
corners = np.zeros((nx, 4, 2))
k = 0
for i in range(nb):
    px, pz, th = frames[i]
    c, s = math.cos(th), math.sin(th)
    for _ in range(counts[i]):
        x0, x1, z0, z1 = boxes[k, :4]
        loc = np.array([[x0, z0], [x1, z0], [x1, z1], [x0, z1]])
        corners[k, :, 0] = px + c * loc[:, 0] + s * loc[:, 1]
        corners[k, :, 1] = pz - s * loc[:, 0] + c * loc[:, 1]
        k += 1
lon, lat = world_to_lonlat(corners[..., 0], corners[..., 1])
gx, gy = lonlat_to_px(lon, lat)
tx0, tx1 = int(gx.min() // 256) - 1, int(gx.max() // 256) + 1
ty0, ty1 = int(gy.min() // 256) - 1, int(gy.max() // 256) + 1
print(f'{nx:,} boxes over z{Z} tiles x {tx0}-{tx1}, y {ty0}-{ty1} ({(tx1 - tx0 + 1) * (ty1 - ty0 + 1):,} tiles)')

# --- fetch the orthophoto tiles (cached, politely) --------------------------------------------------------------------
URL = ('https://www.ign.es/wmts/pnoa-ma?layer=OI.OrthoimageCoverage&style=default&tilematrixset=GoogleMapsCompatible'
       '&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/jpeg&TileMatrix={z}&TileCol={x}&TileRow={y}')


def fetch(xy):
    x, y = xy
    path = os.path.join(cache, f'{Z}_{x}_{y}.jpg')
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return path
    for attempt in range(4):
        try:
            data = urllib.request.urlopen(urllib.request.Request(URL.format(z=Z, x=x, y=y), headers=UA), timeout=30).read()
            open(path, 'wb').write(data)
            time.sleep(0.05)
            return path
        except Exception:
            time.sleep(2 * (attempt + 1))
    return None


jobs = [(x, y) for y in range(ty0, ty1 + 1) for x in range(tx0, tx1 + 1)]
with cf.ThreadPoolExecutor(4) as ex:
    paths = list(ex.map(fetch, jobs))
missing = sum(p is None for p in paths)
print(f'tiles ready ({missing} failed)')
W, H = (tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256
mosaic = np.zeros((H, W, 3), np.uint8)
for (x, y), p in zip(jobs, paths):
    if p:
        try:
            mosaic[(y - ty0) * 256:(y - ty0 + 1) * 256, (x - tx0) * 256:(x - tx0 + 1) * 256] = np.asarray(Image.open(p).convert('RGB'))
        except Exception:
            pass

# --- per-box roof colour: label raster of the boxes (pulled in a pixel), brighter half's mean ------------------------
shapes = []
for k in range(nx):
    poly = Polygon(np.column_stack([gx[k] - tx0 * 256, gy[k] - ty0 * 256])).buffer(-1.0)
    if not poly.is_empty and poly.area >= 2:
        shapes.append((poly, k + 1))
lab = rasterio.features.rasterize(shapes, out_shape=(H, W), transform=Affine.identity(), fill=0, dtype='int32').ravel()
sel = lab > 0
ids = lab[sel] - 1
rgb = mosaic.reshape(-1, 3)[sel].astype(np.float32)
lum = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
order = np.lexsort((lum, ids))
ids, rgb, lum = ids[order], rgb[order], lum[order]
uniq, start, cnt = np.unique(ids, return_index=True, return_counts=True)
colors = np.zeros((nx, 3), np.uint8)
for u, s0, n in zip(uniq, start, cnt):
    half = rgb[s0 + n // 2:s0 + n] if n >= 4 else rgb[s0:s0 + n]
    colors[u] = np.clip(half.mean(0), 0, 255).astype(np.uint8)
# boxes too small to sample: their building's mean roof colour
k = 0
for i in range(nb):
    sl = slice(k, k + counts[i])
    have = colors[sl].sum(1) > 0
    if have.any() and not have.all():
        colors[sl][~have] = colors[sl][have].mean(0).astype(np.uint8)
    k += counts[i]
known = (colors.sum(1) > 0).mean()
print(f'roof colours for {known:.1%} of boxes; median sRGB {np.median(colors[colors.sum(1) > 0], 0).astype(int)}')

# --- VLB3 ---------------------------------------------------------------------------------------------------------------
pad = lambda b: b + b'\0' * ((-len(b)) % 4)  # noqa: E731
sec.append(pad(colors.tobytes()))
header = struct.pack('<4sIII', b'VLB3', nb, nx, nh) + struct.pack('<10I', *[len(x) for x in sec])
with gzip.open(out_path, 'wb', compresslevel=9) as fh:
    fh.write(header + b''.join(sec))
print(f'wrote {out_path}: {os.path.getsize(out_path) / 1e6:.2f} MB gzipped')
# placement check: the boxes' outlines over the orthophoto around the cathedral (docs: top-down vs orthophoto)
if len(sys.argv) > 5:
    from PIL import ImageDraw
    cx, cy = lonlat_to_px(-0.3755, 39.4755)
    cx, cy = int(cx - tx0 * 256), int(cy - ty0 * 256)
    crop = Image.fromarray(mosaic[cy - 300:cy + 300, cx - 400:cx + 400].copy())
    d = ImageDraw.Draw(crop)
    for k in range(nx):
        xs, ys = gx[k] - tx0 * 256 - (cx - 400), gy[k] - ty0 * 256 - (cy - 300)
        if xs.min() < 0 or ys.min() < 0 or xs.max() > 800 or ys.max() > 600:
            continue
        d.polygon(list(zip(xs, ys)), outline=(255, 230, 0))
    crop.resize((1600, 1200), Image.NEAREST).save(sys.argv[5], quality=88)
