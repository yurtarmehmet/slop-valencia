"""Extract València's shops, bars & restaurants and the EMT bus lines from OpenStreetMap into tools/data/vlc_*.json.

usage: python3 -I tools/shops-extract.py path/to/valencia-latest.osm.pbf
       (needs pyosmium; Geofabrik's extract is download.geofabrik.de/europe/spain/valencia-latest.osm.pbf)

Outputs:
  vlc_shops.json      [lon, lat, kind, osm id] for every shop / food & drink / service point (nodes, and the centroids of
                      shop areas) inside the bounding box. `kind` is the generic trade the sign shows (shop-signs.js):
                      only the trade, never the business's own name, so no brand or trademark ends up in the game.
  vlc_bus_lines.json  [line, destination] for each direction of the EMT València lines (route relations' `ref` and
                      the destination after "=>" in their names), regular services only.
© OpenStreetMap contributors, ODbL 1.0.
"""
import json
import os
import re
import sys

import osmium

BBOX = (39.420, -0.440, 39.515, -0.300)  # as tools/bcn-extract.py
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')

SHOP = {
    'bakery': 'forn', 'pastry': 'pastisseria', 'confectionery': 'pastisseria', 'greengrocer': 'fruiteria',
    'butcher': 'carnisseria', 'seafood': 'peixateria', 'deli': 'xarcuteria', 'supermarket': 'super',
    'convenience': 'alimentacio', 'variety_store': 'basar', 'clothes': 'moda', 'boutique': 'moda', 'shoes': 'sabateria',
    'hairdresser': 'perruqueria', 'beauty': 'estetica', 'optician': 'optica', 'jewelry': 'joieria', 'tobacco': 'estanc',
    'lottery': 'loteria', 'books': 'llibreria', 'stationery': 'papereria', 'copyshop': 'copisteria',
    'florist': 'floristeria', 'hardware': 'ferreteria', 'doityourself': 'ferreteria', 'furniture': 'mobles',
    'interior_decoration': 'mobles', 'bed': 'mobles', 'bicycle': 'bicicletes', 'laundry': 'bugaderia',
    'dry_cleaning': 'bugaderia', 'mobile_phone': 'telefonia', 'telecommunication': 'telefonia',
    'electronics': 'informatica', 'computer': 'informatica', 'gift': 'regals', 'travel_agency': 'viatges',
    'car_repair': 'taller', 'pet': 'mascotes', 'toys': 'joguets', 'sports': 'esports', 'perfumery': 'perfumeria',
    'cosmetics': 'perfumeria', 'herbalist': 'herboristeria', 'vacant': 'lloga', 'wine': 'vins', 'alcohol': 'vins',
    'frozen_food': 'congelats', 'nuts': 'fruits-secs', 'kiosk': None, 'car': None, 'yes': None,
}
AMENITY = {'pharmacy': 'farmacia', 'bank': 'banc', 'bar': 'bar', 'pub': 'bar', 'bureau_de_change': 'canvi'}


def kind_of(t):
    name = t.get('name', '')
    cuisine = t.get('cuisine', '').lower()
    a = t.get('amenity')
    if a == 'restaurant':
        if re.search(r'paella|rice|arroz|arros', cuisine) or re.search(r'arroc|arros|arroz|paella', name, re.I):
            return 'arros'
        return 'restaurant'
    if a in ('cafe', 'ice_cream'):
        if 'horchata' in cuisine or 'orxata' in cuisine or re.search(r'orxat|horchat', name, re.I):
            return 'orxata'
        return 'gelat' if a == 'ice_cream' or 'ice_cream' in cuisine else 'cafe'
    if a == 'fast_food':
        for key, k in (('kebab', 'kebab'), ('pizza', 'pizza'), ('burger', 'burger'), ('chicken', 'pollastre'),
                       ('sandwich', 'bocateria')):
            if key in cuisine:
                return k
        return 'emportar'
    if a in AMENITY:
        return AMENITY[a]
    s = t.get('shop')
    return SHOP.get(s) if s else None


def inside(lat, lon):
    return BBOX[0] <= lat <= BBOX[2] and BBOX[1] <= lon <= BBOX[3]


class Handler(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.shops = []
        self.lines = {}

    def node(self, n):
        if not n.location.valid() or not inside(n.location.lat, n.location.lon):
            return
        k = kind_of(n.tags)
        if k:
            self.shops.append([round(n.location.lon, 7), round(n.location.lat, 7), k, n.id])

    def way(self, w):
        if not w.is_closed() or ('shop' not in w.tags and 'amenity' not in w.tags):
            return
        k = kind_of(w.tags)
        if not k:
            return
        try:
            pts = [(nd.lon, nd.lat) for nd in w.nodes][:-1]
        except osmium.InvalidLocationError:
            return
        lon = sum(p[0] for p in pts) / len(pts)
        lat = sum(p[1] for p in pts) / len(pts)
        if inside(lat, lon):
            self.shops.append([round(lon, 7), round(lat, 7), k, -w.id])

    def relation(self, r):
        t = r.tags
        if t.get('type') != 'route' or t.get('route') != 'bus':
            return
        if 'EMT' not in t.get('operator', '') + t.get('network', ''):
            return
        ref, name = t.get('ref'), t.get('name', '')
        if not ref or '=>' not in name or '(' in name:  # skip diversions, market-day, summer & night variants
            return
        to = name.rsplit('=>', 1)[1].strip()  # the final stop (a few names list a via: A => B => C)
        self.lines.setdefault((ref, to), True)


h = Handler()
h.apply_file(sys.argv[1], locations=True)
h.shops.sort(key=lambda s: s[3])
lines = sorted(h.lines, key=lambda k: (len(k[0]), k[0], k[1]))
json.dump(h.shops, open(os.path.join(OUT, 'vlc_shops.json'), 'w'), separators=(',', ':'), ensure_ascii=False)
json.dump([list(k) for k in lines], open(os.path.join(OUT, 'vlc_bus_lines.json'), 'w'), indent=0, ensure_ascii=False)
counts = {}
for s in h.shops:
    counts[s[2]] = counts.get(s[2], 0) + 1
print(len(h.shops), 'shops;', len(lines), 'bus directions')
print(sorted(counts.items(), key=lambda kv: -kv[1]))
