"""Real kerb positions for the street widths of the blocks (tools/bcn-ways.mjs) and the old town's stone lanes
(js/vlc-stone-lanes.js), from the Ajuntament de València's *Cartografia base: Vorades / Bordillos*
(cartografia-base-vorades-bordillos, CC BY 4.0, 1:500 kerb lines), the Catastro's building footprints (facades) and
OpenStreetMap's `surface` tags.

For every OpenStreetMap street in tools/data/bcn_roads.json inside the detailed area, at stations every 3 m along its
segments (clear of the junctions at their ends), a ray is cast square to the street on each side, up to 25 m: the first
kerb line it crosses before a facade is that side's kerb. Per street:
  (a kerb line within 0.8 m of the facade is the foot of the wall, not a sidewalk's edge)
  - kerbed: kerbs found on both sides at >= 40 % of its stations -> the roadway's left & right half widths are the
    medians of those distances (the blocks are stamped from them: real roadway widths, real sidewalks to the facades)
  - shared surface: no kerb on either side at >= 75 % of its stations, facades within 9 m on at least one side at most of
    them (the other side, a garden wall or a gap, keeps the street's rule half width), in the old town (Ciutat Vella) or a pedestrian / living street -> a kerb-free lane from facade to facade
  - otherwise: unmeasured (bcn-ways.mjs keeps its rule widths)
Stone surface: shared lanes, and streets OpenStreetMap tags surface = sett / paving_stones / cobblestone / stone /
unhewn_cobblestone (not footways: those are the sidewalks).

Outputs: tools/data/vlc_kerbs.json {way id: [left half width, right half width, 1 = shared lane]} (read by
tools/bcn-ways.mjs), js/vlc-stone-lanes.js (stone lanes: polylines in world metres with their half widths, and the
paving: 0 setts, 1 stone slabs).
usage: python -I tools/build-kerbs.py
"""
import json
import math
import os
import re
import sys

import geopandas as gpd
import numpy as np
from shapely.geometry import LineString, Point, Polygon
from shapely.strtree import STRtree

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'realism'))
import vlci  # noqa: E402

CATASTRO = os.environ.get('CATASTRO_BUILDINGS', '/private/tmp/claude-501/-Users-mehmetyurtar-Desktop-cdev/'
                          'b4ed1d03-75f5-4134-bab7-22c8cdafb463/scratchpad/catastro/buildings.parquet')
OSM_PBF = os.environ.get('OSM_PBF', '/private/tmp/claude-501/-Users-mehmetyurtar-Desktop-cdev/'
                         'b4ed1d03-75f5-4134-bab7-22c8cdafb463/scratchpad/osm/valencia-region.osm.pbf')
CLASSES = {'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
           'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'pedestrian', 'busway'}
STONE = {'sett': 0, 'cobblestone': 0, 'unhewn_cobblestone': 0, 'paving_stones': 1, 'stone': 1}
# Ciutat Vella's barris (city-config.js BARRIS centres): El Carme, La Seu, La Xerea, El Mercat, Sant Francesc, El Pilar
OLD_TOWN = [(-0.3810, 39.4782), (-0.3752, 39.4757), (-0.3715, 39.4740), (-0.3790, 39.4735), (-0.3765, 39.4695),
            (-0.3830, 39.4722)]
OLD_TOWN_R = 450.0  # m around each centre
STEP, RAY, END_CLEAR = 3.0, 25.0, 6.0

D = vlci.FRAME['detail']
old = [vlci.lonlat_to_world(lon, lat) for lon, lat in OLD_TOWN]


def in_old_town(x, z):
    return any(math.hypot(x - ox, z - oz) < OLD_TOWN_R for ox, oz in old)


# --- inputs --------------------------------------------------------------------------------------------------------
roads = json.load(open(os.path.join(ROOT, 'tools', 'data', 'bcn_roads.json')))['elements']
kerbs = vlci.clip_detail(vlci.add_world(vlci.read('cartografia-base-vorades-bordillos')), margin=60)
kerb_lines = [LineString(r) for rs in kerbs.world if rs for r in rs if len(r) > 1]
kerb_tree = STRtree(kerb_lines)
bld = gpd.read_parquet(CATASTRO).to_crs(25830)
bld = vlci.clip_detail(vlci.add_world(bld), margin=60)
facades = [Polygon(r).exterior for rs in bld.world if rs for r in rs if len(r) > 3]
facade_tree = STRtree(facades)
print(f'{len(roads)} OSM streets, {len(kerb_lines)} kerb lines, {len(facades)} building outlines')

# OSM surface per way id (the extract in tools/data has no surface tag)
surface = {}
try:
    osm = gpd.read_file(OSM_PBF, layer='lines', bbox=(-0.44, 39.42, -0.30, 39.515))
    for oid, tags in zip(osm.osm_id, osm.other_tags):
        if isinstance(tags, str):
            m = re.search(r'"surface"=>"([^"]*)"', tags)
            if m:
                surface[int(oid)] = m.group(1)
except Exception as e:  # noqa: BLE001
    print('no OSM surface tags:', e)


def first_hit(tree, geoms, origin, d, limit):
    ray = LineString([origin, (origin[0] + d[0] * limit, origin[1] + d[1] * limit)])
    best = None
    for i in tree.query(ray):
        inter = geoms[int(i)].intersection(ray)
        if inter.is_empty:
            continue
        pts = [inter] if inter.geom_type == 'Point' else [g for g in getattr(inter, 'geoms', []) if g.geom_type == 'Point']
        if inter.geom_type in ('LineString', 'MultiLineString'):
            pts = [Point(c) for c in inter.coords] if inter.geom_type == 'LineString' else []
        for p in pts:
            dist = math.hypot(p.x - origin[0], p.y - origin[1])
            if dist > 0.3 and (best is None or dist < best):
                best = dist
    return best


out = {}
lanes = []
stats = {'kerbed': 0, 'shared': 0, 'unmeasured': 0}
asym = []
for w in roads:
    t = w['tags']
    if t.get('highway') not in CLASSES or (t.get('tunnel') and t.get('tunnel') != 'no'):
        continue
    pts = [vlci.lonlat_to_world(lon, lat) for lon, lat in w['pts']]
    if not any(D['x0'] <= x <= D['x1'] and D['z0'] <= z <= D['z1'] for x, z in pts):
        continue
    kl, kr, fl, fr = [], [], [], []
    n = 0
    for (ax, az), (bx, bz) in zip(pts, pts[1:]):
        L = math.hypot(bx - ax, bz - az)
        if L < 1:
            continue
        ux, uz = (bx - ax) / L, (bz - az) / L
        rx, rz = -uz, ux  # right of the way's direction (the game's right normal: rx = -dz, rz = dx)
        lo, hi = min(END_CLEAR, L / 2), max(L - END_CLEAR, L / 2)
        for s in np.arange(lo, hi + 1e-6, STEP) if hi > lo else [L / 2]:
            o = (ax + ux * s, az + uz * s)
            n += 1
            for side, ks, fs in ((1, kr, fr), (-1, kl, fl)):
                d = (rx * side, rz * side)
                f = first_hit(facade_tree, facades, o, d, RAY)
                k = first_hit(kerb_tree, kerb_lines, o, d, RAY)
                # a kerb before the facade bounds a sidewalk; one within 0.8 m of it is the foot of the wall
                if k is not None and (f is None or k < f - 0.8):
                    ks.append(k)
                fs.append(f)
    if n == 0:
        continue
    both = sum(1 for _ in range(min(len(kl), len(kr))))
    share_l, share_r = len(kl) / n, len(kr) / n
    mid = [(x, z) for x, z in pts]
    cx, cz = mid[len(mid) // 2]
    town = in_old_town(cx, cz) or t.get('highway') in ('pedestrian', 'living_street')
    fl_ok = [f for f in fl if f is not None and f < 9]
    fr_ok = [f for f in fr if f is not None and f < 9]
    rec = None
    # each side: 'kerb' (a kerb at >= 40 % of the stations), 'wall' (no kerb at > 75 %, a facade within 9 m at >= 60 %)
    def side(share, ks, fs_ok):
        if share >= 0.4:
            return 'kerb', float(np.median(ks))
        if share < 0.25 and len(fs_ok) >= 0.6 * n:
            return 'wall', float(np.median(fs_ok))
        return None, None
    sl, dl = side(share_l, kl, fl_ok)
    sr, dr = side(share_r, kr, fr_ok)
    half = {'pedestrian': 2.5, 'living_street': 2.5, 'residential': 4.0, 'service': 3.0}.get(t.get('highway'), 4.0)
    if sl == 'kerb' and sr == 'kerb' or (sl and sr and 'kerb' in (sl, sr)):
        # kerbs both sides, or a kerb on one and the facade (no sidewalk) on the other
        if 1.0 <= dl + dr <= 60:
            rec = [round(dl, 2), round(dr, 2), 0]
            stats['kerbed'] += 1
            asym.append(abs(dl - dr) / 2)
    elif town and (sl == 'wall' or sr == 'wall') and 'kerb' not in (sl, sr):
        # no kerb at all: facade to facade (a side without facades, a garden wall or a gap, keeps the rule half width)
        rl = dl if sl == 'wall' else half
        rr = dr if sr == 'wall' else half
        if 1.5 <= rl + rr <= 16:
            rec = [round(rl, 2), round(rr, 2), 1]
            stats['shared'] += 1
    if os.environ.get('KERB_DEBUG') == str(w['id']):
        print('debug', w['id'], n, share_l, share_r, len(fl_ok), len(fr_ok), town)
    if rec is None:
        stats['unmeasured'] += 1
    else:
        out[str(w['id'])] = rec
    paving = STONE.get(surface.get(int(w['id'])))
    if rec and rec[2] == 1 and paving is None:
        paving = 0 if in_old_town(cx, cz) else 1
    if paving is not None:
        if rec:
            hl, hr = rec[0], rec[1]
        else:
            hl = hr = {'pedestrian': 2.5, 'living_street': 2.5}.get(t.get('highway'), 4.0)
        lanes.append({'pts': [[round(x, 1), round(z, 1)] for x, z in pts], 'l': hl, 'r': hr, 'p': paving})

json.dump(out, open(os.path.join(ROOT, 'tools', 'data', 'vlc_kerbs.json'), 'w'), separators=(',', ':'))
print(stats, f'median half-offset of the kerbed roadways from the OSM centreline {np.median(asym):.2f} m')
js = ('// Stone-paved lanes of the detailed city, generated by tools/build-kerbs.py: the old town\'s kerb-free lanes\n'
      '// (no kerb in the Ajuntament\'s Bordillos between the facades) and the streets OpenStreetMap tags as setts or\n'
      '// paving stones. pts: centre polyline (world m), l / r: half widths to the left / right, p: 0 setts, 1 slabs.\n'
      '// Sources: Ajuntament de València (Cartografia base: Vorades, CC BY 4.0), Catastro, © OpenStreetMap (ODbL).\n'
      f'export const STONE_LANES = {json.dumps(lanes, separators=(",", ":"))};\n')
open(os.path.join(ROOT, 'js', 'vlc-stone-lanes.js'), 'w').write(js)
print(f'{len(lanes)} stone lanes ({sum(1 for v in out.values() if v[2])} shared), js {len(js)} bytes')
