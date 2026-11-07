import * as THREE from 'three/webgpu';
import { attribute, vertexColor, mix } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BLOCKS, blockAt, ISLAND_BOUNDS } from './city-config.js';
import {
  SIGN_SIZE, SIGN_CLEAR, SIGN_EMT, createSignPlateGeometry, createSignPlateMaterial, createSignPoleGeometry,
  createSignPoleMaterial
} from './vlc-signs.js';

// València's street furniture and traffic signs (gap #5 of docs/fidelity-gaps.md), from js/vlc-furniture.bin.gz
// (tools/build-furniture.py): every waste container, glass igloo, litter bin, bench, bike rack, EMT stop, drinking
// fountain, kiosk and retractable bollard of the Ajuntament's inventories (CC BY 4.0) at its surveyed place, and the
// traffic signs the build places by rule. Our own models, after how they look in València.
//
// Placement against the game's kerbs (city-config.js BLOCKS): containers and igloos stand in the parking lane, side on
// to the nearest kerb, a row of them laid out without overlapping; sidewalk furniture and sign poles are kept on the
// sidewalk at their distance from the kerb (moved in from the roadway where the game's kerb runs inside the real one).
// Everything is instanced per model and cut into 200 m cells, each hidden beyond its model's draw distance (update()).

export const KIND = { container: 0, igloo: 1, bin: 2, bench: 3, rack: 4, emt: 5, fountain: 6, kiosk: 7, bollard: 8, sign: 9 };
const RECORD = 8;

/** Decodes the VLF1 records: { count, x, z (Float32Array, m), kind, variant, yaw (Uint8Array), extra (Uint8Array) } */
export function decodeFurniture(bytes) {
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (tag !== 'VLF1') throw new Error('Invalid furniture data.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4, true);
  const out = {
    count,
    x: new Float32Array(count), z: new Float32Array(count),
    kind: new Uint8Array(count), variant: new Uint8Array(count), yaw: new Uint8Array(count), extra: new Uint8Array(count)
  };
  for (let i = 0, o = 8; i < count; i++, o += RECORD) {
    out.x[i] = view.getInt16(o, true) / 4;
    out.z[i] = view.getInt16(o + 2, true) / 4;
    out.kind[i] = bytes[o + 4];
    out.variant[i] = bytes[o + 5];
    out.yaw[i] = bytes[o + 6];
    out.extra[i] = bytes[o + 7];
  }
  return out;
}

async function loadFurniture() {
  const response = await fetch(new URL('./vlc-furniture.bin.gz', import.meta.url));
  if (!response.ok) throw new Error(`Furniture data request failed: ${response.status}`);
  const body = new Uint8Array(await response.arrayBuffer());
  const data = body[0] === 0x1f && body[1] === 0x8b
    ? new Uint8Array(await new Response(new Response(body).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    : body;
  return decodeFurniture(data);
}

// ---------------------------------------------------------------------------------------------------------------------
// Kerbs: every edge of the game's curb islands, indexed in 16 m cells
// ---------------------------------------------------------------------------------------------------------------------
const KCELL = 16;
function buildKerbIndex() {
  const segs = []; // [ax, az, bx, bz, nx, nz (outward, toward the road), median]
  const grid = new Map();
  for (const b of BLOCKS) {
    const p = b.poly;
    let a2 = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) a2 += p[j].x * p[i].z - p[i].x * p[j].z;
    const s = a2 > 0 ? 1 : -1;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const A = p[j], B = p[i];
      const ex = B.x - A.x, ez = B.z - A.z;
      const L = Math.hypot(ex, ez);
      if (L < 0.3) continue;
      const id = segs.length;
      segs.push([A.x, A.z, B.x, B.z, (ez / L) * s, (-ex / L) * s, b.median ? 1 : 0]);
      const x0 = Math.floor((Math.min(A.x, B.x) - 1) / KCELL), x1 = Math.floor((Math.max(A.x, B.x) + 1) / KCELL);
      const z0 = Math.floor((Math.min(A.z, B.z) - 1) / KCELL), z1 = Math.floor((Math.max(A.z, B.z) + 1) / KCELL);
      for (let ix = x0; ix <= x1; ix++) {
        for (let iz = z0; iz <= z1; iz++) {
          const k = ix * 65536 + iz;
          let list = grid.get(k);
          if (!list) grid.set(k, (list = []));
          list.push(id);
        }
      }
    }
  }
  const hit = { d: 0, px: 0, pz: 0, nx: 0, nz: 0, tx: 0, tz: 0, seg: -1, t: 0 };
  // Nearest kerb edge to (x, z) within maxd (m): the point on it, its outward normal and tangent; null if none
  function nearest(x, z, maxd, skipMedians = false) {
    let best = maxd * maxd;
    let found = -1;
    const r = Math.ceil(maxd / KCELL);
    const cx = Math.floor(x / KCELL), cz = Math.floor(z / KCELL);
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const list = grid.get(ix * 65536 + iz);
        if (!list) continue;
        for (const id of list) {
          const s = segs[id];
          if (skipMedians && s[6]) continue;
          const ex = s[2] - s[0], ez = s[3] - s[1];
          const L2 = ex * ex + ez * ez;
          const t = Math.max(0, Math.min(1, ((x - s[0]) * ex + (z - s[1]) * ez) / L2));
          const px = s[0] + ex * t, pz = s[1] + ez * t;
          const d2 = (px - x) ** 2 + (pz - z) ** 2;
          if (d2 < best) {
            best = d2;
            found = id;
            hit.px = px; hit.pz = pz; hit.t = t * Math.sqrt(L2);
          }
        }
      }
    }
    if (found < 0) return null;
    const s = segs[found];
    hit.d = Math.sqrt(best);
    hit.nx = s[4]; hit.nz = s[5];
    hit.tx = -s[5]; hit.tz = s[4];
    hit.seg = found;
    return hit;
  }
  return { nearest, segs };
}

const groundAt = (x, z) => {
  const b = blockAt(x, z);
  if (!b) return 0;
  return b.park > 0.6 ? ISLAND_BOUNDS.parkPavingHeight : ISLAND_BOUNDS.sidewalkHeight;
};

// ---------------------------------------------------------------------------------------------------------------------
// Models: merged vertex-coloured parts; `tint` parts take the instance's colour (container lids, bin bodies, slats)
// ---------------------------------------------------------------------------------------------------------------------
const _c = new THREE.Color();
function part(geo, hex, tint = 0) {
  const g = geo.index ? geo : geo;
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  _c.setHex(hex);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([_c.r, _c.g, _c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('tintMask', new THREE.BufferAttribute(new Float32Array(n).fill(tint), 1));
  return g.index ? g : g;
}
const box = (w, h, d, x, y, z, hex, tint = 0) => part(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex, tint);
const cyl = (r0, r1, h, seg, x, y, z, hex, tint = 0) => part(new THREE.CylinderGeometry(r0, r1, h, seg).translate(x, y, z), hex, tint);
const merge = (parts) => {
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
};

const DARK = 0x2d3033;
const BODY = 0x3d4245; // València's containers: charcoal grey bodies under the coloured lids
const GALV = 0x9ea4a7;

// Lid colours per waste fraction (0 rest, 1 paper & card, 2 light packaging, 3 organic)
const LID = [0x6d7376, 0x2368c4, 0xf0c419, 0x7a4f2e];

function containerSideLoader() {
  // 3,200 l side-loaded container, long side (x, 1.8 m) along the kerb, the loading side (+z) to the road
  const L = 1.8, D = 1.45, H = 1.42;
  const lid = new THREE.CylinderGeometry(D / 2, D / 2, L, 14, 1, false, -Math.PI / 2, Math.PI);
  lid.rotateZ(Math.PI / 2).scale(1, 0.32, 1).translate(0, H, 0);
  return merge([
    box(L, H - 0.12, D, 0, 0.12 + (H - 0.12) / 2, 0, BODY),
    box(L + 0.04, 0.05, D + 0.04, 0, H, 0, BODY),
    part(lid, 0xffffff, 1),
    box(L - 0.2, 0.05, 0.06, 0, H - 0.25, D / 2 + 0.02, 0xffffff, 1), // coloured band under the lid
    ...[-1, 1].flatMap((s) => [
      box(0.1, 0.12, 0.1, s * (L / 2 - 0.12), 0.06, D / 2 - 0.15, DARK),
      box(0.1, 0.12, 0.1, s * (L / 2 - 0.12), 0.06, -D / 2 + 0.15, DARK),
      // red and white reflective chevrons on the front corners
      box(0.09, 0.42, 0.012, s * (L / 2 - 0.06), 0.62, D / 2 + 0.006, 0xd8262c),
      box(0.09, 0.14, 0.014, s * (L / 2 - 0.06), 0.62, D / 2 + 0.008, 0xf2f2f2),
      box(0.012, 0.42, 0.09, s * (L / 2 + 0.006), 0.62, D / 2 - 0.06, 0xd8262c)
    ]),
    box(0.26, 0.26, 0.012, 0.35, 0.95, D / 2 + 0.006, 0xeeeeee) // no-parking sticker
  ]);
}

function containerRearLoader() {
  // 1,100 l four-wheel container, domed lid, loaded from its short end
  const L = 1.37, D = 1.08, H = 1.15;
  const lid = new THREE.CylinderGeometry(D / 2, D / 2, L, 12, 1, false, -Math.PI / 2, Math.PI);
  lid.rotateZ(Math.PI / 2).scale(1, 0.38, 1).translate(0, H, 0);
  return merge([
    box(L - 0.06, H - 0.3, D - 0.06, 0, 0.3 + (H - 0.3) / 2, 0, BODY),
    box(L, 0.06, D, 0, H - 0.02, 0, BODY),
    part(lid, 0xffffff, 1),
    ...[-1, 1].flatMap((s) => [-1, 1].map((t) => cyl(0.1, 0.1, 0.06, 8, s * (L / 2 - 0.15), 0.1, t * (D / 2 - 0.15), 0x1c1c1c))),
    box(0.012, 0.32, 0.12, L / 2 - 0.02, 0.6, D / 2 - 0.08, 0xd8262c),
    box(0.012, 0.32, 0.12, L / 2 - 0.02, 0.6, -D / 2 + 0.08, 0xd8262c)
  ]);
}

function containerUnderground() {
  // the steel mouth of an underground bin
  return merge([
    box(0.6, 1.0, 0.6, 0, 0.5, 0, 0x8d9396),
    box(0.64, 0.12, 0.64, 0, 1.06, 0, 0xffffff, 1),
    box(0.5, 0.02, 0.5, 0, 0.005, 0, 0x5a5f62)
  ]);
}

function igloo() {
  // 3 m³ glass bell: green, with its lifting knob and a white label
  const prof = [[0, 0], [0.82, 0], [0.84, 0.08], [0.8, 0.9], [0.66, 1.35], [0.4, 1.58], [0.14, 1.66], [0, 1.67]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const bell = new THREE.LatheGeometry(prof, 16);
  return merge([
    part(bell, 0x5fa35c),
    cyl(0.07, 0.07, 0.16, 8, 0, 1.74, 0, 0x2f2f2f),
    cyl(0.16, 0.16, 0.05, 10, 0, 1.83, 0, 0x2f2f2f),
    box(0.42, 0.3, 0.05, 0, 0.95, 0.79, 0xf2f2ee)
  ]);
}

function binHanging(post) {
  // 50 l cylinder hung from a post (the instance colour paints the bin)
  const parts = [
    part(new THREE.CylinderGeometry(0.2, 0.18, 0.5, 14, 1, true).translate(0, 0.62, 0.24), 0xffffff, 1),
    cyl(0.18, 0.18, 0.02, 14, 0, 0.38, 0.24, 0x333333),
    part(new THREE.TorusGeometry(0.2, 0.015, 4, 16).rotateX(Math.PI / 2).translate(0, 0.87, 0.24), 0x3a3d40)
  ];
  if (post) parts.push(cyl(0.035, 0.035, 1.15, 8, 0, 0.575, 0, GALV), box(0.06, 0.08, 0.06, 0, 0.75, 0.05, 0x3a3d40));
  return merge(parts);
}

function binStanding() {
  // 80-120 l standing bin
  return merge([
    cyl(0.28, 0.25, 0.9, 14, 0, 0.45, 0, 0xffffff, 1),
    cyl(0.3, 0.3, 0.08, 14, 0, 0.94, 0, 0x2c2f31)
  ]);
}

function binPedestal() {
  // cast-iron basket on a fluted pedestal (Salamanca, cesta)
  return merge([
    cyl(0.12, 0.16, 0.08, 10, 0, 0.04, 0, 0x26282a),
    cyl(0.045, 0.06, 0.45, 8, 0, 0.3, 0, 0x26282a),
    part(new THREE.CylinderGeometry(0.24, 0.19, 0.48, 12, 1, true).translate(0, 0.76, 0), 0x26282a),
    cyl(0.19, 0.19, 0.02, 12, 0, 0.53, 0, 0x26282a)
  ]);
}

function binDoublePost() {
  // steel basket between two posts (Hamburger)
  return merge([
    cyl(0.03, 0.03, 1.0, 8, -0.3, 0.5, 0, 0x2a2c2e),
    cyl(0.03, 0.03, 1.0, 8, 0.3, 0.5, 0, 0x2a2c2e),
    part(new THREE.CylinderGeometry(0.24, 0.2, 0.5, 12, 1, true).translate(0, 0.68, 0), 0x6a6f72)
  ]);
}

function benchSlats() {
  // the city's standard bench (Mediterráneo): wooden slats on two cast-iron side frames, back to -z
  const L = 1.8;
  const parts = [];
  for (let i = 0; i < 4; i++) parts.push(box(L, 0.035, 0.085, 0, 0.44, 0.2 - i * 0.11, 0xffffff, 1));
  for (let i = 0; i < 3; i++) {
    const g = new THREE.BoxGeometry(L, 0.085, 0.035).rotateX(-0.25).translate(0, 0.58 + i * 0.12, -0.2 - i * 0.03);
    parts.push(part(g, 0xffffff, 1));
  }
  for (const s of [-1, 1]) {
    const x = s * (L / 2 - 0.15);
    parts.push(
      box(0.06, 0.42, 0.06, x, 0.21, 0.18, 0x2b2b2b),
      box(0.06, 0.82, 0.06, x, 0.41, -0.2, 0x2b2b2b),
      box(0.06, 0.05, 0.48, x, 0.4, 0, 0x2b2b2b),
      box(0.06, 0.05, 0.4, x, 0.66, 0.06, 0x2b2b2b) // arm rest
    );
  }
  return merge(parts);
}

function benchStone() {
  return merge([box(1.8, 0.45, 0.5, 0, 0.225, 0, 0xc4bcaf)]);
}

function bikeHoop() {
  // galvanised inverted U, 0.75 m tall, 0.7 m long, across the kerb (z)
  return merge([
    cyl(0.025, 0.025, 0.7, 6, 0, 0.35, -0.3, GALV),
    cyl(0.025, 0.025, 0.7, 6, 0, 0.35, 0.3, GALV),
    part(new THREE.TorusGeometry(0.3, 0.025, 5, 10, Math.PI).rotateY(Math.PI / 2).translate(0, 0.7, 0), GALV)
  ]);
}

function emtShelter() {
  // bus shelter: glass back to the buildings (-z), flat roof, bench, an end panel; open to the road (+z)
  const L = 3.6, D = 1.5, H = 2.45;
  return merge([
    box(L + 0.2, 0.1, D + 0.15, 0, H, 0, 0xdedfe0),
    box(L, 1.95, 0.03, 0, 1.12, -D / 2 + 0.1, 0x7d93a0),
    box(0.03, 1.95, D - 0.3, L / 2, 1.12, -0.1, 0x7d93a0),
    box(1.2, 1.8, 0.14, -L / 2 + 0.6, 1.1, D / 2 - 0.12, 0xf0f0ec), // end panel (plain)
    ...[-1, 1].map((s) => box(0.08, H, 0.08, s * L / 2, H / 2, -D / 2 + 0.1, 0x3c4145)),
    box(0.08, H, 0.08, -L / 2 + 1.2, H / 2, D / 2 - 0.12, 0x3c4145),
    box(1.6, 0.05, 0.36, 0.6, 0.48, -D / 2 + 0.32, 0x9aa0a3),
    box(0.05, 0.46, 0.05, 0.0, 0.23, -D / 2 + 0.32, 0x3c4145),
    box(0.05, 0.46, 0.05, 1.2, 0.23, -D / 2 + 0.32, 0x3c4145)
  ]);
}

function emtPole() {
  // stop pole with the timetable box (the flag plate is a sign instance)
  return merge([
    cyl(0.045, 0.045, 3.0, 8, 0, 1.5, 0, 0x3c4145),
    box(0.4, 0.62, 0.08, 0, 1.45, 0.07, 0xe9e9e4),
    box(0.42, 0.04, 0.1, 0, 1.78, 0.07, 0xc8222c)
  ]);
}

function fountain() {
  // the city's drinking fountain: dark cast-iron column with a tap over a little basin
  return merge([
    cyl(0.24, 0.27, 0.12, 12, 0, 0.06, 0, 0x2f3734),
    cyl(0.1, 0.13, 0.95, 10, 0, 0.6, 0, 0x2f3734),
    cyl(0.14, 0.1, 0.1, 10, 0, 1.11, 0, 0x2f3734),
    box(0.05, 0.05, 0.16, 0, 0.98, 0.14, 0x9c8b5a),
    cyl(0.17, 0.12, 0.08, 12, 0, 0.32, 0.22, 0x2f3734)
  ]);
}

function kioskOnce() {
  // lottery booth, plain (no logo): cream panels, glass band to the front (+z)
  return merge([
    box(1.6, 2.3, 1.3, 0, 1.15, 0, 0xe6e2d6),
    box(1.3, 0.75, 0.04, 0, 1.45, 0.66, 0x34414a),
    box(1.8, 0.12, 1.5, 0, 2.36, 0, 0x7f8487),
    box(1.6, 0.3, 0.04, 0, 2.1, 0.66, 0xd8d4c8)
  ]);
}

function kioskNews(hex) {
  return merge([
    box(2.6, 2.2, 1.7, 0, 1.1, 0, hex),
    box(2.2, 1.0, 0.04, 0, 1.4, 0.86, 0x2c3338),
    box(3.0, 0.14, 2.1, 0, 2.3, 0.1, 0x353b3f),
    box(2.6, 0.3, 0.05, 0, 0.3, 0.87, 0x2a2e31)
  ]);
}

function kioskFlowers() {
  // the Plaça de l'Ajuntament flower stalls: dark timber posts, cream panels, a copper-brown pyramid roof
  const roof = new THREE.ConeGeometry(1.75, 0.55, 4).rotateY(Math.PI / 4).translate(0, 2.68, 0);
  return merge([
    box(2.2, 2.2, 2.2, 0, 1.1, 0, 0xcbbfa6),
    ...[-1, 1].flatMap((s) => [-1, 1].map((t) => box(0.14, 2.3, 0.14, s * 1.08, 1.15, t * 1.08, 0x3f2d22))),
    box(2.5, 0.16, 2.5, 0, 2.38, 0, 0x3f2d22),
    part(roof, 0x7b4b34),
    cyl(0.05, 0.05, 0.3, 6, 0, 3.05, 0, 0x7b4b34)
  ]);
}

function bollard() {
  return merge([
    cyl(0.1, 0.1, 0.8, 10, 0, 0.4, 0, 0xb4babd),
    cyl(0.102, 0.102, 0.06, 10, 0, 0.68, 0, 0xc8262c),
    cyl(0.16, 0.16, 0.02, 10, 0, 0.01, 0, 0x6c7174)
  ]);
}

// Litter-bin body colours per shape: grey steel, green, yellow, dark green standing bins
const BIN_TINT = [0x4c5155, 0x2f6a3c, 0xe8c21a, 0x2f4a38];
// Slat colours per bench model: Mediterráneo, chair, -, Romántico, timber, Neobarcino, metal
const SLAT_TINT = [0x8b5a36, 0x8b5a36, 0, 0x6b4a32, 0x9a6a40, 0x7c5234, 0x6f767a];

// ---------------------------------------------------------------------------------------------------------------------
// Instancing: per model, a list of instances; chunked into cells at the end
// ---------------------------------------------------------------------------------------------------------------------
const CELL = 200;

/**
 * Where everything stands in the game: { key (model), x, y, z, yaw, sx, sy, sz, tint (hex or null), extra }, from the
 * decoded records and the game's kerbs (see the header). No three.js here: tests run it in Node.
 */
export function placeFurniture(data) {
  const kerbs = buildKerbIndex();
  const items = [];
  const push = (key, x, y, z, yaw, sx = 1, sy = 1, sz = 1, tint = null, extra = null) => {
    items.push({ key, x, y, z, yaw, sx, sy, sz, tint, extra });
  };
  const yawOf = (dx, dz) => Math.atan2(dx, dz); // the yaw turning local +z onto (dx, dz)

  // Sidewalk placement: on the curb island, at least `inset` m in from its edge; from the roadway only when the
  // game's kerb is within `reach` m (its sidewalk narrower than the real one), else left where the data has it
  const onSidewalk = (x, z, inset, reach = 5) => {
    const k = kerbs.nearest(x, z, reach + inset + 1);
    if (!k) return { x, z, k: null };
    const inside = !!blockAt(x, z);
    if (!inside && k.d > reach) return { x, z, k: null };
    if (!inside || k.d < inset) {
      return { x: k.px - k.nx * inset, z: k.pz - k.nz * inset, k: { ...k } };
    }
    return { x, z, k: { ...k } };
  };

  // --- Containers and igloos: in the parking lane, side on to the kerb, rows without overlaps ------------------------
  const rows = new Map(); // kerb segment -> [{ t, len, depth, key, tint, ...}]
  const loose = [];
  for (let i = 0; i < data.count; i++) {
    const kind = data.kind[i];
    if (kind !== KIND.container && kind !== KIND.igloo) continue;
    const x = data.x[i], z = data.z[i];
    let key, len, depth, tint = null;
    if (kind === KIND.igloo) {
      key = 'igloo'; len = 1.75; depth = 1.7;
    } else {
      const body = data.variant[i] >> 2;
      tint = LID[data.variant[i] & 3];
      if (body === 2) { key = 'underground'; len = 0.7; depth = 0.7; }
      else if (body === 1) { key = 'rearLoader'; len = 1.4; depth = 1.1; }
      else { key = 'sideLoader'; len = 1.84; depth = 1.5; }
    }
    if (key === 'underground') {
      const p = onSidewalk(x, z, 0.6);
      loose.push({ key, x: p.x, z: p.z, yaw: p.k ? yawOf(p.k.nx, p.k.nz) : 0, tint });
      continue;
    }
    const k = kerbs.nearest(x, z, 10, true);
    const inside = !!blockAt(x, z);
    if (!k || (inside && k.d > 5)) {
      // a square, a pedestrian street or an open area: where the data has it, square to the nearest kerb
      loose.push({ key, x, z, yaw: k ? yawOf(k.nx, k.nz) : 0, tint });
      continue;
    }
    let row = rows.get(k.seg);
    if (!row) rows.set(k.seg, (row = []));
    // its distance out from the game's kerb (negative: the game's sidewalk covers the real parking lane)
    row.push({ key, t: k.t, out: inside ? -k.d : k.d, len, depth, tint, order: i });
  }
  for (const [seg, row] of rows) {
    const s = kerbs.segs[seg];
    const ex = s[2] - s[0], ez = s[3] - s[1];
    const L = Math.hypot(ex, ez);
    const tx = ex / L, tz = ez / L, nx = s[4], nz = s[5];
    row.sort((a, b) => a.t - b.t || a.order - b.order);
    // clusters: containers whose footprints touch or nearly do
    let c0 = 0;
    for (let i = 1; i <= row.length; i++) {
      if (i < row.length && row[i].t - row[i - 1].t < (row[i].len + row[i - 1].len) / 2 + 0.9) continue;
      const cl = row.slice(c0, i);
      const total = cl.reduce((a, c) => a + c.len, 0) + 0.15 * (cl.length - 1);
      const mid = cl.reduce((a, c) => a + c.t, 0) / cl.length;
      // the row keeps the real distance from the kerb while that leaves it in the parking lane, by the kerb
      const out = cl.reduce((a, c) => a + c.out, 0) / cl.length;
      let at = mid - total / 2;
      for (const c of cl) {
        const t = at + c.len / 2;
        at += c.len + 0.15;
        const off = Math.min(c.depth / 2 + 0.9, Math.max(c.depth / 2 + 0.2, out));
        const x = s[0] + tx * t + nx * off, z = s[1] + tz * t + nz * off;
        loose.push({ key: c.key, x, z, yaw: yawOf(nx, nz), tint: c.tint, road: true });
      }
      c0 = i;
    }
  }
  // Rows that meet across a kerb corner, and containers surveyed at the same point in a square: slide each one along
  // its own row (local x) until it clears those already placed
  const LEN = { sideLoader: 1.84, rearLoader: 1.4, igloo: 1.75, underground: 0.7 };
  const placed = new Map();
  const cellOf = (x, z) => Math.floor(x / 4) * 65536 + Math.floor(z / 4);
  for (const c of loose) {
    const r = LEN[c.key] / 2;
    const ux = Math.cos(c.yaw), uz = -Math.sin(c.yaw);
    for (let step = 0; step < 12; step++) {
      let hit = null;
      const k = cellOf(c.x, c.z);
      for (let a = -1; a <= 1 && !hit; a++) {
        for (let b = -1; b <= 1 && !hit; b++) {
          for (const o of placed.get(k + a * 65536 + b) || []) {
            if (Math.hypot(o.x - c.x, o.z - c.z) < o.r + r + 0.1) { hit = o; break; }
          }
        }
      }
      if (!hit) break;
      const side = (c.x - hit.x) * ux + (c.z - hit.z) * uz >= 0 ? 1 : -1;
      c.x += ux * side * 0.5;
      c.z += uz * side * 0.5;
    }
    const k = cellOf(c.x, c.z);
    if (!placed.has(k)) placed.set(k, []);
    placed.get(k).push({ x: c.x, z: c.z, r });
  }
  for (const c of loose) {
    const y = c.road ? 0 : groundAt(c.x, c.z);
    push(c.key, c.x, y, c.z, c.yaw, 1, 1, 1, c.tint);
  }

  // --- Sidewalk furniture and signs ----------------------------------------------------------------------------------
  const signPole = (x, y, z, yaw, cell) => {
    const size = SIGN_SIZE[cell];
    const top = SIGN_CLEAR + size;
    push('signPole', x, y, z, 0, 1, top + 0.08, 1);
    const fx = Math.sin(yaw) * 0.045, fz = Math.cos(yaw) * 0.045;
    push('signPlate', x + fx, y + SIGN_CLEAR + size / 2, z + fz, yaw, size, size, 1, null, cell);
  };
  for (let i = 0; i < data.count; i++) {
    const kind = data.kind[i];
    const x0 = data.x[i], z0 = data.z[i], v = data.variant[i], ex = data.extra[i];
    switch (kind) {
      case KIND.bin: {
        const mount = ex & 7;
        const p = onSidewalk(x0, z0, mount === 5 ? 0.3 : 0.45);
        const y = groundAt(p.x, p.z);
        // hung bins face the road from their post
        const yaw = p.k ? yawOf(p.k.nx, p.k.nz) : 0;
        if (v <= 2) push(mount === 5 ? 'binWall' : 'binPost', p.x, y, p.z, yaw, 1, 1, 1, BIN_TINT[v]);
        else if (v === 3) push('binStanding', p.x, y, p.z, yaw, 1, 1, 1, BIN_TINT[3]);
        else if (v === 4) push('binPedestal', p.x, y, p.z, yaw);
        else push('binDouble', p.x, y, p.z, yaw + Math.PI / 2 * 0, 1, 1, 1);
        break;
      }
      case KIND.bench: {
        const p = onSidewalk(x0, z0, 0.9);
        const y = groundAt(p.x, p.z);
        // along the kerb, back to the road when close to it; otherwise turned like the nearest kerb
        const yaw = p.k ? yawOf(-p.k.nx, -p.k.nz) : 0;
        if (v === 2) push('benchStone', p.x, y, p.z, yaw);
        else push('bench', p.x, y, p.z, yaw, v === 1 ? 0.36 : 1, 1, 1, SLAT_TINT[v] || SLAT_TINT[0]);
        break;
      }
      case KIND.rack: {
        const p = onSidewalk(x0, z0, 0.8);
        const y = groundAt(p.x, p.z);
        const hoops = Math.max(1, ex & 127);
        const tx = p.k ? p.k.tx : 1, tz = p.k ? p.k.tz : 0;
        const yaw = p.k ? yawOf(p.k.nx, p.k.nz) : 0;
        const step = v === 1 ? 0.6 : 0.85;
        for (let h = 0; h < hoops; h++) {
          const o = (h - (hoops - 1) / 2) * step;
          push('hoop', p.x + tx * o, y, p.z + tz * o, yaw);
        }
        break;
      }
      case KIND.emt: {
        if (v === 1) {
          const p = onSidewalk(x0, z0, 1.1);
          push('shelter', p.x, groundAt(p.x, p.z), p.z, p.k ? yawOf(p.k.nx, p.k.nz) : 0);
        } else {
          const p = onSidewalk(x0, z0, 0.45);
          const y = groundAt(p.x, p.z);
          // the flag looks along the street, toward the oncoming bus
          const yaw = p.k ? yawOf(p.k.tx, p.k.tz) : 0;
          push('emtPole', p.x, y, p.z, yaw);
          push('signPlate', p.x + Math.sin(yaw) * 0.05, y + 2.55, p.z + Math.cos(yaw) * 0.05, yaw, 0.6, 0.6, 1, null, SIGN_EMT);
        }
        break;
      }
      case KIND.fountain: {
        const p = onSidewalk(x0, z0, 0.6, 3);
        push('fountain', p.x, groundAt(p.x, p.z), p.z, p.k ? yawOf(-p.k.nx, -p.k.nz) : 0);
        break;
      }
      case KIND.kiosk: {
        const p = onSidewalk(x0, z0, v === 0 ? 1.0 : 1.5, 4);
        const key = ['kioskOnce', 'kioskNews', 'kioskNews2', 'kioskFlowers'][v] || 'kioskOnce';
        push(key, p.x, groundAt(p.x, p.z), p.z, p.k ? yawOf(p.k.nx, p.k.nz) : 0);
        break;
      }
      case KIND.bollard: {
        const p = onSidewalk(x0, z0, 0.3, 3);
        push('bollard', p.x, groundAt(p.x, p.z), p.z, 0);
        break;
      }
      case KIND.sign: {
        const p = onSidewalk(x0, z0, 0.35, 6);
        const yaw = (data.extra[i] & 128) ? (data.yaw[i] / 256) * Math.PI * 2 : (p.k ? yawOf(p.k.tx, p.k.tz) : 0);
        signPole(p.x, groundAt(p.x, p.z), p.z, yaw, v);
        break;
      }
    }
  }

  return items;
}

export async function buildFurniture(scene) {
  const data = await loadFurniture();
  const group = new THREE.Group();
  group.name = 'VlcFurniture';

  const baseMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.12 });
  baseMat.name = 'FurnitureVertexColour';
  const tintMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.1 });
  tintMat.colorNode = mix(vertexColor().rgb, attribute('tint', 'vec3'), attribute('tintMask', 'float'));
  tintMat.name = 'FurnitureTinted';

  const models = {};
  const model = (key, geometry, material, { cull = 250, shadow = false, tinted = false } = {}) => {
    models[key] = { key, geometry, material, cull, shadow, tinted, list: [] };
  };
  model('sideLoader', containerSideLoader(), tintMat, { cull: 260, shadow: true, tinted: true });
  model('rearLoader', containerRearLoader(), tintMat, { cull: 230, shadow: true, tinted: true });
  model('underground', containerUnderground(), tintMat, { cull: 220, tinted: true });
  model('igloo', igloo(), baseMat, { cull: 260, shadow: true });
  model('binPost', binHanging(true), tintMat, { cull: 200, tinted: true });
  model('binWall', binHanging(false), tintMat, { cull: 160, tinted: true });
  model('binStanding', binStanding(), tintMat, { cull: 200, tinted: true });
  model('binPedestal', binPedestal(), baseMat, { cull: 180 });
  model('binDouble', binDoublePost(), baseMat, { cull: 180 });
  model('bench', benchSlats(), tintMat, { cull: 180, tinted: true });
  model('benchStone', benchStone(), baseMat, { cull: 180 });
  model('hoop', bikeHoop(), baseMat, { cull: 150 });
  model('shelter', emtShelter(), baseMat, { cull: 320, shadow: true });
  model('emtPole', emtPole(), baseMat, { cull: 300 });
  model('fountain', fountain(), baseMat, { cull: 180 });
  model('kioskOnce', kioskOnce(), baseMat, { cull: 350, shadow: true });
  model('kioskNews', kioskNews(0x2f4b3c), baseMat, { cull: 350, shadow: true });
  model('kioskNews2', kioskNews(0x596066), baseMat, { cull: 350, shadow: true });
  model('kioskFlowers', kioskFlowers(), baseMat, { cull: 350, shadow: true });
  model('bollard', bollard(), baseMat, { cull: 150 });
  model('signPole', createSignPoleGeometry(), createSignPoleMaterial(), { cull: 220 });
  const plate = createSignPlateGeometry();
  plate.computeBoundingBox();
  plate.computeBoundingSphere();
  model('signPlate', plate, createSignPlateMaterial(), { cull: 260 });

  const tintColor = new THREE.Color();
  for (const it of placeFurniture(data)) {
    const m = models[it.key];
    if (m.tinted) {
      tintColor.setHex(it.tint ?? 0xffffff);
      it.t = [tintColor.r, tintColor.g, tintColor.b];
    }
    m.list.push(it);
  }

  // --- Meshes: per model, one InstancedMesh per CELL x CELL m square --------------------------------------------------
  const culled = [];
  const dummy = new THREE.Object3D();
  let instanceCount = 0;
  for (const m of Object.values(models)) {
    if (!m.list.length) continue;
    const cells = new Map();
    for (const it of m.list) {
      const k = Math.floor(it.x / CELL) * 65536 + Math.floor(it.z / CELL);
      let c = cells.get(k);
      if (!c) cells.set(k, (c = []));
      c.push(it);
    }
    let first = null;
    for (const list of cells.values()) {
      const geo = new THREE.BufferGeometry();
      geo.setIndex(m.geometry.index);
      for (const [name, a] of Object.entries(m.geometry.attributes)) geo.setAttribute(name, a);
      geo.boundingBox = m.geometry.boundingBox;
      geo.boundingSphere = m.geometry.boundingSphere;
      if (m.tinted) {
        const arr = new Float32Array(list.length * 3);
        list.forEach((it, j) => arr.set(it.t, j * 3));
        geo.setAttribute('tint', new THREE.InstancedBufferAttribute(arr, 3));
      }
      if (m.key === 'signPlate') {
        geo.setAttribute('signCell', new THREE.InstancedBufferAttribute(new Float32Array(list.map((it) => it.extra)), 1));
      }
      const mesh = new THREE.InstancedMesh(geo, m.material, list.length);
      list.forEach((it, j) => {
        dummy.position.set(it.x, it.y, it.z);
        dummy.rotation.set(0, it.yaw, 0);
        dummy.scale.set(it.sx, it.sy, it.sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(j, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = m.shadow;
      mesh.receiveShadow = true;
      mesh.name = `Furniture:${m.key}`;
      if (first) mesh.userData.sharesPipelineWith = first;
      else first = mesh;
      group.add(mesh);
      const sp = mesh.boundingSphere;
      culled.push({ mesh, x: sp.center.x, y: sp.center.y, z: sp.center.z, r: sp.radius, d: m.cull });
      instanceCount += list.length;
    }
  }
  // ?nofurniture: leave it all out (fps comparisons)
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('nofurniture')) group.visible = false;
  scene.add(group);

  const counts = Object.fromEntries(Object.values(models).map((m) => [m.key, m.list.length]));
  // Per frame: hide the cells beyond their model's draw distance
  function update(cameraPosition) {
    const { x, y, z } = cameraPosition;
    for (const c of culled) {
      const dx = c.x - x, dy = c.y - y, dz = c.z - z;
      c.mesh.visible = Math.sqrt(dx * dx + dy * dy + dz * dz) - c.r < c.d;
    }
  }
  return { group, update, counts, instanceCount, meshes: culled.length, setVisible: (v) => { group.visible = v; } };
}
