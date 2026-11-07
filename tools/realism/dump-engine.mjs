// Dump what slop-valencia's engine builds today in the detailed city: per block, the expected storeys (buildings.js
// profile rules) and its built-coverage polygons (lot rects, frontage-frame rects, illa rings) in world metres.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const repo = process.argv[2];
const { BLOCKS } = await import(pathToFileURL(`${repo}/js/city-config.js`).href);
const { GEO } = await import(pathToFileURL(`${repo}/js/bcn-geodata.js`).href);
// buildings.js profiles (floors ranges) by district, and the block-storeys rule
const PROF = { gotic: [4, 6], raval: [4, 6], born: [4, 6], barceloneta: [4, 5], gracia: [3, 5], sant_gervasi: [3, 5],
  sants: [5, 7], poble_sec: [5, 7], sant_antoni: [5, 7], montjuic: [5, 7], poblenou: [3, 7], vila_olimpica: [10, 20],
  glories: [6, 8], eixample: [6, 8] };
const out = [];
for (const b of BLOCKS) {
  if (b.park > 0.6 || b.median) continue;
  const fl = b.illa ? [6, 8] : PROF[b.district] || [6, 8];
  const s = b.storeys[0];
  const expFloors = s >= 2 ? Math.max(2, Math.min(fl[1] + 2, s)) : (fl[0] + fl[1]) / 2;
  const polys = [];
  for (const [x0, x1, z0, z1] of b.rects) polys.push([[x0, z0], [x1, z0], [x1, z1], [x0, z1]]);
  for (const [th, px, pz, rects] of b.frames || []) {
    const c = Math.cos(th), sn = Math.sin(th);
    // world = p + R_y(θ)·(local − p): R_y maps (x, z) -> (x cos + z sin, -x sin + z cos)
    const w = ([x, z]) => [px + (x - px) * c + (z - pz) * sn, pz - (x - px) * sn + (z - pz) * c];
    for (const [x0, x1, z0, z1] of rects) polys.push([[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(w));
  }
  let ring = null;
  if (b.illa) { const [x0, x1, z0, z1] = b.illa; ring = { outer: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], inner: [[x0 + 22, z0 + 22], [x1 - 22, z0 + 22], [x1 - 22, z1 - 22], [x0 + 22, z1 - 22]] }; }
  out.push({ id: b.id, district: b.district, illa: !!b.illa, osmStoreys: s, expFloors, poly: b.poly.map((p) => [p.x, p.z]), lots: polys, ring });
}
fs.writeFileSync(process.argv[3], JSON.stringify({ frame: GEO.frame, blocks: out }));
console.log(`${out.length} built blocks dumped`);
