"""Extract València's street lamps from OpenStreetMap into tools/data/vlc_street_lamps.json (gap #9, street lights).

usage: python3 -I tools/lamps-extract.py path/to/valencia-latest.osm.pbf
       (needs pyosmium, e.g. the repo's .venv; Geofabrik's extract is download.geofabrik.de/europe/spain/valencia-latest.osm.pbf)

Output: [[lon, lat, osm id, mount, height], ...] for every highway=street_lamp node inside the bounding box, where
  mount   'wall' (support=wall_mounted / lamp_mount=wall...), 'pole' (support=pole / ground, lamp_mount=straight_mast,
          bent_mast, pole...), or '' when untagged
  height  the `height` tag in metres, 0 when untagged
tools/build-lamps.py turns them into js/vlc-lamps.js.
© OpenStreetMap contributors, ODbL 1.0.
"""
import json
import os
import sys

import osmium

BBOX = (39.420, -0.440, 39.515, -0.300)  # as tools/bcn-extract.py
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'vlc_street_lamps.json')

WALL = {'wall', 'wall_mounted', 'wall_mount', 'facade', 'building'}
POLE = {'pole', 'ground', 'straight_mast', 'bent_mast', 'cast_steel_mast', 'mast', 'post_top', 'suspended'}


def mount_of(t):
    for k in ('support', 'lamp_mount', 'light:mount'):
        v = (t.get(k) or '').lower()
        if v in WALL:
            return 'wall'
        if v in POLE:
            return 'pole'
    return ''


def height_of(t):
    try:
        return round(float((t.get('height') or '0').replace('m', '').replace(',', '.').strip()), 1)
    except ValueError:
        return 0


class Lamps(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.out = []

    def node(self, n):
        if n.tags.get('highway') != 'street_lamp' or not n.location.valid():
            return
        lat, lon = n.location.lat, n.location.lon
        if not (BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]):
            return
        t = {k: v for k, v in n.tags}
        self.out.append([round(lon, 7), round(lat, 7), n.id, mount_of(t), height_of(t)])


if __name__ == '__main__':
    h = Lamps()
    h.apply_file(sys.argv[1])
    h.out.sort(key=lambda r: r[2])
    with open(OUT, 'w') as f:
        json.dump(h.out, f, separators=(',', ':'))
    print(f'{len(h.out)} street lamps -> {OUT}')
