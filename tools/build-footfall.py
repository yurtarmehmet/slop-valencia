"""Footfall for the detailed city: how many people walk each street -> js/vlc-footfall.bin.gz.

The pedestrian systems (js/pedestrian-system.js, js/plaza-crowd.js) spawn and route people by this map: a grid of 20 m
cells over GEO.frame.detail with three channels, each the expected number of people per metre of street (both
sidewalks together) at a busy weekday midday, from what brings them out:

  home  residents and workplaces nearby. Residents per block: the Ajuntament's cadastral blocks (*Illes de cases
        cadastrals amb dades de població*, 4,929 blocks) hold the population per block in their description, but the
        published layer has every population field empty (SHP, CSV, GeoJSON and GML alike: only refman, hoja,
        coorx, coory and a null area), so each block's residents are rebuilt: the official residents of its barri
        (*Aparcaments per districtes-barris*, HABITANTES per barri) shared out over the barri's blocks by the
        Catastro dwellings in them (INSPIRE Buildings, numberOfDwellings). Workplaces: Catastro office and public
        service floor area.
  shop  the shops, markets and services from OpenStreetMap (js/vlc-shops.js, built by tools/build-shops.mjs)
  food  the bars, cafés and restaurants in the same file (they keep the streets busy late)

Each source is spread over its neighbourhood (Gaussian kernels: residents 70 m, workplaces 60 m, shops 35 m) and
scaled to people per metre of street with these rules (no pedestrian counts are published for València):
  a residential street of the Ensanche (about 450 residents/ha around it) ~ 0.06 people/m: one every 15 m or so;
  each shop within ~35 m adds footfall so that a dense shopping street (~40 shops/ha) reaches ~0.3 people/m.
The game multiplies the channels by time of day (pedestrian-system.js FOOTFALL_HOURS).

File VLF1 (gzipped): magic, u16 nx, u16 nz, f32 x0, f32 z0, f32 cell, f32 scale (people/m per unit), then nx*nz
u8 per channel (home, shop, food), row-major from (x0, z0), x fastest.  Stats -> tools/data/footfall-stats.json.

usage: python -I tools/build-footfall.py <catastro_dir with parts.parquet & buildings.parquet>
"""
import gzip
import json
import math
import os
import re
import struct
import sys
import unicodedata
import base64

import geopandas as gpd
import numpy as np
import rasterio.features
from affine import Affine
from scipy.ndimage import gaussian_filter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, 'realism'))
import vlci  # noqa: E402

CELL = 20.0
SCALE = 1 / 400  # people per metre per u8 step: 255 -> 0.64 people/m
OUT = os.path.join(ROOT, 'js', 'vlc-footfall.bin.gz')
STATS = os.path.join(ROOT, 'tools', 'data', 'footfall-stats.json')
BLOCKS_ID = 'illa-de-cases-cadastrals-amb-dades-de-poblacio'
BARRIS_ID = 'barris-barrios'
HAB_ID = 'car-parks-by-districts-neighborhoods'

# --- rules: people per metre of street per unit of each source (see the docstring) -----------------------------------
K_RES = 0.06 / 450       # per resident/ha in the 70 m neighbourhood
K_WORK = 0.02 / 10000    # per m2 of office & public floor per ha (a ministry block, ~10,000 m2/ha -> +0.02)
K_SHOP = 0.0065          # per shop/ha in the 35 m neighbourhood
K_FOOD = 0.0065          # per bar or restaurant/ha
BASE = 0.006             # anyone out at all on a street with people nearby


def norm(s):
    s = unicodedata.normalize('NFKD', str(s)).encode('ascii', 'ignore').decode().upper()
    return re.sub(r'[^A-Z]', '', s)


def barri_habitants():
    """The official residents per barri: the CSV resource of car-parks-by-districts-neighborhoods, pinned in the
    manifest the way vlci.fetch pins geodata."""
    import datetime
    import hashlib
    d = os.path.join(vlci.CACHE, HAB_ID)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, 'data.csv')
    pkg = json.loads(vlci._get(vlci.CKAN + HAB_ID))['result']
    url = next(r['url'] for r in pkg['resources'] if r['format'].upper() == 'CSV' and r['url'].endswith('-cas.csv'))
    if not os.path.exists(path):
        vlci._get(url, path)
    data = open(path, 'rb').read()
    rows = [r.split(';') for r in data.decode('utf-8-sig').splitlines()]
    head = rows[0]
    ib, ig, ih = head.index('BARRIO'), head.index('GRUPOS'), head.index('HABITANTES')
    hab = {}
    for r in rows[1:]:
        if len(r) > ih and r[ib] != 'Distrito' and r[ig].startswith('Grupo') and r[ih]:
            hab[norm(r[ib])] = int(r[ih])
    vlci._save_manifest({HAB_ID: {
        'title': pkg.get('title'), 'url': url, 'licence': pkg.get('license_title'),
        'fetched': datetime.date.today().isoformat(), 'sha256': hashlib.sha256(data).hexdigest(),
        'bytes': len(data), 'records': len(hab), 'modified': pkg.get('metadata_modified')}})
    return hab


def shops():
    src = open(os.path.join(ROOT, 'js', 'vlc-shops.js'), encoding='utf8').read()
    n = int(re.search(r'SHOP_COUNT = (\d+)', src).group(1))
    raw = base64.b64decode(re.search(r"SHOP_DATA = '([^']+)'", src).group(1))
    kinds = re.findall(r"\{ key: '([^']+)'", open(os.path.join(ROOT, 'js', 'shop-signs-kinds.js'), encoding='utf8').read())
    food = set(range(kinds.index('emportar') + 1))  # restaurant ... take-away come first
    out = []
    for i in range(n):
        x, z, k, _ = struct.unpack_from('<hhBB', raw, i * 6)
        out.append((x / 4, z / 4, k in food))
    return out


def main():
    cat_dir = sys.argv[1]
    D = vlci.FRAME['detail']
    nx = int(math.ceil((D['x1'] - D['x0']) / CELL))
    nz = int(math.ceil((D['z1'] - D['z0']) / CELL))
    x0, z0 = float(D['x0']), float(D['z0'])
    T = Affine(CELL, 0, x0, 0, CELL, z0)
    ha = CELL * CELL / 10000

    # 1. blocks, barris, residents
    blocks = vlci.read(BLOCKS_ID)
    pop_fields = [c for c in blocks.columns if c != 'geometry' and blocks[c].notna().any() and c not in ('refman', 'objectid', 'hoja', 'coorx', 'coory')]
    barris = vlci.read(BARRIS_ID)
    hab = barri_habitants()
    barris['key'] = barris.nombre.map(norm)
    missing = sorted(set(barris.key) - set(hab))
    assert not missing, f'barris without residents: {missing}'
    barris['hab'] = barris.key.map(hab)

    bld = gpd.read_parquet(os.path.join(cat_dir, 'buildings.parquet')).to_crs(25830)
    parts = gpd.read_parquet(os.path.join(cat_dir, 'parts.parquet')).to_crs(25830)
    bld['dw'] = bld.numberOfDwellings.fillna(0).astype(float)
    pt = bld.copy()
    pt['geometry'] = bld.geometry.representative_point()
    pt = gpd.sjoin(pt, barris[['key', 'hab', 'geometry']], predicate='within', how='left').drop(columns='index_right')
    dw_barri = pt.groupby('key').dw.sum()
    pt['res'] = pt.dw * pt.key.map(barris.set_index('key').hab / dw_barri).fillna(0)
    blocks = blocks.reset_index(drop=True)
    blocks['bid'] = blocks.index
    pt = gpd.sjoin(pt, blocks[['bid', 'geometry']], predicate='within', how='left').drop(columns='index_right')
    res_block = pt.groupby('bid').res.sum()
    blocks['res'] = blocks.bid.map(res_block).fillna(0.0)
    off_block = pt[pt.bid.isna()]
    # workplaces: floor area of offices & public services
    parts['ref'] = parts.localId.str.split('_').str[0]
    parts['floor'] = parts.geometry.area * parts.numberOfFloorsAboveGround.fillna(1).clip(lower=1)
    use = bld.set_index('localId').currentUse
    parts['use'] = parts.ref.map(use)
    work = parts[parts.use.isin(['4_1_office', '4_3_publicServices'])].copy()
    work['geometry'] = work.geometry.representative_point()

    # 2. to the world frame & onto the grid
    blocks = vlci.add_world(blocks)
    in_detail = vlci.clip_detail(blocks)
    res_grid = np.zeros((nz, nx))
    from shapely.geometry import Polygon
    for _, b in blocks.iterrows():
        if b.res <= 0 or not b.world:
            continue
        poly = Polygon(b.world[0])
        if not poly.is_valid or poly.area <= 0:
            continue
        mask = rasterio.features.rasterize([(poly, 1)], out_shape=(nz, nx), transform=T, all_touched=True).astype(bool)
        n = mask.sum()
        if n:
            res_grid[mask] += b.res / n
    # residents of buildings outside every block (rare) where they stand
    if len(off_block):
        ob = vlci.add_world(gpd.GeoDataFrame(off_block[['res']], geometry=off_block.geometry, crs=25830))
        for x, z, r in zip(ob.x, ob.z, ob.res):
            i, j = int((x - x0) // CELL), int((z - z0) // CELL)
            if 0 <= i < nx and 0 <= j < nz:
                res_grid[j, i] += r
    work_grid = np.zeros((nz, nx))
    ww = vlci.add_world(gpd.GeoDataFrame(work[['floor']], geometry=work.geometry, crs=25830))
    for x, z, f in zip(ww.x, ww.z, ww.floor):
        i, j = int((x - x0) // CELL), int((z - z0) // CELL)
        if 0 <= i < nx and 0 <= j < nz:
            work_grid[j, i] += f
    shop_grid = np.zeros((nz, nx))
    food_grid = np.zeros((nz, nx))
    sh = shops()
    n_shop_in = 0
    for x, z, food in sh:
        i, j = int((x - x0) // CELL), int((z - z0) // CELL)
        if 0 <= i < nx and 0 <= j < nz:
            (food_grid if food else shop_grid)[j, i] += 1
            n_shop_in += 1

    # 3. neighbourhoods (per hectare) & people per metre of street
    blur = lambda g, r: gaussian_filter(g, r / CELL, mode='constant') / ha
    res_ha, work_ha = blur(res_grid, 70), blur(work_grid, 60)
    shop_ha, food_ha = blur(shop_grid, 35), blur(food_grid, 35)
    home = np.where(res_ha + work_ha > 5, BASE, 0) + K_RES * res_ha + K_WORK * work_ha
    shop = K_SHOP * shop_ha
    food = K_FOOD * food_ha
    q = lambda a: np.clip(np.rint(a / SCALE), 0, 255).astype(np.uint8)
    chans = [q(home), q(shop), q(food)]
    head = b'VLF1' + struct.pack('<HHffff', nx, nz, x0, z0, CELL, SCALE)
    body = head + b''.join(c.tobytes() for c in chans)
    with open(OUT, 'wb') as f:
        f.write(gzip.compress(body, 9, mtime=0))

    total = (np.stack(chans).astype(float).sum(0)) * SCALE
    land = total > 0.0001
    stats = {
        'grid': {'nx': nx, 'nz': nz, 'x0': x0, 'z0': z0, 'cell': CELL, 'scale': SCALE},
        'blocks': len(blocks), 'blocks_in_detail': int(len(in_detail)),
        'blocks_in_detail_with_residents': int((in_detail.res > 0).sum()),
        'block_population_fields_published': pop_fields,
        'barris': len(barris), 'barri_residents_total': int(sum(hab.values())),
        'catastro_buildings': int(len(bld)), 'catastro_dwellings': int(bld.dw.sum()),
        'residents_placed_on_grid': round(float(res_grid.sum())),
        'residents_in_detail_blocks': round(float(in_detail.res.sum())),
        'work_parts': int(len(work)), 'shops': len(sh), 'shops_on_grid': n_shop_in,
        'shops_food': sum(1 for s in sh if s[2]),
        'people_per_m_midday': {p: round(float(np.percentile(total[land], p)), 4) for p in (10, 25, 50, 75, 90, 98, 99.5)},
        'bytes_gz': os.path.getsize(OUT),
    }
    json.dump(stats, open(STATS, 'w'), indent=1)
    print(json.dumps(stats, indent=1))


if __name__ == '__main__':
    main()
