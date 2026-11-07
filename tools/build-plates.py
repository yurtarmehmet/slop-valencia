"""Street-name plates & door numbers for the detailed city -> js/vlc-plates.bin.gz (gap #12, docs/fidelity-gaps.md).

Sources (Ajuntament de València open data, CC BY 4.0, all through tools/realism/vlci.py):
  portals-dels-carrers-portales-de-las-calles   every street door: codvia, numportal, dupli_trip (A/B/.. or DUPL),
                                                accesorio (SI: a second door of the same number), angulo
  eixos-lineals-dels-carrers                    street centre lines: codvia, tipcalle (CARRER, AVINGUDA...), nomcalle
                                                (the official Valencian name, inverted: "HIGINIO NOJA (PROFESSOR)")
  cartografia-base-toponimia-toponimia          read and NOT used: its 6,784 points are map labels (crop and land-use
                                                texts, landmarks, barri names), none is a street-name plate (see below)
plus OpenStreetMap street names (tools/data/bcn_roads.json, ODbL) for the particle the plates print between the type and
the name ("CARRER / DE / LA BOATELLA"), and the real buildings (js/vlc-buildings.bin.gz) for the walls.

Placement:
  door numbers   each portal point snapped to the nearest street wall of the real buildings (a box wall classed shop
                 or entry, buildings.js WALL_KINDS) within SNAP_DOOR m, facing the street, centred above the door at
                 DOOR_Y (2.6 m; 3.0 m on buildings before 1920), measured from reference photos & Street View: the
                 number sits on or just above the lintel.
  street plates  rule (no plate dataset exists): at every node of the street axes where two or more named streets meet,
                 for each street and each side of it, the first street wall fronting that street gets a plate near its
                 corner end, at PLATE_Y (centre 3.9 m: 3.3-4.0 m in the Street View captures, above the ground floor and clear
                 of the shop fascias, which end at the ground-floor height - 0.12 m).
Which street a wall fronts: the codvia of the portals snapped to it (majority), else the nearest roughly parallel
street axis in front of it.

usage: python -I tools/build-plates.py [--report]
"""
import gzip
import json
import math
import os
import re
import struct
import sys
import unicodedata
from collections import Counter, defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'realism'))
import vlci  # noqa: E402

import numpy as np  # noqa: E402

PORTALS = 'portals-dels-carrers-portales-de-las-calles'
AXES = 'eixos-lineals-dels-carrers'
TOPONIMIA = 'cartografia-base-toponimia-toponimia'
OUT = os.path.join(ROOT, 'js', 'vlc-plates.bin.gz')

SNAP_DOOR = 8.0  # a portal point may lie this far from its wall (they sit on the facade line, a few in the patio)
DOOR_Y = 2.6
DOOR_Y_OLD = 3.0
PLATE_Y = 3.9
PLATE_EDGE = 0.35  # free wall between the building's corner and the plate
CELL = 25.0


# --- the real buildings: every box wall classed as a street front (shop 0, entry 1) ------------------------------------
def load_buildings():
    raw = gzip.open(os.path.join(ROOT, 'js', 'vlc-buildings.bin.gz')).read()
    magic = raw[:4].decode()
    assert magic in ('VLB2', 'VLB3'), magic
    nsec = 10 if magic == 'VLB3' else 9
    count, nbox, nhouse = struct.unpack_from('<3I', raw, 4)
    lens = struct.unpack_from(f'<{nsec}I', raw, 16)
    at = 16 + nsec * 4
    secs = []
    for ln in lens:
        secs.append(raw[at:at + ln])
        at += ln
    frames = np.frombuffer(secs[0], np.float32)[:count * 3].reshape(-1, 3)
    meta = np.frombuffer(secs[1], np.uint8)[:count * 4].reshape(-1, 4)
    counts = np.frombuffer(secs[2], np.uint16)[:count]
    boxes = np.frombuffer(secs[3], np.int16)[:nbox * 5].reshape(-1, 5).astype(np.float64)
    faces = np.frombuffer(secs[4], np.uint8)[:nbox]
    return frames, meta, counts, boxes, faces


def buildings_hash():
    """FNV-1a over the box array (as int16 values): the plates refer to box walls, so they must be rebuilt whenever
    js/vlc-buildings.bin.gz changes (js/vlc-plates-data.js and tests/plates.test.mjs check it)"""
    frames, meta, counts, boxes, faces = load_buildings()
    v = boxes.astype(np.int64).ravel() & 0xFFFF
    h = 0x811C9DC5
    for x in v.tolist():
        h = ((h ^ x) * 0x01000193) & 0xFFFFFFFF
    return dict(buildings=int(len(frames)), boxes=int(len(boxes)), fnv=h)


def landmark_reserve():
    """buildings.js skips the real buildings whose frame origin lies on a landmark's lot (LANDMARK_RESERVE): same here"""
    src = open(os.path.join(ROOT, 'js', 'bcn-geodata.js'), encoding='utf8').read()
    i = src.find('"landmarks":')
    lm, _ = json.JSONDecoder().raw_decode(src[i + len('"landmarks":'):])
    js = open(os.path.join(ROOT, 'js', 'buildings.js'), encoding='utf8').read()
    m = re.search(r'const LANDMARK_RESERVE = \[(.*?)\]\.map', js, re.S)
    out = []
    for name, margin in re.findall(r"\[(?:'|\")(.+?)(?:'|\"), (\d+)\]", m.group(1)):
        t = lm.get(name.replace("\\'", "'"))
        if not t:
            continue
        mg = float(margin)
        # the bullring reserves its circle's box (city-config.js LANDMARK_CIRCLES); its outline box is close enough
        out.append((t['x'] - t['w'] / 2 - mg, t['x'] + t['w'] / 2 + mg, t['z'] - t['d'] / 2 - mg, t['z'] + t['d'] / 2 + mg))
    return out


def street_walls():
    frames, meta, counts, boxes, faces = load_buildings()
    reserve = landmark_reserve()
    walls = []  # dict per wall
    rects = []  # every box as an oriented rect (cx, cz, hx, hz, cs, sn, building)
    k = 0
    for i in range(len(frames)):
        px, pz, th = (float(v) for v in frames[i])
        n = int(counts[i])
        skip = any(x0 - 1 < px < x1 + 1 and z0 - 1 < pz < z1 + 1 for x0, x1, z0, z1 in reserve)
        cs, sn = math.cos(th), math.sin(th)
        decade = int(meta[i][2])
        year = (decade + 150) * 10 if decade else 0

        def to_world(x, z):
            # buildings.js toWorld: world = p + R(local - p), R maps (x, z) -> (x cos + z sin, -x sin + z cos)
            return px + x * cs + z * sn, pz - x * sn + z * cs

        for kk in range(k, k + n):
            x0, x1, z0, z1, h = boxes[kk] / 10.0
            if skip:
                continue
            h = max(2.5, h)
            cx, cz = to_world((x0 + x1) / 2, (z0 + z1) / 2)
            rects.append((cx, cz, (x1 - x0) / 2, (z1 - z0) / 2, cs, sn, i))
            f = int(faces[kk])
            kinds = [f & 3, (f >> 2) & 3, (f >> 4) & 3, (f >> 6) & 3]
            for side in range(4):
                if kinds[side] > 1:
                    continue
                ax, az, bx, bz, nx, nz = [(x0, z1, x0, z0, -1, 0), (x1, z0, x1, z1, 1, 0),
                                          (x0, z0, x1, z0, 0, -1), (x1, z1, x0, z1, 0, 1)][side]
                wax, waz = to_world(ax, az)
                wbx, wbz = to_world(bx, bz)
                ln = math.hypot(wbx - wax, wbz - waz)
                if ln < 0.8:
                    continue
                walls.append(dict(id=len(walls), ax=wax, az=waz, bx=wbx, bz=wbz, len=ln,
                                  tx=(wbx - wax) / ln, tz=(wbz - waz) / ln,
                                  nx=nx * cs + nz * sn, nz=-nx * sn + nz * cs, h=h, b=i, box=kk, year=year,
                                  ref=kk * 4 + side))
        k += n
    return walls, rects


class Grid:
    def __init__(self, cell=CELL):
        self.cell = cell
        self.g = defaultdict(list)

    def add_seg(self, item, ax, az, bx, bz, pad=0.0):
        c = self.cell
        for i in range(math.floor((min(ax, bx) - pad) / c), math.floor((max(ax, bx) + pad) / c) + 1):
            for j in range(math.floor((min(az, bz) - pad) / c), math.floor((max(az, bz) + pad) / c) + 1):
                self.g[(i, j)].append(item)

    def near(self, x, z, r):
        c = self.cell
        seen = set()
        for i in range(math.floor((x - r) / c), math.floor((x + r) / c) + 1):
            for j in range(math.floor((z - r) / c), math.floor((z + r) / c) + 1):
                for it in self.g.get((i, j), ()):
                    if id(it) not in seen:
                        seen.add(id(it))
                        yield it


def in_other_box(rgrid, x, z, own_building):
    for (cx, cz, hx, hz, cs, sn, b) in rgrid.near(x, z, 0):
        if b == own_building:
            continue
        dx, dz = x - cx, z - cz
        # inverse of toWorld's rotation
        lx, lz = dx * cs - dz * sn, dx * sn + dz * cs
        if abs(lx) < hx - 0.02 and abs(lz) < hz - 0.02:
            return True
    return False


def seg_dist(w, x, z):
    """(distance, t along the wall, n signed distance in front) of point to wall"""
    dx, dz = x - w['ax'], z - w['az']
    t = dx * w['tx'] + dz * w['tz']
    n = dx * w['nx'] + dz * w['nz']
    tc = min(max(t, 0.0), w['len'])
    d = math.hypot(x - (w['ax'] + w['tx'] * tc), z - (w['az'] + w['tz'] * tc))
    return d, t, n


# --- names: type / particle / name, as the plates print them ------------------------------------------------------
TYPES = ['GRAN VIA', 'CAMÍ VELL', 'CAMÍ FONDO', 'CARRER', 'AVINGUDA', 'PLAÇA', 'PASSEIG', 'CAMÍ', 'CARRETERA', 'LLOC',
         'ENTRADOR', 'CARRERA', 'PASSATGE', 'PASSAGE', 'SENDA', 'CARRERÓ', 'BARRI', 'PLACETA', 'TRAVESSIA', 'RONDA',
         'PONT', 'ILLA', 'JARDÍ', 'PARC', 'POLÍGON', 'GLORIETA', 'URBANITZACIÓ', 'PUJADA', 'BAIXADA', 'RACÓ']
# titles and trades take the article: "Carrer del Doctor Serrano", "Carrer del Pintor Sorolla"
TITLES = {'DOCTOR', 'DOCTORA', 'PROFESSOR', 'PROFESSORA', 'PINTOR', 'PINTORA', 'ESCULTOR', 'MESTRE', 'MESTRA', 'COMTE',
          'COMTESSA', 'MARQUÉS', 'MARQUESA', 'DUC', 'DUQUESSA', 'BISBE', 'PARE', 'GENERAL', 'ARQUEBISBE', 'POETA', 'MÚSIC',
          'CARDENAL', 'REI', 'ARQUITECTE', 'ENGINYER', 'CANONGE', 'CAPITÀ', 'CAPITANS', 'ESCRIPTOR', 'ESCRIPTORA',
          'PERIODISTA', 'METGE', 'MILITAR', 'ACTOR', 'ACTRIU', 'GRAVADOR', 'CRONISTA', 'DOCTORS', 'PINTORS', 'GERMANS',
          'MAESTRO', 'BARÓ', 'BARONESSA', 'PRÍNCEP', 'PRESIDENT', 'ALCALDE', 'ALMIRALL', 'BEAT', 'PAPA', 'TINENT',
          'CORONEL', 'COMANDANT', 'SERGENT', 'APÒSTOL', 'ABAT', 'PREVERE', 'MOSSÈN', 'CATEDRÀTIC', 'HISTORIADOR',
          'NOVEL·LISTA', 'COMPOSITOR', 'MESTRES', 'FOTÒGRAF', 'DIBUIXANT', 'ESPORTISTA', 'FUTBOLISTA', 'CICLISTA',
          'FARMACÈUTIC', 'ADVOCAT', 'NOTARI', 'JUTGE', 'ENGINYERA', 'ARQUITECTA', 'POETESSA', 'INFANT', 'INFANTA',
          'ARTISTA', 'TENOR', 'SOPRANO', 'BALLARINA', 'DIRECTOR', 'MONJO', 'FRARE', 'GERMÀ'}
PARTICLES = ['DE LES ', 'DE LA ', "DE L'", 'DELS ', 'DEL ', "D'", 'DE ']


def fold(s):
    s = unicodedata.normalize('NFD', s.upper())
    s = ''.join(ch for ch in s if unicodedata.category(ch) != 'Mn')
    return re.sub(r'[^A-Z0-9]+', ' ', s).strip()


def clean_apos(s):
    return re.sub(r"[´’`‘]", "'", s)


def official_name(nom):
    """-> (name, subtitle): 'HIGINIO NOJA (PROFESSOR)' -> 'PROFESSOR HIGINIO NOJA'; '(LA)' / '(ELS)' articles go first
    too; a longer description in brackets ('(HISTORIADOR DE LA MEDICINA)') is the plate's small line under the name"""
    nom = clean_apos(nom.strip()).upper()
    nom = re.sub(r'L\.L', 'L·L', nom)
    sub = ''
    m = re.match(r'^(.*?)\s*\(([^)]+)\)\s*$', nom)
    if m:
        lead = m.group(2).strip()
        rest = m.group(1).strip()
        if len(lead.split()) > 1 and lead.split()[0] not in ('LA', 'EL', 'ELS', 'LES'):
            nom, sub = rest, lead
        else:
            nom = (lead + rest) if lead.endswith("'") else f'{lead} {rest}'
    return re.sub(r'\s+', ' ', nom), sub


def rule_particle(name):
    """the particle between type and name when OpenStreetMap has no match (Valencian contraction rules)"""
    w = name.split(' ')
    first = w[0]
    if first in ('EL',):
        return 'DEL', ' '.join(w[1:])
    if first in ('ELS',):
        return 'DELS', ' '.join(w[1:])
    if first in ('LA', 'LES') or first.startswith("L'"):
        return 'DE', name
    if first in TITLES:
        return 'DEL', name
    if re.match(r"^H?[AEIOUÀÈÉÍÒÓÚ]", first) and first not in ('UNIÓ', 'IOGURT', 'HUIT'):
        return "D'", name
    return 'DE', name


def split_osm(name):
    """'Carrer de la Boatella' -> ('CARRER', 'DE', 'LA BOATELLA'), or None if it doesn't parse"""
    up = clean_apos(name).upper()
    typ = next((t for t in TYPES if up.startswith(t + ' ')), None)
    if not typ:
        return None
    rest = up[len(typ) + 1:]
    for p in PARTICLES:
        if rest.startswith(p):
            body = rest[len(p):]
            if p == 'DE LA ':
                return typ, 'DE', 'LA ' + body
            if p == 'DE LES ':
                return typ, 'DE', 'LES ' + body
            if p == "DE L'":
                return typ, 'DE', "L'" + body
            return typ, p.strip(), body
    return typ, '', rest


def load_osm_names():
    d = json.load(open(os.path.join(ROOT, 'tools', 'data', 'bcn_roads.json')))
    g = Grid(40.0)
    n = 0
    for e in d['elements']:
        nm = e['tags'].get('name')
        if not nm:
            continue
        pts = [vlci.lonlat_to_world(lon, lat) for lon, lat in e['pts']]
        sp = split_osm(nm)
        if not sp:
            continue
        for (ax, az), (bx, bz) in zip(pts, pts[1:]):
            g.add_seg((nm, sp, ax, az, bx, bz), ax, az, bx, bz)
        n += 1
    return g


def point_seg(x, z, ax, az, bx, bz):
    dx, dz = bx - ax, bz - az
    L2 = dx * dx + dz * dz or 1e-9
    t = max(0.0, min(1.0, ((x - ax) * dx + (z - az) * dz) / L2))
    return math.hypot(x - ax - dx * t, z - az - dz * t), t


def street_labels(axes, osm):
    """codvia -> (type, particle, name) with OpenStreetMap's particle & article where its name matches the official one"""
    out, src = {}, Counter()
    by = defaultdict(list)
    for a in axes:
        by[a['codvia']].append(a)
    for cv, segs in by.items():
        typ = segs[0]['tip']
        name, sub = official_name(segs[0]['nom'])
        if name.startswith('EP '):  # 'EP ...': espais privats (private passages), no city plate
            src['private'] += 1
            continue
        key = set(fold(name).split()) - {'DE', 'DEL', 'DELS', 'LA', 'LES', 'EL', 'ELS', 'L', 'D', 'I'}
        votes = Counter()
        for s in segs:
            for (ax, az), (bx, bz) in zip(s['pts'], s['pts'][1:]):
                mx, mz = (ax + bx) / 2, (az + bz) / 2
                for (nm, sp, oax, oaz, obx, obz) in osm.near(mx, mz, 25):
                    d, _ = point_seg(mx, mz, oax, oaz, obx, obz)
                    if d > 25:
                        continue
                    ok = set(fold(sp[2]).split()) - {'DE', 'DEL', 'DELS', 'LA', 'LES', 'EL', 'ELS', 'L', 'D', 'I'}
                    if key and ok and (key <= ok or ok <= key) and len(key & ok) >= max(1, min(len(key), len(ok))):
                        votes[sp] += 1
        if votes:
            _, part, body = votes.most_common(1)[0][0]
            # the official spelling, with OSM's particle and the article it adds ("NAVARROS" -> "DELS" "NAVARROS",
            # "BOATELLA" -> "DE" "LA BOATELLA")
            m = re.match(r"^(LA |LES |L')", body)
            art = m.group(1) if m and not re.match(r"^(LA |LES |L')", name) else ''
            body = art + name
            if part == 'DE' and not art and name.split(' ')[0] in TITLES:
                part = 'DEL'
            if part == 'DE' and body.startswith('EL '):
                part, body = 'DEL', body[3:]
            elif part == 'DE' and body.startswith('ELS '):
                part, body = 'DELS', body[4:]
            out[cv] = (typ, part, body, sub)
            src['osm'] += 1
        else:
            part, body = rule_particle(name)
            out[cv] = (typ, part, body, sub)
            src['rule'] += 1
    return out, src


def load_axes():
    g = vlci.clip_detail(vlci.add_world(vlci.read(AXES)), margin=200)
    axes = []
    for cv, tip, nom, world in zip(g.codvia, g.tipcalle, g.nomcalle, g.world):
        if cv != cv or not isinstance(nom, str) or not nom.strip() or world is None:
            continue
        for part in world:
            if len(part) >= 2:
                axes.append(dict(codvia=int(cv), tip=tip.strip() if isinstance(tip, str) and tip.strip() else 'CARRER', nom=nom.strip(),
                                 pts=[(float(x), float(z)) for x, z in part]))
    return axes


# --- door numbers -----------------------------------------------------------------------------------------------------
def snap_portals(walls, wgrid, rgrid):
    raw = vlci.add_world(vlci.read(PORTALS))
    p = vlci.clip_detail(raw)
    th = math.radians(vlci.FRAME['bearingDeg'])
    c, s = math.cos(th), math.sin(th)
    doors, excluded = [], Counter()
    for x, z, cv, num, dup, acc, ang in zip(p.x, p.z, p.codvia, p.numportal, p.dupli_trip, p.accesorio, p.angulo):
        best = None
        for w in wgrid.near(x, z, 0):
            d, t, n = seg_dist(w, x, z)
            if d > SNAP_DOOR:
                continue
            score = d
            if ang == ang:
                # angulo: the address label's direction along the street (degrees anticlockwise from grid east, either
                # way along): walls across it are a corner's other street
                e, nn = c * w['tx'] - s * w['tz'], -s * w['tx'] - c * w['tz']
                da = abs((ang - math.degrees(math.atan2(nn, e)) + 90) % 180 - 90)
                score += 0.0 if da < 25 else 4.0
            if best is None or score < best[0]:
                best = (score, w, t)
        if best is None:
            excluded['no street wall within %g m' % SNAP_DOOR] += 1
            continue
        _, w, t = best
        t = min(max(t, 0.12), w['len'] - 0.12)
        px, pz = w['ax'] + w['tx'] * t, w['az'] + w['tz'] * t
        if in_other_box(rgrid, px + w['nx'] * 0.3, pz + w['nz'] * 0.3, w['b']):
            excluded['wall hidden by another building'] += 1
            continue
        suffix = ''
        if isinstance(dup, str) and dup.strip():
            dd = dup.strip().upper()
            suffix = 'DUP' if dd.startswith('DUP') else 'TRIP' if dd.startswith('TRI') else dd[:2]
        w.setdefault('codvias', Counter())[int(cv) if cv == cv else -1] += 1
        y = DOOR_Y_OLD if 0 < w['year'] < 1920 else DOOR_Y
        doors.append(dict(x=px, z=pz, nx=w['nx'], nz=w['nz'], y=y, num=int(num), suffix=suffix, wall=w['id'],
                          ref=w['ref'], t=t,
                          codvia=int(cv) if cv == cv else -1, year=w['year'], b=w['b']))
    return doors, excluded, len(raw), len(p)


# --- street plates at the corners -------------------------------------------------------------------------------------
def assign_streets(walls, axes):
    ag = Grid(40.0)
    for a in axes:
        for (ax, az), (bx, bz) in zip(a['pts'], a['pts'][1:]):
            ag.add_seg((a['codvia'], ax, az, bx, bz), ax, az, bx, bz)
    src = Counter()
    for w in walls:
        if w.get('codvias'):
            cv, n = w['codvias'].most_common(1)[0]
            if cv > 0:
                w['street'] = cv
                src['portals'] += 1
                continue
        mx, mz = (w['ax'] + w['bx']) / 2, (w['az'] + w['bz']) / 2
        best = None
        for (cv, ax, az, bx, bz) in ag.near(mx, mz, 45):
            L = math.hypot(bx - ax, bz - az)
            if L < 1:
                continue
            if abs(((bx - ax) * w['tx'] + (bz - az) * w['tz']) / L) < 0.9:
                continue
            d, t = point_seg(mx, mz, ax, az, bx, bz)
            cx, cz = ax + (bx - ax) * t, az + (bz - az) * t
            n = (cx - mx) * w['nx'] + (cz - mz) * w['nz']
            if n < 0.5 or d > 45 or (0 < t < 1 and False):
                continue
            if best is None or d < best[0]:
                best = (d, cv)
        if best:
            w['street'] = best[1]
            src['axis'] += 1
        else:
            src['none'] += 1
    return src


def axis_nodes(axes):
    """nodes where two or more named streets meet: (x, z, {codvia: [unit directions away from the node]})"""
    ends = []
    for a in axes:
        pts = a['pts']
        for (x, z), path in (((pts[0]), pts), ((pts[-1]), pts[::-1])):
            # direction: towards the point ~8 m along the line
            acc, k = 0.0, 1
            while k < len(path) - 1 and acc + math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]) < 8:
                acc += math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1])
                k += 1
            dx, dz = path[k][0] - x, path[k][1] - z
            L = math.hypot(dx, dz)
            if L < 0.5:
                continue
            ends.append((x, z, a['codvia'], dx / L, dz / L))
    # cluster the ends within 1.5 m
    g = Grid(5.0)
    for i, e in enumerate(ends):
        g.add_seg(i, e[0], e[1], e[0], e[1])
    parent = list(range(len(ends)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i, e in enumerate(ends):
        for j in g.near(e[0], e[1], 1.5):
            if j > i and math.hypot(ends[j][0] - e[0], ends[j][1] - e[1]) < 1.5:
                parent[find(i)] = find(j)
    groups = defaultdict(list)
    for i in range(len(ends)):
        groups[find(i)].append(ends[i])
    nodes = []
    for es in groups.values():
        streets = defaultdict(list)
        for (x, z, cv, dx, dz) in es:
            streets[cv].append((dx, dz))
        if len(streets) < 2:
            continue
        x = sum(e[0] for e in es) / len(es)
        z = sum(e[1] for e in es) / len(es)
        nodes.append((x, z, dict(streets)))
    return nodes


def corner_plates(nodes, walls, wgrid, rgrid):
    plates = []
    taken = defaultdict(list)  # wall id -> [(end, codvia)]
    stats = Counter()
    for (nx0, nz0, streets) in nodes:
        for cv, dirs in streets.items():
            for (dx, dz) in dirs:
                for side in (1, -1):  # 1: left of the direction (dz, -dx)... sign of the cross product
                    # every street-front wall parallel to the street on this side, facing its axis; the corner is
                    # the near end of the first one along the street (among the nearest row of facades)
                    cands = []
                    for w in wgrid.near(nx0, nz0, 45):
                        if abs(w['tx'] * dx + w['tz'] * dz) < 0.8:
                            continue
                        lat = lambda px, pz: (px - nx0) * (-dz) + (pz - nz0) * dx  # noqa: E731
                        la, lb = lat(w['ax'], w['az']), lat(w['bx'], w['bz'])
                        if la * side < 1.0 or lb * side < 1.0 or min(abs(la), abs(lb)) > 45:
                            continue
                        if (w['nx'] * (-dz) + w['nz'] * dx) * side > -0.5:
                            continue
                        ta = (w['ax'] - nx0) * dx + (w['az'] - nz0) * dz
                        tb = (w['bx'] - nx0) * dx + (w['bz'] - nz0) * dz
                        near_end, tn = ('a', ta) if ta < tb else ('b', tb)
                        if tn < -3 or tn > 40:
                            continue
                        cands.append((tn, min(abs(la), abs(lb)), w, near_end))
                    if not cands:
                        stats['corner without a street wall'] += 1
                        continue
                    front = min(c[1] for c in cands)
                    best = min((c for c in cands if c[1] < front + 6), key=lambda c: c[0])
                    best = (best[0], best[2], best[3])
                    tn, w, end = best
                    if any(e == end and c == cv for e, c in taken[w['id']]):
                        stats['already plated'] += 1
                        continue
                    taken[w['id']].append((end, cv))
                    # anchor: PLATE_EDGE in from the corner end, the plate extends further along the wall (dir)
                    if end == 'a':
                        ax, az, sx, sz = w['ax'], w['az'], w['tx'], w['tz']
                    else:
                        ax, az, sx, sz = w['bx'], w['bz'], -w['tx'], -w['tz']
                    room = w['len'] - PLATE_EDGE
                    if room < 0.45:
                        stats['wall too short'] += 1
                        continue
                    px, pz = ax + sx * PLATE_EDGE, az + sz * PLATE_EDGE
                    if in_other_box(rgrid, px + sx * 0.3 + w['nx'] * 0.3, pz + sz * 0.3 + w['nz'] * 0.3, w['b']):
                        stats['hidden by another building'] += 1
                        continue
                    plates.append(dict(x=px, z=pz, nx=w['nx'], nz=w['nz'], sx=sx, sz=sz, room=min(room, 2.5),
                                       ref=w['ref'], end=0 if end == 'a' else 1,
                                       y=PLATE_Y, codvia=cv, wall=w['id'], b=w['b']))
                    stats['plates'] += 1
    return plates, stats


# --- output -----------------------------------------------------------------------------------------------------------
def zigzag(v):
    return (v << 1) ^ (v >> 63)


def varints(vals):
    out = bytearray()
    for v in vals:
        u = zigzag(int(v)) & 0xFFFFFFFFFFFFFFFF
        while True:
            b = u & 0x7F
            u >>= 7
            if u:
                out.append(b | 0x80)
            else:
                out.append(b)
                break
    return out


def columns(items, fields):
    """struct of arrays, one column after the other, zigzag varints; 'ref' is delta-coded (the items are sorted by it)"""
    out = bytearray()
    for f in fields:
        col = [it[f] for it in items]
        if f == 'ref' and col:
            col = [col[0]] + [b - a for a, b in zip(col, col[1:])]
        out += varints(col)
    return out


def main():
    report = '--report' in sys.argv
    walls, rects = street_walls()
    wgrid = Grid()
    for w in walls:
        wgrid.add_seg(w, w['ax'], w['az'], w['bx'], w['bz'], pad=SNAP_DOOR)
    rgrid = Grid()
    for r in rects:
        rad = math.hypot(r[2], r[3])
        rgrid.add_seg(r, r[0] - rad, r[1] - rad, r[0] + rad, r[1] + rad)
    doors, door_excl, raw_total, raw_detail = snap_portals(walls, wgrid, rgrid)
    axes = load_axes()
    osm = load_osm_names()
    labels, label_src = street_labels(axes, osm)
    wall_src = assign_streets(walls, axes)
    nodes = axis_nodes(axes)
    plates, plate_stats = corner_plates(nodes, walls, wgrid, rgrid)
    # keep the plates inside the detailed area (the axes were read with a margin)
    dt = vlci.FRAME['detail']
    inside = lambda o: dt['x0'] <= o['x'] <= dt['x1'] and dt['z0'] <= o['z'] <= dt['z1']  # noqa: E731
    plates = [p for p in plates if inside(p)]
    plates = [p for p in plates if p['codvia'] in labels]
    used = sorted({p['codvia'] for p in plates})
    name_index = {cv: i for i, cv in enumerate(used)}
    names = [list(labels[cv]) for cv in used]

    # toponímia: read so the manifest pins what was checked; count its street-name records (there are none)
    topo = vlci.read(TOPONIMIA)
    topo_kinds = Counter(topo.elemento)

    # each plate / number refers to its wall (box index * 4 + side, the order buildings.js walks them) and its place
    # on it, so it sits exactly on the facade however the buildings are drawn
    pl = sorted((dict(ref=p['ref'], end=p['end'], n=name_index[p['codvia']]) for p in plates),
                key=lambda r: (r['ref'], r['end']))
    SUFFIX = ['', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'DUP', 'TRIP']
    dr = sorted((dict(ref=d['ref'], t=round(d['t'] * 10), num=d['num'],
                      sfx=SUFFIX.index(d['suffix']) if d['suffix'] in SUFFIX else 0) for d in doors),
                key=lambda r: (r['ref'], r['t']))
    head = dict(
        version=1, plates=len(pl), doors=len(dr), names=names, suffixes=SUFFIX, buildings=buildings_hash(),
        plateY=PLATE_Y, plateEdge=PLATE_EDGE, doorY=DOOR_Y, doorYOld=DOOR_Y_OLD,
        source=dict(portals=dict(id=PORTALS, records=raw_total, in_detail=raw_detail, excluded=dict(door_excl)),
                    axes=dict(id=AXES, streets_named=len(labels), labels=dict(label_src), walls=dict(wall_src)),
                    toponimia=dict(id=TOPONIMIA, records=len(topo), kinds=dict(topo_kinds), street_names=0),
                    plates=dict(nodes=len(nodes), **dict(plate_stats))))
    hj = json.dumps(head, ensure_ascii=False, separators=(',', ':')).encode()
    PF, DF = ['ref', 'end', 'n'], ['ref', 't', 'num', 'sfx']
    body = columns(pl, PF) + columns(dr, DF)
    blob = b'VPL1' + struct.pack('<I', len(hj)) + hj + bytes(body)
    gz = gzip.compress(blob, 9, mtime=0)
    if report:
        import zlib
        for nm, items, fs in (('plates', pl, PF), ('doors', dr, DF)):
            print(nm, {f: len(zlib.compress(bytes(columns(items, [f])), 9)) for f in fs})
    open(OUT, 'wb').write(gz)
    print(f'{len(pl)} plates ({len(used)} streets) at {len(nodes)} nodes, {len(dr)} door numbers of {raw_detail} portals in '
          f'the detailed area ({raw_total} in all); {len(gz) / 1024:.0f} KB gzipped -> {os.path.relpath(OUT, ROOT)}')
    print('door exclusions', dict(door_excl), '| labels', dict(label_src), '| walls', dict(wall_src), '|', dict(plate_stats))
    if report:
        for cv in used[:60]:
            print(cv, labels[cv])


if __name__ == '__main__':
    main()
