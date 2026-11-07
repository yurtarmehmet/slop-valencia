"""Fetch an Ajuntament de València open-data layer whose SHP dump link is broken (404) from its ArcGIS MapServer
GeoJSON query, limited to the game's detailed area (GEO.frame.detail plus a margin), into .cache/vlci/<id>/data.geojson,
and pin it in tools/data/vlci-manifest.json through tools/realism/vlci.py (so vlci.read(id) then serves it).

usage: python -I tools/fetch-arcgis.py <dataset_id> [--margin 150]
"""
import concurrent.futures
import datetime
import hashlib
import json
import math
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'realism'))
import vlci  # noqa: E402

dataset_id = sys.argv[1]
margin = float(sys.argv[sys.argv.index('--margin') + 1]) if '--margin' in sys.argv else 150.0

pkg = json.loads(vlci._get(vlci.CKAN + dataset_id))['result']
res = {r['format'].upper(): r['url'] for r in pkg['resources']}
base = res['GEOJSON'].split('?')[0]  # .../MapServer/<layer>/query

# Detailed area corners -> lon/lat envelope (world x = east-ish, z = south-ish, turned by bearingDeg)
F = vlci.FRAME
th = math.radians(F['bearingDeg'])
dt = F['detail']
lons, lats = [], []
for x in (dt['x0'] - margin, dt['x1'] + margin):
    for z in (dt['z0'] - margin, dt['z1'] + margin):
        # inverse of vlci.lonlat_to_world
        e = x * math.cos(th) - z * math.sin(th)
        n = -x * math.sin(th) - z * math.cos(th)
        lons.append(F['lon0'] + e / F['kx'])
        lats.append(F['lat0'] + n / F['ky'])
env = f'{min(lons)},{min(lats)},{max(lons)},{max(lats)}'


def q(params):
    p = {'where': '1=1', 'geometry': env, 'geometryType': 'esriGeometryEnvelope', 'inSR': '4326',
         'spatialRel': 'esriSpatialRelIntersects', **params}
    return json.loads(vlci._get(base + '?' + urllib.parse.urlencode(p)))


total = q({'returnCountOnly': 'true', 'f': 'json'})['count']
full = json.loads(vlci._get(base + '?where=1%3D1&returnCountOnly=true&f=json'))['count']
print(f'{dataset_id}: {total} of {full} features in the envelope {env}', flush=True)
PAGE = 2000


def page(off):
    for attempt in range(5):
        try:
            return q({'outFields': '*', 'f': 'geojson', 'orderByFields': 'OBJECTID', 'outSR': '4326',
                      'resultOffset': off, 'resultRecordCount': PAGE})['features']
        except Exception as e:  # noqa: BLE001
            print('retry', off, e, flush=True)
    raise RuntimeError(f'page {off} failed')


feats = []
with concurrent.futures.ThreadPoolExecutor(8) as ex:
    for i, fs in enumerate(ex.map(page, range(0, total, PAGE))):
        feats += fs
        if i % 25 == 0:
            print(len(feats), flush=True)
assert len(feats) == total, (len(feats), total)
d = os.path.join(vlci.CACHE, dataset_id)
os.makedirs(d, exist_ok=True)
data = json.dumps({'type': 'FeatureCollection', 'features': feats}).encode()
open(os.path.join(d, 'data.geojson'), 'wb').write(data)
vlci._save_manifest({dataset_id: {
    'title': pkg.get('title'), 'url': base, 'licence': pkg.get('license_title'),
    'fetched': datetime.date.today().isoformat(), 'sha256': hashlib.sha256(data).hexdigest(),
    'bytes': len(data), 'records': len(feats), 'recordsFull': full,
    'note': f'GeoJSON query limited to the detailed area envelope {env} (the SHP dump link returns 404)',
    'modified': pkg.get('metadata_modified')}})
print('done', len(feats))
