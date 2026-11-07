// Held-out viewpoints, by rule (README.md): for every barri centre inside the detailed city, the nearest point on a
// DIFFERENT street (not the main set's street for that barri) that is at least 150 m from every main viewpoint and
// from every held-out point already chosen, on a street >= 7 m wide or pedestrian, looking along it. Street View
// capture (sv.mjs) then snaps each to its panorama and fills in the pose.
//
// usage: node tools/realism/fidelity/points.mjs [--js <dir with bcn-geodata.js and city-config.js>]
// Reads the frozen game data from .fidelity/baseline-site/js when it exists (so the rule is stable while the game
// changes), else js/. Writes sets.heldout in viewpoints.json (pose v is filled from the unsnapped point; sv.mjs
// rewrites it from the snapped panorama).
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..', '..');
const argJs = process.argv.indexOf('--js');
const base = path.join(ROOT, '.fidelity/baseline-site/js');
const JS = argJs > 0 ? path.resolve(process.argv[argJs + 1]) : fs.existsSync(base) ? base : path.join(ROOT, 'js');
const { GEO } = await import(path.join(JS, 'bcn-geodata.js'));
const C = await import(path.join(JS, 'city-config.js'));
const VPF = path.join(HERE, 'viewpoints.json');
const VP = JSON.parse(fs.readFileSync(VPF, 'utf8'));
const MIN_GAP = 150;

const { lat0, lon0, kx, ky, bearingDeg } = GEO.frame;
const th = bearingDeg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
const toLL = (x, z) => { const e = x * c - z * s, n = -x * s - z * c; return [lon0 + e / kx, lat0 + n / ky]; };
const compass = (dx, dz) => { const de = dx * c - dz * s, dn = -dx * s - dz * c; return ((Math.atan2(de, dn) * 180 / Math.PI) + 360) % 360; };
const D = C.GEO_FRAME_DETAIL;

// road samples every 4 m along every non-highway road, with direction (same as the main set's rule)
const samples = [];
for (const r of C.ROADS) {
  if (r.highway) continue;
  for (let i = 0; i + 1 < r.pts.length; i++) {
    const a = r.pts[i], b = r.pts[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z);
    for (let t = 0; t < L; t += 4) samples.push({ x: a.x + (b.x - a.x) * t / L, z: a.z + (b.z - a.z) * t / L, dx: (b.x - a.x) / L, dz: (b.z - a.z) / L, name: r.name, w: r.w, ped: r.pedestrian });
  }
}
const main = VP.sets.main;
const mainXZ = main.map((p) => ({ x: p.v[0], z: p.v[2] }));
const src = fs.readFileSync(path.join(JS, 'city-config.js'), 'utf8');
const re = /\['([^']+)', (-?[\d.]+), ([\d.]+), '[a-z_]+'\]/g;
const chosen = [];
let m;
while ((m = re.exec(src))) {
  const [, name, lon, lat] = m;
  const { x, z } = C.lonLatToWorld(+lon, +lat);
  if (x < D.x0 || x > D.x1 || z < D.z0 || z > D.z1) continue;
  const mainStreet = main.find((p) => p.kind === 'barri' && p.name === name)?.street;
  const far = (q) => [...mainXZ, ...chosen].every((p) => Math.hypot(p.x - q.x, p.z - q.z) >= MIN_GAP);
  let best = null, bd = Infinity;
  for (const q of samples) {
    if ((q.w < 7 && !q.ped) || !q.name || q.name === mainStreet) continue;
    if (q.x < D.x0 || q.x > D.x1 || q.z < D.z0 || q.z > D.z1) continue;
    const d = (q.x - x) ** 2 + (q.z - z) ** 2;
    if (d < bd && far(q)) { bd = d; best = q; }
  }
  if (!best || Math.sqrt(bd) > 600) { console.error(`skip ${name}: no street within 600 m`); continue; }
  chosen.push({ kind: 'barri2', name, street: best.name, x: best.x, z: best.z, dx: best.dx, dz: best.dz, dist: Math.round(Math.sqrt(bd)) });
}
const heldout = chosen.map((p, i) => {
  const [lon, lat] = toLL(p.x, p.z);
  return { id: 'h' + String(i + 1).padStart(2, '0'), kind: p.kind, name: p.name, street: p.street,
    lat: +lat.toFixed(6), lon: +lon.toFixed(6), heading: +compass(p.dx, p.dz).toFixed(1), fromCentre: p.dist,
    v: [p.x, 2.5, p.z, p.x + p.dx * 30, 2.3, p.z + p.dz * 30].map((v) => +v.toFixed(3)), snapped: false, svDate: null, svPano: null };
});
VP.sets.heldout = heldout;
fs.writeFileSync(VPF, JSON.stringify(VP, null, 1));
console.log(heldout.length, 'held-out viewpoints from', JS);
for (const p of heldout) console.log(p.id, p.name, '|', p.street, `${p.fromCentre} m`, `h${p.heading}`);
