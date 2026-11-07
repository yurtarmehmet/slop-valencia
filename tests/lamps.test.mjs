import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

// Street lamps (gap #9): the mapped lamps baked by tools/build-lamps.py (js/vlc-lamps.js) and the placement of every lamp
// by js/street-lamps-plan.js (mapped lamps, then by area & street width along every street)
const { LAMPS, LAMP_COUNTS } = await import('../js/vlc-lamps.js');
const { GEO } = await import('../js/bcn-geodata.js');
const C = await import('../js/city-config.js');
const { planStreetLamps, streetWallsFrom, LAMP_TYPES, T } = await import('../js/street-lamps-plan.js');
const OSM = JSON.parse(readFileSync(new URL('../tools/data/vlc_street_lamps.json', import.meta.url), 'utf8'));
const D = GEO.frame.detail;
const inside = (x, z) => x >= D.x0 && x <= D.x1 && z >= D.z0 && z <= D.z1;

// the real buildings' walls, decoded as js/vlc-buildings.js does (node has no fetch for files)
function realBuildings() {
  const raw = gunzipSync(readFileSync(new URL('../js/vlc-buildings.bin.gz', import.meta.url)));
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const n = view.getUint32(4, true), nb = view.getUint32(8, true);
  const lens = Array.from({ length: 10 }, (_, k) => view.getUint32(16 + k * 4, true));
  let at = 56;
  const take = (len) => { const b = Buffer.from(raw.subarray(at, at + len)); at += len; return b; };
  const fb = take(lens[0]);
  const meta = new Uint8Array(take(lens[1]));
  const cb = take(lens[2]);
  const bb = take(lens[3]);
  return {
    count: n, frames: new Float32Array(fb.buffer, fb.byteOffset, n * 3), meta, counts: new Uint16Array(cb.buffer, cb.byteOffset, n),
    boxes: new Int16Array(bb.buffer, bb.byteOffset, nb * 5), faces: new Uint8Array(take(lens[4]))
  };
}
const walls = streetWallsFrom(realBuildings());
const { lamps, stats } = planStreetLamps(walls, LAMPS);
const near = (x, z, r, pred = () => true) => lamps.filter((l) => Math.hypot(l.x - x, l.z - z) < r && pred(l));

test('every mapped lamp in the detailed area is baked once (OSM + the Ajuntament\'s Mobiliari urbà FAROLA)', () => {
  const osmIn = OSM.filter(([lon, lat]) => { const w = C.lonLatToWorld(lon, lat); return inside(w.x, w.z); }).length;
  assert.equal(osmIn, LAMP_COUNTS.osmDetail);
  assert.equal(osmIn, 741, 'the 741 OSM street lamps of docs/fidelity-gaps.md');
  assert.equal(LAMP_COUNTS.ajuntamentDetail, 311);
  assert.equal(LAMPS.length / 3, LAMP_COUNTS.osmDetail - LAMP_COUNTS.osmDuplicates + LAMP_COUNTS.ajuntamentDetail - LAMP_COUNTS.repeats,
    'baked = clipped minus cross-source duplicates and repeated outlines');
  for (let i = 0; i < LAMPS.length; i += 3) assert.ok(inside(LAMPS[i] / 10, LAMPS[i + 1] / 10), 'inside the detailed area');
});

test('known OSM lamps are baked and stand where they are mapped', () => {
  for (const id of [12358240781, 12364716930, 5886017940]) { // El Carme, La Seu, Ciutat Universitària
    const [lon, lat] = OSM.find((r) => r[2] === id);
    const w = C.lonLatToWorld(lon, lat);
    let baked = false;
    for (let i = 0; i < LAMPS.length; i += 3) if (Math.hypot(LAMPS[i] / 10 - w.x, LAMPS[i + 1] / 10 - w.z) < 0.15) baked = true;
    assert.ok(baked, `OSM ${id} baked`);
    assert.ok(near(w.x, w.z, 4.5, (l) => l.src === 'osm').length >= 1, `OSM ${id} placed within 4.5 m (on its facade or kerb)`);
  }
  // the surveyed big candelabra bases around the Plaça de l'Ajuntament
  const [ax, az] = GEO.points.ajuntament;
  assert.ok(near(ax, az, 120, (l) => l.src === 'ajuntament' && l.type === T.CANDELABRA).length >= 10);
});

test('no cobra heads: only València\'s lamp families, mapped lamps kept', () => {
  assert.deepEqual(LAMP_TYPES, ['wallLantern', 'column', 'candelabra', 'modernWall', 'streetPole', 'avenuePole']);
  assert.ok(lamps.every((l) => l.type >= 0 && l.type < LAMP_TYPES.length));
  assert.ok(stats.data >= LAMPS.length / 3 - 40, `${stats.data} of ${LAMPS.length / 3} mapped lamps placed`);
  assert.ok(lamps.length > 20000 && lamps.length < 45000, `${lamps.length} lamps`);
});

test('standing lamps stand on a kerb island, wall lamps on a real facade', () => {
  const W = new Map();
  for (const w of walls) if (w.front) {
    for (let i = Math.floor(Math.min(w.ax, w.bx) / 20); i <= Math.floor(Math.max(w.ax, w.bx) / 20); i++) {
      for (let j = Math.floor(Math.min(w.az, w.bz) / 20); j <= Math.floor(Math.max(w.az, w.bz) / 20); j++) {
        const k = i + ',' + j;
        if (!W.has(k)) W.set(k, []);
        W.get(k).push(w);
      }
    }
  }
  const onWall = (l) => {
    {
      for (const w of W.get(Math.floor(l.x / 20) + ',' + Math.floor(l.z / 20)) || []) {
        const ex = w.bx - w.ax, ez = w.bz - w.az, L2 = ex * ex + ez * ez;
        const u = ((l.x - w.ax) * ex + (l.z - w.az) * ez) / L2;
        if (u < 0 || u > 1) continue;
        if (Math.hypot(w.ax + ex * u - l.x, w.az + ez * u - l.z) < 0.05) return true;
      }
    }
    return false;
  };
  let off = 0;
  for (const l of lamps) {
    if (l.type === T.WALL_LANTERN || l.type === T.MODERN_WALL) {
      assert.ok(onWall(l), `wall lamp at ${l.x.toFixed(1)}, ${l.z.toFixed(1)} on a facade`);
      assert.ok(l.y >= 3.2 && l.y <= 6.5);
    } else if (!C.blockAt(l.x, l.z)) off++;
  }
  assert.equal(off, 0, 'standing lamps off the kerbs');
});

test('the model follows the area, as on the Street View pairs', () => {
  const share = (x, z, r, types) => { const l = near(x, z, r); return l.filter((q) => types.includes(q.type)).length / Math.max(1, l.length); };
  // El Carme, Carrer de Sant Ramon (viewpoint 01): wall lanterns
  assert.ok(share(87, -1003, 80, [T.WALL_LANTERN]) > 0.6);
  // Gran Via de Ferran el Catòlic (viewpoint 10): candelabras
  assert.ok(near(-610, -1110, 60, (l) => l.type === T.CANDELABRA).length >= 2);
  // Avinguda d'Aragó (viewpoint 19) & Penya-roja (24): steel poles
  assert.ok(share(1591, 468, 80, [T.STREET_POLE, T.AVENUE_POLE, T.MODERN_WALL]) > 0.7);
  assert.ok(share(1620, 2117, 120, [T.STREET_POLE, T.AVENUE_POLE, T.MODERN_WALL]) > 0.7);
  // Arrancapins, Carrer del Marqués de Zenete (viewpoint 13): lantern columns
  assert.ok(near(-1053, 72, 60, (l) => l.type === T.COLUMN).length >= 2);
});
