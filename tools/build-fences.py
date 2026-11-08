"""Bake València's mapped fences and railings into js/vlc-fences.js (gap #4).

Source: OpenStreetMap barrier=fence / railing / guard_rail / handrail ways (tools/data/vlc_fences.json, from
tools/fences-extract.py). © OpenStreetMap contributors, ODbL 1.0. The Ajuntament publishes no fence layer.

Every segment with both ends inside the detailed area (GEO.frame.detail) is kept; segments shorter than 0.3 m are
dropped (documented exclusion). Kind and height come from the tags where mapped (fence_type, height, 0.5-4 m);
otherwise by rule: a fence is 2 m of vertical iron bars, or chain-link on ~35 % of them (by OSM id), a railing 1.1 m,
a guard rail 0.8 m, a handrail 1.0 m.

Rule fences (no barrier mapped): the outline of a leisure=pitch is 3 m of chain-link (València's courts are caged in
tall mesh: the Street View pairs show it over school and barri walls), of a leisure=playground a 1 m railing (its
playgrounds are ringed by a low railing). Kept only for 100-9000 m2 outlines (not stadium fields), not for open-air
sports without a cage (PITCH_OPEN), and not where the outline is already fenced: half or more of its points within
2 m of a mapped barrier.

Output js/vlc-fences.js: FENCES, base64 of an Int16 list of polylines [n, kind, height (dm), x0, z0, ..., x(n-1),
z(n-1)] with x, z in quarter metres of the world frame; kind 0 iron bars, 1 chain-link, 2 railing, 3 guard rail;
and FENCE_COUNTS (raw ways, ways kept, segments kept, short segments dropped) for tests/facades.test.mjs.

usage: python -I tools/build-fences.py      (the GIS env: vlci.py's frame)
"""
import base64
import json
import math
import os
import struct
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'realism'))
import vlci  # noqa: E402

OUT = os.path.join(ROOT, 'js', 'vlc-fences.js')
DEFAULT_H = {0: 2.0, 1: 2.0, 2: 1.1, 3: 0.8}
PITCH_OPEN = {'boules', 'table_tennis', 'skateboard', 'equestrian', 'athletics', 'roller_skating', 'chess', 'golf',
              'running', 'swimming', 'fitness', 'beachvolleyball', 'shooting', 'archery', 'bmx', 'cycling'}


def area(w):
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(w, w[1:] + w[:1]))) * 0.5


def fenced(w, grid):
    """Is half or more of outline `w` (points every ~2 m) within 2 m of a mapped barrier segment in `grid`?"""
    pts = []
    for a, b in zip(w, w[1:]):
        k = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / 2))
        pts += [(a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k) for i in range(k)]
    near = 0
    for x, z in pts:
        for ax, az, bx, bz in grid.get((int(x // 10), int(z // 10)), ()):
            ex, ez = bx - ax, bz - az
            t = max(0.0, min(1.0, ((x - ax) * ex + (z - az) * ez) / max(ex * ex + ez * ez, 1e-9)))
            if math.hypot(ax + ex * t - x, az + ez * t - z) < 2:
                near += 1
                break
    return near * 2 >= len(pts)


def inside(x, z):
    d = vlci.FRAME['detail']
    return d['x0'] <= x <= d['x1'] and d['z0'] <= z <= d['z1']


def kind_of(oid, barrier, ftype):
    if barrier == 'pitch':
        return 1
    if barrier == 'playground':
        return 2
    if barrier == 'guard_rail':
        return 3
    if barrier in ('railing', 'handrail'):
        return 2
    if ftype == 'chain_link':
        return 1
    if ftype in ('metal', 'metal_bars', 'bars', 'railing', 'wood', 'brick'):
        return 0
    return 1 if (oid * 2654435761 % 2 ** 32) / 2 ** 32 < 0.35 else 0


def height_of(tag, kind, barrier):
    try:
        h = float(tag.replace('m', '').replace(',', '.').strip())
        if 0.5 <= h <= 4:
            return h
    except ValueError:
        pass
    if barrier == 'pitch':
        return 3.0
    return 1.0 if barrier in ('handrail', 'playground') else DEFAULT_H[kind]


def main():
    ways = json.load(open(os.path.join(ROOT, 'tools', 'data', 'vlc_fences.json')))
    data = []
    kept = segs = short = 0
    grid = {}  # 10 m cells -> mapped barrier segments (padded by a cell), for the rule fences' "already fenced" test
    for oid, barrier, ftype, htag, pts in ways:
        if barrier in ('pitch', 'playground'):
            continue
        w = [vlci.lonlat_to_world(lon, lat) for lon, lat in pts]
        for a, b in zip(w, w[1:]):
            for i in range(int(min(a[0], b[0]) // 10) - 1, int(max(a[0], b[0]) // 10) + 2):
                for j in range(int(min(a[1], b[1]) // 10) - 1, int(max(a[1], b[1]) // 10) + 2):
                    grid.setdefault((i, j), []).append((a[0], a[1], b[0], b[1]))
    rule = {'pitch': 0, 'playground': 0}
    for oid, barrier, ftype, htag, pts in ways:
        w = [vlci.lonlat_to_world(lon, lat) for lon, lat in pts]
        if barrier in rule:
            if barrier == 'pitch' and set(ftype.split(';')) <= PITCH_OPEN and ftype:
                continue
            if not 100 <= area(w) <= 9000 or not all(inside(*p) for p in w) or fenced(w, grid):
                continue
            rule[barrier] += 1
        kind = kind_of(oid, barrier, ftype)
        h = height_of(htag, kind, barrier)
        # runs of consecutive segments with both ends inside and at least 0.3 m long
        runs, cur = [], []
        for a, b in zip(w, w[1:]):
            if not (inside(*a) and inside(*b)):
                if len(cur) > 1:
                    runs.append(cur)
                cur = []
                continue
            if math.hypot(b[0] - a[0], b[1] - a[1]) < 0.3:
                short += 1
                continue
            if not cur:
                cur = [a]
            cur.append(b)
            segs += 1
        if len(cur) > 1:
            runs.append(cur)
        if runs:
            kept += 1
        for r in runs:
            data += [len(r), kind, round(h * 10)]
            for x, z in r:
                data += [round(x * 4), round(z * 4)]
    blob = base64.b64encode(struct.pack(f'<{len(data)}h', *data)).decode()
    with open(OUT, 'w') as f:
        f.write('// València\'s fences and railings (gap #4), generated by tools/build-fences.py from OpenStreetMap\n')
        f.write('// barrier=fence / railing / guard_rail / handrail, and the cages of pitches and railings of playgrounds\n')
        f.write('// (leisure=pitch / playground outlines, by rule) (© OpenStreetMap contributors, ODbL 1.0).\n')
        f.write('// FENCES: base64 Int16 polylines [n, kind, height dm, x0, z0, ...] in quarter metres of the world frame;\n')
        f.write('// kind 0 iron bars, 1 chain-link, 2 railing, 3 guard rail.\n')
        counts = {"raw": len(ways), "ways": kept, "segments": segs, "short": short, "pitches": rule['pitch'],
                  "playgrounds": rule['playground']}
        f.write(f'export const FENCE_COUNTS = {json.dumps(counts)};\n')
        f.write(f'export const FENCES = \'{blob}\';\n')
    print(f'{len(ways)} ways, {kept} kept ({rule}), {segs} segments, {short} short dropped -> {OUT} ({os.path.getsize(OUT)} bytes)')


if __name__ == '__main__':
    main()
