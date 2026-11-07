"""A landmark's surface from PNOA-LiDAR 2023 (CC BY 4.0 scne.es) on a fine grid, for modelling and checking it:
the highest point above ground (height above the nearest ground points, classes but ground/noise/water) per cell, in
the game's world frame (x east-ish, z south-ish, as GEO.frame turns them), plus the PNOA orthophoto under it.

usage: python -I landmark-lidar.py frame.json lidar_dir out_prefix x z half [cell]
  frame.json  GEO.frame ({lon0, lat0, kx, ky, bearingDeg})
  x z half    the square's centre and half size in world metres; cell (default 0.5) the grid step
writes out_prefix.npz (grid: hag[row = z, col = x], x0, z0, cell) and out_prefix.png (height map, 2 m contours)
"""
import json
import math
import os
import sys

import numpy as np
import pdal
from pyproj import Transformer

frame_path, lidar_dir, out, X, Z, HALF = sys.argv[1:7]
X, Z, HALF = float(X), float(Z), float(HALF)
CELL = float(sys.argv[7]) if len(sys.argv) > 7 else 0.5
fr = json.load(open(frame_path))
TH = math.radians(fr['bearingDeg'])
C, S = math.cos(TH), math.sin(TH)
to_utm = Transformer.from_crs(4326, 25830, always_xy=True)
to_ll = Transformer.from_crs(25830, 4326, always_xy=True)


def w2u(x, z):
    e = x * C - z * S
    n = -x * S - z * C
    return to_utm.transform(fr['lon0'] + e / fr['kx'], fr['lat0'] + n / fr['ky'])


def u2w(ex, ny):
    lon, lat = to_ll.transform(ex, ny)
    e = (lon - fr['lon0']) * fr['kx']
    n = (lat - fr['lat0']) * fr['ky']
    # inverse of e = x C - z S, n = -x S - z C
    return e * C - n * S, -e * S - n * C


corners = [w2u(X + dx, Z + dz) for dx in (-HALF, HALF) for dz in (-HALF, HALF)]
ex0, ex1 = min(c[0] for c in corners) - 2, max(c[0] for c in corners) + 2
ny0, ny1 = min(c[1] for c in corners) - 2, max(c[1] for c in corners) + 2
tiles = set()
for ex in (ex0, ex1):
    for ny in (ny0, ny1):
        tiles.add(os.path.join(lidar_dir, f'PNOA_2023_VAL_{int(ex // 1000)}-{int(ny // 1000) + 1}_H30_NPC02.laz'))
tiles = [t for t in tiles if os.path.exists(t)]
arrs = []
for t in tiles:
    p = pdal.Pipeline(json.dumps({'pipeline': [t, {'type': 'filters.crop', 'bounds': f'([{ex0},{ex1}],[{ny0},{ny1}])'},
                                               {'type': 'filters.hag_nn'}]}))
    p.execute()
    arrs.append(p.arrays[0])
a = np.concatenate(arrs)
keep = ~np.isin(a['Classification'], [7, 9, 18])
a = a[keep]
# world coordinates of every point (linearised: the frame is a rotation + scale near the site)
lon, lat = to_ll.transform(a['X'], a['Y'])
e = (lon - fr['lon0']) * fr['kx']
n = (lat - fr['lat0']) * fr['ky']
wx, wz = e * C - n * S, -e * S - n * C
N = int(round(2 * HALF / CELL))
ix = np.floor((wx - (X - HALF)) / CELL).astype(int)
iz = np.floor((wz - (Z - HALF)) / CELL).astype(int)
ok = (ix >= 0) & (ix < N) & (iz >= 0) & (iz < N)
hag = np.where(a['Classification'] == 2, 0.0, a['HeightAboveGround'])
grid = np.full((N, N), np.nan, np.float32)
np.fmax.at(grid, (iz[ok], ix[ok]), hag[ok].astype(np.float32))
# ground elevation (for absolute checks) and point density
gz = np.full((N, N), np.nan, np.float32)
g = ok & (a['Classification'] == 2)
np.fmax.at(gz, (iz[g], ix[g]), a['Z'][g].astype(np.float32))
np.savez_compressed(out + '.npz', hag=grid, ground=gz, x0=X - HALF, z0=Z - HALF, cell=CELL)

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(9, 9), dpi=110)
ext = [X - HALF, X + HALF, Z + HALF, Z - HALF]
im = ax.imshow(grid, extent=ext, cmap='turbo', vmin=0, vmax=np.nanpercentile(grid, 99.8))
gg = np.nan_to_num(grid)
ax.contour(np.linspace(X - HALF, X + HALF, N), np.linspace(Z - HALF, Z + HALF, N), gg, levels=np.arange(2, 120, 2), colors='k', linewidths=0.25)
ax.set_xlabel('world x (m)'); ax.set_ylabel('world z (m)')
plt.colorbar(im, ax=ax, shrink=0.8, label='height above ground (m)')
ax.set_title(os.path.basename(out))
fig.savefig(out + '.png', bbox_inches='tight')
print(f'{len(a)} points, grid {N}x{N}, max {np.nanmax(grid):.1f} m -> {out}.npz / .png')
