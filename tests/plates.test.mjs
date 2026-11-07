import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

// Street-name plates & door numbers (gap #12): js/vlc-plates.bin.gz from tools/build-plates.py, decoded against the real
// buildings it refers to (js/vlc-plates-data.js)
const { decodePlates, buildingsHash } = await import('../js/vlc-plates-data.js');
const { GEO } = await import('../js/bcn-geodata.js');
const manifest = JSON.parse(readFileSync(new URL('../tools/data/vlci-manifest.json', import.meta.url)));

function realBuildings() {
  const raw = gunzipSync(readFileSync(new URL('../js/vlc-buildings.bin.gz', import.meta.url)));
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const count = v.getUint32(4, true), boxCount = v.getUint32(8, true);
  const lens = Array.from({ length: 10 }, (_, k) => v.getUint32(16 + k * 4, true));
  let at = 56;
  const take = (len) => { const b = Uint8Array.prototype.slice.call(raw, at, at + len); at += len; return b.buffer; };
  const frames = new Float32Array(take(lens[0]), 0, count * 3);
  const meta = new Uint8Array(take(lens[1]), 0, count * 4);
  const counts = new Uint16Array(take(lens[2]), 0, count);
  const boxes = new Int16Array(take(lens[3]), 0, boxCount * 5);
  return { count, boxCount, frames, meta, counts, boxes };
}
const R = realBuildings();
const D = decodePlates(gunzipSync(readFileSync(new URL('../js/vlc-plates.bin.gz', import.meta.url))), R);
const src = D.head.source;

test('the plates were built from the current buildings (rerun tools/build-plates.py if not)', () => {
  assert.equal(D.stale, false, `buildings ${R.count}/${R.boxCount}/${buildingsHash(R.boxes)} vs ${JSON.stringify(D.head.buildings)}`);
  assert.equal(D.plates.length, D.head.plates);
  assert.equal(D.doors.length, D.head.doors);
});

test('every portal of the detailed area is a door number, but the documented exclusions', () => {
  const m = manifest[src.portals.id];
  assert.ok(m, 'Portals pinned in the manifest');
  assert.equal(src.portals.records, m.records, 'the whole dataset was read');
  const excluded = Object.values(src.portals.excluded).reduce((a, b) => a + b, 0);
  assert.equal(D.doors.length + excluded, src.portals.in_detail);
  assert.ok(src.portals.in_detail > 30000 && excluded / src.portals.in_detail < 0.06, `${excluded} excluded`);
  for (const d of D.doors) {
    assert.match(d.text, /^[1-9][0-9]{0,3}$/);
    assert.ok(d.y >= 2.5 && d.y <= 3.1);
  }
});

test('Toponímia holds no street names (map labels only), so the plates come from the street axes', () => {
  const t = src.toponimia;
  assert.equal(t.records, manifest[t.id].records);
  assert.equal(t.street_names, 0);
  assert.ok(manifest[src.axes.id], 'street axes pinned in the manifest');
});

test('plates sit at the corners of the street axes, on the facades, inside the detailed city', () => {
  const dt = GEO.frame.detail;
  assert.ok(D.plates.length > 15000, `${D.plates.length} plates`);
  assert.ok(D.head.names.length > 1500, `${D.head.names.length} streets`);
  for (const p of D.plates) {
    assert.ok(p.x >= dt.x0 - 1 && p.x <= dt.x1 + 1 && p.z >= dt.z0 - 1 && p.z <= dt.z1 + 1);
    assert.ok(Math.abs(Math.hypot(p.nx, p.nz) - 1) < 1e-6 && Math.abs(p.nx * p.sx + p.nz * p.sz) < 1e-6, 'flat on its wall');
    assert.ok(p.room >= 0.45);
    const [type, , name] = p.name;
    assert.ok(type.length > 2 && name.length > 1 && name === name.toUpperCase(), p.name.join(' '));
  }
});

// known corners & doors (Street View viewpoints of docs/fidelity-gaps.md)
const near = (list, x, z, r) => list.filter((o) => Math.hypot(o.x - x, o.z - z) < r);
const label = (p) => p.name.slice(0, 3).join(' ');
test('spot checks: real plates and numbers where they are', () => {
  // Carrer de la Boatella at the Plaça de la Ciutat de Bruges corner (viewpoint 39)
  assert.ok(near(D.plates, 6.6, -590.8, 10).some((p) => label(p) === 'CARRER DE LA BOATELLA'));
  // Carrer del Micalet, door 5 (viewpoint 02)
  assert.ok(near(D.doors, 396.1, -549.0, 10).some((d) => d.text === '5'));
  assert.ok(near(D.plates, 396.1, -549.0, 15).some((p) => label(p) === 'CARRER DEL MICALET'));
  // Ensanche corner of Marqués de Zenete & Honorat Juan: both streets on the corner buildings (viewpoint 13)
  const c = near(D.plates, -1053.1, 72.0, 25).map(label);
  assert.ok(c.filter((l) => l === 'CARRER DEL MARQUÉS DE CENETE').length >= 3, c.join(', '));
  assert.ok(c.filter((l) => l === "CARRER D' HONORAT JUAN").length >= 3, c.join(', '));
  // Plaça de Sant Pere Nolasc (viewpoint 14)
  assert.ok(near(D.plates, 915.6, -1263.8, 20).some((p) => label(p) === 'PLAÇA DE SANT PERE NOLASC'));
});
