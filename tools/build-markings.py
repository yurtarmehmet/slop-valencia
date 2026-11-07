"""Road markings of the detailed city for js/vlc-markings.js, from the Ajuntament de València's *Senyalització
horitzontal / Señalización horizontal* (senalizacion-horizontal, CC BY 4.0; fetched by tools/fetch-arcgis.py).

The dataset draws every painted shape as its outline (a closed ring, lon/lat), each with GRUPO (the kind of marking,
its line width in cm as a suffix: Linea10, CarrilBus30, ZigzagBus15...) and COLOR (Blanco, Amarillo, Azul, Naranja,
Verde, Rojo, Gris). Continuous lines come cut into ~1 m pieces and dashed ones as one ring per dash, so the shapes are
rebuilt as strokes to keep the file small:
  1. each ring becomes a stroke (a centre polyline with a width): a rectangle its long axis; a thin outline (curved
     lines, zigzags, bay corners) its centre line, from its two sides resampled and averaged; anything else (arrows,
     triangles, wide hatched areas) stays a filled polygon
  2. strokes of one kind and colour that meet end to end (within 4 cm, turning less than 35 deg) are joined
  3. equal rectangles in a row at a steady spacing become one dashed run: dashes along their own axis (lane lines,
     bay ticks, bus lane dashes) or side by side (zebra stripes, crossing squares)
Excluded: slivers under 4 cm wide (digitising leftovers), COLOR Verde (ORA residents' bays, a few hundred lines: the gap's target is no green paint), COLOR Gris ("marcas viales a distinto nivel", markings on another level: underpasses & flyovers, not at
grade), and rings with no area.

Output js/vlc-markings.bin.gz, VLM2 (gzipped), little endian, all coordinates world metres x 100 (cm):
  (see write() for the current VLM3 layout)
  magic, u32 nStyles, u32 nStrokes, u32 nPoints, u32 nPolys, u32 nPolyPoints
  styles: per style u8 r, g, b, u8 kind (0 line, 1 crossing, 2 parking, 3 bike, 4 bus, 5 hatch, 6 other)
  strokes (sorted along x): u8 style, u16 width (mm), u16 period (cm, 0 = continuous), u8 duty (/255), u8 nPts
  stroke points: i32 x, z of each stroke's first point as a step from the previous stroke's first point, then i16
    steps (cm) to the next points (written as columns: all x steps, then all z steps)
  polys: u8 style, u8 nPts; poly points as for the strokes
usage: python -I tools/build-markings.py
"""
import collections
import gzip
import math
import os
import struct
import sys

import numpy as np
from shapely.geometry import LineString, Polygon

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'realism'))
import vlci  # noqa: E402

# Verde (ORA residents' bays & lines, 2,452 shapes here) is left out: the gap's target is no green paint on the road
COLORS = {'Blanco': (232, 230, 222), 'Amarillo': (226, 178, 46), 'Azul': (40, 104, 186), 'Naranja': (226, 128, 40),
          'Rojo': (178, 52, 42)}


# motorbike bays: small outlines, mostly under parked motorbikes, and a ninth of the file (kept out for the size budget)
EXCLUDE_GROUPS = [g for g in os.environ.get('MARK_EXCLUDE_GROUPS', 'EstacionamientoMotos,EstacionamientoORAMotos').split(',') if g]


def kind_of(g):
    if g.startswith('Pasos') or g.startswith('CarrilBiciPaso'):
        return 1
    if g.startswith('Estacionamiento') or g.startswith('Vados') or g.startswith('NoEstacionamiento') or g.startswith('Zigzag'):
        return 2
    if g.startswith('CarrilBici'):
        return 3
    if g.startswith('CarrilBus'):
        return 4
    if g.startswith('Cebreados') or g.startswith('NoBloq'):
        return 5
    if g.startswith('Linea') or g.startswith('Bandas'):
        return 0
    return 6


def stroke_of(ring):
    """(points [[x, z]...], width) of a ring drawn as a stroke, or None if it isn't one"""
    p = Polygon(ring)
    if not p.is_valid:
        p = p.buffer(0)
        if p.geom_type != 'Polygon':
            return None
    if p.area < 1e-4:
        return None
    p = p.simplify(0.01)
    pts = np.array(p.exterior.coords[:-1])
    n = len(pts)
    r = p.minimum_rotated_rectangle
    rc = np.array(r.exterior.coords[:-1])
    e1, e2 = rc[1] - rc[0], rc[2] - rc[1]
    l1, l2 = np.hypot(*e1), np.hypot(*e2)
    if n <= 6 and p.area / r.area > 0.9:
        if l1 >= l2:
            a, b, w = (rc[0] + rc[3]) / 2, (rc[1] + rc[2]) / 2, l2
        else:
            a, b, w = (rc[0] + rc[1]) / 2, (rc[3] + rc[2]) / 2, l1
        return [a.tolist(), b.tolist()], w, True
    if n == 4:
        # a parallelogram (hatch stripes, slanted bay lines): a stroke between the middles of its two short sides
        e = [pts[(k + 1) % 4] - pts[k] for k in range(4)]
        L = [np.hypot(*v) for v in e]
        par = all(abs(e[k][0] * e[k + 2][1] - e[k][1] * e[k + 2][0]) < 0.09 * L[k] * L[k + 2] for k in (0, 1))
        if par:
            k = 0 if L[0] + L[2] < L[1] + L[3] else 1  # short sides k and k + 2
            a = (pts[k] + pts[k + 1]) / 2
            b = (pts[(k + 2) % 4] + pts[(k + 3) % 4]) / 2
            length = float(np.hypot(*(b - a)))
            if length > 0.05:
                return [a.tolist(), b.tolist()], p.area / length, True
    # thin outline: split at the two vertices furthest apart, average the two sides
    thick = 2 * p.area / p.length
    if thick > 0.6:
        return None
    d = np.hypot(pts[:, None, 0] - pts[None, :, 0], pts[:, None, 1] - pts[None, :, 1])
    i, j = np.unravel_index(np.argmax(d), d.shape)
    i, j = min(i, j), max(i, j)
    s1 = np.vstack([pts[i:j + 1]])
    s2 = np.vstack([pts[j:], pts[:i + 1]])[::-1]
    L1, L2 = LineString(s1), LineString(s2)
    m = max(2, int(max(L1.length, L2.length) / 0.25) + 1)
    c = []
    ws = []
    for t in np.linspace(0, 1, m):
        q1 = L1.interpolate(t, normalized=True)
        q2 = L2.interpolate(t, normalized=True)
        c.append([(q1.x + q2.x) / 2, (q1.y + q2.y) / 2])
        ws.append(q1.distance(q2))
    w = float(np.median(ws))
    line = LineString(c).simplify(0.03)
    if line.length < 0.05:
        return None
    test = line.buffer(w / 2, cap_style='flat')
    if test.symmetric_difference(p).area > 0.45 * p.area:
        return None
    chord = LineString([line.coords[0], line.coords[-1]])
    if chord.length > 0.05 and chord.hausdorff_distance(line) < 0.04:
        return [list(line.coords[0]), list(line.coords[-1])], w, True  # straight enough: a rectangle
    return [list(xy) for xy in line.coords], w, False


def main():
    g = vlci.clip_detail(vlci.add_world(vlci.read('senalizacion-horizontal')))
    raw = len(g)
    styles = {}
    strokes = []  # [style, width, pts, isRect]
    polys = []
    skipped = collections.Counter()
    for grp, col, rings in zip(g.GRUPO, g.COLOR, g.world):
        if col not in COLORS:
            skipped[col] += 1
            continue
        if any(grp.startswith(x) for x in EXCLUDE_GROUPS):
            skipped[grp] += 1
            continue
        st = styles.setdefault((kind_of(grp), col), len(styles))
        for ring in rings:
            if len(ring) < 4:
                skipped['degenerate'] += 1
                continue
            s = stroke_of(ring)
            if s is None:
                p = Polygon(ring).buffer(0)
                if p.is_empty or p.area < 1e-3:
                    skipped['no area'] += 1
                    continue
                for part in getattr(p, 'geoms', [p]):
                    q = part.simplify(0.04)
                    polys.append([st, [list(xy) for xy in q.exterior.coords[:-1]]])
                continue
            pts, w, rect = s
            if w < 0.04:  # slivers under 4 cm wide (digitising leftovers)
                skipped['sliver'] += 1
                continue
            strokes.append([st, w, pts, rect])
    print(f'{raw} marking shapes in the detailed area: {len(strokes)} strokes, {len(polys)} polygons, skipped {dict(skipped)}')

    # --- 2. join strokes end to end ---------------------------------------------------------------------------------
    def key(x, z):
        return (round(x / 0.1), round(z / 0.1))
    ends = collections.defaultdict(list)
    for k, s in enumerate(strokes):
        for e in (0, 1):
            x, z = s[2][-1 if e else 0]
            ends[key(x, z)].append((k, e))
    alive = [True] * len(strokes)

    def direction(pts, at_end):
        a, b = (pts[-2], pts[-1]) if at_end else (pts[1], pts[0])
        dx, dz = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dz) or 1
        return dx / L, dz / L

    def partner(k, at_end):
        s = strokes[k]
        x, z = s[2][-1 if at_end else 0]
        dx, dz = direction(s[2], at_end)
        best = None
        kx, kz = key(x, z)
        for i in (-1, 0, 1):
            for j in (-1, 0, 1):
                for (m, e) in ends.get((kx + i, kz + j), ()):
                    if m == k or not alive[m]:
                        continue
                    t = strokes[m]
                    if t[0] != s[0] or abs(t[1] - s[1]) > 0.03:
                        continue
                    px, pz = t[2][-1 if e else 0]
                    d = math.hypot(px - x, pz - z)
                    if d > 0.04:
                        continue
                    ox, oz = direction(t[2], e)
                    if -(dx * ox + dz * oz) < math.cos(math.radians(35)):
                        continue
                    if best is None or d < best[0]:
                        best = (d, m, e)
        return best
    joined = 0
    for k in range(len(strokes)):
        if not alive[k]:
            continue
        for at_end in (True, False):
            while True:
                s = strokes[k]
                b = partner(k, at_end)
                if not b:
                    break
                _, m, e = b
                t = strokes[m]
                tp = t[2] if (e == 0) == at_end else t[2][::-1]
                if at_end:
                    s[2] = s[2] + tp[1:]
                else:
                    s[2] = tp[:-1] + s[2]
                s[1] = (s[1] + t[1]) / 2
                s[3] = False
                alive[m] = False
                joined += 1
                # the joined stroke's new end
                x, z = s[2][-1 if at_end else 0]
                ends[key(x, z)].append((k, 1 if at_end else 0))
    strokes = [s for s, a in zip(strokes, alive) if a]
    for s in strokes:
        if len(s[2]) > 2:
            ls = LineString(s[2]).simplify(0.03)
            s[2] = [list(xy) for xy in ls.coords]
    print(f'joined {joined} pieces: {len(strokes)} strokes')

    # --- 3. dashed runs of equal rectangles ----------------------------------------------------------------------
    runs = []
    rects = [s for s in strokes if s[3] and len(s[2]) == 2]
    others = [s for s in strokes if not (s[3] and len(s[2]) == 2)]
    by = collections.defaultdict(list)
    for s in rects:
        (ax, az), (bx, bz) = s[2]
        L = math.hypot(bx - ax, bz - az)
        ang = math.atan2(bz - az, bx - ax) % math.pi
        s.append(((ax + bx) / 2, (az + bz) / 2, L, ang))
        by[s[0]].append(s)
    used = set()
    for st, lst in by.items():
        grid = collections.defaultdict(list)
        for i, s in enumerate(lst):
            cx, cz = s[4][0], s[4][1]
            grid[(int(cx // 8), int(cz // 8))].append(i)

        def near(i, r=8.0):
            cx, cz = lst[i][4][0], lst[i][4][1]
            gx, gz = int(cx // 8), int(cz // 8)
            for a in (-1, 0, 1):
                for b in (-1, 0, 1):
                    for j in grid.get((gx + a, gz + b), ()):
                        if j != i and (st, j) not in used:
                            yield j
        for i in range(len(lst)):
            if (st, i) in used:
                continue
            si = lst[i]
            cx, cz, L, ang = si[4]
            ux, uz = math.cos(ang), math.sin(ang)
            best = None
            for j in near(i):
                sj = lst[j]
                if abs(sj[4][2] - L) > 0.05 or abs(sj[1] - si[1]) > 0.03:
                    continue
                da = abs((sj[4][3] - ang + math.pi / 2) % math.pi - math.pi / 2)
                if da > math.radians(3):
                    continue
                dx, dz = sj[4][0] - cx, sj[4][1] - cz
                dist = math.hypot(dx, dz)
                if dist < 0.05:
                    continue
                along = abs(dx * ux + dz * uz) / dist
                across = abs(-dx * uz + dz * ux) / dist
                mode = 0 if along > 0.999 else (1 if across > 0.999 else -1)
                if mode < 0:
                    continue
                if mode == 0 and dist < L - 0.02:
                    continue
                if best is None or dist < best[0]:
                    best = (dist, j, mode, dx / dist, dz / dist)
            if not best:
                continue
            dist, j, mode, vx, vz = best
            # walk both ways along v at the spacing `dist`
            chain = [i, j]
            for sign, tip in ((1, j), (-1, i)):
                cur = tip
                while True:
                    px = lst[cur][4][0] + vx * dist * sign
                    pz = lst[cur][4][1] + vz * dist * sign
                    nxt = None
                    for k in near(cur):
                        if k in chain:
                            continue
                        sk = lst[k]
                        if abs(sk[4][2] - L) > 0.05 or abs(sk[1] - si[1]) > 0.03:
                            continue
                        if math.hypot(sk[4][0] - px, sk[4][1] - pz) < 0.06 + 0.02 * dist:
                            nxt = k
                            break
                    if nxt is None:
                        break
                    chain.append(nxt) if sign > 0 else chain.insert(0, nxt)
                    cur = nxt
            if len(chain) < 3:
                continue
            cs = np.array([[lst[k][4][0], lst[k][4][1]] for k in chain])
            t = (cs[:, 0] - cs[0, 0]) * vx + (cs[:, 1] - cs[0, 1]) * vz
            order = np.argsort(t)
            t = t[order]
            period = (t[-1] - t[0]) / (len(t) - 1)
            if np.max(np.abs(t - t[0] - period * np.arange(len(t)))) > 0.08:
                continue
            for k in chain:
                used.add((st, k))
            c0 = cs[order[0]]
            if mode == 0:
                dash, width = L, si[1]
            else:
                dash, width = si[1], L
            a = [c0[0] - vx * period / 2, c0[1] - vz * period / 2]
            b = [c0[0] + vx * (t[-1] + period / 2), c0[1] + vz * (t[-1] + period / 2)]
            runs.append([st, width, [a, b], period, min(1.0, dash / period)])
    singles = [s for st, lst in by.items() for i, s in enumerate(lst) if (st, i) not in used]
    out = []
    for s in others + singles:
        pts = s[2]
        for k in range(0, len(pts) - 1, 200):
            out.append([s[0], s[1], pts[k:k + 201], 0.0, 1.0])
    out += runs
    import pickle
    pickle.dump({'singles': singles, 'others': others, 'polys': polys, 'styles': styles, 'runs': runs}, open(os.environ.get('MARK_DEBUG', '/dev/null'), 'wb'))
    print(f'{len(runs)} dashed runs from {len(used)} dashes; {len(out)} strokes, '
          f'{sum(len(s[2]) for s in out)} points; {len(polys)} polygons, {sum(len(p[1]) for p in polys)} points')
    write(styles, out, polys)


def densify(pts, step=300.0):
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        k = int(L // step) + 1
        for i in range(1, k):
            out.append([a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k])
        out.append(b)
    return out


def varints(values):
    """zigzag LEB128 varints of a sequence of ints"""
    out = bytearray()
    for v in values:
        v = int(v)
        z = (v << 1) ^ (v >> 63)
        while z >= 0x80:
            out.append((z & 0x7f) | 0x80)
            z >>= 7
        out.append(z)
    return bytes(out)


def morton(x, z):
    x, z = int(x // 4) + 4096, int(z // 4) + 4096
    r = 0
    for b in range(14):
        r |= ((x >> b) & 1) << (2 * b) | ((z >> b) & 1) << (2 * b + 1)
    return r


UNIT = float(os.environ.get('MARK_UNIT', 0.04))  # metres per coordinate step
DIRS = int(os.environ.get('MARK_DIRS', 4096))  # direction steps per turn


def nn_order(items, key):
    """greedy nearest-neighbour walk over the items' key points, so consecutive items are close (small steps)"""
    from scipy.spatial import cKDTree
    if not items:
        return items
    pts = np.array([key(it) for it in items])
    tree = cKDTree(pts)
    left = np.ones(len(items), bool)
    order = []
    cur = int(np.argmin(pts[:, 0]))
    while True:
        order.append(cur)
        left[cur] = False
        if len(order) == len(items):
            break
        k = 8
        nxt = -1
        while nxt < 0:
            d, ix = tree.query(pts[cur], k=min(k, len(items)))
            for j in np.atleast_1d(ix):
                if left[j]:
                    nxt = int(j)
                    break
            if nxt < 0:
                if k >= len(items):
                    nxt = int(np.flatnonzero(left)[0])
                k *= 4
                if k > 512:  # far from anything left: jump to the nearest remaining by brute force
                    rem = np.flatnonzero(left)
                    nxt = int(rem[np.argmin(((pts[rem] - pts[cur]) ** 2).sum(1))])
        cur = nxt
    return [items[i] for i in order]


def write(styles, strokes, polys):
    """VLM4: header, styles, then sections of zigzag varints (see js/vlc-markings-decode.js), coordinates in UNIT steps:
    A. straight strokes (2 points, pointing into [0, 180 deg)): style, width cm, period cm, duty /255, first point
       step (x, z) from the previous stroke's first point, length, direction step from the previous stroke's
       (DIRS per turn)
    B. polylines: style, width cm, nPts, first point step, then steps to each next point
    C. polygons: style, nPts, first point step, then steps"""
    ex = {int(k) for k in os.environ.get('MARK_EXCLUDE_KINDS', '').split(',') if k}
    if ex:
        kinds = {v: k[0] for k, v in styles.items()}
        strokes = [s for s in strokes if kinds[s[0]] not in ex]
        polys = [p for p in polys if kinds[p[0]] not in ex]
    for s in strokes:
        s[2] = densify(s[2])
    two = [s for s in strokes if len(s[2]) == 2]
    many = [s for s in strokes if len(s[2]) > 2]
    for s in two:
        (x0, z0), (x1, z1) = s[2]
        if math.atan2(z1 - z0, x1 - x0) < 0:
            s[2] = [s[2][1], s[2][0]]
    def by_style(items, key):
        groups = collections.defaultdict(list)
        for it in items:
            groups[(it[0], round(it[1], 2)) if len(it) > 2 else it[0]].append(it)
        return [it for k in sorted(groups) for it in nn_order(groups[k], key)]
    two = by_style(two, lambda s: s[2][0])
    many = by_style(many, lambda s: s[2][0])
    polys = by_style(polys, lambda p: p[1][0])
    inv = sorted(styles.items(), key=lambda kv: kv[1])
    sty = b''.join(struct.pack('<4B', *COLORS[col], kind) for (kind, col), _ in inv)

    def q(v):
        return int(round(v / UNIT))

    def firsts(pts0):
        qq = [(q(x), q(z)) for x, z in pts0]
        dx = [qq[0][0]] + [qq[i][0] - qq[i - 1][0] for i in range(1, len(qq))] if qq else []
        dz = [qq[0][1]] + [qq[i][1] - qq[i - 1][1] for i in range(1, len(qq))] if qq else []
        return dx, dz

    def steps_of(shapes):
        out = []
        for pts in shapes:
            # relative to the shape's first point, so equal shapes get equal steps
            qq = [(q(x - pts[0][0]), q(z - pts[0][1])) for x, z in pts]
            for a, b in zip(qq, qq[1:]):
                out += [b[0] - a[0], b[1] - a[1]]
        return out
    # A: each first point as a step from the previous one in the previous stroke's frame (along, across its
    # direction), closed loop on the decoded positions: dashes in a line step along, bay ticks across
    ax, az, lens, dirs = [], [], [], []
    rx = rz = 0.0
    prev = 0
    for s in two:
        (x0, z0), (x1, z1) = s[2]
        th = prev * 2 * math.pi / DIRS
        c, sn = math.cos(th), math.sin(th)
        dx, dz = x0 - rx, z0 - rz
        qa, qc = q(dx * c + dz * sn), q(-dx * sn + dz * c)
        ax.append(qa)
        az.append(qc)
        rx += (qa * c - qc * sn) * UNIT
        rz += (qa * sn + qc * c) * UNIT
        lens.append(q(math.hypot(x1 - x0, z1 - z0)))
        d = int(round(math.atan2(z1 - z0, x1 - x0) / (2 * math.pi) * DIRS)) % DIRS
        dirs.append(d - prev)
        prev = d
    secA = [varints(s[0] for s in two), varints(round(s[1] * 100) for s in two), varints(round(s[3] * 100) for s in two),
            varints(round(s[4] * 255) for s in two), varints(ax), varints(az), varints(lens), varints(dirs)]
    # B
    bx, bz = firsts([s[2][0] for s in many])
    secB = [varints(s[0] for s in many), varints(round(s[1] * 100) for s in many), varints(len(s[2]) for s in many),
            varints(bx), varints(bz), varints(steps_of([s[2] for s in many]))]
    # C
    cx, cz = firsts([p[1][0] for p in polys])
    secC = [varints(p[0] for p in polys), varints(len(p[1]) for p in polys), varints(cx), varints(cz),
            varints(steps_of([p[1] for p in polys]))]
    secs = secA + secB + secC
    head = b'VLM4' + struct.pack('<4IfI', len(inv), len(two), len(many), len(polys), UNIT, DIRS) + struct.pack(f'<{len(secs)}I', *map(len, secs))
    body = head + sty + b''.join(secs)
    for name, sec in zip('A.style A.width A.period A.duty A.x A.z A.len A.dir B.style B.width B.n B.x B.z B.steps C.style C.n C.x C.z C.steps'.split(), secs):
        print(f'  {name} {len(sec)} -> {len(gzip.compress(sec, 9))}')
    out = os.environ.get('MARK_OUT') or os.path.join(ROOT, 'js', 'vlc-markings.bin.gz')
    with gzip.GzipFile(out, 'wb', mtime=0, compresslevel=9) as f:
        f.write(body)
    print(f'{len(two)} straight strokes, {len(many)} polylines, {len(polys)} polygons; '
          f'{len(body)} bytes raw, {os.path.getsize(out)} gzipped -> {out}')


if __name__ == '__main__':
    main()
