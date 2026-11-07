// Where València's street lamps stand and which model each one is (gap #9). Pure placement, no three.js: street-lamps.js
// builds the models; tests/lamps.test.mjs runs this in node.
//
// Data first: every mapped lamp in the detailed city (vlc-lamps.js: 741 OpenStreetMap street_lamp nodes + 311 surveyed
// FAROLA bases of the Ajuntament's Mobiliari urbà) stands where it is mapped, wall lamps on the facade nearest to it.
// Rule second, for every street the data leaves dark: lamps along both kerbs of each street centreline (ROADS), the
// model, side and spacing chosen from the area and the street's measured width (facade to facade, from the real
// Catastro building walls):
//   old town (Ciutat Vella's barris) & old village / fishing quarters (Benimaclet, Campanar, Cabanyal, Grau,
//     Malva-rosa): Fernandine iron lanterns on scrolled wall brackets, staggered; a lantern column where the street
//     opens out (squares, streets over 16 m) and a three-lantern candelabra on the boulevards
//   historic Ensanche & extramurs barris (the 19th-century extramurs, and Ensanche / later barris whose buildings'
//     median Catastro year is before 1965 / 1945): wall
//     lanterns on streets under 15 m or with sidewalks under 2.2 m, lantern columns on the wider streets, candelabras on
//     the boulevards (Gran Vies, Colón, Xàtiva, Guillem de Castro, Plaça de l'Ajuntament...)
//   newer barris: a functional wall arm on streets under 13 m, a 8 m steel pole with a disc luminaire on the wider
//     streets, and 11 m twin-headed poles in pairs on the avenues (28 m and wider)
// Lamps keep clear of each other (the spacing), of signal poles and of the roadway.

import { ROADS, blockAt, barriAt, nearestRoads, LANDMARK_SITES } from './city-config.js';

export const LAMP_TYPES = ['wallLantern', 'column', 'candelabra', 'modernWall', 'streetPole', 'avenuePole'];
export const T = { WALL_LANTERN: 0, COLUMN: 1, CANDELABRA: 2, MODERN_WALL: 3, STREET_POLE: 4, AVENUE_POLE: 5 };
const WALL_TYPES = new Set([T.WALL_LANTERN, T.MODERN_WALL]);
// distance along the street from one lamp to the next (either side), and whether they stand in opposite pairs
const STEP = [12, 13, 25, 15, 16, 32];
const PAIRED = [false, false, true, false, false, true];
// no two lamps closer than this (m): keeps cross streets & doubled centrelines from piling lamps up at junctions
const CLEAR = [7, 9, 14, 9, 11, 16];

const OLD = new Set(['gotic', 'born', 'raval']);
const VILLAGE = new Set(['gracia', 'barceloneta']);
const NEW = new Set(['glories', 'vila_olimpica', 'poblenou']);
const BOULEVARD = /^(Gran Via |Plaça de l'Ajuntament|Carrer de Colón|Carrer de Xàtiva|Carrer de Guillem de Castro|Plaça de la Reina|Plaça de la Mare de Déu|Plaça dels Furs|Passeig de Russafa|Carrer de Sant Vicent Màrtir|Carrer de la Pau$|Plaça de Sant Agustí)/;

/**
 * Outer wall planes of the real buildings (vlc-buildings.js REAL_BUILDINGS), party walls left out:
 * [{ ax, az, bx, bz, nx, nz, h, year, front }], front: a street facade (else a patio / rear wall, which only blocks rays)
 */
export function streetWallsFrom(R) {
  const walls = [];
  const reserve = Object.values(LANDMARK_SITES || {}).map((t) => ({ x0: t.x - t.w / 2 - 2, x1: t.x + t.w / 2 + 2, z0: t.z - t.d / 2 - 2, z1: t.z + t.d / 2 + 2 }));
  let k = 0;
  for (let i = 0; i < R.count; i++) {
    const px = R.frames[i * 3], pz = R.frames[i * 3 + 1], th = R.frames[i * 3 + 2];
    const cs = Math.cos(th), sn = Math.sin(th);
    const decade = R.meta[i * 4 + 2];
    const year = decade ? (decade + 150) * 10 : 0;
    const n = R.counts[i];
    const skip = reserve.some((h) => px > h.x0 && px < h.x1 && pz > h.z0 && pz < h.z1);
    for (let j = 0; j < n; j++, k++) {
      if (skip) continue;
      const x0 = R.boxes[k * 5] / 10, x1 = R.boxes[k * 5 + 1] / 10, z0 = R.boxes[k * 5 + 2] / 10, z1 = R.boxes[k * 5 + 3] / 10;
      const h = R.boxes[k * 5 + 4] / 10;
      const f = R.faces[k];
      for (let side = 0; side < 4; side++) {
        const kind = (f >> (side * 2)) & 3; // shop 0 / entry 1: a street front; rear 2, lot line 3
        if (kind === 3) continue;
        const [ax, az, bx, bz, nx, nz] = side === 0 ? [x0, z1, x0, z0, -1, 0] : side === 1 ? [x1, z0, x1, z1, 1, 0]
          : side === 2 ? [x0, z0, x1, z0, 0, -1] : [x1, z1, x0, z1, 0, 1];
        if (Math.hypot(bx - ax, bz - az) < 2) continue;
        walls.push({
          ax: px + ax * cs + az * sn, az: pz - ax * sn + az * cs, bx: px + bx * cs + bz * sn, bz: pz - bx * sn + bz * cs,
          nx: nx * cs + nz * sn, nz: -nx * sn + nz * cs, h, year, front: kind <= 1
        });
      }
    }
  }
  return walls;
}

// 16 m grid of wall segments
function wallIndex(walls) {
  const CELL = 16;
  const grid = new Map();
  for (const w of walls) {
    const ix0 = Math.floor(Math.min(w.ax, w.bx) / CELL), ix1 = Math.floor(Math.max(w.ax, w.bx) / CELL);
    const iz0 = Math.floor(Math.min(w.az, w.bz) / CELL), iz1 = Math.floor(Math.max(w.az, w.bz) / CELL);
    for (let ix = ix0; ix <= ix1; ix++) for (let iz = iz0; iz <= iz1; iz++) {
      const key = ix * 100000 + iz;
      let c = grid.get(key);
      if (!c) grid.set(key, (c = []));
      c.push(w);
    }
  }
  let stamp = 0;
  const seen = new WeakMap();
  // first wall facing back at a ray from (ox, oz) along unit (dx, dz) within maxT: { t, w, x, z } or null; a rear wall
  // stops the ray too (the hit's w.front tells)
  function ray(ox, oz, dx, dz, maxT) {
    stamp++;
    let best = null;
    for (let t = 0; t <= maxT + CELL; t += CELL * 0.5) {
      const key = Math.floor((ox + dx * t) / CELL) * 100000 + Math.floor((oz + dz * t) / CELL);
      for (const w of grid.get(key) || []) {
        if (seen.get(w) === stamp) continue;
        seen.set(w, stamp);
        if (w.nx * dx + w.nz * dz > -0.3) continue;
        const ex = w.bx - w.ax, ez = w.bz - w.az;
        const den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-6) continue;
        const qx = w.ax - ox, qz = w.az - oz;
        const tt = (qx * ez - qz * ex) / den;
        const u = (qx * dz - qz * dx) / den;
        const len = Math.hypot(ex, ez);
        if (tt <= 0.2 || tt > maxT || u * len < 0.45 || (1 - u) * len < 0.45) continue;
        if (!best || tt < best.t) best = { t: tt, w, x: ox + dx * tt, z: oz + dz * tt };
      }
      if (best && best.t < t - CELL) break;
    }
    return best;
  }
  // nearest point on a wall within r of (x, z), on the wall's open side
  function nearest(x, z, r) {
    let best = null;
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        for (const w of grid.get(ix * 100000 + iz) || []) {
          const ex = w.bx - w.ax, ez = w.bz - w.az;
          const len2 = ex * ex + ez * ez;
          const len = Math.sqrt(len2);
          const u = Math.max(0.45 / len, Math.min(1 - 0.45 / len, ((x - w.ax) * ex + (z - w.az) * ez) / len2));
          const cx = w.ax + ex * u, cz = w.az + ez * u;
          if (!w.front || (x - cx) * w.nx + (z - cz) * w.nz < -0.5) continue;
          const d = Math.hypot(x - cx, z - cz);
          if (d < r && (!best || d < best.d)) best = { d, w, x: cx, z: cz };
        }
      }
    }
    return best;
  }
  return { ray, nearest };
}

// Median Catastro construction year of the buildings around a point (120 m cells, widened where sparse)
function yearGrid(walls) {
  const CELL = 120;
  const cells = new Map();
  for (const w of walls) {
    if (!w.year) continue;
    const key = Math.floor((w.ax + w.bx) / 2 / CELL) * 100000 + Math.floor((w.az + w.bz) / 2 / CELL);
    let c = cells.get(key);
    if (!c) cells.set(key, (c = []));
    c.push(w.year);
  }
  const memo = new Map();
  return (x, z) => {
    const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL);
    const key = ix * 100000 + iz;
    if (memo.has(key)) return memo.get(key);
    let ys = cells.get(key) || [];
    if (ys.length < 12) {
      ys = [];
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) ys.push(...(cells.get((ix + a) * 100000 + iz + b) || []));
    }
    ys.sort((p, q) => p - q);
    const y = ys.length ? ys[ys.length >> 1] : 0;
    memo.set(key, y);
    return y;
  };
}

/**
 * Plans every lamp. `walls`: streetWallsFrom(REAL_BUILDINGS); `data`: vlc-lamps.js LAMPS; `isClearOfPoles(x, z, r)`
 * optional (signal poles). Returns { lamps: [{ type, x, z, y, yaw, src }], stats }: y is the base (sidewalk top) or,
 * for wall types, the bracket's height; yaw turns the model's +x (its arm / the lantern's reach) toward the street.
 */
export function planStreetLamps(walls, data, opts = {}) {
  const isClearOfPoles = opts.isClearOfPoles || (() => true);
  const W = wallIndex(walls);
  const yearAt = yearGrid(walls);
  const lamps = [];
  const stats = { data: 0, dataWall: 0, dataSnapped: 0, dataDropped: 0, droppedAt: [], rule: 0, byType: LAMP_TYPES.map(() => 0), ruleStreets: new Set(), dataStreets: new Set() };

  // lamp spacing hash (8 m cells)
  const HC = 8;
  const hash = new Map();
  const clearOfLamps = (x, z, r) => {
    for (let ix = Math.floor((x - r) / HC); ix <= Math.floor((x + r) / HC); ix++) {
      for (let iz = Math.floor((z - r) / HC); iz <= Math.floor((z + r) / HC); iz++) {
        for (const l of hash.get(ix * 100000 + iz) || []) if ((l.x - x) ** 2 + (l.z - z) ** 2 < r * r) return false;
      }
    }
    return true;
  };
  const add = (l) => {
    lamps.push(l);
    stats.byType[l.type]++;
    const key = Math.floor(l.x / HC) * 100000 + Math.floor(l.z / HC);
    let c = hash.get(key);
    if (!c) hash.set(key, (c = []));
    c.push(l);
  };

  const zoneAt = (x, z) => {
    const p = barriAt(x, z).profile;
    if (OLD.has(p)) return 'old';
    if (VILLAGE.has(p)) return 'village';
    if (NEW.has(p)) return 'modern';
    if (p === 'sant_antoni') return 'historic'; // the 19th-century extramurs: Botànic, Roqueta, Petxina, Arrancapins
    // the Ensanche's newer edges (Exposició, Mestalla, Jaume Roig) and the later barris by their buildings' age
    const y = yearAt(x, z);
    return y && y < (p === 'eixample' ? 1965 : 1945) ? 'historic' : 'modern';
  };
  const curbAt = (b) => b && !(b.park > 0.6);
  // across the street from (x, z) toward unit (nx, nz): kerb distance (null: none / a median first) & facade hit
  function probe(x, z, nx, nz) {
    let curb = null;
    for (let r = 1; r <= 26; r += 1) {
      const b = blockAt(x + nx * r, z + nz * r);
      if (!b) continue;
      if (!b.median) {
        // back to the kerb to a quarter metre
        let lo = r - 1, hi = r;
        for (let k = 0; k < 2; k++) { const m = (lo + hi) / 2; if (blockAt(x + nx * m, z + nz * m)) hi = m; else lo = m; }
        curb = { r: hi, park: b.park > 0.6 };
      }
      break;
    }
    const hit = W.ray(x, z, nx, nz, 40);
    // a facade more than a sidewalk's width past the kerb is a building set back (or another street's): not this one's
    const wall = hit && (curb ? hit.t < curb.r + 9 : hit.t < 12) ? hit : null;
    return { curb, wall };
  }
  const widthOf = (A, B) => {
    const side = (p) => (p.wall ? p.wall.t : p.curb ? p.curb.r + 6 : 14);
    return side(A) + side(B);
  };
  const sidewalkOf = (p) => (p.curb ? (p.wall ? p.wall.t - p.curb.r : 8) : 0);
  // the model for one side of a street
  // zone, facade-to-facade width, this side's sidewalk, the street's name, a facade on this side, kerb-to-kerb gap
  function classify(zone, width, sidewalk, name, hasWall, gap = 99) {
    const boulevard = BOULEVARD.test(name || '');
    if (zone === 'old' || zone === 'village') {
      if (boulevard && sidewalk >= 3) return T.CANDELABRA;
      // the lanes: lanterns on the walls, never a post in a 3-8 m lane
      if (width < 16 || gap < 10) return hasWall ? T.WALL_LANTERN : -1;
      if (hasWall && sidewalk < 2.5) return T.WALL_LANTERN;
      return sidewalk >= 1.6 ? T.COLUMN : hasWall ? T.WALL_LANTERN : -1;
    }
    if (zone === 'historic') {
      if (boulevard && sidewalk >= 3) return T.CANDELABRA;
      if (width >= 34 && sidewalk >= 2.5) return T.AVENUE_POLE;
      if (hasWall && (width < 15 || sidewalk < 2.2)) return T.WALL_LANTERN;
      return sidewalk >= 1.6 ? T.COLUMN : hasWall ? T.WALL_LANTERN : -1;
    }
    if (width >= 28 && sidewalk >= 2.2) return T.AVENUE_POLE;
    if (hasWall && (width < 13 || sidewalk < 2.0)) return T.MODERN_WALL;
    return sidewalk >= 1.6 ? T.STREET_POLE : hasWall ? T.MODERN_WALL : -1;
  }
  const yawOut = (dx, dz) => Math.atan2(-dz, dx); // the model's +x along (dx, dz)
  function wallLamp(type, hit, src) {
    const { w } = hit;
    const mount = type === T.WALL_LANTERN ? Math.min(4.6, w.h - 0.9) : Math.min(6.4, w.h - 0.7);
    if (mount < (type === T.WALL_LANTERN ? 3.2 : 4.2)) return null;
    return { type, x: hit.x, z: hit.z, y: mount, yaw: yawOut(w.nx, w.nz), src };
  }
  function poleLamp(type, x, z, ax, az, src) {
    const b = blockAt(x, z);
    return { type, x, z, y: b ? 0.2 : 0.02, yaw: yawOut(ax, az), src };
  }

  // the street centreline nearest to (x, z) within r: { road, x, z, tx, tz } (tx, tz its unit direction)
  function nearestStreet(x, z, r) {
    let best = null, bd = r * r;
    for (const { road } of nearestRoads(x, z, r)) {
      const p = road.pts;
      for (let i = 0; i + 1 < p.length; i++) {
        const ex = p[i + 1].x - p[i].x, ez = p[i + 1].z - p[i].z;
        const l2 = ex * ex + ez * ez || 1e-9;
        const u = Math.max(0, Math.min(1, ((x - p[i].x) * ex + (z - p[i].z) * ez) / l2));
        const cx = p[i].x + ex * u, cz = p[i].z + ez * u;
        const d = (cx - x) ** 2 + (cz - z) ** 2;
        if (d < bd) { bd = d; const l = Math.sqrt(l2); best = { road, x: cx, z: cz, tx: ex / l, tz: ez / l }; }
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 1. The mapped lamps
  // ---------------------------------------------------------------------------------------------------------------
  for (let i = 0; i < data.length; i += 3) {
    const x = data[i] / 10, z = data[i + 1] / 10, code = data[i + 2];
    const src = code >> 4 ? 'ajuntament' : 'osm';
    const mount = (code >> 2) & 3, size = code & 3;
    const zone = zoneAt(x, z);
    const st = nearestStreet(x, z, 30);
    let toX = 1, toZ = 0, width = 14, name = '';
    if (st) {
      name = st.road.name;
      const d = Math.hypot(st.x - x, st.z - z);
      if (d > 0.3) { toX = (st.x - x) / d; toZ = (st.z - z) / d; } else { toX = -st.tz; toZ = st.tx; }
      const nx = -st.tz, nz = st.tx;
      width = widthOf(probe(st.x, st.z, nx, nz), probe(st.x, st.z, -nx, -nz));
    }
    const onBlock = curbAt(blockAt(x, z));
    const near = W.nearest(x, z, 4);
    const historic = zone !== 'modern';
    // wall-mounted: tagged so, or untagged off the kerbs (the old town's kerb-free lanes) or by a facade where the area's
    // rule hangs lamps on walls
    let wantWall = mount === 1;
    if (!mount && size === 0 && near) {
      const facadeDist = near.d;
      const t = classify(zone, width, onBlock ? facadeDist : 0, name, true);
      wantWall = !onBlock || WALL_TYPES.has(t) || facadeDist < 1.2;
    }
    let lamp = null;
    if (wantWall && near) {
      lamp = wallLamp(historic ? T.WALL_LANTERN : T.MODERN_WALL, near, src);
      if (lamp) stats.dataWall++;
    }
    if (!lamp) {
      let px = x, pz = z;
      if (!onBlock) {
        // a pole mapped on the engine's roadway: onto the nearest kerb within 3 m
        let found = null;
        for (let r = 0.5; r <= 3 && !found; r += 0.5) {
          for (let a = 0; a < 12; a++) {
            const qx = x + Math.cos(a * Math.PI / 6) * r, qz = z + Math.sin(a * Math.PI / 6) * r;
            const b = blockAt(qx, qz);
            if (b && !b.median && !(b.park > 0.6)) { found = { x: qx, z: qz }; break; }
          }
        }
        if (found) { px = found.x; pz = found.z; stats.dataSnapped++; }
        else if (blockAt(x, z)) { /* in a park or on a median: keep it there */ }
        else { stats.dataDropped++; stats.droppedAt.push([x, z]); continue; }
      }
      let type;
      if (size === 2) type = historic ? T.CANDELABRA : T.AVENUE_POLE;
      else if (size === 1) type = historic ? T.COLUMN : T.STREET_POLE;
      else {
        type = classify(zone, width, 8, name, false);
        if (type < 0 || WALL_TYPES.has(type)) type = historic ? T.COLUMN : T.STREET_POLE;
      }
      lamp = poleLamp(type, px, pz, toX, toZ, src);
    }
    add(lamp);
    stats.data++;
    if (name) stats.dataStreets.add(name);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 2. By rule along every street the data leaves dark
  // ---------------------------------------------------------------------------------------------------------------
  const hash01 = (a, b) => { const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return s - Math.floor(s); };
  for (const road of ROADS) {
    const p = road.pts;
    if (p.length < 2) continue;
    const cum = [0];
    for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z));
    const len = cum[cum.length - 1];
    if (len < 10) continue;
    let seg = 0;
    const at = (d) => {
      while (seg < p.length - 2 && cum[seg + 1] < d) seg++;
      const l = cum[seg + 1] - cum[seg] || 1e-9;
      const u = (d - cum[seg]) / l;
      return { x: p[seg].x + (p[seg + 1].x - p[seg].x) * u, z: p[seg].z + (p[seg + 1].z - p[seg].z) * u, tx: (p[seg + 1].x - p[seg].x) / l, tz: (p[seg + 1].z - p[seg].z) / l };
    };
    let side = hash01(p[0].x, p[0].z) < 0.5 ? 1 : -1;
    let d = Math.min(6, len * 0.5);
    let placedAny = false;
    while (d <= len - Math.min(5, len * 0.5)) {
      const q = at(d);
      const nx = -q.tz, nz = q.tx;
      const zone = zoneAt(q.x, q.z);
      const pr = { 1: probe(q.x, q.z, nx, nz), [-1]: probe(q.x, q.z, -nx, -nz) };
      // inside a park (paths): the park lamps light it
      const b0 = blockAt(q.x, q.z);
      if (b0 && b0.park > 0.6) { d += 12; continue; }
      const width = widthOf(pr[1], pr[-1]);
      const gap = (pr[1].curb ? pr[1].curb.r : 13) + (pr[-1].curb ? pr[-1].curb.r : 13);
      const typeOf = (s) => {
        const pp = pr[s];
        if (pp.curb && pp.curb.park && !pp.wall) return -1;
        return classify(zone, width, sidewalkOf(pp), road.name, !!pp.wall && pp.wall.w.front, gap);
      };
      const types = { 1: typeOf(1), [-1]: typeOf(-1) };
      const main = types[side] >= 0 ? types[side] : types[-side];
      if (main < 0) { d += 10; side = -side; continue; }
      const sides = [side, -side]; // staggered: this side, else the other; paired: both
      for (const s of sides) {
        const type = types[s];
        if (type < 0) continue;
        const pp = pr[s];
        let lamp = null;
        if (WALL_TYPES.has(type)) {
          if (pp.wall && pp.wall.w.front && clearOfLamps(pp.wall.x, pp.wall.z, CLEAR[type])) lamp = wallLamp(type, pp.wall, 'rule');
        } else if (pp.curb) {
          const off = pp.curb.r + 0.55;
          const x = q.x + nx * s * off, z = q.z + nz * s * off;
          const b = blockAt(x, z);
          if (b && !b.median && blockAt(x + nx * s * 0.4, z + nz * s * 0.4) && isClearOfPoles(x, z, 2.5) && clearOfLamps(x, z, CLEAR[type])) {
            lamp = poleLamp(type, x, z, -nx * s, -nz * s, 'rule');
          }
        }
        if (lamp) {
          add(lamp);
          stats.rule++;
          placedAny = true;
          if (!PAIRED[main]) break; // staggered: one side per step
        }
      }
      d += STEP[main];
      side = -side;
    }
    if (placedAny) stats.ruleStreets.add(road.name);
  }
  return { lamps, stats };
}
