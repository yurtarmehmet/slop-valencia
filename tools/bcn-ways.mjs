// València's streets from OpenStreetMap in the world frame, with the curb-to-curb roadway and sidewalk widths the
// blocks (bcn-blocks.mjs) and the road graph (bcn-roadgraph.mjs) share, and the Ensanche's chamfered crossings.
import fs from 'node:fs';
import { roadsOSM, toWorld, log } from './bcn-base.mjs';

// Real roadway widths from the Ajuntament's kerb lines (tools/build-kerbs.py): way id -> [left, right half width
// (m) of the roadway from the OpenStreetMap centreline, 1 if a kerb-free shared lane (facade to facade)]
const KERBS = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./data/vlc_kerbs.json', import.meta.url), 'utf8'));
  } catch {
    return {};
  }
})();

const DEG = Math.PI / 180;
export const XAFLA = 9.9; // a chamfer's leg on the building line (m): a 14 m face

// --- Roadways ----------------------------------------------------------------------------------------------------------
// Curb-to-curb width & sidewalk (building line in from the curb) by class, when OpenStreetMap gives no lanes
const CLASS = {
  motorway: [20, 3], motorway_link: [7, 2], trunk: [16, 5], trunk_link: [7, 3], primary: [14, 5], primary_link: [7, 3],
  secondary: [12, 5], secondary_link: [7, 3], tertiary: [10, 5], tertiary_link: [6, 3], unclassified: [8, 3],
  residential: [8, 4], living_street: [5, 1.2], pedestrian: [5, 0.8], busway: [7, 3]
};
// The great avenues mapped as one way: curb-to-curb roadway & sidewalk (their side carriageways are mapped apart)
const WIDE = {
  'Gran Via del Marqués del Túria': [34, 9], 'Gran Via de Ferran el Catòlic': [34, 9], 'Gran Via de les Germanies': [34, 9],
  'Gran Via de Ramón y Cajal': [30, 7], 'Avinguda del Regne de València': [30, 7], 'Carrer de Colón': [16, 6],
  'Carrer de Xàtiva': [20, 6], 'Carrer de Guillem de Castro': [24, 6], "Passeig de l'Albereda": [30, 8],
  'Avinguda de Blasco Ibáñez': [36, 8], 'Avinguda del Port': [28, 6], "Avinguda d'Aragó": [24, 6],
  "Avinguda de l'Oest": [14, 5], 'Carrer de la Pau': [9, 4], 'Avinguda de les Tarongers': [30, 6],
  'Avinguda de Peris i Valero': [28, 6], 'Carrer de Sant Vicent Màrtir': [10, 4], 'Avinguda de Neptú': [14, 10]
};
const TOWN = new Set(['living_street', 'pedestrian']);
const num = (v) => {
  const n = parseFloat(String(v || '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// Ways in world coordinates with their roadway (half width r) and sidewalk
const ways = [];
for (const w of roadsOSM) {
  const t = w.tags;
  if (!CLASS[t.highway]) continue;
  if (t.tunnel && t.tunnel !== 'no') continue;
  // underpasses & flyovers don't bound blocks; the bridges over the Turia's old bed do (they carry the city's streets
  // across the garden: kept at grade so traffic can cross)
  const bridge = t.bridge && t.bridge !== 'no';
  if (num(t.layer) < 0 || (num(t.layer) > 0 && !(bridge && num(t.layer) <= 1))) continue;
  const pts = w.pts.map(([lon, lat]) => toWorld(lon, lat));
  let [width, sidewalk] = CLASS[t.highway];
  const lanes = num(t.lanes);
  if (lanes && !TOWN.has(t.highway)) width = Math.max(width * 0.6, lanes * 3.1 + (lanes >= 2 ? 1.5 : 0.5));
  const tagged = num(t.width);
  if (tagged && tagged > 2 && tagged < 60) width = tagged;
  if (WIDE[t.name] && !(t.oneway === 'yes' && lanes && lanes <= 3)) [width, sidewalk] = WIDE[t.name];
  // Overall heading & length: the Ensanche's streets run along the grid axes
  const [ax, az] = pts[0];
  const [bx, bz] = pts[pts.length - 1];
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const ang = Math.atan2(bz - az, bx - ax);
  const off = Math.abs((((ang % (Math.PI / 2)) + Math.PI * 2.25) % (Math.PI / 2)) - Math.PI / 4);
  const axis = off < 4 * DEG && len > 12 ? (Math.abs(Math.cos(ang)) > 0.7 ? 'x' : 'z') : null;
  // The Ensanche's ordinary streets: about 10 m of roadway between 4-5 m sidewalks, whatever their lanes say
  // (calmed & pedestrian grid streets too: the same width between the building lines)
  const calmed = TOWN.has(t.highway) && axis && len > 60;
  if (axis && !WIDE[t.name] && ((['primary', 'secondary', 'tertiary', 'residential', 'unclassified'].includes(t.highway) && width > 9 && width < 17 && !(lanes > 4)) || calmed)) {
    width = 10;
    sidewalk = 5;
  }
  // Measured kerbs: the roadway's real width, its centre off the OpenStreetMap centreline by `off` (to the right),
  // the building line where it was; a shared lane runs facade to facade with no sidewalk
  let shift = 0;
  let shared = false;
  const k = KERBS[w.id];
  const ruleWidth = width;
  if (k) {
    const line = width / 2 + sidewalk;
    width = k[0] + k[1];
    shift = (k[1] - k[0]) / 2;
    shared = k[2] === 1;
    sidewalk = shared ? 0 : Math.max(0.5, line - width / 2);
  }
  ways.push({ id: w.id, t, pts, r: width / 2, sidewalk, axis, len, town: TOWN.has(t.highway) && !calmed, w: width, lanes, off: shift, shared, kerbs: !!k, ruleWidth });
}
log(`${ways.length} at-grade ways bound the blocks (${ways.filter((w) => w.kerbs).length} at their measured kerbs, ${ways.filter((w) => w.shared).length} shared lanes)`);

// --- Xaflans: the chamfered corners where two of the grid's streets cross ------------------------------------------------
// A building line's corner (Ha, Hb from the crossing: half each street's width to it) is cut by a 45° face about 14 m
// long (smaller than Cerdà's 20 m in Barcelona), i.e. the line |dx| + |dz| = Ha + Hb + 9.9; the curb follows it 5 m in
const nodeWays = new Map();
for (const w of ways) {
  if (!w.axis || w.town) continue;
  w.pts.forEach(([x, z], i) => {
    const k = `${Math.round(x * 10)},${Math.round(z * 10)}`;
    if (!nodeWays.has(k)) nodeWays.set(k, { x, z, list: [] });
    nodeWays.get(k).list.push(w);
  });
}
const chamfers = [];
for (const { x, z, list } of nodeWays.values()) {
  const ax = list.filter((w) => w.axis === 'x');
  const az = list.filter((w) => w.axis === 'z');
  if (!ax.length || !az.length) continue;
  const Ha = Math.min(...ax.map((w) => w.r + w.sidewalk));
  const Hb = Math.min(...az.map((w) => w.r + w.sidewalk));
  const line = Ha + Hb + XAFLA;
  chamfers.push({ x, z, curb: line - 5 * Math.SQRT2, line });
}
log(`${chamfers.length} chamfered grid crossings`);

export { ways, chamfers, CLASS };
