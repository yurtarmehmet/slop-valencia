"""Measured height and crown diameter of every inventory tree from PNOA-LiDAR 2023 (CNIG, CC BY 4.0), to scale the
game's trees (build-trees.py) and to check them.

1. Per LiDAR tile, a canopy height model (cached in .cache/lidar-chm/<tile>.npy, uint16 cm on a 0.5 m grid):
   ground = class 2 grid minimum at 1 m (gaps filled from the nearest ground cell), CHM = maximum height above
   ground of the vegetation points (classes 3-5), single empty cells closed.
2. Per living inventory tree (stumps, missing trees and shrubs are not seeds): height = CHM maximum within 2.0 m of
   the surveyed point, inside the tree's own Voronoi cell among the living trees; crown = the CHM cells
   >= max(1.5 m, 0.4 x height) within 10 m in that Voronoi cell, the connected part touching the cell nearest the
   point; crown diameter = 2 sqrt(area / pi). Rows of touching crowns are split half-way between trees, which is what
   the eye sees from the street too.

usage: python -I tree-lidar.py out.csv tile.laz [tile.laz ...]   (trees in the tiles given; tiles' neighbours used
       for the halo when they are in the list)
"""
import csv
import os
import re
import sys

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vlci  # noqa: E402

CELL = 0.5
N = int(1000 / CELL)
CACHE = os.path.join(vlci.ROOT, '.cache', 'lidar-chm')
DEAD = {'Falta', 'Tocón', 'Tocon', ''}


def tile_key(path):
    m = re.search(r'_(\d{3})-(\d{4})_', os.path.basename(path))
    return int(m[1]), int(m[2])  # E km of the west edge, N km of the north edge


def chm_tile(path):
    e, n = tile_key(path)
    os.makedirs(CACHE, exist_ok=True)
    out = os.path.join(CACHE, f'{e}-{n}.npy')
    if os.path.exists(out):
        return np.load(out)
    import pdal
    p = pdal.Pipeline(f'[{{"type":"readers.las","filename":"{path}"}}]')
    p.execute()
    a = p.arrays[0]
    x0, y0 = e * 1000.0, (n - 1) * 1000.0
    cls = a['Classification']
    gr = cls == 2
    gi = (a['X'][gr] - x0).astype(int).clip(0, 999)
    gj = (a['Y'][gr] - y0).astype(int).clip(0, 999)
    dtm = np.full((1000, 1000), np.inf)
    np.minimum.at(dtm, (gj, gi), a['Z'][gr])
    idx = ndimage.distance_transform_edt(~np.isfinite(dtm), return_distances=False, return_indices=True)
    dtm = dtm[tuple(idx)]
    veg = (cls >= 3) & (cls <= 5)
    vx, vy, vz = a['X'][veg], a['Y'][veg], a['Z'][veg]
    hag = vz - dtm[(vy - y0).astype(int).clip(0, 999), (vx - x0).astype(int).clip(0, 999)]
    ci = ((vx - x0) / CELL).astype(int).clip(0, N - 1)
    cj = ((vy - y0) / CELL).astype(int).clip(0, N - 1)
    chm = np.zeros((N, N))
    np.maximum.at(chm, (cj, ci), np.clip(hag, 0, 60))
    chm = ndimage.grey_closing(chm, size=(3, 3))
    chm = (chm * 100).astype(np.uint16)
    np.save(out, chm)
    return chm


def main():
    out, *tiles = sys.argv[1:]
    by_key = {tile_key(t): t for t in tiles}
    g = vlci.read('arbratge-arbolado')
    g = g[g.geometry.notna()].reset_index(drop=True)
    genus = g['nom_botani'].fillna('').str.split(' ').str[0]
    live = ~genus.isin(DEAD) & ~g['grupo'].fillna('').str.startswith('Arbusto')
    TX, TY = g.geometry.x.to_numpy(), g.geometry.y.to_numpy()
    LI = np.where(live)[0]
    seeds = cKDTree(np.c_[TX[LI], TY[LI]])
    F = ['nom_botani', 'grupo', 'altura', 'copa', 'cruz', 'perimetro', 'tipo_situa', 'ubicación']
    H = 24  # halo cells (12 m)
    R = int(10 / CELL)
    rows = []
    for (e, n), path in sorted(by_key.items()):
        # the tile with a 12 m halo from its neighbours (zeros where a neighbour is missing)
        big = np.zeros((N + 2 * H, N + 2 * H), dtype=np.float32)
        for de in (-1, 0, 1):
            for dn in (-1, 0, 1):
                k = (e + de, n + dn)
                if k not in by_key:
                    continue
                t = chm_tile(by_key[k]) / 100.0
                # tile rows go north (j up); neighbour dn=+1 lies north
                js, is_ = H + dn * N, H + de * N
                j0, j1 = max(0, js), min(big.shape[0], js + N)
                i0, i1 = max(0, is_), min(big.shape[1], is_ + N)
                big[j0:j1, i0:i1] = t[j0 - js:j1 - js, i0 - is_:i1 - is_]
        x0, y0 = e * 1000.0 - H * CELL, (n - 1) * 1000.0 - H * CELL
        sel = LI[(TX[LI] >= e * 1000) & (TX[LI] < e * 1000 + 1000) & (TY[LI] >= (n - 1) * 1000) & (TY[LI] < n * 1000)]
        jj, ii = np.mgrid[-R:R + 1, -R:R + 1]
        for k in sel:
            cx, cy = (TX[k] - x0) / CELL, (TY[k] - y0) / CELL
            i0, j0 = int(cx), int(cy)
            win = big[j0 - R:j0 + R + 1, i0 - R:i0 + R + 1]
            wx = x0 + (ii + i0 + 0.5) * CELL
            wy = y0 + (jj + j0 + 0.5) * CELL
            d = np.hypot(wx - TX[k], wy - TY[k])
            _, near = seeds.query(np.c_[wx.ravel(), wy.ravel()])
            own = (LI[near].reshape(wx.shape) == k)
            core = own & (d <= 2.0)
            core[R, R] = True
            h = float(win[core].max())
            diam = 0.0
            if h >= 1.5:
                m = (win >= max(1.5, 0.4 * h)) & own & (d <= 10)
                lab, _ = ndimage.label(m)
                dd = np.where(m, d, 99.0)
                if dd.min() <= 2.0:
                    seed = lab.ravel()[dd.argmin()]
                    diam = 2 * np.sqrt((lab == seed).sum() * CELL * CELL / np.pi)
            r = g.iloc[k]
            rows.append([int(r['objectid']), round(TX[k], 2), round(TY[k], 2), round(h, 2), round(diam, 2)] + [r[f] for f in F])
        print(f'{e}-{n}', len(sel), 'trees', flush=True)
    with open(out, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['objectid', 'e', 'n', 'lidar_h', 'lidar_crown'] + F)
        w.writerows(rows)
    print(len(rows), 'trees measured')


main()
