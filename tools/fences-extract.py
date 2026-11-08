"""Extract València's fences and railings from OpenStreetMap into tools/data/vlc_fences.json (gap #4).

usage: python3 -I tools/fences-extract.py path/to/valencia-latest.osm.pbf
       (needs pyosmium, e.g. the repo's .venv; Geofabrik's extract is download.geofabrik.de/europe/spain/valencia-latest.osm.pbf)

Output: [[osm id, barrier, fence_type, height, [[lon, lat], ...]], ...] for every way tagged barrier=fence, railing,
guard_rail or handrail inside the bounding box (park and school railings, sports-ground and building-site fences,
bridge and stair railings: what segments as "fence" in the Street View comparison). Walls and hedges are left out
(they segment as wall / vegetation). Also the outlines of closed leisure=pitch and leisure=playground ways, as
barrier "pitch" / "playground" with the sport tag in the fence_type slot: València's courts are caged in tall mesh and
its playgrounds ringed by a low railing, mostly unmapped as barriers (tools/build-fences.py decides which to keep). tools/build-fences.py turns them into js/vlc-fences.js.
© OpenStreetMap contributors, ODbL 1.0.
"""
import json
import os
import sys

import osmium

BBOX = (39.420, -0.440, 39.515, -0.300)  # as tools/bcn-extract.py
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'vlc_fences.json')
KINDS = {'fence', 'railing', 'guard_rail', 'handrail'}


class Fences(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.out = []

    def way(self, w):
        b = w.tags.get('barrier')
        lei = w.tags.get('leisure')
        if b not in KINDS and lei in ('pitch', 'playground') and w.is_closed():
            b = lei
        elif b not in KINDS:
            return
        try:
            pts = [[round(n.lon, 7), round(n.lat, 7)] for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(pts) < 2 or not all(BBOX[0] < la < BBOX[2] and BBOX[1] < lo < BBOX[3] for lo, la in pts):
            return
        ftype = w.tags.get('sport', '') if b in ('pitch', 'playground') else w.tags.get('fence_type', '')
        self.out.append([w.id, b, ftype, w.tags.get('height', '') if b in KINDS else '', pts])


def main():
    h = Fences()
    h.apply_file(sys.argv[1], locations=True)
    h.out.sort(key=lambda r: r[0])
    with open(OUT, 'w') as f:
        json.dump(h.out, f, separators=(',', ':'))
    print(f'{len(h.out)} fence ways -> {OUT}')


if __name__ == '__main__':
    main()
