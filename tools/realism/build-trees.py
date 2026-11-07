"""js/vlc-trees.bin.gz from the municipal tree inventory (Ajuntament de València, Arbratge / Arbolado, CC BY 4.0,
dataset 'arbratge-arbolado' via vlci.py) and the trees' sizes measured in PNOA-LiDAR 2023 (tree-lidar.py).

Every living tree in the detailed city (stumps, missing trees and shrubs left out), with
- kind: its genus (or species where the game draws them differently: Phoenix canariensis / dactylifera, the
  purple-leaved Prunus cerasifera) -> foliage tint in trees.js; archetype: the geometry trees.js grows for it
  (0 plane, 1 feathery, 2 broad evergreen, 3 fan palm, 4 bitter orange, 5 canary palm, 6 date palm, 7 pine, 8 cypress)
- height and crown diameter: the LiDAR measurement where it agrees with the inventory's class (altura, copa: a tree
  under a bigger neighbour's crown, or planted since 2023, measures wrong); otherwise the median accepted LiDAR value
  for its kind and class (then its archetype and class, then the class alone)
- flags: 1 in a pit in the pavement, 2 height measured, 4 crown measured

VLT2 (gzipped): 'VLT2', u32 count, u16 n, n bytes of JSON [[kind, archetype], ...], then 8-byte records
[i16 x, i16 z (world, 0.25 m units), u8 kind, u8 height x 8, u8 crown x 8, u8 flags], sorted by z then x.
usage: python -I build-trees.py lidar.csv out.bin.gz [stats.json]
"""
import csv
import gzip
import json
import os
import struct
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vlci  # noqa: E402

DEAD = {'Falta', 'Tocón', 'Tocon', ''}
ARCH = {}
for a, names in {
    0: 'Platanus Acer Populus Tilia Fraxinus Ulmus Aesculus Liquidambar Catalpa Paulownia Morus Ailanthus Betula Alnus '
       'Salix Juglans Liriodendron Carpinus Zelkova Ginkgo Firmiana',
    1: 'Melia Jacaranda Tipuana Styphnolobium Sophora Gleditsia Robinia Albizia Schinus Grevillea Parkinsonia Acacia '
       'Koelreuteria Ceiba Erythrina Casuarina Tamarix Cassia Senna Delonix Pistacia Spathodea Chorisia Sapindus',
    2: 'Celtis Ficus Ligustrum Quercus Olea Laurus Brachychiton Magnolia Ceratonia Pittosporum Lagunaria Cercis Bauhinia '
       'Pyrus Prunus Eucalyptus Phytolacca Hibiscus Lagerstroemia Photinia Myoporum Metrosideros Punica Eriobotrya '
       'Persea Cinnamomum Arbutus Melaleuca Callistemon Ilex Viburnum Nerium Malus Citharexylum Schefflera Tecoma',
    3: 'Washingtonia Trachycarpus Chamaerops Livistona Brahea Sabal Bismarckia',
    4: 'Citrus Fortunella',
    6: 'Phoenix Syagrus Archontophoenix Roystonea Howea Butia Dypsis Cycas',
    7: 'Pinus Cedrus Araucaria Abies Picea',
    8: 'Cupressus Thuja Juniperus Platycladus Chamaecyparis Taxus Calocedrus Cupressocyparis',
}.items():
    for n in names.split():
        ARCH[n] = a
BY_GROUP = {'Caduco': 0, 'Caduca': 0, 'Perenne': 2, 'Conifera': 7, 'Palmacea': 6}
HCLS = {'0/4': (0, 4), '4/8': (4, 8), '8/12': (8, 12), '>12': (12, 40)}
CCLS = {'0/4': (0, 4), '4/8': (4, 8), '8/12': (8, 12), '>12': (12, 30)}
HMID = {'0/4': 3.0, '4/8': 6.5, '8/12': 10.5, '>12': 15.0, None: 6.5}
CMID = {'0/4': 3.0, '4/8': 6.0, '8/12': 9.0, '>12': 12.0, None: 5.0}


def norm(s):
    s = str(s or '').replace(' ', '').replace('m', '').replace(',', '.')
    s = {'0-4': '0/4', '4-8': '4/8', '8-12': '8/12', '>12': '>12'}.get(s, s)
    return s if s in HCLS else None


def kind_of(bot, genus):
    sp = ' '.join(bot.split(' ')[:2])
    if sp in ('Phoenix canariensis', 'Phoenix dactylifera', 'Prunus cerasifera'):
        return sp
    return genus


def main():
    lidar_path, out = sys.argv[1:3]
    stats_path = sys.argv[3] if len(sys.argv) > 3 else None
    g = vlci.clip_detail(vlci.add_world(vlci.read('arbratge-arbolado')))
    raw = len(g)
    bot = g['nom_botani'].fillna('').astype(str)
    genus = bot.str.split(' ').str[0]
    grupo = g['grupo'].fillna('').astype(str)
    keep = ~genus.isin(DEAD) & ~grupo.str.startswith('Arbusto')
    g, bot, genus, grupo = g[keep], bot[keep], genus[keep], grupo[keep]
    lid = {}
    with open(lidar_path) as f:
        for r in csv.DictReader(f):
            lid[int(r['objectid'])] = (float(r['lidar_h']), float(r['lidar_crown']))

    trees = []
    for (_, r), b, ge, gr in zip(g.iterrows(), bot, genus, grupo):
        k = kind_of(b, ge)
        arch = 5 if k == 'Phoenix canariensis' or ge == 'Jubaea' else ARCH.get(ge, BY_GROUP.get(gr, 0))
        hc, cc = norm(r['altura']), norm(r['copa'])
        lh, lc = lid.get(int(r['objectid']), (0.0, 0.0))
        h_ok = lh >= 1.5 and (hc is None or HCLS[hc][0] - 2 <= lh <= HCLS[hc][1] + max(4, HCLS[hc][1] * 0.5))
        c_ok = h_ok and lc >= 1.0 and (cc is None or CCLS[cc][0] - 2 <= lc <= CCLS[cc][1] + 4)
        trees.append(dict(x=r['x'], z=r['z'], kind=k, arch=arch, hc=hc, cc=cc, lh=lh, lc=lc, h_ok=h_ok, c_ok=c_ok,
                          pit=str(r['ubicación'] or '').startswith('Alcorque')))

    # medians of the accepted measurements per (kind | archetype | -, class)
    med = defaultdict(list)
    for t in trees:
        if t['h_ok']:
            for key in (('h', t['kind'], t['hc']), ('h', t['arch'], t['hc']), ('h', None, t['hc'])):
                med[key].append(t['lh'])
        if t['c_ok']:
            for key in (('c', t['kind'], t['cc']), ('c', t['arch'], t['cc']), ('c', None, t['cc']),
                        ('ch', t['kind'], t['hc']), ('ch', t['arch'], t['hc'])):
                med[key].append(t['lc'])
    medv = {k: float(np.median(v)) for k, v in med.items() if len(v) >= 15}

    def pick(kind, keys, default):
        for k in keys:
            if k in medv:
                return medv[k]
        return default

    kinds = {}
    recs = []
    nh = nc = 0
    for t in trees:
        if t['h_ok']:
            h = t['lh']
            nh += 1
        else:
            h = pick('h', [('h', t['kind'], t['hc']), ('h', t['arch'], t['hc']), ('h', None, t['hc'])], HMID[t['hc']])
        if t['c_ok']:
            c = t['lc']
            nc += 1
        elif t['cc'] is not None:
            c = pick('c', [('c', t['kind'], t['cc']), ('c', t['arch'], t['cc']), ('c', None, t['cc'])], CMID[t['cc']])
        else:
            c = pick('c', [('ch', t['kind'], t['hc']), ('ch', t['arch'], t['hc'])], CMID[None])
        t['h'], t['c'] = min(31.8, max(1.5, h)), min(31.8, max(1.0, c))
        kid = kinds.setdefault((t['kind'], t['arch']), len(kinds))
        if kid > 255:
            raise SystemExit('more than 256 kinds')
        t['kid'] = kid
    trees.sort(key=lambda t: (round(t['z'] * 4), round(t['x'] * 4)))
    for t in trees:
        flags = (1 if t['pit'] else 0) | (2 if t['h_ok'] else 0) | (4 if t['c_ok'] else 0)
        recs.append(struct.pack('<hhBBBB', round(t['x'] * 4), round(t['z'] * 4), t['kid'], round(t['h'] * 8), round(t['c'] * 8), flags))
    table = json.dumps([[k, a] for (k, a), _ in sorted(kinds.items(), key=lambda kv: kv[1])], ensure_ascii=False, separators=(',', ':')).encode()
    raw_bytes = b'VLT2' + struct.pack('<IH', len(recs), len(table)) + table + b''.join(recs)
    with gzip.GzipFile(out, 'wb', compresslevel=9, mtime=0) as fh:
        fh.write(raw_bytes)
    by_arch = defaultdict(int)
    for t in trees:
        by_arch[t['arch']] += 1
    st = {'inventory_in_detail': raw, 'trees': len(recs), 'excluded': raw - len(recs), 'kinds': len(kinds),
          'height_lidar': nh, 'crown_lidar': nc, 'by_archetype': dict(sorted(by_arch.items())),
          'median_h': float(np.median([t['h'] for t in trees])), 'median_crown': float(np.median([t['c'] for t in trees])),
          'gz_bytes': os.path.getsize(out)}
    print(json.dumps(st))
    if stats_path:
        json.dump(st, open(stats_path, 'w'), indent=1)


main()
