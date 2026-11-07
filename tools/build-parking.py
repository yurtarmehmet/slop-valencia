"""Parked cars and motorbikes along València's kerbs -> js/vlc-parked.bin.gz (read by js/vlc-parked.js).

Data (Ajuntament de València open data, CC BY 4.0, fetched and pinned through tools/realism/vlci.py):
  aparcaments-no-regulats-aparcamientos-no-regulados   the painted marks of every free on-street bay (1:500 outlines)
  aparcaments-ora-aparcamientos-ora                    the same for the regulated zone, with its colour (Azul = blue
                                                       zone, Naranja / Verde = residents; Amarillo = loading / no
                                                       parking and Blanco = other marks such as the motorbike boxes,
                                                       neither of which holds cars)
  cartografia-base-vorades-bordillos                   kerb lines: which side of a bay line the kerb is, and how far
  aparcament-per-a-motos-aparcamiento-para-motos       motorbike bays (point + number of places)
  taxis                                                taxi ranks (point + number of places)
  contenidors-residus-solids-contenidores-residuos-solidos, contenidors-vidre-contenedores-vidrio
                                                       waste and glass containers: they stand in the parking lane, so
                                                       no car is put where one stands
Also the game's own road graph (GEO.roadGraph in js/bcn-geodata.js, OpenStreetMap) for the direction of one-way streets.

What the bay data is: every record is the outline of one painted mark (0.1 m wide). In-line bays are bounded on the
road side by a dashed line (1 m dashes, 1 m gaps) or a continuous one, with short ticks at the ends pointing to the
kerb; battery and angled bays by 4-6 m strokes, one between each pair of bays. There is no field for the bay type or
the vehicle class, so both come from the geometry: strokes in parallel rows 2.0-3.4 m apart are battery bays, the
rest chain into bay lines; the kerb (bordillos) gives the side and depth. Garage doors, crossings and corners are
already gaps in the painted lines, so cars only go along the painted lines.

Rules where the data says nothing (documented in the output's header comment):
  occupancy        daytime: 0.88 of free bays, 0.80 in the blue zone (paid, short stays turn over), 0.92 for residents'
                   bays: dense barris run near saturation by day; spot-checked on PNOA orthophoto crops (Alameda and the
                   Russafa/Arrancapins squares ~full, the Fausto Elio kerb on the city edge ~0.7)
  cars             real lengths: small hatchback 4.0 m, compact/saloon 4.4-4.5 m, SUV/crossover 4.4-4.6 m, small van
                   4.4 m; 0.5-1.3 m between parked cars; kerb-side wheels 0.2-0.3 m off the kerb
  colours          the Spanish fleet: white, greys and silver about two thirds, then black, blue, red and a few others
  heading          in-line cars face the traffic of their side (kerb on the right, or with the one-way flow);
                   battery cars mostly nose in

usage: python -I tools/build-parking.py      (GeoPandas env, see tools/realism/vlci.py)
"""
import gzip
import json
import math
import os
import random
import struct
import sys

import numpy as np
import shapely
from scipy.spatial import cKDTree

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'realism'))
import vlci  # noqa: E402

ROOT = vlci.ROOT
OUT = os.path.join(ROOT, 'js', 'vlc-parked.bin.gz')
STATS = os.path.join(ROOT, 'tools', 'data', 'vlc_parked_stats.json')
DS_FREE = 'aparcaments-no-regulats-aparcamientos-no-regulados'
DS_ORA = 'aparcaments-ora-aparcamientos-ora'
DS_KERB = 'cartografia-base-vorades-bordillos'
DS_MOTO = 'aparcament-per-a-motos-aparcamiento-para-motos'
DS_TAXI = 'taxis'
DS_WASTE = 'contenidors-residus-solids-contenidores-residuos-solidos'
DS_GLASS = 'contenidors-vidre-contenedores-vidrio'

# vehicle kinds (js/vlc-parked.js draws them): length, half width
KINDS = ['hatch', 'sedan', 'suv', 'van', 'taxi', 'moto']
K_HATCH, K_SEDAN, K_SUV, K_VAN, K_TAXI, K_MOTO = range(6)
LENGTH = {K_HATCH: 4.0, K_SEDAN: 4.5, K_SUV: 4.6, K_VAN: 4.4, K_TAXI: 4.5, K_MOTO: 2.05}
HALF_W = {K_HATCH: 0.86, K_SEDAN: 0.93, K_SUV: 0.97, K_VAN: 0.92, K_TAXI: 0.93, K_MOTO: 0.4}
# share of the parked fleet (València: small hatchbacks and compacts dominate, crossovers rising, some small vans)
MIX = [(K_HATCH, 0.40), (K_SEDAN, 0.30), (K_SUV, 0.22), (K_VAN, 0.08)]
# paint palette indices (js/vlc-parked.js PAINT): 0 white, 1 pearl white, 2 silver, 3 light grey, 4 graphite,
# 5 black, 6 dark blue, 7 mid blue, 8 red, 9 dark red, 10 beige, 11 green-grey, 12 orange-brown, 13 yellow
PAINT_W = [0.22, 0.06, 0.14, 0.12, 0.12, 0.11, 0.06, 0.04, 0.05, 0.03, 0.02, 0.015, 0.01, 0.005]
VAN_PAINT_W = [0.62, 0.08, 0.1, 0.08, 0.04, 0.02, 0.02, 0.0, 0.02, 0.0, 0.02, 0.0, 0.0, 0.0]
MOTO_PAINT_W = [0.2, 0.0, 0.14, 0.08, 0.16, 0.28, 0.05, 0.03, 0.04, 0.02, 0.0, 0.0, 0.0, 0.0]
OCCUPANCY = {'free': 0.88, 'Azul': 0.80, 'Naranja': 0.92, 'Verde': 0.92}
TAXI_OCC = 0.5
MOTO_OCC = 0.7
ORA_CARS = ('Azul', 'Naranja', 'Verde')

rng = random.Random(20261105)


def pick(weights):
    r = rng.random() * sum(weights)
    for i, w in enumerate(weights):
        r -= w
        if r <= 0:
            return i
    return len(weights) - 1


def pick_kind():
    r = rng.random()
    for k, w in MIX:
        r -= w
        if r <= 0:
            return k
    return K_HATCH


# ---------------------------------------------------------------------------------------------------------------
# 1. Marks: oriented rectangles (centre, unit axis, length, width) of every painted outline in the detailed area

def detail_mask(xs, ys):
    """EPSG:25830 points inside GEO.frame.detail (via the game's lon/lat -> world formula)."""
    from pyproj import Transformer
    tr = Transformer.from_crs(25830, 4326, always_xy=True)
    lon, lat = tr.transform(xs, ys)
    wx, wz = world(lon, lat)
    dt = vlci.FRAME['detail']
    return (wx >= dt['x0']) & (wx <= dt['x1']) & (wz >= dt['z0']) & (wz <= dt['z1'])


def world(lon, lat):
    F = vlci.FRAME
    th = math.radians(F['bearingDeg'])
    e = (np.asarray(lon) - F['lon0']) * F['kx']
    n = (np.asarray(lat) - F['lat0']) * F['ky']
    return e * math.cos(th) - n * math.sin(th), -(e * math.sin(th) + n * math.cos(th))


def load_marks():
    marks = []  # rows: cx, cy, ux, uy, L, W, src (0 free, 1 ORA), colour name
    stats = {}
    for ds, src in ((DS_FREE, 0), (DS_ORA, 1)):
        g = vlci.read(ds)
        stats[ds] = {'records': len(g)}
        geoms = g.geometry.values
        cen = shapely.centroid(geoms)
        cx, cy = shapely.get_x(cen), shapely.get_y(cen)
        inside = detail_mask(cx, cy)
        stats[ds]['in_detail'] = int(inside.sum())
        colours = g['color'].values if 'color' in g else np.array(['free'] * len(g))
        for i in np.nonzero(inside)[0]:
            marks.append((geoms[i], src, colours[i]))
    return marks, stats


def rect_of(geom):
    """Oriented min rectangle of a mark outline: centre, unit long axis, length, width."""
    poly = shapely.Polygon(geom.coords) if geom.geom_type == 'LineString' and geom.is_closed and len(geom.coords) >= 4 else geom
    r = shapely.oriented_envelope(poly)
    if r.geom_type != 'Polygon':
        c = np.array(geom.coords)
        p0, p1 = c[0][:2], c[-1][:2]
        d = p1 - p0
        L = float(np.hypot(*d)) or 1e-6
        return (p0 + p1) / 2, d / L, L, 0.0
    c = np.array(r.exterior.coords)[:4, :2]
    a, b = c[1] - c[0], c[2] - c[1]
    la, lb = np.hypot(*a), np.hypot(*b)
    centre = c.mean(axis=0)
    if la >= lb:
        return centre, a / max(la, 1e-9), la, lb
    return centre, b / max(lb, 1e-9), lb, la


def centreline(geom):
    """Centre path of a long thin (possibly curved) outline: the ring split at its two farthest points, sides averaged."""
    c = np.array(geom.coords)[:, :2]
    if len(c) > 2 and np.allclose(c[0], c[-1]):
        c = c[:-1]
    n = len(c)
    if n < 4:
        return c
    # farthest pair, by brute force on a subsample (rings have at most a few hundred points)
    idx = np.arange(n) if n <= 400 else np.linspace(0, n - 1, 400).astype(int)
    sub = c[idx]
    d2 = ((sub[:, None, :] - sub[None, :, :]) ** 2).sum(-1)
    i, j = np.unravel_index(np.argmax(d2), d2.shape)
    i, j = sorted((idx[i], idx[j]))
    side_a = c[i:j + 1]
    side_b = np.concatenate([c[j:], c[:i + 1]])[::-1]
    la, lb = shapely.LineString(side_a), shapely.LineString(side_b)
    L = (la.length + lb.length) / 2
    k = max(2, int(L / 0.5) + 1)
    ts = np.linspace(0, 1, k)
    pa = np.array([la.interpolate(t, normalized=True).coords[0][:2] for t in ts])
    pb = np.array([lb.interpolate(t, normalized=True).coords[0][:2] for t in ts])
    return (pa + pb) / 2


# ---------------------------------------------------------------------------------------------------------------
# 2. Kerbs

class Kerbs:
    def __init__(self):
        g = vlci.read(DS_KERB)
        parts = []
        for geom in g.geometry.values:
            if geom is None or geom.is_empty:
                continue
            parts.extend(getattr(geom, 'geoms', [geom]))
        self.lines = parts
        self.tree = shapely.STRtree(parts)
        self.count = len(g)

    def ray(self, p, n, reach):
        """Distance from p along unit n to the first kerb line within reach (or None)."""
        seg = shapely.LineString([p, p + n * reach])
        best = None
        for k in self.tree.query(seg):
            x = seg.intersection(self.lines[k])
            if x.is_empty:
                continue
            for q in getattr(x, 'geoms', [x]):
                if q.geom_type != 'Point':
                    q = q.representative_point()
                d = math.hypot(q.x - p[0], q.y - p[1])
                if d > 0.05 and (best is None or d < best):
                    best = d
        return best

    def nearest(self, p):
        """(distance, unit tangent, nearest point) of the nearest kerb line to p."""
        pt = shapely.Point(p)
        k = self.tree.nearest(pt)
        line = self.lines[k]
        s = line.project(pt)
        q = np.array(line.interpolate(s).coords[0][:2])
        a = np.array(line.interpolate(max(0, s - 0.5)).coords[0][:2])
        b = np.array(line.interpolate(min(line.length, s + 0.5)).coords[0][:2])
        t = b - a
        t = t / (np.hypot(*t) or 1)
        return float(np.hypot(*(q - p))), t, q


# ---------------------------------------------------------------------------------------------------------------
# 3. Battery rows: strokes 3-7 m long in parallel rows, 2.0-3.4 m apart across their axis

def battery_rows(strokes):
    """strokes: list of dicts with c, u, L. Returns rows (lists of stroke indices in order) and the used set."""
    if not strokes:
        return [], set()
    C = np.array([s['c'] for s in strokes])
    tree = cKDTree(C)
    nbr = {i: [] for i in range(len(strokes))}
    for i, j in tree.query_pairs(4.2):
        a, b = strokes[i], strokes[j]
        if abs(float(a['u'] @ b['u'])) < 0.96:
            continue
        u = a['u'] + b['u'] * np.sign(a['u'] @ b['u'])
        u /= np.hypot(*u)
        d = b['c'] - a['c']
        along = float(d @ u)
        across = abs(float(d[0] * -u[1] + d[1] * u[0]))
        if 2.0 <= across <= 3.4 and abs(along) <= 3.0 and abs(a['L'] - b['L']) < 1.5:
            nbr[i].append((across, j))
            nbr[j].append((across, i))
    # keep at most the nearest neighbour on each side across the axis
    links = {i: [] for i in nbr}
    for i, lst in nbr.items():
        a = strokes[i]
        perp = np.array([-a['u'][1], a['u'][0]])
        sides = {}
        for across, j in sorted(lst):
            s = 1 if float((strokes[j]['c'] - a['c']) @ perp) > 0 else -1
            if s not in sides:
                sides[s] = j
        links[i] = list(sides.values())
    # mutual links only, then walk the chains
    adj = {i: [j for j in links[i] if i in links[j]] for i in links}
    seen, rows = set(), []
    for i in adj:
        if i in seen or not adj[i] or len(adj[i]) == 2:
            continue
        row, prev, cur = [i], None, i
        seen.add(i)
        while True:
            nxt = [j for j in adj[cur] if j != prev and j not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            row.append(cur)
            seen.add(cur)
        if len(row) >= 2:
            rows.append(row)
    for i in adj:  # closed loops (rare): start anywhere
        if i in seen or not adj[i]:
            continue
        row, prev, cur = [i], None, i
        seen.add(i)
        while True:
            nxt = [j for j in adj[cur] if j != prev and j not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            row.append(cur)
            seen.add(cur)
        if len(row) >= 2:
            rows.append(row)
    used = {i for r in rows for i in r}
    return rows, used


# ---------------------------------------------------------------------------------------------------------------
# 4. Bay lines: dashes and continuous lines chained end to end

def chain_pieces(pieces):
    """pieces: list of dicts with p0, p1 (np arrays), u. Returns chains: lists of (piece index, reversed?)."""
    n = len(pieces)
    E = np.array([p['p0'] for p in pieces] + [p['p1'] for p in pieces])
    tree = cKDTree(E)
    cand = {}
    for a, b in tree.query_pairs(1.75):
        i, ei = a % n, a // n
        j, ej = b % n, b // n
        if i == j:
            continue
        pi, pj = pieces[i], pieces[j]
        if abs(float(pi['u'] @ pj['u'])) < 0.97:  # zigzags (no parking) and ticks don't chain
            continue
        # the gap must run along both pieces, outward from each end
        oi = pi['u'] * (1 if ei == 1 else -1)
        oj = pj['u'] * (1 if ej == 1 else -1)
        g = E[b] - E[a]
        gl = float(np.hypot(*g))
        if gl > 0.05:
            gu = g / gl
            if float(gu @ oi) < 0.97 or float(-gu @ oj) < 0.97:
                continue
        if float(oi @ oj) > -0.85:
            continue
        cand.setdefault(a, []).append((gl, b))
        cand.setdefault(b, []).append((gl, a))
    best = {a: min(lst)[1] for a, lst in cand.items()}
    link = {a: b for a, b in best.items() if best.get(b) == a}
    seen = set()
    chains = []
    for start in range(n):
        if start in seen:
            continue
        # walk back to an open end
        cur, end = start, 0  # we enter piece `cur` through end `end` (0 = p0)
        steps = 0
        while True:
            other_end_idx = cur + n * end  # endpoint we entered through
            nb = link.get(other_end_idx)
            if nb is None or steps > n:
                break
            nxt, nxt_end = nb % n, nb // n
            if nxt == start:
                break
            cur, end = nxt, 1 - nxt_end
            steps += 1
        # now walk forward from cur entering through `end`
        chain = []
        while cur not in seen:
            seen.add(cur)
            chain.append((cur, end == 1))  # reversed if entered through p1
            out = cur + n * (1 - end)
            nb = link.get(out)
            if nb is None:
                break
            cur, end = nb % n, nb // n
        chains.append(chain)
    return chains


def chain_polyline(chain, pieces):
    pts = []
    for i, rev in chain:
        p = pieces[i]
        a, b = (p['p1'], p['p0']) if rev else (p['p0'], p['p1'])
        if pts and np.hypot(*(pts[-1] - a)) < 0.02:
            pts.append(b)
        else:
            pts.extend([a, b])
    return np.array(pts)


def resample(poly, step):
    seg = np.hypot(*(poly[1:] - poly[:-1]).T)
    s = np.concatenate([[0], np.cumsum(seg)])
    return s, seg


def at(poly, s_cum, s):
    """Point and unit tangent at arc length s along the polyline."""
    k = int(np.clip(np.searchsorted(s_cum, s) - 1, 0, len(poly) - 2))
    d = poly[k + 1] - poly[k]
    L = np.hypot(*d) or 1e-9
    t = (s - s_cum[k]) / L
    return poly[k] + d * t, d / L


# ---------------------------------------------------------------------------------------------------------------
# 5. Road graph (OSM, the game's): one-way direction near a point

class Roads:
    def __init__(self):
        src = open(os.path.join(ROOT, 'js', 'bcn-geodata.js'), encoding='utf8').read()
        i = src.index('export const GEO = ') + len('export const GEO = ')
        j = src.index('\n', i)
        G = json.loads(src[i:j].rstrip().rstrip(';'))
        rg = G['roadGraph']
        nodes = rg['nodes']
        segs, dirs = [], []
        for a, b, ni, w, lanes, d, inner in rg['links']:
            pts = [(nodes[2 * a], nodes[2 * a + 1])] + [(inner[k], inner[k + 1]) for k in range(0, len(inner), 2)] + [(nodes[2 * b], nodes[2 * b + 1])]
            for p, q in zip(pts[:-1], pts[1:]):
                segs.append((p, q))
                dirs.append(d)
        self.segs = np.array(segs, dtype=float)
        self.dirs = np.array(dirs)
        mid = self.segs.mean(axis=1)
        self.tree = cKDTree(mid)

    def oneway(self, wx, wz, tx, tz):
        """+1 / -1 if the nearest street (world frame) is one-way along / against (tx, tz), 0 if two-way or unsure."""
        ks = self.tree.query_ball_point([wx, wz], 40)
        best, bd = None, 1e9
        for k in ks:
            (ax, az), (bx, bz) = self.segs[k]
            dx, dz = bx - ax, bz - az
            L2 = dx * dx + dz * dz or 1e-9
            t = max(0, min(1, ((wx - ax) * dx + (wz - az) * dz) / L2))
            d = math.hypot(ax + dx * t - wx, az + dz * t - wz)
            L = math.sqrt(L2)
            if abs(dx * tx + dz * tz) / L < 0.8:
                continue
            if d < bd:
                bd, best = d, k
        if best is None or bd > 18 or self.dirs[best] == 0:
            return 0
        (ax, az), (bx, bz) = self.segs[best]
        s = 1 if (bx - ax) * tx + (bz - az) * tz > 0 else -1
        return s * int(self.dirs[best])


# ---------------------------------------------------------------------------------------------------------------

def main():
    from pyproj import Transformer
    to_ll = Transformer.from_crs(25830, 4326, always_xy=True)

    def to_world(p):
        lon, lat = to_ll.transform(p[0], p[1])
        x, z = world(lon, lat)
        return float(x), float(z)

    def world_dir(p, u):
        a = to_world(p)
        b = to_world(p + u)
        d = np.array([b[0] - a[0], b[1] - a[1]])
        return d / np.hypot(*d)

    marks, stats = load_marks()
    print(f'{len(marks)} marks in the detailed area')
    kerbs = Kerbs()
    roads = Roads()

    strokes, pieces = [], []
    n_symbol = n_nocar = 0
    for geom, src, col in marks:
        if src == 1 and col not in ORA_CARS:
            n_nocar += 1
            continue
        cls = 'free' if src == 0 else col
        c, u, L, W = rect_of(geom)
        if W > 0.3:
            if L > 3.0 and W < 1.5 and len(geom.coords) > 8:
                path = centreline(geom)  # a curved line
            else:
                n_symbol += 1
                continue
        elif 3.0 <= L <= 7.0 and W <= 0.25:
            strokes.append({'c': c, 'u': u, 'L': L, 'cls': cls})
            continue
        else:
            path = np.array([c - u * L / 2, c + u * L / 2])
        # pieces of at most ~1 m along the path
        for a, b in zip(path[:-1], path[1:]):
            d = b - a
            l = float(np.hypot(*d))
            if l < 0.05:
                continue
            k = max(1, int(math.ceil(l / 1.2)))
            for t in range(k):
                p0, p1 = a + d * (t / k), a + d * ((t + 1) / k)
                pieces.append({'p0': p0, 'p1': p1, 'u': d / l, 'cls': cls})

    rows, used = battery_rows(strokes)
    for i, s in enumerate(strokes):  # strokes outside a battery row are long dashes of a bay line
        if i not in used:
            pieces.append({'p0': s['c'] - s['u'] * s['L'] / 2, 'p1': s['c'] + s['u'] * s['L'] / 2, 'u': s['u'], 'cls': s['cls']})
    print(f'{len(strokes)} strokes, {len(rows)} battery rows ({len(used)} strokes), {len(pieces)} line pieces, {n_symbol} symbols, {n_nocar} ORA marks of no-car colours')

    chains = chain_pieces(pieces)
    print(f'{len(chains)} chains')

    # Containers: points in metres (they stand in the parking lane; their footprint is kept free)
    cont = []
    for ds in (DS_WASTE, DS_GLASS):
        g = vlci.read(ds)
        units = g['unidades'].fillna(1).astype(int).clip(1, 6).values if 'unidades' in g else np.ones(len(g), int)
        xy = np.array([(p.x, p.y) for p in g.geometry.values])
        m = detail_mask(xy[:, 0], xy[:, 1])
        stats[ds] = {'records': len(g), 'in_detail': int(m.sum())}
        for (x, y), n in zip(xy[m], units[m]):
            cont.append((x, y, n))
    cont = np.array(cont)
    cont_tree = cKDTree(cont[:, :2])

    vehicles = []  # (x, y metres, axis unit (front), kind, kerb code, cls)
    blocked_by_container = 0
    no_kerb = 0

    def clear_of_containers(c, u, L, hw):
        nonlocal blocked_by_container
        for k in cont_tree.query_ball_point(c, L / 2 + 2.5):
            d = cont[k, :2] - c
            along = abs(float(d @ u))
            across = abs(float(d[0] * -u[1] + d[1] * u[0]))
            half = 0.9 + 0.75 * (cont[k, 2] - 1)  # one container ~1.8 m along the kerb, more side by side
            if along < L / 2 + half + 0.2 and across < hw + 0.9:
                blocked_by_container += 1
                return False
        return True

    # 4a. In-line bays along each chain
    bay_len_total = 0.0
    battery_bays_plain = [0]
    debug_chains, debug_nokerb = [], []
    inline_bays = 0
    for chain in chains:
        poly = chain_polyline(chain, pieces)
        if len(poly) < 2:
            continue
        s_cum, seg = resample(poly, 1)
        total = s_cum[-1]
        if total < 4.2:
            continue
        cls = pieces[chain[0][0]]['cls']
        # kerb side and depth, sampled every 2 m
        votes = {1: [], -1: []}
        samples = np.arange(0.5, total - 0.4, 2.0) if total > 1 else [total / 2]
        for s in samples:
            p, t = at(poly, s_cum, s)
            n = np.array([-t[1], t[0]])
            for side in (1, -1):
                d = kerbs.ray(p, n * side, 3.6)
                if d is not None and d >= 0.9:
                    votes[side].append(d)
        if not votes[1] and not votes[-1]:
            # no kerb within an in-line bay's depth: a battery row painted with its outer line only (no separators)
            # when the kerb is a battery bay's depth away (4.0-6.2 m)
            for s in samples:
                p, t = at(poly, s_cum, s)
                n = np.array([-t[1], t[0]])
                for side in (1, -1):
                    d = kerbs.ray(p, n * side, 6.2)
                    if d is not None and d >= 4.0:
                        votes[side].append(d)
            if len(votes[1]) + len(votes[-1]) < max(1, len(samples) // 2):
                no_kerb += 1
                debug_nokerb.append(poly)
                continue
            side = 1 if len(votes[1]) >= len(votes[-1]) else -1
            depth = float(np.median(votes[side]))
            debug_chains.append((poly, side, depth, cls))
            s = 0.2 + rng.random() * 0.3
            while s + 2.45 <= total - 0.2:
                battery_bays_plain[0] += 1
                if rng.random() < OCCUPANCY[cls]:
                    kind = pick_kind()
                    L, hw = LENGTH[kind], HALF_W[kind]
                    p, t = at(poly, s_cum, s + 1.225)
                    u = np.array([-t[1], t[0]]) * side
                    c = p + u * (depth - rng.uniform(0.3, 0.6) - L / 2)
                    front = u if rng.random() < 0.7 else -u
                    if clear_of_containers(c, u, L, hw):
                        vehicles.append([c, front, kind, 'battery', u, cls, L])
                s += 2.45
            continue
        side = 1 if (len(votes[1]), -np.median(votes[1] or [9])) >= (len(votes[-1]), -np.median(votes[-1] or [9])) else -1
        depth = float(np.median(votes[side]))
        if depth > 3.4:
            continue
        bay_len_total += total
        debug_chains.append((poly, side, depth, cls))
        occ = OCCUPANCY[cls]
        s = 0.35 + rng.random() * 0.6
        end = total - 0.35
        while s < end:
            kind = pick_kind()
            L = LENGTH[kind] + rng.uniform(-0.15, 0.15)
            if s + L > end:
                break
            inline_bays += 1
            if rng.random() < occ:
                mid = s + L / 2
                p, t = at(poly, s_cum, mid)
                n = np.array([-t[1], t[0]]) * side
                hw = HALF_W[kind]
                lat = min(max(depth - rng.uniform(0.18, 0.32) - hw, hw - 0.25), 1.6)
                c = p + n * lat
                if clear_of_containers(c, t, L, hw):
                    vehicles.append([c, t, kind, 'inline', n, cls, L])
                s += L + rng.uniform(0.5, 1.3)
            else:
                s += 5.0 + rng.uniform(-0.3, 0.6)

    # 4b. Battery / angled bays between consecutive strokes of each row
    battery_bays = 0
    for row in rows:
        S = [strokes[i] for i in row]
        cls = S[0]['cls']
        # orient every stroke the same way, then find which end is the kerb (vote over the row)
        u0 = S[0]['u']
        us = [s['u'] if float(s['u'] @ u0) >= 0 else -s['u'] for s in S]
        vote = 0
        for s, u in zip(S, us):
            da = kerbs.nearest(s['c'] + u * s['L'] / 2)[0]
            db = kerbs.nearest(s['c'] - u * s['L'] / 2)[0]
            vote += 1 if da < db else -1
        kerb_sign = 1 if vote >= 0 else -1
        for a, b, ua, ub in zip(S[:-1], S[1:], us[:-1], us[1:]):
            u = (ua + ub)
            u = u / np.hypot(*u) * kerb_sign  # unit axis pointing to the kerb
            battery_bays += 1
            if rng.random() >= OCCUPANCY[cls]:
                continue
            kind = pick_kind()
            L = LENGTH[kind]
            hw = HALF_W[kind]
            Ls = (a['L'] + b['L']) / 2
            mid = (a['c'] + b['c']) / 2
            # the kerb end of the strokes, then the car's kerb end 0.3-0.6 m short of it
            kerb_end = mid + u * Ls / 2
            c = kerb_end - u * (rng.uniform(0.3, 0.6) + L / 2)
            nose_in = rng.random() < 0.7
            front = u if nose_in else -u
            if clear_of_containers(c, u, L, hw):
                vehicles.append([c, front, kind, 'battery', u, cls, L])

    # 4c. Taxi ranks: white taxis along the nearest kerb, half the places taken
    gt = vlci.read(DS_TAXI)
    taxi_pts = [(p, int(n or 1)) for p, n in zip(gt.geometry.values, gt['numplazas'].values)]
    xy = np.array([(p.x, p.y) for p, _ in taxi_pts])
    m = detail_mask(xy[:, 0], xy[:, 1])
    stats[DS_TAXI] = {'records': len(gt), 'in_detail': int(m.sum())}
    taxis = 0
    taxi_zones = []
    for (p, n), keep in zip(taxi_pts, m):
        if not keep:
            continue
        P = np.array([p.x, p.y])
        d, t, q = kerbs.nearest(P)
        if d > 6:
            continue
        side = road_side(q, np.array([-t[1], t[0]]), kerbs)
        if side == 0:
            continue
        nrm = np.array([-t[1], t[0]]) * side
        n = max(1, min(n, 12))
        length = n * 5.3
        taxi_zones.append((q + nrm * 1.1, t, length))
        for k in range(n):
            if rng.random() >= TAXI_OCC:
                continue
            c = q + nrm * 1.15 + t * ((k - (n - 1) / 2) * 5.3)
            vehicles.append([c, t, K_TAXI, 'inline', -nrm, 'taxi', LENGTH[K_TAXI]])
            taxis += 1

    # 4d. Motorbikes: the motorbike bays (point + places), side by side across the kerb, a little angled
    gm = vlci.read(DS_MOTO)
    xy = np.array([(p.x, p.y) for p in gm.geometry.values])
    m = detail_mask(xy[:, 0], xy[:, 1])
    stats[DS_MOTO] = {'records': len(gm), 'in_detail': int(m.sum()), 'places_in_detail': int(gm['numplazas'].values[m].sum())}
    motos = 0
    moto_zones = []
    for P, n, keep in zip(xy, gm['numplazas'].values, m):
        if not keep or not n:
            continue
        n = int(min(n, 30))
        d, t, q = kerbs.nearest(P)
        if d > 4:
            continue
        # which side of the kerb is the roadway: the side the nearest bay line / road centre lies on
        nrm = np.array([-t[1], t[0]])
        wx, wz = to_world(q)
        # bikes stand in the road against the kerb (the bays are painted in the parking lane)
        side = road_side(q, nrm, kerbs)
        if side == 0:
            continue
        nrm = nrm * side
        spacing = 0.95
        length = n * spacing
        moto_zones.append((q + nrm * 1.0, t, length + 0.6))
        ang = math.radians(rng.choice([70, 75, 80, 90]))
        for k in range(n):
            if rng.random() >= MOTO_OCC:
                continue
            along = (k - (n - 1) / 2) * spacing
            # the bike's front wheel to the road (parked reversing into the kerb), axis tilted ang from the kerb
            ax = -nrm * math.sin(ang) + t * math.cos(ang)
            ax = ax / np.hypot(*ax)
            c = q + t * along + nrm * (0.3 + LENGTH[K_MOTO] / 2 * math.sin(ang))
            vehicles.append([c, -ax, K_MOTO, 'moto', ax, 'moto', LENGTH[K_MOTO]])
            motos += 1

    # cars overlapping a motorbike bay or a taxi rank give way to it
    def in_zone(c, zones, half_w):
        for zc, zt, zl in zones:
            d = c - zc
            if abs(float(d @ zt)) < zl / 2 + 2.0 and abs(float(d[0] * -zt[1] + d[1] * zt[0])) < half_w:
                return True
        return False
    before = len(vehicles)
    vehicles = [v for v in vehicles if v[2] in (K_MOTO, K_TAXI) or not (in_zone(v[0], moto_zones, 1.4) or in_zone(v[0], taxi_zones, 1.4))]
    gave_way = before - len(vehicles)

    print(f'{inline_bays} in-line bays ({bay_len_total / 1000:.1f} km of bay line), {battery_bays} battery bays between strokes + {battery_bays_plain[0]} along a line, '
          f'{no_kerb} chains without a kerb in reach, {blocked_by_container} spots left free at containers, '
          f'{gave_way} cars removed at moto bays / taxi ranks, {taxis} taxis, {motos} motorbikes')

    if os.environ.get('PARKING_DEBUG'):
        import pickle
        pickle.dump({'vehicles': vehicles, 'chains': debug_chains, 'strokes': strokes, 'rows': rows,
                     'nokerb': debug_nokerb}, open(os.environ['PARKING_DEBUG'], 'wb'))

    # 5. Kerb code (what js/vlc-parked.js shifts along if a car meets the game's own sidewalk) and heading
    out = []
    dt = vlci.FRAME['detail']
    for c, front, kind, typ, kerbvec, cls, L in vehicles:
        wx, wz = to_world(c)
        if not (dt['x0'] + 1 < wx < dt['x1'] - 1 and dt['z0'] + 1 < wz < dt['z1'] - 1) or not np.all(np.isfinite(front)) or np.hypot(*front) < 0.5:
            continue
        f = world_dir(c, front)
        n = world_dir(c, kerbvec)  # towards the kerb
        if typ == 'inline':
            # facing the traffic of its side: kerb on the right (two-way) or along a one-way street
            ow = roads.oneway(wx, wz, f[0], f[1])
            # world frame: x east-ish, z south-ish (left-handed seen from above): right of heading (fx, fz) is (-fz, fx)
            if ow == 0:
                right = np.array([-f[1], f[0]])
                if float(n @ right) < 0:
                    f = -f
            elif ow < 0:
                f = -f
        yaw = math.atan2(f[0], f[1])  # three.js: rotation.y = atan2(dx, dz) points the model's +z along (dx, dz)
        if n is None:
            kerb = 0
        else:
            # kerb direction in the car frame: +x = car's left? encode as the axis the kerb lies along
            lx = n[0] * math.cos(yaw) - n[1] * math.sin(yaw)
            lz = n[0] * math.sin(yaw) + n[1] * math.cos(yaw)
            kerb = (1 if lx > 0 else 2) if abs(lx) > abs(lz) else (3 if lz > 0 else 4)
        if kind == K_TAXI:
            paint = 0
        elif kind == K_MOTO:
            paint = pick(MOTO_PAINT_W)
        elif kind == K_VAN:
            paint = pick(VAN_PAINT_W)
        else:
            paint = pick(PAINT_W)
        out.append((wx, wz, yaw, kind, paint, kerb))

    # order along the streets is lost by now: sort by a coarse space-filling order so the deltas stay small
    out.sort(key=lambda r: (int((r[1] + 1700) // 64), int((r[0] + 1500) // 64) if int((r[1] + 1700) // 64) % 2 == 0 else -int((r[0] + 1500) // 64), r[0], r[1]))
    write(out)
    counts = {KINDS[k]: sum(1 for r in out if r[3] == k) for k in range(len(KINDS))}
    stats.update({'vehicles': len(out), 'by_kind': counts, 'inline_bays': inline_bays, 'battery_bays': battery_bays + battery_bays_plain[0],
                  'bay_line_km': round(bay_len_total / 1000, 1), 'container_spots_free': blocked_by_container,
                  'chains_without_kerb': no_kerb, 'battery_rows': len(rows), 'kerb_lines': kerbs.count,
                  'occupancy': OCCUPANCY, 'containers_in_detail': int(len(cont))})
    json.dump(stats, open(STATS, 'w'), indent=1)
    print(json.dumps(counts), len(out), 'vehicles ->', os.path.relpath(OUT, ROOT), os.path.getsize(OUT), 'bytes')


def road_side(q, nrm, kerbs):
    """Which side of the kerb at q (along +/- nrm) is roadway: the roadway side has the opposite kerb or a bay line
    further away; the sidewalk side meets a building line or the facing kerb of the same sidewalk within a few metres.
    Here: the side whose next kerb is further away (sidewalks are narrower than streets)."""
    da = kerbs.ray(q + nrm * 0.15, nrm, 25) or 25
    db = kerbs.ray(q - nrm * 0.15, -nrm, 25) or 25
    if abs(da - db) < 1.0:
        return 0
    return 1 if da > db else -1


def write(rows):
    """VLP1 (gzipped): magic, u32 count, then columns: x, z as u16 deltas (0.1 m, from x -1500 / z -1700, mod 65536),
    yaw as u16 deltas (65536ths of a turn), kind u8, paint u8, kerb u8."""
    n = len(rows)
    X = np.array([round((r[0] + 1500) * 10) for r in rows], dtype=np.int64)
    Z = np.array([round((r[1] + 1700) * 10) for r in rows], dtype=np.int64)
    Y = np.array([round((r[2] / (2 * math.pi)) * 65536) % 65536 for r in rows], dtype=np.int64)
    assert X.min() >= 0 and X.max() < 65536 and Z.min() >= 0 and Z.max() < 65536
    dX = (np.diff(np.concatenate([[0], X])) % 65536).astype(np.uint16)
    dZ = (np.diff(np.concatenate([[0], Z])) % 65536).astype(np.uint16)
    dY = (np.diff(np.concatenate([[0], Y])) % 65536).astype(np.uint16)
    body = b'VLP1' + struct.pack('<I', n)
    body += dX.tobytes() + dZ.tobytes() + dY.tobytes()
    body += bytes(r[3] for r in rows) + bytes(r[4] for r in rows) + bytes(r[5] for r in rows)
    with open(OUT, 'wb') as f:
        f.write(gzip.compress(body, 9, mtime=0))


if __name__ == '__main__':
    main()
