"""València's municipal tree inventory (Ajuntament de València, Arbratge / Arbolado, CC BY 4.0) from the Geoportal's
ArcGIS service, every tree with its species, group, height & crown class, as GeoJSON-like JSON lines.

usage: python -I fetch-trees.py out.json
"""
import json
import sys
import time
import urllib.parse
import urllib.request

out = sys.argv[1]
B = 'https://geoportal.valencia.es/server/rest/services/OPENDATA/MedioAmbiente/MapServer/151/query?'
UA = {'User-Agent': 'slop-valencia-trees/0.1 (hobby open-source project)'}
rows, off = [], 0
while True:
    q = urllib.parse.urlencode({'where': '1=1', 'outFields': 'nom_botanico,grupo,altura,copa,tipo_situacion,ubicación',
                                'outSR': 4326, 'f': 'json', 'resultOffset': off, 'resultRecordCount': 2000, 'orderByFields': 'objectid'})
    for attempt in range(5):
        try:
            d = json.load(urllib.request.urlopen(urllib.request.Request(B + q, headers=UA), timeout=60))
            break
        except Exception:
            time.sleep(3 * (attempt + 1))
    feats = d.get('features', [])
    for f in feats:
        g = f.get('geometry') or {}
        if 'x' in g:
            a = f['attributes']
            rows.append([round(g['x'], 7), round(g['y'], 7), a.get('nom_botanico') or '', a.get('grupo') or '', a.get('altura') or '',
                         a.get('copa') or '', a.get('tipo_situacion') or '', a.get('ubicación') or ''])
    off += len(feats)
    if not feats or not d.get('exceededTransferLimit', len(feats) == 2000):
        break
    time.sleep(0.2)
json.dump({'source': 'Ajuntament de València, Arbratge / Arbolado (CC BY 4.0), geoportal.valencia.es', 'fields':
           ['lon', 'lat', 'nom_botanico', 'grupo', 'altura', 'copa', 'tipo_situacion', 'ubicacion'], 'trees': rows}, open(out, 'w'), ensure_ascii=False)
print(f'{len(rows):,} trees')
