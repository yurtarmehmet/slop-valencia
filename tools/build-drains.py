"""Storm drains (imbornals) of the detailed city for js/vlc-drains.js, from the Ajuntament de València's
*Embornals / Imbornales* (embornals-imbornales, CC BY 4.0), each turned along its nearest kerb line in
*Cartografia base: Vorades / Bordillos* (cartografia-base-vorades-bordillos, CC BY 4.0).

Output js/vlc-drains.bin.gz: VLD3 (gzipped) = magic, u32 count, u32 byte length of the x column, then columns over
the drains in a nearest-neighbour walk: x steps and z steps from the previous drain (world, 0.25 m units, zigzag
LEB128 varints), u8 kind (0 Valencian kerb inlet, 1 small grate, 2 large grate, 3 square, 4 hexagonal), u8 yaw
(256ths of a half turn: a grate looks the same turned 180°).

usage: python -I tools/build-drains.py
"""
import gzip
import math
import os
import struct
import sys

import numpy as np
from shapely.geometry import Point
from shapely.strtree import STRtree

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'realism'))
import vlci  # noqa: E402

KIND = {'IMBORNAL VALENCIA': 0, 'IMBORNAL NO ESTANDAR': 0, 'PEMAP VALENCIA': 0,
        'REJILLA NO ESTANDAR': 1, 'RECTANGULAR': 1, 'OTRO': 1,
        'RECTANGULAR GRANDE': 2, 'CUADRADO': 3, 'HEXAGONAL': 4}

drains = vlci.clip_detail(vlci.add_world(vlci.read('embornals-imbornales')))
kerbs = vlci.clip_detail(vlci.add_world(vlci.read('cartografia-base-vorades-bordillos')), margin=50)
print(len(drains), 'drains in the detailed area;', len(kerbs), 'kerb lines')

# kerb segments in world metres
segs = []
for rings in kerbs.world:
    for ring in rings or []:
        for a, b in zip(ring, ring[1:]):
            if a != b:
                segs.append((a, b))
from shapely.geometry import LineString  # noqa: E402
lines = [LineString(s) for s in segs]
tree = STRtree(lines)

recs = []
turned = 0
for x, z, tipo in zip(drains.x, drains.z, drains.tipo):
    if not (math.isfinite(x) and math.isfinite(z)):
        continue
    k = KIND.get(tipo, 1)
    i = tree.query_nearest(Point(x, z), max_distance=3.0)
    yaw = 0.0
    if len(i):
        (ax, az), (bx, bz) = segs[int(i[0])]
        yaw = math.atan2(bz - az, bx - ax) % math.pi
        turned += 1
    recs.append((int(round(x * 4)), int(round(z * 4)), k, int(round(yaw / math.pi * 256)) % 256))


import importlib.util  # noqa: E402
_spec = importlib.util.spec_from_file_location('build_markings', os.path.join(ROOT, 'tools', 'build-markings.py'))
bm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bm)
recs = bm.nn_order(recs, lambda r: (r[0], r[1]))
xs = np.array([r[0] for r in recs], dtype=np.int64)
zs = np.array([r[1] for r in recs], dtype=np.int64)
cx = bm.varints(np.diff(xs, prepend=0))
cz = bm.varints(np.diff(zs, prepend=0))
buf = (b'VLD3' + struct.pack('<II', len(recs), len(cx)) + cx + cz + np.array([r[2] for r in recs], 'u1').tobytes()
       + np.array([r[3] for r in recs], 'u1').tobytes())
out = os.path.join(ROOT, 'js', 'vlc-drains.bin.gz')
with gzip.GzipFile(out, 'wb', mtime=0, compresslevel=9) as f:
    f.write(buf)
kinds = np.bincount([r[2] for r in recs], minlength=5)
print(f'{len(recs)} drains ({turned} turned along a kerb within 3 m), kinds {kinds.tolist()}, '
      f'{os.path.getsize(out)} bytes gzipped')
