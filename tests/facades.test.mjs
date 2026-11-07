import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';

// València's facade rules (gap #4): balconies by era, the bay rule shared with the facade shader, and no New York fire
// escapes left in the building code
const { hasBalcony, facadeStyle, railStyle, boxBalconies, cableRuns, graffitiLevel } = await import('../js/vlc-facade-rules.js');

const ENSANCHE = { windowWidth: 2.4, floorHeight: 3.5, windowRatioX: 0.42 };

test('balcony rule: never on the ground floor, every bay or a pattern of bays above it', () => {
  for (let mode = 0; mode <= 6; mode++) for (let b = 0; b < 6; b++) assert.equal(hasBalcony(mode, 0, b, 0), false);
  assert.equal([0, 1, 2, 3, 4, 5].filter((b) => hasBalcony(3, 0, b, 2)).length, 3);
  assert.equal([0, 1, 2, 3, 4, 5].filter((b) => hasBalcony(4, 0, b, 2)).length, 2);
  assert.equal(hasBalcony(6, 0, 1, 1), true);
  assert.equal(hasBalcony(6, 0, 1, 2), false);
  assert.equal(hasBalcony(0, 0, 1, 2), false);
});

test('the tsl-materials.js balconyMask spells the same modes', () => {
  const src = fs.readFileSync(new URL('../js/tsl-materials.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function balconyMask'), src.indexOf('function balconyMask') + 700);
  assert.match(body, /is\(1\)\.add\(is\(2\)\)\.add\(is\(5\)\)/);
  assert.match(body, /mod\(bayIdx\.add\(phase\), 2\.0\)/);
  assert.match(body, /mod\(bayIdx\.add\(phase\), 3\.0\)\.sub\(1\.0\)/);
});

test('styles by era: old town and Ensanche always balconied, glass towers never', () => {
  for (let k = 0; k < 50; k++) {
    const r = k / 50;
    assert.ok([1, 2].includes(facadeStyle(1, 1880, 5, r)[0]));
    assert.ok([1, 2].includes(facadeStyle(0, 1925, 6, r)[0]));
    assert.equal(facadeStyle(3, 2005, 20, r)[0], 0);
    const s = facadeStyle(7, 1968, 8, r);
    assert.ok(s[2] >= 0 && s[2] < 1 && s[3] >= 0 && s[3] < 1);
  }
  const shares = (mat, year) => Array.from({ length: 200 }, (_, k) => facadeStyle(mat, year, 7, (k + 0.5) / 200)[0] > 0).filter(Boolean).length / 200;
  assert.ok(shares(7, 1970) > 0.5 && shares(7, 1970) < 0.85, 'about two thirds of 1960s-70s blocks have some balconies');
  assert.ok(shares(8, 2000) < 0.7);
  assert.equal(railStyle(0), 1);
  assert.equal(railStyle(7), 2);
});

test('an Ensanche front of 12 m and 5 storeys gets a balcony at each bay of floors 1-4, on the wall, facing out', () => {
  const item = { x: 100, y: 8.75, z: 50, w: 12, h: 17.5, d: 15, ry: 0, faces: [3, 3, 1, 3], style: [1, 0, 0.5, 0.5], mat: 0 };
  const out = [];
  boxBalconies(item, ENSANCHE, out);
  const n = out.length / 8;
  // 12 m - 2 x 1.2 m piers = 9.6 m -> 4 bays of 2.4 m; 4 upper floors
  assert.equal(n, 16);
  for (let i = 0; i < n; i++) {
    const [x, y, z, ry, w] = out.slice(i * 8, i * 8 + 5);
    assert.ok(Math.abs(z - (50 - 7.5)) < 1e-9, 'on the -z wall');
    assert.ok(x > 100 - 6 + 1.2 && x < 100 + 6 - 1.2, 'between the corner piers');
    assert.equal(Math.round(y / 3.5) * 3.5, y);
    assert.ok(Math.abs(Math.cos(ry) + 1) < 1e-9, 'facing -z');
    assert.ok(w < 2.4 && w > 1);
  }
  // turned a quarter: the same balconies, turned with the box
  const turned = [];
  boxBalconies({ ...item, ry: Math.PI / 2 }, ENSANCHE, turned);
  assert.equal(turned.length, out.length);
  assert.ok(Math.abs(turned[0] - (100 - 7.5)) < 1e-9);
  // a shopfront wall keeps its balconies; party walls and rear walls get none
  // (the -x wall: 15 m - 2.4 m of piers -> 5 bays of 2.52 m)
  assert.equal((() => { const o = []; boxBalconies({ ...item, faces: [0, 3, 3, 3] }, ENSANCHE, o); return o.length / 8; })(), 20);
  assert.equal((() => { const o = []; boxBalconies({ ...item, faces: [2, 3, 3, 3] }, ENSANCHE, o); return o.length; })(), 0);
});

test('no New York fire escapes in the building code', () => {
  const src = fs.readFileSync(new URL('../js/buildings.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /createFireEscapes|fireEscapes/);
});

test('cables (gap #11): along older street fronts just above the ground floor, never on glass or modern fronts', () => {
  const item = { x: 0, y: 8, z: 0, w: 40, h: 16, d: 12, ry: 0.3, faces: [3, 3, 1, 3], mat: 1, year: 1900, fh: 3.2, style: [1, 0, 0.5, 0.5] };
  let runs = 0;
  for (let k = 0; k < 40; k++) {
    const out = [];
    cableRuns({ ...item, x: k * 13.7 }, out, null);
    for (let i = 0; i < out.length; i += 10) {
      runs++;
      assert.ok(out[i + 1] > 2.6 && out[i + 1] < 3.2, 'at the top of the ground floor, under the first-floor balconies');
      assert.ok(Math.hypot(out[i + 3] - out[i], out[i + 5] - out[i + 2]) < 9, 'hooks at most ~7-8 m apart');
      assert.ok(out[i + 7] >= 2 && out[i + 7] <= 3);
    }
  }
  assert.ok(runs > 100, `${runs} spans`);
  for (const mat of [3, 8]) { const o = []; cableRuns({ ...item, mat }, o, null); assert.equal(o.length, 0); }
  const o = []; cableRuns({ ...item, year: 1995 }, o, null); assert.equal(o.length, 0);
  // a cable across the street reaches the facade opposite
  let across = 0;
  for (let k = 0; k < 60; k++) {
    const out = [];
    cableRuns({ ...item, x: k * 9.1 }, out, (x, z, nx, nz) => ({ x: x + nx * 12, z: z + nz * 12, h: 15 }));
    for (let i = 0; i < out.length; i += 10) if (Math.abs(Math.hypot(out[i + 3] - out[i], out[i + 5] - out[i + 2]) - 12) < 1e-6) across++;
  }
  assert.ok(across > 3, `${across} crossings`);
});

test('graffiti by barri: El Carme, Benimaclet & the Cabanyal most, glass towers never', () => {
  assert.ok(graffitiLevel('El Carme', 1900, 1) > 0.6);
  assert.ok(graffitiLevel('Benimaclet', 1960, 7) > 0.6);
  assert.ok(graffitiLevel('Exposició', 2000, 8) < 0.15);
  assert.equal(graffitiLevel('El Carme', 2010, 3), 0);
});
