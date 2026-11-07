"""LiDAR top height (above ground) at landmarks with published heights: a check that the ground truth is right."""
import json, sys
import numpy as np, pdal
from pyproj import Transformer
t = Transformer.from_crs(4326, 25830, always_xy=True)
L = {  # name: (lon, lat, radius m, published height m, source of the published figure)
  'el Micalet': (-0.37570, 39.47530, 9, 51.0, 'OSM height tag / commonly cited 51 m'),
  'Torres dels Serrans': (-0.37630, 39.47920, 14, 33.0, 'OSM height tag 33'),
  'Torres de Quart': (-0.38410, 39.47560, 14, 34.0, 'OSM height tag 34'),
  'Torre de Francia': (-0.35260, 39.45980, 16, 115.0, 'OSM height tag 115'),
  'Torres Oceanográficas': (-0.35710, 39.45470, 20, 75.0, 'OSM height tag 75'),
}
lidar_dir = sys.argv[1]
for name, (lo, la, r, pub, src) in L.items():
    x, y = t.transform(lo, la)
    tile = f"{lidar_dir}/PNOA_2023_VAL_{int(x // 1000)}-{int(y // 1000) + 1}_H30_NPC02.laz"
    try:
        p = pdal.Pipeline(json.dumps({'pipeline': [tile, {'type': 'filters.crop', 'point': f'POINT({x} {y})', 'distance': r}, {'type': 'filters.hag_nn'}]}))
        p.execute()
        a = p.arrays[0]
        h = a['HeightAboveGround'][a['Classification'] == 6]
        top = float(np.percentile(h, 99.5)) if h.size else float('nan')
        print(f"{name:24s} lidar p99.5 {top:6.1f} m  published {pub:6.1f} m  diff {100 * (top - pub) / pub:+5.1f}%  ({h.size} pts; {src})")
    except Exception as e:
        print(f"{name:24s} tile {tile.split('/')[-1]} not in sample ({type(e).__name__})")
