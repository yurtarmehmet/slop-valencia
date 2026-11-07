import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

// The ground's data files: storm drains (tools/build-drains.py) and road markings (tools/build-markings.py)
const { GEO } = await import('../js/bcn-geodata.js');
const { decodeDrains } = await import('../js/vlc-drains.js');
const { decodeMarkings } = await import('../js/vlc-markings-decode.js');
const read = (name) => {
  const raw = gunzipSync(readFileSync(new URL(`../js/${name}`, import.meta.url)));
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
};
const D = GEO.frame.detail;
const inside = (x, z, m = 20) => x > D.x0 - m && x < D.x1 + m && z > D.z0 - m && z < D.z1 + m;

test('every storm drain of the Ajuntament in the detailed area is baked, at its place', () => {
  const drains = decodeDrains(read('vlc-drains.bin.gz'));
  // embornals-imbornales: 68,152 drains in the city, 41,342 inside the detailed area (vlci.clip_detail), no exclusions
  assert.equal(drains.length, 41342);
  for (const d of drains) {
    assert.ok(inside(d.x, d.z), `drain at ${d.x}, ${d.z} inside the detailed area`);
    assert.ok(d.kind >= 0 && d.kind <= 4);
  }
  // three real drains (objectid: kind, world x, z from the raw dataset)
  for (const [x, z, kind] of [[825.95, 1223.56, 0], [60.79, -1513.7, 0], [-260.76, 2424.39, 2]]) {
    const hit = drains.find((d) => Math.hypot(d.x - x, d.z - z) < 0.2);
    assert.ok(hit, `a drain at ${x}, ${z}`);
    assert.equal(hit.kind, kind);
  }
});

test('the road markings are the city\'s, in its colours, where it painted them', () => {
  const { styles, strokes, polys } = decodeMarkings(read('vlc-markings.bin.gz'));
  assert.ok(strokes.length > 100000 && polys.length > 5000, `${strokes.length} strokes, ${polys.length} polygons`);
  const colour = (s) => `${s.r},${s.g},${s.b}`;
  const YELLOW = '226,178,46';
  const GREEN = '60,150,80';
  // no green paint (the ORA residents' green bays are left out, see the build script)
  assert.ok(!styles.some((s) => colour(s) === GREEN || (s.g > s.r + 30 && s.g > s.b + 30)), 'no green style');
  // yellow is the no-parking, loading & bus-stop paint and yellow box junctions; the dataset's few yellow lines
  // (Linea10/15/40 Amarillo, 123 shapes: kerb-side lines, not centre lines) stay a sliver of it
  const yellowLines = strokes.filter((s) => colour(styles[s.style]) === YELLOW && styles[s.style].kind === 0).length;
  const yellow = strokes.filter((s) => colour(styles[s.style]) === YELLOW).length;
  assert.ok(yellowLines < 200 && yellowLines < yellow * 0.02, `${yellowLines} yellow lines of ${yellow} yellow strokes`);
  for (const s of strokes) {
    assert.ok(s.width > 0.03, `stroke width ${s.width}`); // (a row of parallel lines is one wide dashed stroke)
    assert.ok(inside(s.pts[0], s.pts[1], 200), 'stroke inside the detailed area');
  }
  // the nearest marking of a colour to a point
  const near = (x, z, rgb) => {
    let best = Infinity;
    for (const s of strokes) {
      if (colour(styles[s.style]) !== rgb) continue;
      const p = s.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], az = p[i + 1], bx = p[i + 2], bz = p[i + 3];
        const L2 = (bx - ax) ** 2 + (bz - az) ** 2 || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / L2));
        best = Math.min(best, Math.hypot(ax + t * (bx - ax) - x, az + t * (bz - az) - z));
      }
    }
    return best;
  };
  const WHITE = '232,230,222';
  // four real markings (centre of the painted shape, world metres, from the raw dataset)
  assert.ok(near(4165.31, 1268.5, WHITE) < 0.4, 'zebra stripe on Carrer de Sant Joan de Déu');
  assert.ok(near(-1301.86, -1687.68, WHITE) < 0.4, 'lane line on Carrer del Marqués de Sant Joan');
  assert.ok(near(-1499.31, -1560.83, YELLOW) < 0.4, 'no-parking line on Carrer de Manuel de Falla');
  assert.ok(near(593.07, -1691.66, WHITE) < 0.4, 'bus lane line on Carrer de Reus');
});
