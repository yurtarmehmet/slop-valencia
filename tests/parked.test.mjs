import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import zlib from 'node:zlib';

// The parked cars & motorbikes baked by tools/build-parking.py (js/vlc-parked.bin.gz, decoded as js/vlc-parked.js does)
// against the build's own record of the datasets it read (tools/data/vlc_parked_stats.json, vlci-manifest.json).
const root = new URL('../', import.meta.url);
const bytes = zlib.gunzipSync(fs.readFileSync(new URL('js/vlc-parked.bin.gz', root)));
const stats = JSON.parse(fs.readFileSync(new URL('tools/data/vlc_parked_stats.json', root), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(new URL('tools/data/vlci-manifest.json', root), 'utf8'));
const KINDS = ['hatch', 'sedan', 'suv', 'van', 'taxi', 'moto'];

function decode(b) {
  const n = b.readUInt32LE(4);
  const v = [];
  let X = 0, Z = 0, Y = 0;
  for (let i = 0; i < n; i++) {
    X = (X + b.readUInt16LE(8 + i * 2)) & 0xffff;
    Z = (Z + b.readUInt16LE(8 + n * 2 + i * 2)) & 0xffff;
    Y = (Y + b.readUInt16LE(8 + n * 4 + i * 2)) & 0xffff;
    v.push({ x: X / 10 - 1500, z: Z / 10 - 1700, yaw: (Y / 65536) * Math.PI * 2, kind: b[8 + n * 6 + i], paint: b[8 + n * 7 + i], kerb: b[8 + n * 8 + i] });
  }
  return v;
}
const V = decode(bytes);
const near = (x, z, r) => V.filter((v) => Math.hypot(v.x - x, v.z - z) < r);

test('the file decodes to the vehicles the build reports, inside the detailed city', () => {
  assert.equal(bytes.subarray(0, 4).toString(), 'VLP1');
  assert.equal(bytes.length, 8 + V.length * 9);
  assert.equal(V.length, stats.vehicles);
  for (const [k, n] of Object.entries(stats.by_kind)) assert.equal(V.filter((v) => KINDS[v.kind] === k).length, n, k);
  for (const v of V) {
    assert.ok(v.x > -1500 && v.x < 5000 && v.z > -1700 && v.z < 3500);
    assert.ok(v.kind < KINDS.length && v.paint < 14 && v.kerb <= 4);
  }
  // budget: <= 0.3 MB gzipped
  assert.ok(fs.statSync(new URL('js/vlc-parked.bin.gz', root)).size < 300 * 1024);
});

test('the build read every record of its datasets (as pinned in the manifest) and clipped them to the detailed area', () => {
  for (const id of ['aparcaments-no-regulats-aparcamientos-no-regulados', 'aparcaments-ora-aparcamientos-ora',
    'aparcament-per-a-motos-aparcamiento-para-motos', 'taxis', 'contenidors-residus-solids-contenidores-residuos-solidos',
    'contenidors-vidre-contenedores-vidrio']) {
    assert.ok(manifest[id], `${id} pinned`);
    assert.equal(stats[id].records, manifest[id].records, id);
    assert.ok(stats[id].in_detail > 0 && stats[id].in_detail <= stats[id].records, id);
  }
  // no more motorbikes than the motorbike bays' places in the detailed area, no more taxis than rank places
  const motos = V.filter((v) => KINDS[v.kind] === 'moto').length;
  assert.ok(motos <= stats['aparcament-per-a-motos-aparcamiento-para-motos'].places_in_detail);
  assert.ok(motos > 0.5 * stats['aparcament-per-a-motos-aparcamiento-para-motos'].places_in_detail, `${motos} motorbikes`);
  // the cars fill the bays at the documented daytime occupancy (in-line + battery bays), less the containers' places
  const cars = V.length - motos - V.filter((v) => KINDS[v.kind] === 'taxi').length;
  const bays = stats.inline_bays + stats.battery_bays;
  assert.ok(cars > 0.78 * bays && cars < 0.92 * bays, `${cars} cars in ${bays} bays`);
  assert.ok(stats.container_spots_free > 0);
});

test('spot checks: real bays hold cars along them, motorbikes at their bays', () => {
  // Carrer de l'Enginyer Fausto Elio: in-line bays along a dashed line running (-0.6, 0.8) in the game frame
  const fausto = near(3657.9, 1075.0, 6).filter((v) => KINDS[v.kind] !== 'moto');
  assert.ok(fausto.length >= 1);
  for (const v of fausto) assert.ok(Math.abs(Math.sin(v.yaw) * -0.6 + Math.cos(v.yaw) * 0.8) > 0.97, 'parallel to the kerb');
  // Carrer del Pintor Sorolla: a motorbike bay of 15 places
  const sorolla = near(318.8, 12.7, 9).filter((v) => KINDS[v.kind] === 'moto');
  assert.ok(sorolla.length >= 6 && sorolla.length <= 15, `${sorolla.length} motorbikes`);
  // Passeig de l'Albereda: angled (battery) bays: several cars side by side, ~2.5 m apart, turned the same way
  const alameda = near(1140.7, 165.3, 9).filter((v) => KINDS[v.kind] !== 'moto');
  assert.ok(alameda.length >= 3, `${alameda.length} cars`);
  const yaw0 = alameda[0].yaw;
  assert.ok(alameda.every((v) => Math.abs(Math.sin(v.yaw - yaw0)) < 0.2), 'battery cars share one axis');
  // a battery car's kerb is ahead of or behind it, an in-line car's to its side
  assert.ok(alameda.every((v) => v.kerb === 3 || v.kerb === 4));
  assert.ok(fausto.every((v) => v.kerb === 1 || v.kerb === 2));
});

test('colours look like València: mostly white, grey and silver; taxis white', () => {
  const cars = V.filter((v) => KINDS[v.kind] !== 'moto' && KINDS[v.kind] !== 'taxi');
  const neutral = cars.filter((v) => v.paint <= 5).length / cars.length; // whites, silver, greys, black
  assert.ok(neutral > 0.7 && neutral < 0.9, `${neutral}`);
  assert.ok(V.filter((v) => KINDS[v.kind] === 'taxi').every((v) => v.paint === 0));
});
