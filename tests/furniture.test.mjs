import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

// js/vlc-furniture.bin.gz (tools/build-furniture.py): the Ajuntament's street-furniture inventories and the rule-placed
// traffic signs. Checked against the build's counts file and, where the raw dumps are cached (.cache/vlci, fetched by
// tools/realism/vlci.py), against the raw datasets themselves, decoded here independently of the build.
const { GEO } = await import('../js/bcn-geodata.js');
const counts = JSON.parse(readFileSync(new URL('../tools/data/vlc_furniture_counts.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../tools/data/vlci-manifest.json', import.meta.url), 'utf8'));
const raw = gunzipSync(readFileSync(new URL('../js/vlc-furniture.bin.gz', import.meta.url)));
const n = raw.readUInt32LE(4);
const rec = Array.from({ length: n }, (_, i) => {
  const o = 8 + i * 8;
  return { x: raw.readInt16LE(o) / 4, z: raw.readInt16LE(o + 2) / 4, kind: raw[o + 4], variant: raw[o + 5], yaw: raw[o + 6], extra: raw[o + 7] };
});
const byKind = (k) => rec.filter((r) => r.kind === k);
const D = GEO.frame.detail;
const P = GEO.points;
const KIND_DATASETS = {
  0: ['contenidors-residus-solids-contenidores-residuos-solidos'],
  1: ['contenidors-vidre-contenedores-vidrio'],
  2: ['papereres-papeleras'],
  3: ['bancs-en-via-publica-bancos-en-via-publica'],
  4: ['aparcaments-bicicletes-aparcamientos-bicicletas'],
  5: ['emt'],
  6: ['fonts-daigua-publica-fuentes-de-agua-publica'],
  7: ['quiosc-once-quiosco-once', 'quioscs-premsa-quioscos-prensa', 'quioscs-flors-quioscos-flores'],
  8: ['pilons-extraibles-bolardos-extraibles']
};

test('the furniture file is well formed', () => {
  assert.equal(raw.subarray(0, 4).toString(), 'VLF1');
  assert.equal(raw.length, 8 + n * 8);
  for (const r of rec) {
    assert.ok(r.kind <= 9, `kind ${r.kind}`);
    assert.ok(r.x >= D.x0 - 1 && r.x <= D.x1 + 1 && r.z >= D.z0 - 1 && r.z <= D.z1 + 1, 'inside the detailed city');
  }
});

test('every inventoried object in the detailed area is baked, minus the documented exclusions', () => {
  for (const [kind, ids] of Object.entries(KIND_DATASETS)) {
    let want = 0;
    for (const id of ids) {
      const c = counts[id];
      assert.ok(c, id);
      assert.equal(c.raw, manifest[id].records, `${id}: the counts match the pinned dump`);
      assert.ok(c.detail <= c.raw && c.excluded < c.detail, id);
      want += c.detail - c.excluded;
    }
    assert.equal(byKind(+kind).length, want, `kind ${kind} (${ids.join(', ')})`);
  }
  // only the door-to-door cardboard round is excluded: a small share
  const c = counts['contenidors-residus-solids-contenidores-residuos-solidos'];
  assert.ok(c.excluded < c.detail * 0.2, `${c.excluded} containers excluded`);
});

test('the traffic signs follow the rules: known types, facing given, every rule used', () => {
  const signs = byKind(9);
  assert.equal(signs.length, counts.signs.total);
  assert.equal(Object.values(counts.signs.byRule).reduce((a, b) => a + b, 0), signs.length);
  for (const rule of ['R1', 'R2', 'R3', 'R4', 'R6']) assert.ok(counts.signs.byRule[rule] > 0, rule);
  for (const s of signs) {
    assert.ok(s.variant < counts.signTypes.length, `sign type ${s.variant}`);
    assert.ok(s.extra & 128, 'a sign knows which way it faces');
  }
  const types = counts.signTypes;
  const of = (t) => signs.filter((s) => types[s.variant] === t).length;
  // València is a city of one-way streets: no-entry and one-way signs at most junctions, a crossing sign per zebra
  assert.ok(of('R-101') > 2000 && of('S-11') > 2000 && of('S-13') > 2000 && of('R-308') > 1000, JSON.stringify(counts.signs.byType));
});

test('spot checks: real objects where they belong', () => {
  // bench no. 1074, a Mediterráneo bench at Carrer del Comte de Trénor 10 (surveyed at 570.85, -864.79)
  assert.ok(byKind(3).some((r) => Math.hypot(r.x - 570.85, r.z + 864.79) < 0.5 && r.variant === 0), 'bench 1074');
  // thirteen of the city's fifteen flower stalls ring the Plaça de l'Ajuntament (the others: Palafox, Blasco Ibáñez)
  const [ax, az] = P.ajuntament;
  const flowers = byKind(7).filter((r) => r.variant === 3);
  assert.equal(flowers.length, 15);
  assert.equal(flowers.filter((f) => Math.hypot(f.x - ax, f.z - az) < 60).length, 13);
  // the bus stops around the Plaça de l'Ajuntament, where most EMT lines pass
  assert.ok(byKind(5).filter((r) => Math.hypot(r.x - ax, r.z - az) < 200).length >= 4, 'EMT stops at the Ajuntament');
});

// --- Independent recount from the raw dumps (when cached) -----------------------------------------------------------
// UTM zone 30 N (ETRS89 / GRS80) to lon/lat, then the game frame (city-config.js lonLatToWorld)
function utmToLonLat(E, N) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const x = E - 500000, y = N;
  const M = y / k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const C1 = ep2 * Math.cos(p1) ** 2, T1 = Math.tan(p1) ** 2;
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2);
  const R1 = a * (1 - e2) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5;
  const Dd = x / (N1 * k0);
  const lat = p1 - (N1 * Math.tan(p1) / R1) * (Dd * Dd / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Dd ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * Dd ** 6 / 720);
  const lon = (Dd - (1 + 2 * T1 + C1) * Dd ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Dd ** 5 / 120) / Math.cos(p1);
  return [-3 + (lon * 180) / Math.PI, (lat * 180) / Math.PI];
}
function toWorld(lon, lat) {
  const F = GEO.frame;
  const th = (F.bearingDeg * Math.PI) / 180;
  const e = (lon - F.lon0) * F.kx, nn = (lat - F.lat0) * F.ky;
  return [e * Math.cos(th) - nn * Math.sin(th), -(e * Math.sin(th) + nn * Math.cos(th))];
}
const inDetail = ([x, z]) => x >= D.x0 && x <= D.x1 && z >= D.z0 && z <= D.z1;
const cacheDir = (id) => new URL(`../.cache/vlci/${id}/`, import.meta.url);
function readShpPoints(id) {
  const dir = cacheDir(id);
  if (!existsSync(dir)) return null;
  const shp = readdirSync(dir).find((f) => f.endsWith('.shp'));
  if (!shp) return null;
  const b = readFileSync(new URL(shp, dir));
  const pts = [];
  for (let o = 100; o + 8 <= b.length;) {
    const len = b.readInt32BE(o + 4) * 2;
    if (b.readInt32LE(o + 8) === 1) pts.push([b.readDoubleLE(o + 12), b.readDoubleLE(o + 20)]);
    else pts.push(null);
    o += 8 + len;
  }
  // DBF attributes
  const d = readFileSync(new URL(shp.replace(/\.shp$/, '.dbf'), dir));
  const nrec = d.readUInt32LE(4), hlen = d.readUInt16LE(8), rlen = d.readUInt16LE(10);
  const fields = [];
  for (let o = 32, at = 1; d[o] !== 0x0d; o += 32) {
    const name = d.subarray(o, o + 11).toString('latin1').replace(/\0.*$/, '');
    fields.push({ name, at, len: d[o + 16] });
    at += d[o + 16];
  }
  const rows = Array.from({ length: nrec }, (_, i) => Object.fromEntries(fields.map((f) => [f.name,
    d.subarray(hlen + i * rlen + f.at, hlen + i * rlen + f.at + f.len).toString('utf8').trim()])));
  return pts.map((p, i) => ({ p, row: rows[i] }));
}

test('recount from the raw dumps: points in the detailed area', (t) => {
  let checked = 0;
  for (const [kind, ids] of Object.entries(KIND_DATASETS)) {
    let want = 0;
    let ok = true;
    for (const id of ids) {
      let feats = readShpPoints(id);
      if (!feats) {
        const gj = cacheDir(id);
        const f = existsSync(gj) && readdirSync(gj).find((x) => x.endsWith('.geojson'));
        if (!f) { ok = false; break; }
        const fc = JSON.parse(readFileSync(new URL(f, gj), 'utf8'));
        want += fc.features.filter((ft) => ft.geometry && inDetail(toWorld(...ft.geometry.coordinates))).length;
        continue;
      }
      let inside = feats.filter((f) => f.p && inDetail(toWorld(...utmToLonLat(...f.p))));
      if (id.startsWith('contenidors-residus')) {
        const bagged = new Set(['MANUAL', 'RECOGIDA MANUAL', 'BOLSEO', '']);
        inside = inside.filter((f) => !(f.row.tipo.toUpperCase() === 'PC PAP' && bagged.has((f.row.tipo_carga || '').toUpperCase())));
      }
      if (id === 'emt') inside = inside.filter((f) => !f.row.suprimida || +f.row.suprimida === 0);
      want += inside.length;
    }
    if (!ok) continue;
    // a point exactly on the detail edge may round either way between the two projections
    assert.ok(Math.abs(byKind(+kind).length - want) <= 2, `kind ${kind}: baked ${byKind(+kind).length}, raw ${want}`);
    checked++;
  }
  if (!checked) t.skip('raw dumps not cached (.cache/vlci)');
});

// --- Placement against the game's kerbs (vlc-furniture.js placeFurniture, three.js stubbed: it needs none) ----------
test('placement: containers in the roadway by the kerb, sidewalk furniture and sign poles on the curb islands', async () => {
  const { register } = await import('node:module');
  const stub = 'data:text/javascript,' + encodeURIComponent('const f = () => new Proxy(function () {}, { get: (t, k) => (k === "then" ? undefined : f()), apply: () => f(), construct: () => f() }); export default f(); export const attribute = f(), vertexColor = f(), mix = f(), texture = f(), uv = f(), vec2 = f(), vec3 = f(), float = f(), mergeGeometries = f(); export const Color = class {}, Group = class {}, CanvasTexture = class {};');
  register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { if (s.startsWith('three')) return { url: ${JSON.stringify(stub)}, shortCircuit: true }; return n(s, c); }`));
  const { decodeFurniture, placeFurniture } = await import('../js/vlc-furniture.js');
  const { blockAt } = await import('../js/city-config.js');
  const items = placeFurniture(decodeFurniture(new Uint8Array(raw)));
  const share = (keys, f) => { const s = items.filter((it) => keys.includes(it.key)); return s.filter(f).length / s.length; };
  const onIsland = (it) => !!blockAt(it.x, it.z);
  // containers & igloos: most in the roadway (the rest in squares and lanes the game paves as one curb island)
  assert.ok(share(['sideLoader', 'rearLoader', 'igloo'], (it) => !onIsland(it)) > 0.7, 'containers in the roadway');
  assert.ok(share(['binPost', 'binStanding', 'binPedestal', 'binDouble'], onIsland) > 0.95, 'bins on the sidewalk');
  assert.ok(share(['bench', 'benchStone'], onIsland) > 0.95, 'benches on the sidewalk');
  assert.ok(share(['signPole'], onIsland) > 0.8, 'sign poles on the sidewalk');
  // every pole carries its plate, every plate faces somewhere, sidewalk tops are at 0.22 m
  assert.equal(items.filter((it) => it.key === 'signPole').length + items.filter((it) => it.key === 'emtPole').length,
    items.filter((it) => it.key === 'signPlate').length);
  for (const it of items) {
    assert.ok(Number.isFinite(it.x + it.z + it.y + it.yaw), it.key);
    if (it.key === 'signPlate') assert.ok(it.y > 2.2 && it.y < 3.2, `plate at ${it.y} m`);
    else assert.ok(it.y >= 0 && it.y < 0.3, `${it.key} at ${it.y} m`);
  }
  // containers in a row never overlap: no two side-loaders closer than their width
  const side = items.filter((it) => it.key === 'sideLoader');
  const grid = new Map();
  let overlaps = 0;
  for (const it of side) {
    const k = Math.floor(it.x / 4) * 100000 + Math.floor(it.z / 4);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const o of grid.get(k + a * 100000 + b) || []) if (Math.hypot(o.x - it.x, o.z - it.z) < 1.4) overlaps++;
    }
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(it);
  }
  assert.ok(overlaps < side.length * 0.02, `${overlaps} overlapping side-loaders of ${side.length}`);
});
