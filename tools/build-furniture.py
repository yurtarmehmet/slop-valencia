"""js/vlc-furniture.bin.gz: València's street furniture and traffic signs in the detailed city.

Furniture comes from the Ajuntament's inventories (opendata.vlci.valencia.es, CC BY 4.0, all read through
tools/realism/vlci.py so they are pinned in tools/data/vlci-manifest.json), one record per inventoried object at its
surveyed position, the dataset's own model / type field choosing the variant:

  0 waste container   contenidors-residus-solids-contenidores-residuos-solidos   tipo -> lid colour, tipo_carga -> body
  1 glass igloo       contenidors-vidre-contenedores-vidrio                       modelo
  2 litter bin        papereres-papeleras                                         modelo -> shape, fijacion -> mount
  3 bench             bancs-en-via-publica-bancos-en-via-publica                  modelo
  4 bike rack         aparcaments-bicicletes-aparcamientos-bicicletas             tipo, numplazas -> hoops
  5 EMT bus stop      emt                                                         shelter from OSM (see below)
  6 drinking fountain fonts-daigua-publica-fuentes-de-agua-publica
  7 kiosk             quiosc-once-quiosco-once, quioscs-premsa-quioscos-prensa (modelo), quioscs-flors-quioscos-flores
  8 retractable bollard pilons-extraibles-bolardos-extraibles
  9 traffic sign      by rule (the portal has no vertical-signage inventory: CKAN searched for senyalitzacio,
                      senalizacion vertical, señales, senyal...; only Senyalització horitzontal exists)

Documented exclusions: containers of the commercial door-to-door cardboard round (tipo 'PC PaP') that are not street
containers (tipo_carga Manual, Recogida manual, Bolseo or empty: bags and small bins collected at the shop door);
EMT stops marked suprimida.

EMT stops: the emt dataset has no shelter field (gid, id_parada, codvia, numportal, suprimida, denominaci, lineas,
proximas_l). A stop gets a shelter when the nearest OpenStreetMap highway=bus_stop within 25 m has shelter=yes; else a
pole.

Traffic signs (kind 9; variant = SIGNS index below; yaw = the direction the face looks, toward the traffic it is for),
each rule placing the pole at the kerb on the driver's right (the game snaps it onto its kerb at load):
  R1 one-way streets (the game's road graph, OpenStreetMap oneway): at the exit end of every one-way link meeting a
     junction (3+ links) an R-101 (no entry) facing the junction; at its entry end an S-11 (one-way road) facing the
     traffic turning in. Set back from the junction by half the widest crossing street + 2 m.
  R2 zebra crossings: OpenStreetMap highway=crossing nodes on a drivable link (within 10 m of its centreline) that are not signal-controlled
     (crossing=traffic_signals / unmarked / no markings excluded): an S-13 for every direction of travel, on its right.
  R3 stop / give way: OpenStreetMap highway=stop / give_way: an R-2 / R-1 facing the traffic approaching the nearest
     junction along the link it stands on.
  R4 no parking: a link side of 30 m or more with no parking bay (aparcaments-no-regulats, aparcaments-ora) along its
     kerb gets an R-308 a few metres after the junction it starts from, facing the traffic along that side.
  R6 the litter-bin inventory records 1,873 bins fixed to a traffic-sign pole (fijacion SEÑAL): where no sign of the
     rules above stands within 8 m, a sign pole is placed there, with an S-13 if a crossing is within 15 m, else an
     R-308.

Record (8 bytes, little endian): i16 x, i16 z (world, 0.25 m units), u8 kind, u8 variant, u8 yaw (256ths of a turn,
valid when extra bit 7 is set), u8 extra (bit 7: yaw given; bits 0-6: kind-specific: litter bin mount, bike-rack
hoops). File: 'VLF1', u32 count, records sorted by kind then position.
Also writes tools/data/vlc_furniture_counts.json (raw / detailed-area / excluded / baked counts per dataset and the
signs per rule), which tests/furniture.test.mjs checks the file against.

usage: python -I tools/build-furniture.py <valencia .osm.pbf>
"""
import collections
import gzip
import json
import math
import os
import re
import struct
import sys

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'realism'))
import vlci  # noqa: E402

OUT = os.path.join(ROOT, 'js', 'vlc-furniture.bin.gz')
COUNTS = os.path.join(ROOT, 'tools', 'data', 'vlc_furniture_counts.json')
PBF = sys.argv[1] if len(sys.argv) > 1 else None

K_CONTAINER, K_IGLOO, K_BIN, K_BENCH, K_RACK, K_EMT, K_FOUNTAIN, K_KIOSK, K_BOLLARD, K_SIGN = range(10)
# Sign variants (js/vlc-signs.js draws them in this order)
SIGNS = ['R-1', 'R-2', 'R-101', 'R-308', 'S-13', 'S-11']
S_R1, S_R2, S_R101, S_R308, S_S13, S_S11 = range(len(SIGNS))

D = vlci.FRAME['detail']
records = []  # (kind, variant, x, z, yaw or None, extra)
counts = {}


def load(ds):
    g = vlci.add_world(vlci.read(ds))
    raw = len(g)
    g = vlci.clip_detail(g)
    g = g[np.isfinite(g.x) & np.isfinite(g.z)]
    return g, raw


def norm(s):
    return (s if isinstance(s, str) else '').strip().upper()


def add(kind, variant, x, z, yaw=None, extra=0):
    records.append((kind, variant, float(x), float(z), yaw, extra))


# --- Furniture --------------------------------------------------------------------------------------------------------
# 0. Waste containers: lid colour by fraction (València: grey rest, blue paper, yellow packaging, brown organic),
#    body by how the lorry lifts it: side-loaded 3,200 l (Lateral), rear-loaded 4-wheel (Trasera), underground bin post
FRACTION = {'RESTO': 0, 'PAPEL / CARTON': 1, 'ENVASES LIGEROS': 2, 'ORGANICO': 3, 'PC PAP': 1}
g, raw = load('contenidors-residus-solids-contenidores-residuos-solidos')
excl = 0
for t, carga, modelo, x, z in zip(g.tipo, g.tipo_carga, g.modelo, g.x, g.z):
    t, carga = norm(t), norm(carga)
    if t == 'PC PAP' and carga in ('MANUAL', 'RECOGIDA MANUAL', 'BOLSEO', ''):
        excl += 1
        continue
    body = 2 if 'SOTERRA' in norm(modelo) else 1 if carga == 'TRASERA' else 0
    add(K_CONTAINER, body * 4 + FRACTION.get(t, 0), x, z)
counts['contenidors-residus-solids-contenidores-residuos-solidos'] = dict(raw=raw, detail=len(g), excluded=excl,
    exclusion="tipo 'PC PaP' collected by hand or in bags (tipo_carga Manual, Recogida manual, Bolseo, empty)")

# 1. Glass igloos
IGLOO = {'CONT009': 0, 'CONT010': 1}
g, raw = load('contenidors-vidre-contenedores-vidrio')
for m, x, z in zip(g.modelo, g.x, g.z):
    add(K_IGLOO, IGLOO.get(norm(m), 0), x, z)
counts['contenidors-vidre-contenedores-vidrio'] = dict(raw=raw, detail=len(g), excluded=0)

# 2. Litter bins: shape by model, mount by fixing
def bin_shape(m):
    m = norm(m)
    if 'GM_VERDE' in m:
        return 1  # 50 l green, hung on a post
    if 'PL_ENVASES' in m:
        return 2  # 50 l yellow plastic
    if m.startswith(('120_LTS', '80_LTS', 'ATRIUM')):
        return 3  # big standing bin
    if m.startswith(('SALAMANCA', 'CESTA')):
        return 4  # cast-iron basket on a pedestal
    if m.startswith('HAMBURGER'):
        return 5  # steel basket between two posts
    return 0  # 50 l grey steel cylinder hung on a post (50_LTS_N4 and the rest)


def bin_mount(f):
    f = norm(f)
    if f.startswith('SUELO'):
        return 1
    if f.startswith('SE') and 'AL' in f:  # SEÑAL (mis-encoded in the dump as SEÇ?AL)
        return 2
    if f.startswith('SEMAFORO'):
        return 3
    if f.startswith('FAROLA'):
        return 4
    if f.startswith('MURO'):
        return 5
    return 0  # POSTE: its own post


g, raw = load('papereres-papeleras')
sign_pole_bins = []
for m, f, x, z in zip(g.modelo, g.fijacion, g.x, g.z):
    mount = bin_mount(f)
    add(K_BIN, bin_shape(m), x, z, extra=mount)
    if mount == 2:
        sign_pole_bins.append((x, z))
counts['papereres-papeleras'] = dict(raw=raw, detail=len(g), excluded=0, onSignPoles=len(sign_pole_bins))

# 3. Benches
def bench_model(m):
    m = norm(m).replace('Á', 'A')
    if 'SILLA' in m or 'SILLON' in m or 'SILLÓN' in m:
        return 1
    if 'PIEDRA' in m or 'GRANITO' in m:
        return 2
    if 'ROMANTICO' in m:
        return 3
    if 'MADERA' in m or 'RESINA' in m or 'ECOLOGICO' in m or 'TAPONES' in m:
        return 4
    if 'NEOBARCINO' in m:
        return 5
    if 'METAL' in m or m.startswith('MODO'):
        return 6
    return 0  # MEDITERRANEO (the city's standard: wooden slats on cast-iron legs), unknown, OTROS


g, raw = load('bancs-en-via-publica-bancos-en-via-publica')
for m, x, z in zip(g.modelo, g.x, g.z):
    add(K_BENCH, bench_model(m), x, z)
counts['bancs-en-via-publica-bancos-en-via-publica'] = dict(raw=raw, detail=len(g), excluded=0)

# 4. Bike racks: inverted-U hoops (Horquilla), 2 bikes a hoop
g, raw = load('aparcaments-bicicletes-aparcamientos-bicicletas')
for t, n, x, z in zip(g.tipo, g.numplazas, g.x, g.z):
    hoops = max(1, min(12, round((n if n == n else 4) / 2)))
    add(K_RACK, 1 if norm(t).startswith('B') else 0, x, z, extra=hoops)
counts['aparcaments-bicicletes-aparcamientos-bicicletas'] = dict(raw=raw, detail=len(g), excluded=0)

# OpenStreetMap points (crossings, stops, give ways, bus stops) for the EMT shelters and the sign rules
osm = []
if PBF:
    import pyogrio
    lon0, lat0 = -0.44, 39.42
    df = pyogrio.read_dataframe(PBF, layer='points', bbox=(lon0, lat0, -0.30, 39.515),
                                where="highway IN ('crossing','stop','give_way','bus_stop','traffic_signals','traffic_signals;crossing')")
    for hw, other, geom in zip(df.highway, df.other_tags, df.geometry):
        x, z = vlci.lonlat_to_world(geom.x, geom.y)
        if not (D['x0'] - 50 <= x <= D['x1'] + 50 and D['z0'] - 50 <= z <= D['z1'] + 50):
            continue
        tags = dict(re.findall(r'"([^"]+)"=>"([^"]*)"', other)) if isinstance(other, str) else {}
        osm.append((hw, tags, x, z))
    print(f'{len(osm)} OpenStreetMap points', collections.Counter(o[0] for o in osm))
else:
    print('no .osm.pbf given: no EMT shelters, crossings, stops or give ways from OpenStreetMap')

# 5. EMT stops
g, raw = load('emt')
stops = [(x, z, t.get('shelter')) for hw, t, x, z in osm if hw == 'bus_stop']
SP = np.array([(s[0], s[1]) for s in stops]) if stops else np.zeros((0, 2))
excl = 0
shelters = 0
for sup, x, z in zip(g.suprimida, g.x, g.z):
    if sup not in (0, '0', None) and sup == sup:
        excl += 1
        continue
    shelter = 0
    if len(SP):
        d = np.hypot(SP[:, 0] - x, SP[:, 1] - z)
        i = int(d.argmin())
        shelter = 1 if d[i] < 25 and stops[i][2] == 'yes' else 0
    shelters += shelter
    add(K_EMT, shelter, x, z)
counts['emt'] = dict(raw=raw, detail=len(g), excluded=excl, exclusion='suprimida', shelters=shelters)

# 6. Drinking fountains
g, raw = load('fonts-daigua-publica-fuentes-de-agua-publica')
for x, z in zip(g.x, g.z):
    add(K_FOUNTAIN, 0, x, z)
counts['fonts-daigua-publica-fuentes-de-agua-publica'] = dict(raw=raw, detail=len(g), excluded=0)

# 7. Kiosks: 0 ONCE (plain booth, no logo), 1 / 2 newspaper (Albufera, Túria models), 3 flowers
g, raw = load('quiosc-once-quiosco-once')
for x, z in zip(g.x, g.z):
    add(K_KIOSK, 0, x, z)
counts['quiosc-once-quiosco-once'] = dict(raw=raw, detail=len(g), excluded=0)
g, raw = load('quioscs-premsa-quioscos-prensa')
for m, x, z in zip(g.modelo, g.x, g.z):
    add(K_KIOSK, 2 if norm(m) == 'TURIA' else 1, x, z)
counts['quioscs-premsa-quioscos-prensa'] = dict(raw=raw, detail=len(g), excluded=0)
g, raw = load('quioscs-flors-quioscos-flores')
for x, z in zip(g.x, g.z):
    add(K_KIOSK, 3, x, z)
counts['quioscs-flors-quioscos-flores'] = dict(raw=raw, detail=len(g), excluded=0)

# 8. Retractable bollards
g, raw = load('pilons-extraibles-bolardos-extraibles')
for x, z in zip(g.x, g.z):
    add(K_BOLLARD, 0, x, z)
counts['pilons-extraibles-bolardos-extraibles'] = dict(raw=raw, detail=len(g), excluded=0)

# --- Traffic signs ----------------------------------------------------------------------------------------------------
src = open(os.path.join(ROOT, 'js', 'bcn-geodata.js'), encoding='utf8').read()
GEO = json.loads(src[src.index('export const GEO = ') + 19:src.rindex(';')])
RG = GEO['roadGraph']
NODES = np.array(RG['nodes'], dtype=float).reshape(-1, 2)
LINKS = []
for a, b, name, w, lanes, direction, inner, *_ in RG['links']:
    pts = np.vstack([NODES[a], np.array(inner, dtype=float).reshape(-1, 2), NODES[b]])
    seg = np.diff(pts, axis=0)
    L = np.hypot(seg[:, 0], seg[:, 1])
    LINKS.append(dict(a=a, b=b, w=float(w), dir=direction, pts=pts, cum=np.r_[0, np.cumsum(L)], len=float(L.sum())))
degree = collections.Counter()
at_node = collections.defaultdict(list)
for i, l in enumerate(LINKS):
    for n in (l['a'], l['b']):
        degree[n] += 1
        at_node[n].append(i)

# segment grid for nearest-link queries
CELL = 25.0
seg_grid = collections.defaultdict(list)
for i, l in enumerate(LINKS):
    p = l['pts']
    for j in range(len(p) - 1):
        x0, z0 = np.minimum(p[j], p[j + 1]) - 12
        x1, z1 = np.maximum(p[j], p[j + 1]) + 12
        for ix in range(int(x0 // CELL), int(x1 // CELL) + 1):
            for iz in range(int(z0 // CELL), int(z1 // CELL) + 1):
                seg_grid[(ix, iz)].append((i, j))


def nearest_link(x, z, maxd):
    best = None
    for i, j in seg_grid.get((int(x // CELL), int(z // CELL)), ()):
        p = LINKS[i]['pts']
        a, b = p[j], p[j + 1]
        d = b - a
        L2 = d @ d or 1.0
        t = max(0.0, min(1.0, ((x - a[0]) * d[0] + (z - a[1]) * d[1]) / L2))
        q = a + d * t
        dist = math.hypot(x - q[0], z - q[1])
        if dist < maxd and (best is None or dist < best[0]):
            best = (dist, i, j, t)
    return best


def point_at(l, s):
    """Point & unit tangent (a -> b) at arc length s along link l"""
    s = max(0.0, min(l['len'], s))
    j = min(len(l['pts']) - 2, int(np.searchsorted(l['cum'], s, side='right') - 1))
    a, b = l['pts'][j], l['pts'][j + 1]
    L = l['cum'][j + 1] - l['cum'][j] or 1.0
    t = (s - l['cum'][j]) / L
    d = (b - a) / L
    return a + (b - a) * t, d


def yaw_facing(dx, dz):
    """Sign yaw (256ths) whose face (+z local) looks along (dx, dz)"""
    return int(round(math.atan2(dx, dz) / (2 * math.pi) * 256)) & 255


signs = []  # (variant, x, z, yaw, rule)


def place_sign(variant, px, pz, hx, hz, half_w, rule, side=1):
    """Pole at the kerb on the `side` (1 right, -1 left) of a driver heading (hx, hz), face toward the driver"""
    rx, rz = -hz * side, hx * side  # the driver's right (x east, z south)
    off = half_w + 0.4
    signs.append((variant, px + rx * off, pz + rz * off, yaw_facing(-hx, -hz), rule))


def setback(node, own):
    w = max([LINKS[k]['w'] for k in at_node[node] if k != own] or [8.0])
    return w / 2 + 2.0


# R1 one-way streets
for i, l in enumerate(LINKS):
    if l['dir'] == 0 or l['len'] < 12:
        continue
    u, v = (l['a'], l['b']) if l['dir'] == 1 else (l['b'], l['a'])
    sv = min(setback(v, i), l['len'] * 0.4)
    su = min(setback(u, i), l['len'] * 0.4)
    if degree[v] >= 3:  # exit end: no entry for whoever turns in from v
        p, d = point_at(l, l['len'] - sv if l['dir'] == 1 else sv)
        h = -d if l['dir'] == 1 else d  # heading of the would-be wrong-way driver (v -> u)
        place_sign(S_R101, p[0], p[1], h[0], h[1], l['w'] / 2, 'R1')
        if l['w'] >= 12:
            place_sign(S_R101, p[0], p[1], h[0], h[1], l['w'] / 2, 'R1', side=-1)
    if degree[u] >= 3:  # entry end: one-way road for the traffic turning in at u
        p, d = point_at(l, su if l['dir'] == 1 else l['len'] - su)
        h = d if l['dir'] == 1 else -d
        place_sign(S_S11, p[0], p[1], h[0], h[1], l['w'] / 2, 'R1')

# R2 zebra crossings & R3 stop / give way
crossing_pts = []
for hw, t, x, z in osm:
    if hw == 'crossing':
        if t.get('crossing') in ('traffic_signals', 'unmarked', 'no') or t.get('crossing:markings') == 'no':
            continue
        crossing_pts.append((x, z))
        near = nearest_link(x, z, 10.0)  # crossings on wide roads lie off the centreline
        if not near:
            continue
        _, i, j, tt = near
        l = LINKS[i]
        a, b = l['pts'][j], l['pts'][j + 1]
        d = (b - a) / (np.hypot(*(b - a)) or 1.0)
        dirs = [1, -1] if l['dir'] == 0 else [l['dir']]
        for s in dirs:
            place_sign(S_S13, x, z, d[0] * s, d[1] * s, l['w'] / 2, 'R2')
    elif hw in ('stop', 'give_way'):
        near = nearest_link(x, z, 8.0)
        if not near:
            continue
        _, i, j, tt = near
        l = LINKS[i]
        s_here = l['cum'][j] + tt * (l['cum'][j + 1] - l['cum'][j])
        # approaching the nearer junction end of the link (respecting one-way travel)
        to_b = (l['len'] - s_here) < s_here
        if l['dir'] == 1:
            to_b = True
        elif l['dir'] == -1:
            to_b = False
        _, d = point_at(l, s_here)
        h = d if to_b else -d
        place_sign(S_R2 if hw == 'stop' else S_R1, x, z, h[0], h[1], l['w'] / 2, 'R3')

# R4 no parking where the kerb has no bays
from shapely import STRtree  # noqa: E402
from shapely.geometry import Point  # noqa: E402
bays = []
for ds in ('aparcaments-no-regulats-aparcamientos-no-regulados', 'aparcaments-ora-aparcamientos-ora'):
    gb = vlci.read(ds)
    gb = gb[gb.geometry.notna()]
    bays.append(gb)
import pandas as pd  # noqa: E402
bay_geoms = pd.concat([b.geometry for b in bays]).to_crs(4326)
# bay vertices in world coordinates, reduced to midpoints (dense enough: bays are a few metres long)
mids = []
for geom in bay_geoms:
    c = geom.interpolate(0.5, normalized=True)
    x, z = vlci.lonlat_to_world(c.x, c.y)
    if D['x0'] - 60 <= x <= D['x1'] + 60 and D['z0'] - 60 <= z <= D['z1'] + 60:
        mids.append((x, z))
from scipy.spatial import cKDTree  # noqa: E402
bay_tree = cKDTree(np.array(mids))
print(f'{len(mids)} parking bays in the detailed area')
r4 = 0
for i, l in enumerate(LINKS):
    if l['len'] < 30 or l['w'] < 5:
        continue
    pts_mid = [point_at(l, s) for s in np.linspace(l['len'] * 0.25, l['len'] * 0.75, 4)]
    for side in (1, -1):
        has_bay = False
        for p, d in pts_mid:
            rx, rz = -d[1] * side, d[0] * side
            for off in (l['w'] / 2 - 1.2, l['w'] / 2 - 3.5):
                if off < 0.5:
                    continue
                if bay_tree.query_ball_point([p[0] + rx * off, p[1] + rz * off], 3.5):
                    has_bay = True
                    break
            if has_bay:
                break
        if has_bay:
            continue
        # traffic along this side: a -> b on the right side of a -> b; b -> a on its left (two-way); one-way: its way
        heading_ab = (side == 1) if l['dir'] == 0 else (l['dir'] == 1)
        start = l['a'] if heading_ab else l['b']
        sb = min(setback(start, i) + 3.0, l['len'] * 0.4)
        p, d = point_at(l, sb if heading_ab else l['len'] - sb)
        h = d if heading_ab else -d
        # which side of the driver the kerb is on
        kerb_side = 1 if (side == 1) == heading_ab else -1
        place_sign(S_R308, p[0], p[1], h[0], h[1], l['w'] / 2, 'R4', side=kerb_side)
        r4 += 1

# R6 sign poles from the litter-bin inventory (bins fixed to a traffic-sign pole)
sign_tree = cKDTree(np.array([(s[1], s[2]) for s in signs])) if signs else None
cross_tree = cKDTree(np.array(crossing_pts)) if crossing_pts else None
for x, z in sign_pole_bins:
    if sign_tree is not None and sign_tree.query_ball_point([x, z], 8.0):
        continue
    near = nearest_link(x, z, 20.0)
    variant = S_S13 if cross_tree is not None and cross_tree.query_ball_point([x, z], 15.0) else S_R308
    if near:
        _, i, j, _t = near
        l = LINKS[i]
        a, b = l['pts'][j], l['pts'][j + 1]
        d = (b - a) / (np.hypot(*(b - a)) or 1.0)
        # face the traffic that has this kerb on its right: the side of the link the bin is on
        on_right = (x - a[0]) * -d[1] + (z - a[1]) * d[0] > 0
        h = d if on_right else -d
        if l['dir'] != 0:
            h = d if l['dir'] == 1 else -d
        signs.append((variant, x, z, yaw_facing(-h[0], -h[1]), 'R6'))
    else:
        signs.append((variant, x, z, 0, 'R6'))

# keep signs inside the detailed area; drop same-type duplicates within 3 m facing the same way
kept = []
grid = collections.defaultdict(list)
for v, x, z, yaw, rule in signs:
    if not (D['x0'] <= x <= D['x1'] and D['z0'] <= z <= D['z1']):
        continue
    key = (int(x // 4), int(z // 4))
    dup = False
    for kx in (key[0] - 1, key[0], key[0] + 1):
        for kz in (key[1] - 1, key[1], key[1] + 1):
            for v2, x2, z2, y2 in grid.get((kx, kz), ()):
                if v2 == v and math.hypot(x2 - x, z2 - z) < 3.0 and min((yaw - y2) & 255, (y2 - yaw) & 255) < 32:
                    dup = True
    if dup:
        continue
    grid[key].append((v, x, z, yaw))
    kept.append((v, x, z, yaw, rule))
for v, x, z, yaw, rule in kept:
    add(K_SIGN, v, x, z, yaw=yaw)
counts['signs'] = dict(total=len(kept), byRule=dict(collections.Counter(s[4] for s in kept)),
                       byType={SIGNS[k]: n for k, n in sorted(collections.Counter(s[0] for s in kept).items())})

# --- Write -------------------------------------------------------------------------------------------------------------
records.sort(key=lambda r: (r[0], round(r[3] / 64), r[2]))
buf = bytearray(b'VLF1' + struct.pack('<I', len(records)))
by_kind = collections.Counter()
for kind, variant, x, z, yaw, extra in records:
    has = yaw is not None
    buf += struct.pack('<hhBBBB', round(x * 4), round(z * 4), kind, variant, (yaw or 0) & 255, (extra & 127) | (128 if has else 0))
    by_kind[kind] += 1
data = gzip.compress(bytes(buf), 9, mtime=0)
open(OUT, 'wb').write(data)
counts['baked'] = {str(k): n for k, n in sorted(by_kind.items())}
counts['signTypes'] = SIGNS
json.dump(counts, open(COUNTS, 'w'), indent=1, ensure_ascii=False)
print(json.dumps(counts, indent=1, ensure_ascii=False))
print(f'wrote {OUT}: {len(records)} records, {len(data)} bytes gzipped')
