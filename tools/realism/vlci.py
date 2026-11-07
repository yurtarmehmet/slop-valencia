"""Shared access to the Ajuntament de València open data portal (opendata.vlci.valencia.es, CC BY 4.0).

Every street-level build script uses this, so all datasets are fetched, pinned and reprojected the same way:

  fetch(dataset_id)   download the full dump (SHP zip, else paged GeoJSON) into .cache/vlci/<id>/ and record
                      url, date, sha256 and record count in tools/data/vlci-manifest.json (committed; the raw
                      files are not)
  read(dataset_id)    GeoDataFrame in EPSG:25830 with the dataset's own field names untouched
  add_world(gdf)      adds world x, z columns (metres, the game's frame: GEO.frame in js/bcn-geodata.js,
                      same formula as lonLatToWorld in js/city-config.js); lines/polygons get a 'world'
                      column with lists of [x, z]
  clip_detail(gdf)    keeps what falls inside the game's detailed area (GEO.frame.detail)

Needs GeoPandas (conda-forge). Run with python -I.
usage as a script: python -I vlci.py <dataset_id> [...]   -> fetches and prints the schema and a sample
"""
import datetime
import hashlib
import json
import math
import os
import re
import sys
import urllib.request
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
CACHE = os.path.join(ROOT, '.cache', 'vlci')
MANIFEST = os.path.join(ROOT, 'tools', 'data', 'vlci-manifest.json')
CKAN = 'https://opendata.vlci.valencia.es/api/3/action/package_show?id='
UA = {'User-Agent': 'slop-valencia-build/1.0'}
# Datasets whose SHP dump is another layer (the bike-rack zip holds the 9,256 VMP tipo A street lines): use GeoJSON
SHP_BROKEN = {'aparcaments-bicicletes-aparcamientos-bicicletas'}


def _frame():
    src = open(os.path.join(ROOT, 'js', 'bcn-geodata.js'), encoding='utf8').read(4000)
    m = re.search(r'"frame":(\{.*?"detail":\{[^}]*\}[^}]*\})', src)
    return json.loads(m.group(1))


FRAME = _frame()


def _get(url, path=None):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=300) as r:
        data = r.read()
    if path:
        with open(path, 'wb') as f:
            f.write(data)
    return data


def _manifest():
    return json.load(open(MANIFEST)) if os.path.exists(MANIFEST) else {}


def _save_manifest(m):
    # several build scripts may run at once: merge with what is on disk now
    cur = _manifest()
    cur.update(m)
    tmp = MANIFEST + f'.{os.getpid()}.tmp'
    json.dump(dict(sorted(cur.items())), open(tmp, 'w'), indent=1, ensure_ascii=False)
    os.replace(tmp, MANIFEST)


def fetch(dataset_id, refresh=False):
    """Download the dataset's full dump once; returns the local path (a directory with the SHP, or a .geojson)."""
    d = os.path.join(CACHE, dataset_id)
    os.makedirs(d, exist_ok=True)
    done = [f for f in os.listdir(d) if f.endswith(('.shp', '.geojson'))]
    if done and not refresh:
        return os.path.join(d, done[0])
    pkg = json.loads(_get(CKAN + dataset_id))['result']
    res = {r['format'].upper(): r['url'] for r in pkg['resources']}
    if 'SHP' in res and dataset_id not in SHP_BROKEN:
        url = res['SHP']
        z = os.path.join(d, 'dump.zip')
        data = _get(url, z)
        with zipfile.ZipFile(z) as zf:
            zf.extractall(d)
        for root, _, files in os.walk(d):
            for f in files:
                if f.endswith('.shp'):
                    out = os.path.join(root, f)
                    break
    else:
        base = res.get('GEOJSON') or res.get('JSON')
        if not base:
            raise RuntimeError(f'{dataset_id}: no SHP or GeoJSON resource ({list(res)})')
        url = base
        feats, off = [], 0
        while True:  # ArcGIS MapServer pages at maxRecordCount
            page = json.loads(_get(re.sub(r'f=\w+', 'f=geojson', base) + f'&resultOffset={off}&resultRecordCount=1000'))
            fs = page.get('features', [])
            feats += fs
            if len(fs) < 1000:
                break
            off += len(fs)
        data = json.dumps({'type': 'FeatureCollection', 'features': feats}).encode()
        out = os.path.join(d, 'data.geojson')
        open(out, 'wb').write(data)
    import geopandas as gpd
    n = len(gpd.read_file(out))
    _save_manifest({dataset_id: {
        'title': pkg.get('title'), 'url': url, 'licence': pkg.get('license_title'),
        'fetched': datetime.date.today().isoformat(), 'sha256': hashlib.sha256(data).hexdigest(),
        'bytes': len(data), 'records': n, 'modified': pkg.get('metadata_modified')}})
    return out


def read(dataset_id):
    import geopandas as gpd
    g = gpd.read_file(fetch(dataset_id))
    if g.crs is None:
        g = g.set_crs(25830)
    return g.to_crs(25830)


def lonlat_to_world(lon, lat):
    th = math.radians(FRAME['bearingDeg'])
    e = (lon - FRAME['lon0']) * FRAME['kx']
    n = (lat - FRAME['lat0']) * FRAME['ky']
    return e * math.cos(th) - n * math.sin(th), -(e * math.sin(th) + n * math.cos(th))


def add_world(g):
    """Adds x, z (point or representative point) and, for lines/polygons, 'world' = [[x, z], ...] per part."""
    ll = g.to_crs(4326)
    xs, zs, ws = [], [], []
    for geom in ll.geometry:
        if geom is None or geom.is_empty:
            xs.append(math.nan); zs.append(math.nan); ws.append(None)
            continue
        p = geom if geom.geom_type == 'Point' else geom.representative_point()
        x, z = lonlat_to_world(p.x, p.y)
        xs.append(x); zs.append(z)
        if geom.geom_type == 'Point':
            ws.append(None)
            continue
        parts = getattr(geom, 'geoms', [geom])
        rings = []
        for part in parts:
            line = part.exterior if part.geom_type == 'Polygon' else part
            rings.append([list(lonlat_to_world(cx, cy)) for cx, cy, *_ in line.coords])
        ws.append(rings)
    g = g.copy()
    g['x'], g['z'], g['world'] = xs, zs, ws
    return g


def clip_detail(g, margin=0):
    dt = FRAME['detail']
    return g[(g.x >= dt['x0'] - margin) & (g.x <= dt['x1'] + margin)
             & (g.z >= dt['z0'] - margin) & (g.z <= dt['z1'] + margin)].copy()


if __name__ == '__main__':
    for ds in sys.argv[1:]:
        g = add_world(read(ds))
        c = clip_detail(g)
        print(f'== {ds}: {len(g)} records, {len(c)} in the detailed area, geometry {g.geom_type.unique().tolist()}')
        print(g.drop(columns=['geometry', 'world']).head(5).to_string())
