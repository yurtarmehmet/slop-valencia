import * as THREE from 'three/webgpu';
import { BLOCKS, ROADS, blockAt, onLand } from './city-config.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';
import { footfallAt, footfallTime, footfallVersion, FOOTFALL_HOURS } from './vlc-footfall.js';

// The crowd on the Plaça de l'Ajuntament: València's main square, pedestrian since 2022 and full of people from
// morning to night. Unlike the sidewalk pedestrians (pedestrian-system.js, on tracks along the curbs) these people
// move freely over the square's open paving: strolling from one spot to another, standing about in groups talking,
// stopping to look round. They keep a little room between them and step out of the way of the player.
//
// The open paving is a 1 m grid over the square's curb island (city-config.js BLOCKS), less every collider (the
// buildings round it); people walk straight lines that stay on it.
//
// The same people also fill the city's other open ground near the camera: OpenStreetMap's pedestrian streets (most of
// the old town) and squares (curb islands that are mostly square, city-config.js BLOCKS). That ground is rasterised
// the same way in a window that follows the camera, without the car roadways and colliders, and peopled by the
// footfall map (vlc-footfall.js): footfall per metre of street over STREET_WIDTH m of width per m2, times
// PEDESTRIAN_STREET in car-free streets, where everyone walks the whole width (rules: no counts are published).
const SQUARES = [{ name: "Plaça de l'Ajuntament", count: 700 }];
const STREET_POOL = 300; // people for the open ground around the camera
const WIN = 150; // m: half side of that window
const REBUILD = 45; // m the camera moves before the window is rebuilt round it
const STREET_WIDTH = 5;
const PEDESTRIAN_STREET = 1.5;
const STREET_DRAW = 220; // m
const CELL = 1;
const ACTIVE_RANGE = 520; // m from the square's centre within which the crowd lives & is drawn
const SEPARATION = 0.72; // m kept between two people walking
const hash = (i, salt) => {
  const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

function colliderHit(c, x, z, r) {
  if (x + r <= c.minX || x - r >= c.maxX || z + r <= c.minZ || z - r >= c.maxZ) return false;
  if ((c.minY ?? 0) > 2.5) return false; // arcades & overhangs well above head height
  const o = c.obb;
  if (!o) return true;
  const dx = x - o.cx, dz = z - o.cz;
  const lx = dx * o.cs - dz * o.sn, lz = dx * o.sn + dz * o.cs;
  const qx = lx - Math.max(-o.hx, Math.min(o.hx, lx)), qz = lz - Math.max(-o.hz, Math.min(o.hz, lz));
  return qx * qx + qz * qz < r * r;
}

function createPlazaCrowd(scene, { colliders, ground }) {
  const squares = [];
  for (const spec of SQUARES) {
    const block = BLOCKS.find((b) => b.parkName === spec.name);
    if (!block) continue;
    // walkable cells: on the square's island, clear of every collider by 0.6 m
    const x0 = Math.floor(block.minX), z0 = Math.floor(block.minZ);
    const nx = Math.ceil(block.maxX - x0) + 1, nz = Math.ceil(block.maxZ - z0) + 1;
    const near = colliders.filter((c) => c.maxX > x0 - 2 && c.minX < x0 + nx + 2 && c.maxZ > z0 - 2 && c.minZ < z0 + nz + 2);
    const open = new Uint8Array(nx * nz);
    const cells = [];
    for (let iz = 0; iz < nz; iz++) {
      for (let ix = 0; ix < nx; ix++) {
        const x = x0 + ix + 0.5, z = z0 + iz + 0.5;
        if (blockAt(x, z) !== block) continue;
        if (near.some((c) => colliderHit(c, x, z, 0.6))) continue;
        open[iz * nx + ix] = 1;
        cells.push(iz * nx + ix);
      }
    }
    if (cells.length < 200) continue;
    // keep only the biggest connected stretch (the square itself, not the odd sliver of sidewalk behind a building)
    const comp = new Int32Array(nx * nz).fill(-1);
    let best = -1, bestSize = 0;
    for (const start of cells) {
      if (comp[start] >= 0) continue;
      const id = start;
      const stack = [start];
      comp[start] = id;
      let size = 0;
      while (stack.length) {
        const k = stack.pop();
        size++;
        const ix = k % nx, iz = (k - ix) / nx;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const jx = ix + dx, jz = iz + dz;
          if (jx < 0 || jx >= nx || jz < 0 || jz >= nz) continue;
          const j = jz * nx + jx;
          if (!open[j] || comp[j] >= 0) continue;
          comp[j] = id;
          stack.push(j);
        }
      }
      if (size > bestSize) { bestSize = size; best = id; }
    }
    const walk = cells.filter((k) => comp[k] === best);
    for (const k of cells) if (comp[k] !== best) open[k] = 0;
    let cx = 0, cz = 0;
    for (const k of walk) { cx += x0 + (k % nx) + 0.5; cz += z0 + Math.floor(k / nx) + 0.5; }
    squares.push({ ...spec, x0, z0, nx, nz, open, cells: walk, cx: cx / walk.length, cz: cz / walk.length });
    console.log(`[plaza-crowd] ${spec.name}: ${walk.length.toLocaleString()} m² of open paving, ${spec.count} people`);
  }
  const total = squares.reduce((t, s) => t + s.count, 0);
  const crowd = new PersonCrowd(total + STREET_POOL, { farDistance: 30 });
  scene.add(...crowd.meshes);

  const isOpen = (sq, x, z) => {
    const ix = Math.floor((x - sq.x0) / CELL), iz = Math.floor((z - sq.z0) / CELL);
    return ix >= 0 && ix < sq.nx && iz >= 0 && iz < sq.nz && sq.open[iz * sq.nx + ix] > 0;
  };
  const clearLine = (sq, ax, az, bx, bz) => {
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 0.7);
    for (let s = 1; s <= n; s++) if (!isOpen(sq, ax + (bx - ax) * s / n, az + (bz - az) * s / n)) return false;
    return true;
  };
  const randomCell = (sq) => {
    const k = sq.cells[Math.floor(Math.random() * sq.cells.length)];
    return [sq.x0 + (k % sq.nx) + 0.2 + Math.random() * 0.6, sq.z0 + Math.floor(k / sq.nx) + 0.2 + Math.random() * 0.6];
  };

  // --- the people ---------------------------------------------------------------------------------------------------
  let clockNow = 0;
  const people = [];
  let seq = 0;
  const streetPeople = [];
  for (const sq of [...squares, null]) {
    for (let n = 0; n < (sq ? sq.count : STREET_POOL); n++, seq++) {
      const i = seq + 5000; // other seeds than the sidewalk pedestrians
      const female = hash(i, 1) < 0.5;
      const hairRoll = hash(i, 2);
      const [x, z] = sq ? randomCell(sq) : [0, 0];
      const person = {
        sq, x, z, heading: Math.random() * Math.PI * 2, live: !!sq, rank: n,
        speed: 0.95 + hash(i, 3) * 0.45, // a stroll, not a commute
        v: 0, gx: x, gz: z, state: 'stand', until: 0, group: null, dodgeX: 0, dodgeZ: 0,
        rig: new PersonRig({
          seed: i * 1.6180339 + 0.71,
          female,
          scale: (female ? 0.9 : 0.97) + hash(i, 4) * 0.11,
          girth: 0.88 + hash(i, 5) * 0.26,
          hair: female ? (hairRoll < 0.7 ? 1 : 0.3 + hairRoll * 0.25) : hairRoll < 0.08 ? 1 : hairRoll * 0.35,
          armSwing: 0.7 + hash(i, 6) * 0.5,
          stride: 0.94 + hash(i, 7) * 0.12
        })
      };
      people.push(person);
      if (!sq) streetPeople.push(person);
    }
  }

  // Groups standing & talking: 2-5 people in a ring facing its centre, for a while
  function formGroup(members, sq, until) {
    for (let tries = 0; tries < 12; tries++) {
      // in the streets a group gathers where its first member stands
      const [gx, gz] = sq.dynamic ? [members[0].x + (Math.random() - 0.5) * 3, members[0].z + (Math.random() - 0.5) * 3] : randomCell(sq);
      const r = 0.45 + members.length * 0.16;
      const spots = members.map((_, k) => {
        const a = (k / members.length) * Math.PI * 2 + Math.random() * 0.4;
        return [gx + Math.cos(a) * r, gz + Math.sin(a) * r];
      });
      if (!spots.every(([x, z]) => isOpen(sq, x, z))) continue;
      const group = { x: gx, z: gz, until };
      members.forEach((p, k) => {
        p.group = group;
        p.state = 'join';
        p.gx = spots[k][0];
        p.gz = spots[k][1];
        p.until = until;
      });
      return true;
    }
    return false;
  }
  // Start with a third of the square in groups, the rest strolling or lingering
  {
    let k = 0;
    while (k < people.length && people[k].sq) {
      const p = people[k];
      if (Math.random() < 0.34) {
        const size = 2 + Math.floor(Math.random() * Math.random() * 4);
        const members = people.slice(k, k + size).filter((q) => q.sq === p.sq);
        if (formGroup(members, p.sq, 20 + Math.random() * 70)) {
          // already in place
          for (const q of members) { q.x = q.gx; q.z = q.gz; q.state = 'talk'; }
          k += members.length;
          continue;
        }
      }
      p.state = Math.random() < 0.7 ? 'walk' : 'stand';
      p.until = p.state === 'stand' ? 4 + Math.random() * 25 : Infinity;
      if (p.state === 'walk') pickGoal(p);
      k++;
    }
  }

  function pickGoal(p) {
    const sq = p.sq;
    if (sq.dynamic) return pickRayGoal(p);
    for (let tries = 0; tries < 10; tries++) {
      const [x, z] = randomCell(sq);
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < 6 || d > 70) continue;
      if (!clearLine(sq, p.x, p.z, x, z)) continue;
      p.gx = x;
      p.gz = z;
      p.state = 'walk';
      return true;
    }
    p.state = 'stand';
    p.until = clockNow + 2 + Math.random() * 6;
    return false;
  }

  // In a street the open ground is long and narrow: look along a few directions (mostly ahead) and walk down the
  // longest clear one, a few metres to a few dozen
  function pickRayGoal(p) {
    const sq = p.sq;
    let best = 0, bx = 0, bz = 0;
    for (let k = 0; k < 8; k++) {
      const a = p.heading + (k === 0 ? 0 : k < 4 ? (Math.random() - 0.5) * 1.2 : Math.random() * Math.PI * 2);
      const dx = Math.sin(a), dz = Math.cos(a);
      let run = 0;
      while (run < 45 && isOpen(sq, p.x + dx * (run + 0.7), p.z + dz * (run + 0.7))) run += 0.7;
      const score = run * (1.2 + Math.cos(a - p.heading) * 0.5) * (0.7 + Math.random() * 0.6);
      if (score > best && run > 3) { best = score; bx = dx * run; bz = dz * run; }
    }
    if (best > 0) {
      const f = 0.35 + Math.random() * 0.6;
      p.gx = p.x + bx * f;
      p.gz = p.z + bz * f;
      p.state = 'walk';
      return true;
    }
    p.state = 'stand';
    p.until = clockNow + 2 + Math.random() * 6;
    return false;
  }

  // --- the open ground round the camera --------------------------------------------------------------------------------
  const fixedBlocks = new Set(squares.map((sq) => BLOCKS.find((b) => b.parkName === sq.name)));
  const SQUARE_BLOCKS = BLOCKS.filter((b) => b.square >= 0.3 && !b.median && !fixedBlocks.has(b));
  const PED_ROADS = ROADS.filter((r) => r.pedestrian);
  const CAR_ROADS = ROADS.filter((r) => !r.pedestrian);
  function eachCell(area, minX, maxX, minZ, maxZ, fn) {
    const i0 = Math.max(0, Math.floor(minX - area.x0)), i1 = Math.min(area.nx - 1, Math.floor(maxX - area.x0));
    const j0 = Math.max(0, Math.floor(minZ - area.z0)), j1 = Math.min(area.nz - 1, Math.floor(maxZ - area.z0));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * area.nx + i, area.x0 + i + 0.5, area.z0 + j + 0.5);
  }
  function eachNearSegment(roads, area, pad, fn) {
    const x1 = area.x0 + area.nx, z1 = area.z0 + area.nz;
    for (const r of roads) {
      const reach = r.w / 2 + pad;
      for (let k = 0; k + 1 < r.pts.length; k++) {
        const a = r.pts[k], b = r.pts[k + 1];
        if (Math.max(a.x, b.x) + reach < area.x0 || Math.min(a.x, b.x) - reach > x1
          || Math.max(a.z, b.z) + reach < area.z0 || Math.min(a.z, b.z) - reach > z1) continue;
        const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
        eachCell(area, Math.min(a.x, b.x) - reach, Math.max(a.x, b.x) + reach, Math.min(a.z, b.z) - reach, Math.max(a.z, b.z) + reach, (k2, x, z) => {
          const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
          if (Math.hypot(x - a.x - dx * t, z - a.z - dz * t) <= reach) fn(k2, x, z);
        });
      }
    }
  }
  function buildStreetArea(cx, cz) {
    const area = { dynamic: true, x0: Math.floor(cx) - WIN, z0: Math.floor(cz) - WIN, nx: WIN * 2, nz: WIN * 2, cx, cz };
    const open = area.open = new Uint8Array(area.nx * area.nz); // 1 square, 2 pedestrian street
    eachNearSegment(PED_ROADS, area, 0.5, (k) => { open[k] = 2; });
    for (const b of SQUARE_BLOCKS) {
      if (b.maxX < area.x0 || b.minX > area.x0 + area.nx || b.maxZ < area.z0 || b.minZ > area.z0 + area.nz) continue;
      eachCell(area, b.minX, b.maxX, b.minZ, b.maxZ, (k, x, z) => { if (!open[k] && blockAt(x, z) === b) open[k] = 1; });
    }
    // never on a car roadway, in the water, in a fixed square's own crowd or inside anything solid
    eachNearSegment(CAR_ROADS, area, -0.2, (k) => { open[k] = 0; });
    const near = colliders.filter((c) => c.maxX > area.x0 - 1 && c.minX < area.x0 + area.nx + 1 && c.maxZ > area.z0 - 1 && c.minZ < area.z0 + area.nz + 1);
    for (const c of near) {
      eachCell(area, c.minX - 0.6, c.maxX + 0.6, c.minZ - 0.6, c.maxZ + 0.6, (k, x, z) => { if (open[k] && colliderHit(c, x, z, 0.5)) open[k] = 0; });
    }
    const cells = [];
    for (let k = 0; k < open.length; k++) {
      if (!open[k]) continue;
      const x = area.x0 + (k % area.nx) + 0.5, z = area.z0 + Math.floor(k / area.nx) + 0.5;
      if (!onLand(x, z) || squares.some((sq) => isOpen(sq, x, z))) { open[k] = 0; continue; }
      cells.push(k);
    }
    area.cells = cells;
    area.cum = new Float32Array(cells.length);
    weighStreetArea(area);
    return area;
  }
  // People per open cell by footfall now: the weights for placing people & how many the window holds
  function weighStreetArea(area) {
    let sum = 0;
    for (let n = 0; n < area.cells.length; n++) {
      const k = area.cells[n];
      const x = area.x0 + (k % area.nx) + 0.5, z = area.z0 + Math.floor(k / area.nx) + 0.5;
      sum += footfallAt(x, z) * (area.open[k] === 2 ? PEDESTRIAN_STREET : 1) / STREET_WIDTH;
      area.cum[n] = sum;
    }
    area.expected = sum;
    area.version = footfallVersion();
  }
  function weightedCell(area) {
    const n = area.cells.length;
    const r = Math.random() * area.cum[n - 1];
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (area.cum[mid] < r) lo = mid + 1; else hi = mid;
    }
    const k = area.cells[lo];
    return [area.x0 + (k % area.nx) + 0.2 + Math.random() * 0.6, area.z0 + Math.floor(k / area.nx) + 0.2 + Math.random() * 0.6];
  }
  let streetArea = null;
  let streetActive = 0;
  // Out of sight where possible: never pop up in front of the camera
  function placeStreetPerson(p, cam, visible, anywhere) {
    let x = 0, z = 0;
    for (let tries = 0; tries < 10; tries++) {
      [x, z] = weightedCell(streetArea);
      const d = Math.hypot(x - cam.x, z - cam.z);
      if (anywhere || d > 110 || !visible(x, z)) break;
      if (tries === 9) return false;
    }
    p.sq = streetArea;
    p.x = p.gx = x; p.z = p.gz = z;
    p.v = 0;
    p.group = null;
    p.heading = Math.random() * Math.PI * 2;
    p.live = true;
    p.rig.placed = false;
    if (Math.random() < 0.75) pickRayGoal(p); else { p.state = 'stand'; p.until = clockNow + 3 + Math.random() * 15; }
    return true;
  }
  function updateStreetArea(cam, visible) {
    const jump = !streetArea || Math.hypot(cam.x - streetArea.cx, cam.z - streetArea.cz) > WIN;
    if (jump || Math.hypot(cam.x - streetArea.cx, cam.z - streetArea.cz) > REBUILD) {
      const area = buildStreetArea(cam.x, cam.z);
      streetArea = area;
      for (const p of streetPeople) {
        if (!p.live) continue;
        p.sq = area;
        if (jump || !isOpen(area, p.x, p.z)) { p.live = false; continue; }
        if (p.group) { p.group = null; p.state = 'stand'; p.until = clockNow + 1; }
        if (p.state === 'walk' && !isOpen(area, p.gx, p.gz)) pickRayGoal(p);
      }
    } else if (streetArea.version !== footfallVersion()) {
      weighStreetArea(streetArea);
    }
    streetActive = streetArea.cells.length ? Math.min(STREET_POOL, Math.round(streetArea.expected)) : 0;
    let budget = jump ? STREET_POOL : 4;
    for (const p of streetPeople) {
      if (p.rank >= streetActive) {
        if (p.live && (jump || !visible(p.x, p.z) || Math.hypot(p.x - cam.x, p.z - cam.z) > 150)) p.live = false;
        continue;
      }
      if (p.live || budget <= 0) continue;
      budget--;
      placeStreetPerson(p, cam, visible, jump);
    }
  }

  // --- simulation -----------------------------------------------------------------------------------------------------
  const grid = new Map(); // 2 m cells -> people, rebuilt each frame
  const key = (ix, iz) => ix * 65536 + iz;
  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  const groundFn = (owner, x, z) => ground(x, z);
  // a square's crowd lives while the camera is within ACTIVE_RANGE, thinner at night; the streets' while placed
  const awake = (p) => !!p.sq && (p.sq.dynamic ? p.live : p.sq.near && p.rank < p.sq.active);

  function update(dt, elapsed, camera, player, mode) {
    clockNow = elapsed;
    const cam = camera.position;
    camera.updateMatrixWorld();
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
    const visible = (x, z) => {
      for (let k = 0; k < 4; k++) {
        const { normal, constant } = frustum.planes[k];
        if (normal.x * x + normal.y + normal.z * z + constant < -2) return false;
      }
      return true;
    };
    updateStreetArea(cam, visible);
    const hours = FOOTFALL_HOURS[footfallTime()] || FOOTFALL_HOURS.midday;
    const share = Math.max(0.4, (hours.home + hours.shop + hours.food) / 3);
    for (const sq of squares) {
      sq.near = Math.hypot(cam.x - sq.cx, cam.z - sq.cz) < ACTIVE_RANGE;
      sq.active = Math.round(sq.count * Math.min(1, share));
    }
    crowd.begin();

    grid.clear();
    for (const p of people) {
      if (!awake(p)) continue;
      const k = key(Math.floor(p.x / 2), Math.floor(p.z / 2));
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push(p);
    }
    // the player: a walker is a person to keep clear of, anything on wheels a body to get out of the way of
    const px = player ? player.position.x : 1e9, pz = player ? player.position.z : 1e9;
    const playerR = mode === 'person' ? 0.75 : mode === 'car' ? 3.2 : 1.6;

    for (const p of people) {
      if (!awake(p)) continue;
      const sq = p.sq;
      // decisions
      if (p.state === 'talk' && elapsed > p.until) {
        if (p.group) p.group = null;
        pickGoal(p);
      } else if (p.state === 'stand' && elapsed > p.until) {
        if (Math.random() < 0.12) {
          // gather a few people standing nearby into a group
          const near = [];
          for (const q of grid.get(key(Math.floor(p.x / 2), Math.floor(p.z / 2))) || []) {
            if (q !== p && q.state === 'stand' && near.length < 3) near.push(q);
          }
          if (!formGroup([p, ...near], sq, elapsed + 25 + Math.random() * 60)) pickGoal(p);
        } else pickGoal(p);
      } else if (p.state === 'join' && Math.hypot(p.gx - p.x, p.gz - p.z) < 0.15) {
        p.state = 'talk';
      }
      let tx = 0, tz = 0, vMax = 0;
      if (p.state === 'walk' || p.state === 'join') {
        const dx = p.gx - p.x, dz = p.gz - p.z;
        const d = Math.hypot(dx, dz);
        if (p.state === 'walk' && d < 0.6) {
          // arrived: look round a while, or walk on
          if (Math.random() < 0.55) { p.state = 'stand'; p.until = elapsed + 3 + Math.random() * 20; } else pickGoal(p);
        } else if (d > 1e-3) {
          tx = dx / d; tz = dz / d;
          vMax = Math.min(p.speed, Math.sqrt(2 * 1.2 * d));
        }
      }
      // separation: slow behind someone in the way, sidestep round them
      let sx = 0, sz = 0;
      const ix = Math.floor(p.x / 2), iz = Math.floor(p.z / 2);
      for (let ax = -1; ax <= 1; ax++) {
        for (let az = -1; az <= 1; az++) {
          for (const q of grid.get(key(ix + ax, iz + az)) || []) {
            if (q === p) continue;
            const dx = p.x - q.x, dz = p.z - q.z;
            const d2 = dx * dx + dz * dz;
            if (d2 > 2.2 * 2.2 || d2 < 1e-6) continue;
            const d = Math.sqrt(d2);
            if (vMax > 0) {
              const ahead = -(dx * tx + dz * tz);
              const side = Math.abs(dx * tz - dz * tx);
              if (ahead > 0 && side < SEPARATION) {
                if (ahead < 1.6) {
                  // step to the side away from them
                  const s = (dx * tz - dz * tx) >= 0 ? 1 : -1;
                  sx += tz * s * (1.6 - ahead) * 0.8;
                  sz += -tx * s * (1.6 - ahead) * 0.8;
                  if (ahead < 0.8) vMax = Math.min(vMax, q.v * 0.9 + 0.15);
                }
              }
            }
            if (d < SEPARATION && !(p.state === 'talk' && q.group === p.group)) {
              sx += (dx / d) * (SEPARATION - d) * 2;
              sz += (dz / d) * (SEPARATION - d) * 2;
            }
          }
        }
      }
      // the player
      const dpx = p.x - px, dpz = p.z - pz;
      const dp = Math.hypot(dpx, dpz);
      if (dp < playerR + 2 && dp > 1e-3) {
        const push = Math.min(1, (playerR + 2 - dp) / 2);
        sx += (dpx / dp) * push * 3;
        sz += (dpz / dp) * push * 3;
        if (p.state === 'talk' || p.state === 'stand') p.until = Math.min(p.until, elapsed + 1);
      }
      // move
      p.v += Math.max(-2.5 * dt, Math.min(1.3 * dt, vMax - p.v));
      let mx = tx * p.v + sx, mz = tz * p.v + sz;
      const m = Math.hypot(mx, mz);
      const cap = Math.max(p.speed * 1.2, dp < playerR + 2 ? 3.5 : 0);
      if (m > cap) { mx *= cap / m; mz *= cap / m; }
      const nx = p.x + mx * dt, nz = p.z + mz * dt;
      if (isOpen(sq, nx, nz)) { p.x = nx; p.z = nz; } else if (isOpen(sq, nx, p.z)) p.x = nx; else if (isOpen(sq, p.x, nz)) p.z = nz;
      // heading: along the walk, at the group's centre while talking, else held
      if (p.state === 'talk' && p.group) p.heading = Math.atan2(p.group.x - p.x, p.group.z - p.z);
      else if (m > 0.25) p.heading = Math.atan2(mx, mz);
      else if (p.state === 'stand' && Math.random() < dt * 0.08) p.heading += (Math.random() - 0.5) * 2;

      const dcam = Math.hypot(p.x - cam.x, p.z - cam.z);
      const draw = dcam < (sq.dynamic ? STREET_DRAW : 420) && visible(p.x, p.z);
      p.rig.update(dt, p.x, p.z, p.heading, groundFn, p, 0, draw);
      if (draw) crowd.add(p.rig, Math.hypot(p.x - cam.x, cam.y, p.z - cam.z));
    }
    crowd.end();
  }

  const stats = () => ({ streetExpected: streetArea ? streetArea.expected : 0, streetActive,
    streetLive: streetPeople.filter((p) => p.live).length, openCells: streetArea ? streetArea.cells.length : 0 });
  return { update, meshes: crowd.meshes, people, stats };
}

export { createPlazaCrowd };
