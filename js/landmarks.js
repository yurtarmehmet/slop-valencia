import * as THREE from 'three/webgpu';
import { positionWorld, normalWorld, texture } from 'three/tsl';
import { LANDMARK_SITES, LANDMARK_CIRCLES, ROADS, lonLatToWorld } from './city-config.js';
import { batchStaticGroupMeshes } from './city-grid.js';
import { LANDMARK_HEIGHTS, LANDMARK_SHAPES } from './vlc-landmark-heights.js';

// València's landmarks as procedural models on their real OpenStreetMap footprints (city-config.js LANDMARK_SITES),
// sized by their PNOA-LiDAR height profiles (vlc-landmark-heights.js: p50 / p90 / top of the points on each footprint)
// and shaped after open reference photos (reference/credits.json): the cathedral & the Micalet, the Desemparats'
// blue-tiled dome, the Serrans & Quart city gates, the Llotja, the Mercat Central, the Estació del Nord, Correus, the
// Mercat de Colón, the bullring, Mestalla, and Calatrava's white Ciutat de les Arts i les Ciències (the Hemisfèric's
// eye, the Palau de les Arts' crest, the Museu de les Ciències' ribs, l'Umbracle's arches, the Assut de l'Or's pylon),
// the Mercat de Russafa's coloured fins, the Torre de França and Veles e Vents. Each model is turned to its footprint's long axis.

// No lawn raised above the sidewalks (controllers.js reads one landmarks.js may lay out)
const bryantParkLawn = null;
// Each model's highest point once built (name -> metres), for checking against LANDMARK_HEIGHTS
const landmarkTops = {};

// A footprint ring (flat [x0, z0, x1, z1, ...]) as [[x, z], ...]
const ringPts = (flat) => {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};
// Minimum-area bounding box over the ring's edge directions: centre, long-side direction (ux, uz), length, width
function obb(flat) {
  const pts = ringPts(flat);
  const cx = pts.reduce((t, p) => t + p[0], 0) / pts.length;
  const cz = pts.reduce((t, p) => t + p[1], 0) / pts.length;
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % pts.length];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.5) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of pts) {
      const u = (x - cx) * ux + (z - cz) * uz;
      const v = -(x - cx) * uz + (z - cz) * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const mu = (u0 + u1) / 2, mv = (v0 + v1) / 2;
      const c = { x: cx + mu * ux - mv * uz, z: cz + mu * uz + mv * ux };
      best = u1 - u0 >= v1 - v0
        ? { area, ...c, ux, uz, L: u1 - u0, W: v1 - v0 }
        : { area, ...c, ux: -uz, uz: ux, L: v1 - v0, W: u1 - u0 };
    }
  }
  return best || { x: cx, z: cz, ux: 1, uz: 0, L: 10, W: 10 };
}
// A landmark's LiDAR height (p50 / p90 / top), or the fallback where the survey has none
const H = (name, key, fallback) => LANDMARK_HEIGHTS[name]?.[key] ?? fallback;

function buildLandmarks(scene) {
  const group = new THREE.Group();
  group.name = 'Landmarks';
  const colliders = [];

  const mat = (color, roughness = 0.8, metalness = 0.0, extra = {}) => new THREE.MeshStandardNodeMaterial({ color, roughness, metalness, ...extra });
  const M = {
    // the cathedral & Micalet's weathered golden-brown limestone, the gates' darker stone (reference/v02, v03, v04)
    sandstone: mat(0xae9672, 0.9),
    oldStone: mat(0x9c8669, 0.92),
    stone: mat(0xddd0b4, 0.82),
    brick: mat(0xb0643f, 0.88),
    terracotta: mat(0xc77b4a, 0.85),
    orange: mat(0xd99a4e, 0.75),
    zinc: mat(0x7d8a8c, 0.45, 0.55),
    tileBlue: mat(0x2f5fa8, 0.25, 0.15),
    tileTeal: mat(0x3d7f86, 0.3, 0.15),
    tileWhite: mat(0xf4f2ec, 0.3, 0.05),
    calatrava: mat(0xf4f4f0, 0.3, 0.05),
    hemiGrey: mat(0x8c9297, 0.35, 0.45),
    glass: mat(0x6f9db0, 0.1, 0.6),
    darkGlass: mat(0x2f4450, 0.08, 0.75),
    steel: mat(0xd4d8dc, 0.3, 0.85),
    concrete: mat(0xa9a8a2, 0.88),
    pitch: mat(0x3f8a3a, 0.95),
    sand: mat(0xd9c08f, 1.0),
    gold: mat(0xc9a24a, 0.35, 0.8),
    iron: mat(0x2b2a28, 0.5, 0.6),
    pit: mat(0x5d5142, 0.95)
  };
  M.calatravaDouble = mat(0xf4f4f0, 0.3, 0.05, { side: THREE.DoubleSide });
  M.hemiGreyDouble = mat(0x8c9297, 0.35, 0.45, { side: THREE.DoubleSide });
  M.brickDouble = mat(0xb0643f, 0.88, 0, { side: THREE.DoubleSide });
  M.concreteDouble = mat(0xa9a8a2, 0.88, 0, { side: THREE.DoubleSide });

  // Geometry helpers in a landmark's local frame
  const add = (g, geo, m, x = 0, y = 0, z = 0, cast = true) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    g.add(mesh);
    return mesh;
  };
  const box = (g, w, h, d, x, y0, z, m) => add(g, new THREE.BoxGeometry(w, h, d), m, x, y0 + h / 2, z);
  const cyl = (g, r0, r1, h, x, y0, z, m, seg = 16) => add(g, new THREE.CylinderGeometry(r1, r0, h, seg), m, x, y0 + h / 2, z);
  const lathe = (g, prof, x, y0, z, m, seg = 24) => add(g, new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), seg), m, x, y0, z);
  // A half dome of radius r (its height scaled by k) standing at y0
  const dome = (g, r, x, y0, z, m, k = 1, seg = 20) => {
    const d = add(g, new THREE.SphereGeometry(r, seg, Math.ceil(seg / 2), 0, Math.PI * 2, 0, Math.PI / 2), m, x, y0, z);
    d.scale.y = k;
    return d;
  };
  // Crenellations (merlons) along a box's top edges
  function merlons(g, w, d, y, m, size = 1.2, gap = 1.4) {
    for (let x = -w / 2 + size / 2; x <= w / 2 - size / 2 + 1e-3; x += size + gap) {
      box(g, size, size * 1.3, size, x, y, -d / 2 + size / 2, m);
      box(g, size, size * 1.3, size, x, y, d / 2 - size / 2, m);
    }
    for (let z = -d / 2 + size / 2 + size + gap; z <= d / 2 - size * 1.5 - gap + 1e-3; z += size + gap) {
      box(g, size, size * 1.3, size, -w / 2 + size / 2, y, z, m);
      box(g, size, size * 1.3, size, w / 2 - size / 2, y, z, m);
    }
  }
  // Merlons round a polygonal / round tower top of radius r
  function ringMerlons(g, r, y, n, m, x = 0, z = 0) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      box(g, 1.2, 1.7, 1.2, x + Math.cos(a) * (r - 0.6), y, z + Math.sin(a) * (r - 0.6), m).rotation.y = -a;
    }
  }

  // The footprint, extruded straight up in world coordinates (holes: rings in the same flat form)
  function extrude(flat, y0, h, m, holes = [], name = '') {
    const shape = new THREE.Shape(ringPts(flat).map(([x, z]) => new THREE.Vector2(x, -z)));
    for (const hole of holes) shape.holes.push(new THREE.Path(ringPts(hole).map(([x, z]) => new THREE.Vector2(x, -z))));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const mesh = add(group, geo, m, 0, y0, 0);
    mesh.name = name;
    return mesh;
  }
  // A modernista hall's walls on its footprint: a plinth, a tall glazed band set back behind piers every ~6 m (the
  // Mercat Central's & Colón's arcades, the station's windows), a stone cornice band to the roof line
  function glazedHall(flat, top, wallMat, trimMat, name, plinth = 3.2, band = 0.62) {
    const pts = ringPts(flat);
    const cx = pts.reduce((t, p) => t + p[0], 0) / pts.length, cz = pts.reduce((t, p) => t + p[1], 0) / pts.length;
    const inset = pts.flatMap(([x, z]) => {
      const d = Math.hypot(x - cx, z - cz) || 1;
      return [x - ((x - cx) / d) * 0.6, z - ((z - cz) / d) * 0.6];
    });
    const bandTop = plinth + (top - plinth) * band;
    const parts = [extrude(flat, 0, plinth, wallMat, [], name), extrude(inset, plinth, bandTop - plinth, M.darkGlass),
      extrude(flat, bandTop, top - bandTop, trimMat)];
    const g = new THREE.Group();
    for (let i = 0; i < pts.length; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[(i + 1) % pts.length];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(L / 6));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const pier = box(g, 1.3, bandTop - plinth, 1.3, ax + (bx - ax) * t, plinth, az + (bz - az) * t, wallMat);
        pier.rotation.y = Math.atan2(-(bz - az), bx - ax);
      }
    }
    group.add(g);
    return parts;
  }

  // A landmark's group at its footprint's box centre, local +x along the long side
  // `trim`: fit only the outline's corners within `trim` m of its area centroid (leaving out a wall stub and the like)
  function place(name, turn = true, trim = Infinity) {
    const s = LANDMARK_SITES[name];
    if (!s || !s.ring) return null;
    let ring = s.ring;
    if (trim < Infinity) {
      let A = 0, cx = 0, cz = 0;
      for (let i = 0, n = ring.length; i < n; i += 2) {
        const x0 = ring[i], z0 = ring[i + 1], x1 = ring[(i + 2) % n], z1 = ring[(i + 3) % n];
        const k = x0 * z1 - x1 * z0;
        A += k; cx += (x0 + x1) * k; cz += (z0 + z1) * k;
      }
      cx /= 3 * A; cz /= 3 * A;
      ring = ringPts(ring).filter(([x, z]) => Math.hypot(x - cx, z - cz) <= trim).flat();
    }
    const b = obb(ring);
    const g = new THREE.Group();
    g.position.set(b.x, 0, b.z);
    if (turn) g.rotation.y = Math.atan2(-b.uz, b.ux);
    g.name = name;
    group.add(g);
    return { g, s, b };
  }
  // Player colliders shaped like the model's footprint, not its world box (a round bullring's or a turned station's
  // box reaches over the streets beside it): the parts of the model within `under` m of the ground are rasterized
  // onto a CELL grid in their footprint's frame, enclosed cells filled (an outline of walls closes on its interior),
  // and the grid's rows merged into oriented boxes as tall as the model.
  function collide(obj, under = 4) {
    const CELL = 0.75;
    obj.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(obj);
    if (bb.isEmpty()) return;
    const tris = []; // world x, z of each ground-reaching triangle's corners, 6 per triangle
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const m = new THREE.Matrix4(), im = new THREE.Matrix4();
    obj.traverse((mesh) => {
      const pos = mesh.isMesh && mesh.geometry?.attributes.position;
      if (!pos) return;
      const index = mesh.geometry.index;
      const n = index ? index.count : pos.count;
      const instances = mesh.isInstancedMesh ? mesh.count : 1;
      for (let k = 0; k < instances; k++) {
        if (mesh.isInstancedMesh) m.multiplyMatrices(mesh.matrixWorld, (mesh.getMatrixAt(k, im), im));
        else m.copy(mesh.matrixWorld);
        for (let t = 0; t + 2 < n; t += 3) {
          const i0 = index ? index.getX(t) : t, i1 = index ? index.getX(t + 1) : t + 1, i2 = index ? index.getX(t + 2) : t + 2;
          a.fromBufferAttribute(pos, i0).applyMatrix4(m);
          b.fromBufferAttribute(pos, i1).applyMatrix4(m);
          c.fromBufferAttribute(pos, i2).applyMatrix4(m);
          if (Math.min(a.y, b.y, c.y) >= under) continue;
          tris.push(a.x, a.z, b.x, b.z, c.x, c.z);
        }
      }
    });
    if (!tris.length) return;
    // the footprint's frame: the minimum-area box round the convex hull of the triangles' corners
    const pts = [];
    for (let i = 0; i < tris.length; i += 2) pts.push([tris[i], tris[i + 1]]);
    pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    const hull = [];
    for (const pass of [pts, pts.slice().reverse()]) {
      const start = hull.length;
      for (const p of pass) {
        while (hull.length >= start + 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
        hull.push(p);
      }
      hull.pop();
    }
    const f = obb(hull.flat());
    const ux = f.ux, uz = f.uz;
    // grid over the frame's box, a cell of margin round it
    const nu = Math.ceil(f.L / CELL) + 3, nv = Math.ceil(f.W / CELL) + 3;
    const u0 = -nu * CELL / 2, v0 = -nv * CELL / 2;
    const grid = new Uint8Array(nu * nv);
    const local = new Float32Array(tris.length);
    for (let i = 0; i < tris.length; i += 2) {
      const dx = tris[i] - f.x, dz = tris[i + 1] - f.z;
      local[i] = (dx * ux + dz * uz - u0) / CELL;
      local[i + 1] = (-dx * uz + dz * ux - v0) / CELL;
    }
    const mark = (u, v) => {
      const iu = Math.floor(u), iv = Math.floor(v);
      if (iu >= 0 && iu < nu && iv >= 0 && iv < nv) grid[iv * nu + iu] = 1;
    };
    for (let i = 0; i < local.length; i += 6) {
      const p = [local[i], local[i + 1], local[i + 2], local[i + 3], local[i + 4], local[i + 5]];
      // edges as lines (a wall seen from above is a line), then the cells whose centres fall inside the triangle
      for (let e = 0; e < 3; e++) {
        const sx = p[e * 2], sz = p[e * 2 + 1], tx = p[(e * 2 + 2) % 6], tz = p[(e * 2 + 3) % 6];
        const steps = Math.ceil(Math.hypot(tx - sx, tz - sz) * 2) + 1;
        for (let s = 0; s <= steps; s++) mark(sx + (tx - sx) * s / steps, sz + (tz - sz) * s / steps);
      }
      const area = (p[2] - p[0]) * (p[5] - p[1]) - (p[3] - p[1]) * (p[4] - p[0]);
      if (Math.abs(area) < 1e-6) continue;
      const lo = Math.max(0, Math.floor(Math.min(p[0], p[2], p[4]))), hi = Math.min(nu - 1, Math.floor(Math.max(p[0], p[2], p[4])));
      const lov = Math.max(0, Math.floor(Math.min(p[1], p[3], p[5]))), hiv = Math.min(nv - 1, Math.floor(Math.max(p[1], p[3], p[5])));
      for (let iv = lov; iv <= hiv; iv++) {
        for (let iu = lo; iu <= hi; iu++) {
          const x = iu + 0.5, z = iv + 0.5;
          const w0 = (p[2] - x) * (p[5] - z) - (p[3] - z) * (p[4] - x);
          const w1 = (p[4] - x) * (p[1] - z) - (p[5] - z) * (p[0] - x);
          const w2 = (p[0] - x) * (p[3] - z) - (p[1] - z) * (p[2] - x);
          if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) grid[iv * nu + iu] = 1;
        }
      }
    }
    // fill what the outside can't reach (flood from the margin)
    const outside = new Uint8Array(nu * nv);
    const stack = [0];
    outside[0] = 1;
    while (stack.length) {
      const k = stack.pop();
      const iu = k % nu, iv = (k - iu) / nu;
      for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ju = iu + du, jv = iv + dv;
        if (ju < 0 || ju >= nu || jv < 0 || jv >= nv) continue;
        const j = jv * nu + ju;
        if (grid[j] || outside[j]) continue;
        outside[j] = 1;
        stack.push(j);
      }
    }
    // rows of runs, a run continuing a rectangle when the row below had the same run
    const cs = ux, sn = -uz; // controllers.js: local x = dx·cs − dz·sn along (ux, uz), local z = dx·sn + dz·cs
    const emit = (r) => {
      const hx = (r.b - r.a) * CELL / 2, hz = (r.v1 - r.v) * CELL / 2;
      const lu = u0 + (r.a + r.b) * CELL / 2, lv = v0 + (r.v + r.v1) * CELL / 2;
      const cx = f.x + lu * ux - lv * uz, cz = f.z + lu * uz + lv * ux;
      const ex = Math.abs(ux) * hx + Math.abs(uz) * hz, ez = Math.abs(uz) * hx + Math.abs(ux) * hz;
      colliders.push({ minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY: 0, maxY: bb.max.y, landmark: obj.name || obj.parent?.name || true, obb: { cx, cz, hx, hz, cs, sn } });
    };
    let open = new Map();
    for (let iv = 0; iv <= nv; iv++) {
      const next = new Map();
      if (iv < nv) {
        for (let iu = 0; iu < nu;) {
          if (outside[iv * nu + iu]) { iu++; continue; }
          const s = iu;
          while (iu < nu && !outside[iv * nu + iu]) iu++;
          const key = s * 65536 + iu;
          const r = open.get(key) || { a: s, b: iu, v: iv };
          r.v1 = iv + 1;
          open.delete(key);
          next.set(key, r);
        }
      }
      for (const r of open.values()) emit(r);
      open = next;
    }
  }
  // the model's highest point (all its parts), for the LiDAR check
  const tops = (name, ...objs) => {
    let y = 0;
    for (const o of objs) {
      o.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(o);
      if (!bb.isEmpty()) y = Math.max(y, bb.max.y);
    }
    landmarkTops[name] = Math.round(y * 10) / 10;
  };

  // ---- Survey-shaped halls (vlc-landmark-heights.js LANDMARK_SHAPES): the roof is the LiDAR surface itself on a 1 m
  // grid, clipped to the outline and coloured from the orthophoto; the walls stand on the outline up to the roof's edge,
  // so gables, lanterns and parapets come out where the survey has them. `cuts`: circles where a dome or tower modelled on
  // its own replaces the surface (the roof there is held at `h`).
  function surveySampler(shape, cuts = []) {
    const G = shape.grid;
    const h = Uint8Array.from(atob(G.h), (c) => c.charCodeAt(0));
    const R = shape.rgb;
    const rgb = Uint8Array.from(atob(R.data), (c) => c.charCodeAt(0));
    const bil = (arr, nx, nz, cell, x, z, k = 0, stride = 1) => {
      const u = Math.min(nx - 1.001, Math.max(0, (x - G.x0) / cell - 0.5)), v = Math.min(nz - 1.001, Math.max(0, (z - G.z0) / cell - 0.5));
      const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
      const at = (ii, jj) => arr[(jj * nx + ii) * stride + k];
      return (at(i, j) * (1 - fu) + at(i + 1, j) * fu) * (1 - fv) + (at(i, j + 1) * (1 - fu) + at(i + 1, j + 1) * fu) * fv;
    };
    return {
      height(x, z) {
        let y = bil(h, G.nx, G.nz, G.cell, x, z) * G.q;
        for (const c of cuts) if (Math.hypot(x - c.x, z - c.z) < c.r) y = Math.min(y, c.h);
        return y;
      },
      // the orthophoto's colour, its saturation raised by `sat` (the aerial survey's haze greys it)
      color(x, z, out, sat = 1.35) {
        const r = bil(rgb, R.nx, R.nz, R.cell, x, z, 0, 3) / 255, g = bil(rgb, R.nx, R.nz, R.cell, x, z, 1, 3) / 255, b = bil(rgb, R.nx, R.nz, R.cell, x, z, 2, 3) / 255;
        const l = (r + g + b) / 3;
        const f = (v) => Math.min(1, Math.max(0, l + (v - l) * sat));
        return out.setRGB(f(r), f(g), f(b), THREE.SRGBColorSpace);
      }
    };
  }
  // The roof: each grid cell clipped to the outline (Sutherland–Hodgman against the cell's square), shared vertices at
  // the cell corners so the surface shades smooth
  function surveyRoof(flat, shape, sampler, roofMat, tint = 1) {
    const G = shape.grid;
    const ring = ringPts(flat);
    const pos = [], col = [], idx = [];
    const vmap = new Map();
    const c = new THREE.Color();
    const vert = (x, z) => {
      const key = `${Math.round(x * 100)},${Math.round(z * 100)}`;
      let i = vmap.get(key);
      if (i !== undefined) return i;
      i = pos.length / 3;
      pos.push(x, sampler.height(x, z), z);
      sampler.color(x, z, c);
      col.push(c.r * tint, c.g * tint, c.b * tint);
      vmap.set(key, i);
      return i;
    };
    const inside = (x, z) => {
      let w = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, zi] = ring[i], [xj, zj] = ring[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) w = !w;
      }
      return w;
    };
    const clip = (poly, axis, val, keepLess) => {
      const out = [];
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        const pin = keepLess ? p[axis] <= val : p[axis] >= val, qin = keepLess ? q[axis] <= val : q[axis] >= val;
        if (pin) out.push(p);
        if (pin !== qin) {
          const t = (val - p[axis]) / (q[axis] - p[axis]);
          out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        }
      }
      return out;
    };
    for (let j = 0; j < G.nz; j++) {
      for (let i = 0; i < G.nx; i++) {
        const x0 = G.x0 + i * G.cell, x1 = x0 + G.cell, z0 = G.z0 + j * G.cell, z1 = z0 + G.cell;
        const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
        const allIn = corners.every(([x, z]) => inside(x, z));
        const vIn = ring.some(([x, z]) => x > x0 && x < x1 && z > z0 && z < z1);
        if (allIn && !vIn) {
          const a = vert(x0, z0), b = vert(x1, z0), cc = vert(x1, z1), d = vert(x0, z1);
          idx.push(a, d, cc, a, cc, b);
          continue;
        }
        let poly = ring;
        poly = clip(poly, 0, x0, false); if (poly.length < 3) continue;
        poly = clip(poly, 0, x1, true); if (poly.length < 3) continue;
        poly = clip(poly, 1, z0, false); if (poly.length < 3) continue;
        poly = clip(poly, 1, z1, true); if (poly.length < 3) continue;
        const tris = THREE.ShapeUtils.triangulateShape(poly.map(([x, z]) => new THREE.Vector2(x, z)), []);
        const ids = poly.map(([x, z]) => vert(x, z));
        for (const [a, b, cc] of tris) {
          // wind upward (+y normal): the x-z polygon's turn decides
          const [ax, az] = poly[a], [bx, bz] = poly[b], [cx, cz] = poly[cc];
          const cr = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
          if (Math.abs(cr) < 1e-6) continue;
          if (cr < 0) idx.push(ids[a], ids[b], ids[cc]); else idx.push(ids[a], ids[cc], ids[b]);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return add(group, geo, roofMat, 0, 0, 0);
  }
  // The walls: a strip up each outline edge to the roof's edge, densified so its top follows gables & steps; u runs
  // along the walls in bays of `bay` metres, v is the height over `texH` metres (the facade texture's scale)
  function surveyWalls(flat, sampler, wallMat, bay, texH, step = 1.0) {
    const ring = ringPts(flat);
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      area += ax * bz - bx * az;
    }
    const pos = [], uv = [], idx = [];
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 0.05) continue;
      // whole bays per edge, so each edge starts and ends on a pier
      const nb = Math.max(1, Math.round(L / bay));
      const n = Math.max(1, Math.ceil(L / step));
      const base = pos.length / 3;
      for (let k = 0; k <= n; k++) {
        const t = k / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const top = Math.max(2, sampler.height(x, z));
        pos.push(x, 0, z, x, top, z);
        uv.push(t * nb, 0, t * nb, top / texH);
      }
      for (let k = 0; k < n; k++) {
        const a = base + k * 2;
        // outward-facing for either winding of the outline
        if (area < 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return add(group, geo, wallMat, 0, 0, 0);
  }
  // A canvas texture (sRGB, repeating across) painted by `draw(ctx, w, h)`
  function canvasTex(w, h, draw, repeatV = false) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = repeatV ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.anisotropy = 4;
    t.generateMipmaps = true;
    return t;
  }
  // A tiled canvas pattern of Valencian azulejos: diamonds of `a` and `b` on `ground`, `n` across the rectangle
  function azulejos(x, X, Y, W, Hh, n, ground, a, b) {
    const s = W / n;
    x.fillStyle = ground; x.fillRect(X, Y, W, Hh);
    for (let j = 0; j * s < Hh; j++) {
      for (let i = 0; i < n; i++) {
        const cx = X + (i + 0.5) * s, cy = Y + (j + 0.5) * s;
        x.fillStyle = (i + j) % 2 ? a : b;
        x.beginPath(); x.moveTo(cx, cy - s * 0.42); x.lineTo(cx + s * 0.42, cy); x.lineTo(cx, cy + s * 0.42); x.lineTo(cx - s * 0.42, cy); x.fill();
        x.fillStyle = ground; x.fillRect(cx - s * 0.08, cy - s * 0.08, s * 0.16, s * 0.16);
      }
    }
  }
  // A material whose canvas texture is laid on in world space (triplanar: each face takes the plane it faces most), one
  // repeat every `size` metres: ashlar on curved towers & boxes alike, without per-geometry uvs
  function worldMat(tex, size, roughness = 0.9) {
    const m = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0 });
    const p = positionWorld.div(size);
    const n = normalWorld.abs();
    const c = texture(tex, p.zy).rgb.mul(n.x).add(texture(tex, p.xz).rgb.mul(n.y)).add(texture(tex, p.xy).rgb.mul(n.z));
    m.colorNode = c.div(n.x.add(n.y).add(n.z));
    return m;
  }
  // Ashlar: courses of 0.5 m blocks (1-1.4 m long, staggered), each block's tone varied, joints a shade darker
  function ashlarTex(base, joint, seed = 3) {
    let sd = seed;
    const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
    const t = canvasTex(256, 256, (x, W, Hc) => {
      x.fillStyle = joint; x.fillRect(0, 0, W, Hc);
      const c = new THREE.Color(base);
      for (let row = 0; row < 8; row++) {
        let xx = -rnd() * 40;
        while (xx < W) {
          const w = 64 + rnd() * 26;
          const k = 0.9 + rnd() * 0.18;
          x.fillStyle = `rgb(${Math.min(255, c.r * 255 * k)},${Math.min(255, c.g * 255 * k)},${Math.min(255, c.b * 255 * k)})`;
          x.fillRect(xx + 1.5, row * 32 + 1.5, w - 3, 29);
          xx += w;
        }
      }
    }, true);
    t.wrapT = THREE.RepeatWrapping;
    return t;
  }
  // A pointed (Gothic) arch's opening, w wide and h tall, as a flat shape facing local +z
  function pointedArch(w, h) {
    const r = w * 0.8, sp = h - Math.sqrt(r * r - (r - w / 2) ** 2); // the springing height: two arcs of radius r meet at h
    const sh = new THREE.Shape();
    sh.moveTo(-w / 2, 0); sh.lineTo(w / 2, 0); sh.lineTo(w / 2, sp);
    const apex = Math.atan2(h - sp, r - w / 2); // each arc's angle at the apex
    sh.absarc(w / 2 - r, sp, r, 0, apex, false);
    sh.absarc(-w / 2 + r, sp, r, Math.PI - apex, Math.PI, false);
    sh.lineTo(-w / 2, 0);
    return new THREE.ShapeGeometry(sh, 8);
  }
  const vcolMat = (roughness = 0.85, metalness = 0) => new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness, metalness });

  // =========================================================================
  // CIUTAT VELLA
  // =========================================================================
  // The cathedral: Gothic nave & transept at the survey's roof height, the octagonal cimbori (lantern) over the crossing
  {
    const name = 'Catedral de València';
    const s = LANDMARK_SITES[name];
    if (s?.ring) {
      const roof = H(name, 'p90', 22);
      const body = extrude(s.ring, 0, roof, M.sandstone, [], name);
      collide(body);
      const b = obb(s.ring);
      const g = new THREE.Group();
      g.position.set(b.x, 0, b.z);
      cyl(g, 9, 9, 15, 0, roof, 0, M.sandstone, 8);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        box(g, 2.2, 9, 0.6, Math.cos(a) * 8.7, roof + 3, Math.sin(a) * 8.7, M.darkGlass).rotation.y = -a + Math.PI / 2;
      }
      add(g, new THREE.ConeGeometry(9.6, 5, 8), M.terracotta, 0, roof + 17.5, 0).rotation.y = Math.PI / 8;
      group.add(g);
      tops(name, body, g);
    }
  }
  // El Micalet: the octagonal bell tower (its terrace at the survey's p50, ~49 m), the belfry's tall pointed openings,
  // and the espadaña: the iron-caged bell turret on the terrace, up to the survey's top (66 m)
  {
    const name = 'el Micalet';
    const s = LANDMARK_SITES[name];
    if (s) {
      const terrace = H(name, 'p50', 50);
      const top = H(name, 'top', 63);
      const g = new THREE.Group();
      g.position.set(s.x, 0, s.z);
      g.name = name;
      const shaftTop = terrace - 10;
      cyl(g, 8.2, 8.0, shaftTop, 0, 0, 0, M.sandstone, 8).rotation.y = Math.PI / 8;
      // string courses up the shaft
      for (const y of [shaftTop * 0.35, shaftTop * 0.7]) cyl(g, 8.35, 8.35, 0.5, 0, y, 0, M.oldStone, 8).rotation.y = Math.PI / 8;
      cyl(g, 8.0, 8.0, 10, 0, shaftTop, 0, M.oldStone, 8).rotation.y = Math.PI / 8;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        box(g, 2.4, 7.5, 0.5, Math.cos(a) * 7.7, shaftTop + 1, Math.sin(a) * 7.7, M.iron).rotation.y = -a + Math.PI / 2;
      }
      cyl(g, 8.7, 8.7, 0.9, 0, terrace - 0.9, 0, M.stone, 8).rotation.y = Math.PI / 8;
      ringMerlons(g, 8.5, terrace, 16, M.oldStone);
      // the espadaña: a stone stage, then the iron cage & its bell under a little spire
      cyl(g, 3.2, 2.9, 5, 0, terrace, 0, M.oldStone, 8);
      const cageH = Math.max(2, top - terrace - 5 - 3.2);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        box(g, 0.25, cageH, 0.25, Math.cos(a) * 2.2, terrace + 5, Math.sin(a) * 2.2, M.iron);
      }
      cyl(g, 1.0, 1.4, 1.6, 0, terrace + 5 + cageH * 0.3, 0, M.gold, 10);
      add(g, new THREE.ConeGeometry(2.4, 3.2, 8), M.iron, 0, terrace + 5 + cageH + 1.6, 0);
      group.add(g);
      collide(g);
      tops(name, g);
    }
  }
  // The Basílica de la Mare de Déu dels Desemparats: an oval church under a dome of Valencian blue glazed tiles
  {
    const name = 'Basílica de la Mare de Déu dels Desemparats';
    const s = LANDMARK_SITES[name];
    if (s?.ring) {
      const walls = H(name, 'p50', 16);
      const top = H(name, 'top', 33);
      const body = extrude(s.ring, 0, walls, M.stone, [], name);
      collide(body);
      const b = obb(s.ring);
      const g = new THREE.Group();
      g.position.set(b.x, 0, b.z);
      const r = Math.min(9, b.W * 0.38);
      const drum = 5;
      const k = Math.max(0.6, (top - walls - drum - 3.4) / r);
      cyl(g, r, r, drum, 0, walls, 0, M.stone, 24);
      dome(g, r, 0, walls + drum, 0, M.tileBlue, k, 24);
      cyl(g, 1.6, 1.4, 2.4, 0, walls + drum + r * k, 0, M.stone, 8);
      add(g, new THREE.SphereGeometry(1.0, 8, 6), M.gold, 0, walls + drum + r * k + 2.4, 0);
      group.add(g);
      tops(name, body, g);
    }
  }
  // Torres dels Serrans: the Gothic city gate on the Turia: two polygonal towers (flat faces outward) ringed by a band
  // of machicolations under their battlements, the gatehouse between with its openwork tracery over the arch
  {
    const name = 'Torres dels Serrans';
    const p = place(name);
    if (p) {
      const { g, b } = p;
      const L = Math.max(30, b.L), W = Math.max(12, b.W);
      const top = H(name, 'p90', 33) - 1.7; // the merlons (1.7 m) bring it up to the survey's p90
      const r = Math.min(W * 0.55, L * 0.21);
      for (const sx of [-1, 1]) {
        const x = sx * (L / 2 - r);
        const shaft = cyl(g, r, r, top - 3, x, 0, 0, M.oldStone, 6);
        shaft.rotation.y = Math.PI / 6;
        // machicolations: a corbelled band standing proud, its underside in shadow
        cyl(g, r + 0.8, r + 0.8, 2.4, x, top - 5.4, 0, M.oldStone, 6).rotation.y = Math.PI / 6;
        cyl(g, r + 0.6, r + 0.1, 0.8, x, top - 6.2, 0, M.pit, 6).rotation.y = Math.PI / 6;
        cyl(g, r + 0.8, r + 0.8, 3, x, top - 3, 0, M.oldStone, 6).rotation.y = Math.PI / 6;
        ringMerlons(g, r + 0.8, top, 12, M.oldStone, x, 0);
      }
      const gw = L - 4 * r + 1.6;
      box(g, gw, top - 6, W * 0.82, 0, 0, 0, M.oldStone);
      merlons(g, gw, W * 0.82, top - 6, M.oldStone, 1.1, 1.3);
      for (const sz of [-1, 1]) {
        box(g, 6.0, 10.5, 0.5, 0, 0, sz * (W * 0.41 + 0.05), M.iron);
        box(g, gw - 2.5, 4.2, 0.5, 0, 15.5, sz * (W * 0.41 + 0.05), M.sandstone);
      }
      collide(g);
      tops(name, g);
    }
  }
  // Torres de Quart: the western gate, two round towers pitted by the 1808 cannonballs, machicolated & crenellated; open on
  // the city side (local +z): the towers' inner walls & the gatehouse cut by tall pointed arches into their vaulted
  // storeys, the gate's pointed arch below, the gatehouse's battlements lower than the towers' (Street View pin 38's side)
  {
    const name = 'Torres de Quart';
    const p = place(name, true, 26); // the outline runs on down a stub of the city wall
    if (p) {
      const { g, b } = p;
      const L = Math.max(26, b.L), W = Math.max(12, b.W);
      const top = H(name, 'p90', 33) - 1.7; // the merlons (1.7 m) bring it up to the survey's p90
      const r = Math.min(W * 0.5, L * 0.22);
      const quartStone = worldMat(ashlarTex(0xb3a58b, '#8f8270', 11), 4);
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (const sx of [-1, 1]) {
        const x = sx * (L / 2 - r);
        cyl(g, r, r, top - 2.6, x, 0, 0, quartStone, 24);
        box(g, r * 2, top - 2.6, W * 0.5, x, 0, W * 0.25, quartStone);
        cyl(g, r + 0.7, r + 0.7, 2.6, x, top - 2.6, 0, quartStone, 24);
        cyl(g, r + 0.5, r, 0.7, x, top - 3.3, 0, M.pit, 24);
        ringMerlons(g, r + 0.7, top, 14, quartStone, x, 0);
        // cannonball pits on the outward faces
        for (let i = 0; i < 46; i++) {
          const a = Math.PI * (0.15 + rnd() * 0.7) * (rnd() < 0.5 ? 1 : -1) + Math.PI;
          const y = 4 + rnd() * (top - 9);
          const pr = 0.25 + rnd() * 0.3;
          add(g, new THREE.SphereGeometry(pr, 6, 4), M.pit, x + Math.cos(a) * (r - pr * 0.4), y, Math.sin(a) * (r - pr * 0.4), false);
        }
      }
      const gw = L - 4 * r + 1, gTop = top - 3.5;
      box(g, gw, gTop, W * 0.8, 0, 0, 0, quartStone);
      box(g, 5.5, 10, 0.6, 0, 0, -W * 0.4 - 0.05, M.iron);
      // the city side: dark pointed openings standing off the faces
      const shade = mat(0x2b2722, 0.95, 0, { side: THREE.DoubleSide });
      const arch = (w, h, x, y0, z) => add(g, pointedArch(w, h), shade, x, y0, z, false);
      arch(5.2, 9.0, 0, 0, W * 0.4 + 0.06);
      arch(gw * 0.62, gTop - 14, 0, 11.5, W * 0.4 + 0.06);
      merlons(g, gw, W * 0.8, gTop, quartStone, 1.1, 1.3);
      for (const sx of [-1, 1]) {
        const x = sx * (L / 2 - r);
        arch(r * 1.25, 9.5, x, 7.5, W * 0.5 + 0.06);
        arch(r * 1.25, 9.0, x, 19.0, W * 0.5 + 0.06);
      }
      collide(g);
      tops(name, g);
    }
  }
  // La Llotja de la Seda: the late-Gothic silk exchange: its crenellated hall at the survey's p90 & the square tower
  {
    const name = 'Llotja de la Seda';
    const s = LANDMARK_SITES[name];
    const p = place(name);
    if (s?.ring && p) {
      const hall = H(name, 'p90', 20) - 1.4;
      const top = H(name, 'top', 28);
      const body = extrude(s.ring, 0, hall, M.sandstone, [], name);
      collide(body);
      const { g, b } = p;
      const t = new THREE.Group();
      t.position.x = b.L / 2 - 7;
      box(t, 11, top - 1.4, 11, 0, 0, 0, M.sandstone);
      merlons(t, 11, 11, top - 1.4, M.sandstone, 1.0, 1.2);
      g.add(t);
      merlons(g, b.L * 0.6, b.W * 0.8, hall, M.sandstone, 0.9, 1.6);
      tops(name, body, g);
    }
  }
  // The Mercat Central (Soler i March & Guàrdia i Vial, 1914-28): the roof is the survey's (LANDMARK_SHAPES: its naves'
  // tiled gables & the long glazed clerestories along their ridges, the fish hall's octagonal pavilion), coloured from the
  // orthophoto; the walls on the outline up to the roof's edge in the market's bays (reference/v07-mercat-11): a stone
  // plinth, stalls under yellow awnings between tiled piers, a blue & white azulejo frieze, tall arched windows of grey
  // louvres under stained-glass lunettes between cream stone piers, azulejo spandrels, the cornice and the tiled gables
  // above it. Modelled on their own at the survey's peaks: the ribbed main dome (drum, dome & lantern with the parrot
  // weathervane), the fish hall's dome, and the two domed stone towers of the west front on the Plaça de la Ciutat de Bruges
  {
    const name = 'Mercat Central';
    const s = LANDMARK_SITES[name];
    const shape = LANDMARK_SHAPES[name];
    if (s?.ring && shape) {
      const F = shape.features;
      const cuts = [
        { x: F.dome.x, z: F.dome.z, r: 7.6, h: F.dome.base },
        { x: F.fishDome.x, z: F.fishDome.z, r: 4.9, h: 20.2 },
        { x: F.towerS.x, z: F.towerS.z, r: 3.6, h: 11.2 },
        { x: F.towerN.x, z: F.towerN.z, r: 3.6, h: 11.2 }
      ];
      const sampler = surveySampler(shape, cuts);
      const PXM = 40, BAY = 6.5, TEXH = 16;
      const facade = canvasTex(256, TEXH * PXM, (x, W, Hc) => {
        const Y = (m) => Hc - m * PXM; // metres up -> canvas row
        const pier = 0.7 * W / BAY;
        x.fillStyle = '#cfbf9f'; x.fillRect(0, 0, W, Hc);
        // the tiled gables above the cornice
        azulejos(x, 0, Y(16), W, Y(13.0) - Y(16), 10, '#d9d3c8', '#3a5a94', '#9b4a45');
        x.fillStyle = '#cdbfa3'; x.fillRect(0, Y(13.0), W, 0.8 * PXM);
        x.fillStyle = '#8b7f6c'; x.fillRect(0, Y(12.25), W, 3);
        // the window bay: louvres, the lunette's stained glass under a stone arch, azulejo spandrels
        const r = (W - 2 * pier) / 2, cx = W / 2, cy = Y(9.6);
        azulejos(x, pier, Y(12.2), W - 2 * pier, cy - Y(12.2), 12, '#d9d3c8', '#3a5a94', '#9b4a45');
        x.fillStyle = '#e0d4bb'; x.beginPath(); x.arc(cx, cy, r, Math.PI, 0); x.fill();
        x.fillStyle = '#3f6f8a'; x.beginPath(); x.arc(cx, cy, r - 7, Math.PI, 0); x.fill();
        for (let i = 0; i < 9; i++) {
          const a = Math.PI + (i + 0.5) / 9 * Math.PI;
          x.fillStyle = ['#6f9cb4', '#b9a862', '#8fb294', '#b8d0d8'][i % 4];
          x.beginPath(); x.moveTo(cx, cy); x.arc(cx, cy, r - 10, a - 0.12, a + 0.12); x.fill();
        }
        x.fillStyle = '#e0d4bb'; x.beginPath(); x.arc(cx, cy, r * 0.32, Math.PI, 0); x.fill();
        x.fillStyle = '#7e8381'; x.fillRect(pier, cy, W - 2 * pier, Y(4.4) - cy);
        x.fillStyle = '#62676a';
        for (let yy = cy + 3; yy < Y(4.4); yy += 6) x.fillRect(pier, yy, W - 2 * pier, 2);
        x.fillStyle = '#4b4f50'; for (const fx of [0.33, 0.66]) x.fillRect(pier + (W - 2 * pier) * fx - 2, cy, 4, Y(4.4) - cy);
        // the piers' stone, a capital at the springing
        x.fillStyle = '#d8c9a8'; x.fillRect(0, Y(12.2), pier, Y(4.4) - Y(12.2)); x.fillRect(W - pier, Y(12.2), pier, Y(4.4) - Y(12.2));
        x.fillStyle = '#b8aa8e'; x.fillRect(0, cy - 4, pier + 4, 8); x.fillRect(W - pier - 4, cy - 4, pier + 4, 8);
        // the azulejo frieze over the stalls
        azulejos(x, 0, Y(4.4), W, Y(3.4) - Y(4.4), 10, '#f1eee6', '#2c58a0', '#d9b23a');
        // the stalls: a dark opening, goods, the yellow awning; tiled piers between
        x.fillStyle = '#3b3530'; x.fillRect(pier, Y(3.4), W - 2 * pier, Y(0.7) - Y(3.4));
        for (let i = 0; i < 9; i++) { x.fillStyle = ['#c98f4f', '#9fb06a', '#d65a3a', '#e8d9a8'][i % 4]; x.fillRect(pier + 6 + i * 20, Y(1.6), 16, 0.8 * PXM); }
        x.fillStyle = '#e2b52c'; x.fillRect(pier - 4, Y(3.4), W - 2 * pier + 8, 0.45 * PXM);
        x.fillStyle = '#7a5a10'; x.fillRect(pier + 20, Y(3.25), W - 2 * pier - 40, 4);
        azulejos(x, 0, Y(3.4), pier, Y(0.7) - Y(3.4), 2, '#f1eee6', '#2c58a0', '#3f8fb8');
        azulejos(x, W - pier, Y(3.4), pier, Y(0.7) - Y(3.4), 2, '#f1eee6', '#2c58a0', '#3f8fb8');
        x.fillStyle = '#a69882'; x.fillRect(0, Y(0.7), W, 0.7 * PXM);
      });
      const wallMat = mat(0xffffff, 0.82, 0, { map: facade });
      const walls = surveyWalls(s.ring, sampler, wallMat, BAY, TEXH);
      walls.name = name;
      const roof = surveyRoof(s.ring, shape, sampler, vcolMat(0.85), 0.8);
      collide(walls);
      const g = new THREE.Group();
      g.name = name;
      group.add(g);
      // the main dome: a glazed drum, the dome's iron ribs over blue-grey glass, the lantern, its cupolino & the parrot
      const ribTex = canvasTex(256, 64, (x, W, Hc) => {
        x.fillStyle = '#5d7486'; x.fillRect(0, 0, W, Hc);
        x.fillStyle = '#7f97a8'; for (let k = 0; k < 16; k++) x.fillRect(k * 16 + 3, 0, 4, Hc);
        x.fillStyle = '#e9e4d8'; for (let k = 0; k < 16; k++) x.fillRect(k * 16, 0, 2, Hc);
        x.fillStyle = '#e9e4d8'; for (let y = 8; y < Hc; y += 16) x.fillRect(0, y, W, 1);
      });
      const domeMat = mat(0xffffff, 0.3, 0.3, { map: ribTex });
      {
        const D = F.dome, spring = 18.5, R = 7.0, k = 1.22;
        cyl(g, R + 0.2, R + 0.2, spring - D.base, D.x, D.base, D.z, M.stone, 24);
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          box(g, 1.7, 2.0, 0.3, D.x + Math.cos(a) * (R + 0.25), D.base + 0.5, D.z + Math.sin(a) * (R + 0.25), M.darkGlass).rotation.y = -a + Math.PI / 2;
        }
        dome(g, R, D.x, spring, D.z, domeMat, k, 32);
        const crown = spring + R * k;
        cyl(g, 2.2, 2.2, 2.4, D.x, crown - 0.4, D.z, M.stone, 12);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          box(g, 0.9, 1.6, 0.2, D.x + Math.cos(a) * 2.25, crown, D.z + Math.sin(a) * 2.25, M.darkGlass).rotation.y = -a + Math.PI / 2;
        }
        dome(g, 2.4, D.x, crown + 2.0, D.z, M.tileTeal, 0.75, 12);
        cyl(g, 0.12, 0.12, 2.4, D.x, crown + 3.7, D.z, M.iron, 6);
        // the parrot (la cotorra) on its rod
        add(g, new THREE.SphereGeometry(0.45, 8, 6), M.pitch, D.x, crown + 5.6, D.z).scale.set(1.6, 1, 0.7);
      }
      // the fish hall's dome over its octagonal pavilion roof
      {
        const D = F.fishDome, spring = 20.2, R = 4.6;
        cyl(g, R + 0.3, R + 0.3, 1.0, D.x, spring - 0.8, D.z, M.stone, 8).rotation.y = Math.PI / 8;
        dome(g, R, D.x, spring, D.z, domeMat, 1.3, 24);
        cyl(g, 0.9, 0.9, 1.2, D.x, spring + R * 1.3 - 0.3, D.z, M.stone, 8);
        add(g, new THREE.SphereGeometry(0.5, 8, 6), M.gold, D.x, spring + R * 1.3 + 1.2, D.z);
      }
      // the west front's two towers: a round stone shaft, a ring of columns round the lantern, a small ribbed dome & vane
      const warm = mat(0xcbb48e, 0.88);
      const warmDark = mat(0xa8936f, 0.9);
      for (const T of [F.towerS, F.towerN]) {
        cyl(g, 3.2, 3.2, 11.2, T.x, 0, T.z, warm, 20);
        // pilasters up the shaft, string courses, tall windows
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          box(g, 0.7, 10.6, 0.35, T.x + Math.cos(a) * 3.25, 0.3, T.z + Math.sin(a) * 3.25, warmDark).rotation.y = -a + Math.PI / 2;
          const a2 = a + Math.PI / 8;
          box(g, 0.9, 2.6, 0.12, T.x + Math.cos(a2) * 3.17, 7.9, T.z + Math.sin(a2) * 3.17, M.darkGlass).rotation.y = -a2 + Math.PI / 2;
        }
        for (const y of [3.6, 7.4]) cyl(g, 3.4, 3.4, 0.4, T.x, y, T.z, warmDark, 20);
        cyl(g, 3.55, 3.55, 0.8, T.x, 11.2, T.z, warmDark, 20);
        cyl(g, 1.9, 1.9, 3.0, T.x, 12.0, T.z, M.pit, 12);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          cyl(g, 0.25, 0.25, 3.0, T.x + Math.cos(a) * 2.35, 12.0, T.z + Math.sin(a) * 2.35, warm, 6);
        }
        cyl(g, 2.7, 2.7, 0.6, T.x, 15.0, T.z, warmDark, 16);
        dome(g, 2.4, T.x, 15.6, T.z, domeMat, 1.1, 16);
        cyl(g, 0.08, 0.08, 2.2, T.x, 18.2, T.z, M.iron, 4);
        box(g, 1.2, 0.5, 0.08, T.x + 0.4, 19.4, T.z, M.iron);
      }
      collide(g);
      tops(name, walls, roof, g);
    }
  }
  // The Estació del Nord: Demetrio Ribes' modernista station, orange & cream, its facade's pinnacles crowned by eagles
  {
    const name = 'Estació del Nord';
    const s = LANDMARK_SITES[name];
    const p = place(name);
    if (s?.ring && p) {
      const walls = H(name, 'p90', 13);
      const top = H(name, 'top', 20);
      const [body] = glazedHall(s.ring, walls, M.orange, M.tileWhite, name, 3.0, 0.55);
      extrude(s.ring, walls, 0.8, M.tileWhite);
      collide(body);
      const { g, b } = p;
      for (const sx of [-1, -0.33, 0.33, 1]) {
        const x = sx * (b.L / 2 - 2);
        cyl(g, 1.3, 1.1, top - walls - 1.5, x, walls, -b.W / 2 + 1.5, M.tileWhite, 8);
        add(g, new THREE.SphereGeometry(1.0, 8, 6), M.gold, x, top - 1.0, -b.W / 2 + 1.5);
      }
      tops(name, body, g);
    }
  }
  // The Plaça de Bous: the neoclassical bullring, four tiers of brick arcades round a sand ring
  {
    const name = 'Plaça de Bous de València';
    const p = place(name, false);
    if (p) {
      // the ring on the circle through its outline's round part (the OSM outline takes in the annex block too)
      const { g, b } = p;
      const circle = LANDMARK_CIRCLES[name];
      if (circle) g.position.set(circle.x, 0, circle.z);
      const r = circle ? circle.r : Math.max(30, (b.L + b.W) / 4);
      const h = H(name, 'p90', 17.5);
      lathe(g, [[r * 0.6, 0], [r * 0.61, 2.5], [r * 0.95, h - 3.5], [r * 0.97, h], [r, h], [r, 0]], 0, 0, 0, M.brickDouble, 48);
      for (const y of [h * 0.17, h * 0.48, h * 0.77]) {
        for (let i = 0; i < 48; i++) {
          const a = (i / 48) * Math.PI * 2;
          box(g, 1.6, h * 0.17, 0.4, Math.cos(a) * (r + 0.05), y, Math.sin(a) * (r + 0.05), M.iron).rotation.y = -a + Math.PI / 2;
        }
      }
      cyl(g, r * 0.6, r * 0.6, 0.3, 0, 0, 0, M.sand, 40);
      collide(g);
      tops(name, g);
    }
  }
  // Edifici de Correus: the post office's stone palace on the Plaça de l'Ajuntament, its glazed cupola & crown
  {
    const name = 'Edifici de Correus i Telègrafs';
    const s = LANDMARK_SITES[name];
    if (s?.ring) {
      const walls = H(name, 'p90', 23);
      const top = H(name, 'top', 40);
      const body = extrude(s.ring, 0, walls, M.stone, [], name);
      collide(body);
      const b = obb(s.ring);
      const g = new THREE.Group();
      g.position.set(b.x, 0, b.z);
      const r = Math.min(8, b.W * 0.28);
      const drum = Math.max(3, (top - walls) * 0.45);
      cyl(g, r, r, drum, 0, walls, 0, M.stone, 16);
      const k = Math.max(0.6, (top - walls - drum - 3) / r);
      dome(g, r, 0, walls + drum, 0, M.glass, k, 16);
      add(g, new THREE.ConeGeometry(1.0, 3, 8), M.gold, 0, walls + drum + r * k + 1.5, 0);
      group.add(g);
      tops(name, body, g);
    }
  }
  // Mercat de Colón (Francesc Mora, 1916): an iron market hall open along its sides. The roof is the survey's
  // (LANDMARK_SHAPES: the nave's gable & its raised lantern at ~26 m, the side aisles' canopies at ~8-9 m reaching ~4.5 m
  // out past the outline over the pavements), coloured from the orthophoto. Along the long sides: a stone plinth, the
  // iron railing on it and the slender green iron columns under the canopy's edge, the sunken aisle & the nave's arcade
  // behind (Street View pin 42's side). At each end the gable front (reference/v05-colon-5): red brick round a great arch
  // ringed with blue ceramic discs, the gable's mosaic of fruit & flowers, white stone piers below, a pinnacle each side
  {
    const name = 'Mercat de Colón';
    const s = LANDMARK_SITES[name];
    const shape = LANDMARK_SHAPES[name];
    if (s?.ring && shape) {
      const sampler = surveySampler(shape);
      const X0 = 531.9, X1 = 597.0, ZN = 389.9, ZS = 428.25, OUT = 4.5; // the aisles' outline & the canopy's overhang
      const NZ0 = 395.6, NZ1 = 422.9, NZC = (NZ0 + NZ1) / 2; // the nave & end fronts
      // the roof's outline: the outline with the aisles' long edges moved out under the canopy's eaves
      const ring = ringPts(s.ring).map(([x, z]) => [x, Math.abs(z - ZN) < 0.5 ? ZN - OUT : Math.abs(z - ZS) < 0.5 ? ZS + OUT : z]).flat();
      const roofMat = vcolMat(0.8);
      roofMat.side = THREE.DoubleSide;
      const roof = surveyRoof(ring, shape, sampler, roofMat, 0.9);
      roof.name = name;
      const g = new THREE.Group();
      g.name = name;
      group.add(g);
      const ironGreen = mat(0x2f4a3c, 0.55, 0.5);
      const plinthStone = mat(0xd8cdb6, 0.85);
      // the railing: a canvas of vertical bars with gaps (alpha-tested)
      const railTex = canvasTex(64, 64, (x, W, Hc) => {
        x.clearRect(0, 0, W, Hc);
        x.fillStyle = '#2f4a3c';
        for (let k = 0; k < 4; k++) x.fillRect(k * 16 + 6, 0, 4, Hc);
        x.fillRect(0, 0, W, 5); x.fillRect(0, Hc - 6, W, 6);
      });
      const railMat = mat(0xffffff, 0.6, 0.4, { map: railTex, alphaTest: 0.5, side: THREE.DoubleSide, transparent: false });
      const nave = canvasTex(256, 256, (x, W, Hc) => {
        // 8 m of the nave's side: an arcade of dark stalls with lit fronts below, iron & glass clerestory above
        x.fillStyle = '#7b4a3a'; x.fillRect(0, 0, W, Hc);
        x.fillStyle = '#2a2826'; x.fillRect(12, Hc * 0.55, W - 24, Hc * 0.45);
        x.fillStyle = '#e9c88a'; x.fillRect(24, Hc * 0.72, W - 48, Hc * 0.12);
        x.fillStyle = '#9fb7bd'; x.fillRect(12, Hc * 0.08, W - 24, Hc * 0.38);
        x.fillStyle = '#2f4a3c'; for (let k = 0; k <= 6; k++) x.fillRect(12 + k * ((W - 24) / 6) - 2, Hc * 0.08, 4, Hc * 0.38);
      });
      const naveMat = mat(0xffffff, 0.75, 0, { map: nave });
      for (const [z, side] of [[ZN, -1], [ZS, 1]]) {
        const L = X1 - X0, xm = (X0 + X1) / 2;
        box(g, L, 1.2, 0.7, xm, 0, z, plinthStone);
        const rail = add(g, new THREE.PlaneGeometry(L, 2.2), railMat, xm, 1.2 + 1.1, z, false);
        rail.geometry.attributes.uv.array.forEach((v, i, a) => { if (i % 2 === 0) a[i] = v * L / 1.0; });
        // the columns, every 4.6 m, up to the canopy
        const n = Math.round(L / 4.6);
        for (let k = 0; k <= n; k++) {
          const x = X0 + (L * k) / n;
          const h = sampler.height(x, z) - 0.2;
          cyl(g, 0.16, 0.2, h, x, 0, z + side * 0.1, ironGreen, 8);
          box(g, 0.12, 0.12, OUT, x, h - 0.6, z + side * (OUT / 2), ironGreen);
        }
        // the nave's side behind the sunken aisle
        const zn = side < 0 ? NZ0 : NZ1;
        const wallH = sampler.height(xm, zn - side * 0.5);
        const wall = add(g, new THREE.PlaneGeometry(L, wallH), naveMat, xm, wallH / 2, zn, false);
        wall.rotation.y = side < 0 ? Math.PI : 0;
        wall.geometry.attributes.uv.array.forEach((v, i, a) => { if (i % 2 === 0) a[i] = v * L / 8; });
        // the aisle's floor, sunk below the street
        box(g, L, 0.2, Math.abs(zn - z) - 0.7, xm, -0.3, (z + zn) / 2, M.pit);
      }
      // the end fronts
      const PX = 18.75; // canvas px per metre
      const W = NZ1 - NZ0;
      const front = canvasTex(512, 512, (x, Wc, Hc) => {
        const X = (m) => Wc / 2 + m * PX, Y = (m) => Hc - m * PX;
        // brick, the gable's mosaic, the white stone base
        x.fillStyle = '#9b3f33'; x.fillRect(0, 0, Wc, Hc);
        x.fillStyle = 'rgba(0,0,0,0.12)'; for (let y = 0; y < Hc; y += 4) x.fillRect(0, y, Wc, 1);
        const grd = x.createLinearGradient(0, Y(22), 0, Y(12));
        grd.addColorStop(0, '#d7c27a'); grd.addColorStop(1, '#8fa35d');
        x.fillStyle = grd; x.beginPath(); x.moveTo(X(-8), Y(14)); x.lineTo(X(0), Y(21)); x.lineTo(X(8), Y(14)); x.fill();
        for (let i = 0; i < 40; i++) { x.fillStyle = ['#d9822b', '#c23b2e', '#e5c84a', '#4f7d3a'][i % 4]; x.beginPath(); x.arc(X(-6 + (i * 37 % 120) / 10), Y(14.4 + (i * 53 % 50) / 10), 4, 0, 7); x.fill(); }
        x.fillStyle = '#e6dcc6'; x.fillRect(0, Y(4.5), Wc, 4.5 * PX);
        // the great arch: its dark depth, the ring of blue discs, the gallery & the three ground arches inside
        const R = 7.6, cy = Y(11.5);
        x.fillStyle = '#c45a3c'; x.beginPath(); x.arc(X(0), cy, (R + 1.4) * PX, Math.PI, 0); x.lineTo(X(R + 1.4), Y(0)); x.lineTo(X(-R - 1.4), Y(0)); x.fill();
        x.fillStyle = '#2b2420'; x.beginPath(); x.arc(X(0), cy, R * PX, Math.PI, 0); x.lineTo(X(R), Y(0)); x.lineTo(X(-R), Y(0)); x.fill();
        for (let i = 0; i <= 22; i++) { const a = Math.PI + (i / 22) * Math.PI; x.fillStyle = '#5b7fc9'; x.beginPath(); x.arc(X(0) + Math.cos(a) * (R + 0.7) * PX, cy + Math.sin(a) * (R + 0.7) * PX, 6, 0, 7); x.fill(); }
        x.fillStyle = '#9b3f33'; x.fillRect(X(-R), Y(9.6), 2 * R * PX, 4.6 * PX);
        x.fillStyle = '#6d8f9a'; for (let k = 0; k < 8; k++) x.fillRect(X(-R + 0.5 + k * 1.85), Y(9.2), 1.2 * PX, 3.4 * PX);
        x.fillStyle = '#b8a37e'; x.fillRect(X(-R), Y(5.6), 2 * R * PX, 0.6 * PX);
        x.fillStyle = '#e6dcc6'; for (const m of [-R, -2.4, 2.4, R - 1.1]) x.fillRect(X(m), Y(5.0), 1.1 * PX, 5.0 * PX);
        x.fillStyle = '#1f1c1a'; for (const m of [-6.3, -1.3, 3.5]) { x.fillRect(X(m), Y(4.3), 3.4 * PX, 4.3 * PX); x.beginPath(); x.arc(X(m + 1.7), Y(4.3), 1.7 * PX, Math.PI, 0); x.fill(); }
        // the side wings' small arched windows
        x.fillStyle = '#1f1c1a'; for (const m of [-12.5, -11, 10, 11.5]) x.fillRect(X(m), Y(10.5), 0.7 * PX, 1.8 * PX);
      });
      const frontMat = mat(0xffffff, 0.8, 0, { map: front, side: THREE.DoubleSide });
      for (const [xf, dir] of [[525.9, -1], [597.5, 1]]) {
        const apex = sampler.height(xf - dir * 1.5, NZC) + 1.0;
        const eave = Math.max(10, sampler.height(xf - dir * 1.5, NZ0 + 1));
        const sh = new THREE.Shape([new THREE.Vector2(-W / 2, 0), new THREE.Vector2(W / 2, 0), new THREE.Vector2(W / 2, eave),
          new THREE.Vector2(W / 2 - 4.6, eave + 1.0), new THREE.Vector2(W / 2 - 4.6, eave + 2.6), new THREE.Vector2(0, apex),
          new THREE.Vector2(-W / 2 + 4.6, eave + 2.6), new THREE.Vector2(-W / 2 + 4.6, eave + 1.0), new THREE.Vector2(-W / 2, eave)]);
        const geo = new THREE.ExtrudeGeometry(sh, { depth: 1.2, bevelEnabled: false });
        // uv from the shape: 27.3 m across the canvas, 1 m = PX px
        const pos = geo.attributes.position, uv = geo.attributes.uv;
        for (let i = 0; i < pos.count; i++) uv.setXY(i, 0.5 + (pos.getX(i) * PX) / 512, (pos.getY(i) * PX) / 512);
        const m = add(g, geo, frontMat, xf, 0, NZC);
        m.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
        m.position.x -= dir * 0.6;
        // the pinnacles beside the arch & the crest at the apex
        for (const sz of [-1, 1]) {
          const z = NZC + sz * (W / 2 - 4.6);
          box(g, 1.7, apex - 1.5, 1.7, xf + dir * 0.4, 0, z, M.brick);
          cyl(g, 0.9, 0.9, 1.2, xf + dir * 0.4, apex - 1.5, z, M.tileTeal, 8);
          add(g, new THREE.ConeGeometry(0.8, 2.6, 8), M.stone, xf + dir * 0.4, apex + 1.0, z);
        }
        box(g, 0.8, 2.2, 2.4, xf, apex - 0.4, NZC, M.stone);
      }
      collide(g);
      tops(name, roof, g);
    }
  }
  // Mercat de Russafa (Julio Bellot, 1957): a long box under a thin, shallow gabled roof slab that overhangs it all
  // round; the upper storey's cream walls screened by rows of deep, angled concrete fins: a red-orange-yellow run
  // on the south end, blues along the side facing the Sant Valer church, greens along the other side, earth tones on the
  // north end under the MERCAT DE RUSSAFA letters; the ground floor a ring of stalls & shops under a cantilevered
  // ledge, red & white striped awnings, thin canopies over the doors (reference/v20-russafa-*: Commons photos)
  {
    const name = 'Mercat de Russafa';
    const p = place(name);
    if (p) {
      const { g, b } = p;
      const L = b.L, W = b.W; // the outline is the roof's
      // the survey: the eaves at its p50 (most of the outline is roof), its p90 the top of the skylight lantern
      // along the ridge; the slab itself only a shallow gable (as seen from the streets)
      const eave = H(name, 'p50', 11.7);
      const lanternTop = Math.max(eave + 3, H(name, 'p90', 16.3));
      const rise = Math.min(2.3, lanternTop - eave - 1);
      const ridge = eave + rise;
      const IN = 2.7; // walls set back under the eaves
      const SHOP = 4.3; // the ground floor
      const wl = L - 2 * IN, ww = W - 2 * IN;
      const cream = mat(0xdbcfb2, 0.86);
      const soffit = mat(0xf1ede2, 0.8);
      const backing = mat(0x2b2e30, 0.6, 0.2);
      // the walls: cream body from the ledge to the eaves, the stalls' band set back further below
      box(g, wl, eave - SHOP, ww, 0, SHOP, 0, cream);
      box(g, wl + 1.2, 0.35, ww + 1.2, 0, SHOP - 0.35, 0, cream); // the cantilevered ledge over the stalls
      // the stalls: shutters & lit shopfronts round the ground floor (a canvas strip, one 4 m bay per repeat)
      const shopTex = (() => {
        const c = document.createElement('canvas');
        c.width = 256; c.height = 128;
        const x = c.getContext('2d');
        x.fillStyle = '#d9cfb6'; x.fillRect(0, 0, 256, 128);
        // a roller shutter & a shopfront, cream piers between
        x.fillStyle = '#6f7275'; x.fillRect(8, 16, 112, 112);
        x.fillStyle = '#5c5f62';
        for (let y = 18; y < 128; y += 5) x.fillRect(8, y, 112, 2);
        x.fillStyle = '#31373b'; x.fillRect(136, 16, 112, 112);
        x.fillStyle = '#f0d9a4'; x.fillRect(142, 34, 100, 70);
        x.fillStyle = '#c98f4f'; for (let k = 0; k < 5; k++) x.fillRect(146 + k * 19, 70 + (k % 2) * 8, 14, 30);
        x.fillStyle = '#9fb06a'; for (let k = 0; k < 4; k++) x.fillRect(152 + k * 22, 86, 16, 18);
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = THREE.RepeatWrapping;
        t.anisotropy = 4;
        return t;
      })();
      const shopMat = mat(0xffffff, 0.7, 0, { map: shopTex });
      // awnings: red & white stripes
      const awnTex = (() => {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 8;
        const x = c.getContext('2d');
        for (let k = 0; k < 4; k++) { x.fillStyle = '#a81e22'; x.fillRect(k * 16, 0, 10, 8); x.fillStyle = '#efe9dc'; x.fillRect(k * 16 + 10, 0, 6, 8); }
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = THREE.RepeatWrapping;
        return t;
      })();
      const awnMat = mat(0xffffff, 0.85, 0, { map: awnTex, side: THREE.DoubleSide });
      // a vertical strip along a wall: length along local x before turning, height h, from y0, uv repeating every `rep` m
      const strip = (len, h, y0, m, rep, x, z, rot, out = 0) => {
        const geo = new THREE.PlaneGeometry(len, h);
        const uv = geo.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * len / rep);
        const mesh = add(g, geo, m, x, y0 + h / 2, z);
        mesh.rotation.y = rot;
        mesh.translateZ(out);
        return mesh;
      };
      box(g, wl - 2.2, SHOP - 0.35, ww - 2.2, 0, 0, 0, cream);
      // the four faces: [half length along, offset across, its yaw, its fins' palette]
      const church = lonLatToWorld(-0.37220, 39.46270);
      const cdx = church.x - b.x, cdz = church.z - b.z;
      const cl = { x: cdx * b.ux + cdz * b.uz, z: -cdx * b.uz + cdz * b.ux }; // the church in the model's frame
      const PAL = {
        blue: [0x1f3f8c, 0x2c5aa8, 0x3f75c2, 0x6b9bd6, 0x9fc0e6, 0x2a4f9c],
        warm: [0xc8381e, 0xdc5a1d, 0xea7f1e, 0xf2a224, 0xf3c234],
        green: [0x0f5236, 0x186a45, 0x237d53, 0x2f8f60, 0x14603f],
        earth: [0x7c4527, 0x9a6038, 0xb88452, 0xcfa778, 0xe2cba6]
      };
      const palMats = Object.fromEntries(Object.entries(PAL).map(([k, cs]) => [k, cs.map((c) => mat(c, 0.75))]));
      const sideBlue = Math.sign(cl.z) || 1; // the long side towards the church is the blue one
      const endEarth = Math.sign(cl.x) || 1; // ...and the end towards it the earth-toned one
      const faces = [
        // wide overlapping panels on three sides, narrower blades in bays of five on the green one
        // `away`: the fins lean away from that end of the face (along it), so from the corners they're photographed
        // from (blue & warm, warm & green) the blue, warm & earth ones show their broad faces
        { half: wl / 2, across: ww / 2, side: sideBlue, alongX: true, pal: 'blue', bays: false, away: -endEarth },
        { half: wl / 2, across: ww / 2, side: -sideBlue, alongX: true, pal: 'green', bays: true, away: endEarth },
        { half: ww / 2, across: wl / 2, side: endEarth, alongX: false, pal: 'earth', bays: false, away: sideBlue },
        { half: ww / 2, across: wl / 2, side: -endEarth, alongX: false, pal: 'warm', bays: false, away: sideBlue }
      ];
      const F0 = SHOP + 1.0, F1 = eave - 2.0; // the fins' zone, between the cream bands (the letters on the top one)
      for (const f of faces) {
        // the face's frame: t along it, n out of it
        const nx = f.alongX ? 0 : f.side, nz = f.alongX ? f.side : 0;
        const tx = f.alongX ? 1 : 0, tz = f.alongX ? 0 : 1;
        const rot = Math.atan2(nx, nz); // a plane's +z turned to face out
        const at = (t, o) => [tx * t + nx * (f.across + o), tz * t + nz * (f.across + o)];
        // the dark glazing & louvres behind the fins
        {
          const [x, z] = at(0, 0.02);
          const m = add(g, new THREE.PlaneGeometry(2 * f.half - 4, F1 - F0), backing, x, (F0 + F1) / 2, z);
          m.rotation.y = rot;
        }
        // the stalls' band & the awnings, broken by a door in the middle
        {
          const len = 2 * f.half - 2.2, [x, z] = at(0, -1.08);
          strip(len, SHOP - 0.35, 0, shopMat, 4, x, z, rot);
          for (const s of [-1, 1]) {
            const seg = f.half - 1.1 - 4;
            const [ax, az] = at(s * (4 + seg / 2), -0.6);
            const aw = strip(seg, 1.1, SHOP - 1.75, awnMat, 1.2, ax, az, rot);
            aw.rotateX(-0.75);
          }
          // the door: a dark opening and a thin canopy slab out over the pavement
          const [dx, dz] = at(0, -1.04);
          const door = add(g, new THREE.PlaneGeometry(6, 3.3), backing, dx, 1.65, dz);
          door.rotation.y = rot;
          const [cx, cz] = at(0, 1.2);
          const canopy = box(g, f.alongX ? 8 : 3.4, 0.28, f.alongX ? 3.4 : 8, cx, SHOP - 0.6, cz, cream);
          canopy.castShadow = true;
        }
        // the fins: deep concrete blades turned 40° off the wall, 0.95 m apart; cream piers at the corners and, on
        // the green & earth faces, between bays of five
        const usable = 2 * f.half - 4.4; // corner piers 2.2 m each
        const pitch = f.bays ? 0.95 : 1.05;
        const depth = f.bays ? 1.0 : 1.55, turn = f.bays ? 0.7 : 0.62;
        const nFins = Math.floor(usable / pitch);
        const cols = palMats[f.pal];
        let k = 0;
        for (let i = 0; i < nFins; i++) {
          const t = -usable / 2 + (i + 0.5) * pitch;
          const inBay = i % 6;
          if (f.bays && inBay === 5) {
            const [px, pz] = at(t, 0.55);
            box(g, f.alongX ? 0.9 : 1.1, F1 - F0, f.alongX ? 1.1 : 0.9, px, F0, pz, cream);
            continue;
          }
          const m = cols[f.bays ? (Math.floor(i / 6) + inBay) % cols.length : k++ % cols.length];
          // the blade's depth along d: out of the wall, leaning away from the `away` end
          const dx = nx * Math.cos(turn) - f.away * tx * Math.sin(turn), dz = nz * Math.cos(turn) - f.away * tz * Math.sin(turn);
          const [px, pz] = at(t, depth * 0.5 * Math.cos(turn) + 0.06);
          const fin = box(g, 0.2, F1 - F0, depth, px - f.away * tx * depth * 0.5 * Math.sin(turn), F0, pz - f.away * tz * depth * 0.5 * Math.sin(turn), m);
          fin.rotation.y = Math.atan2(dx, dz);
        }
        for (const s of [-1, 1]) {
          const [px, pz] = at(s * (f.half - 1.1), 0.5);
          box(g, f.alongX ? 2.2 : 1.0, F1 - F0 + 0.2, f.alongX ? 1.0 : 2.2, px, F0 - 0.1, pz, cream);
        }
      }
      // MERCAT DE RUSSAFA in raised dark letters on the cream band between the fins and the eaves, on every side as
      // in the photos: centred on the north end, towards the north on both long sides, towards the blue side on the
      // south end. Our own lettering in the sign's manner (thin geometric capitals, widely spaced), each letter a
      // set of strokes on a 1 x 1 cell (x right, y up), arcs as short straight runs
      {
        const arc = (cx, cy, rx, ry, a0, a1, n = 10) => Array.from({ length: n + 1 }, (_, i) => {
          const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180;
          return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
        });
        const GLYPHS = {
          M: { w: 0.86, strokes: [[[0, 0], [0, 1], [0.43, 0.28], [0.86, 1], [0.86, 0]]] },
          E: { w: 0.56, strokes: [[[0.56, 1], [0, 1], [0, 0], [0.56, 0]], [[0, 0.5], [0.48, 0.5]]] },
          R: { w: 0.6, strokes: [[[0, 0], [0, 1], [0.3, 1], ...arc(0.3, 0.75, 0.25, 0.25, 90, -90, 8), [0, 0.5]], [[0.26, 0.5], [0.6, 0]]] },
          C: { w: 0.8, strokes: [arc(0.5, 0.5, 0.5, 0.5, 45, 315, 16)] },
          A: { w: 0.8, strokes: [[[0, 0], [0.4, 1], [0.8, 0]], [[0.15, 0.36], [0.65, 0.36]]] },
          T: { w: 0.66, strokes: [[[0, 1], [0.66, 1]], [[0.33, 1], [0.33, 0]]] },
          D: { w: 0.74, strokes: [[[0, 0], [0, 1], [0.24, 1], ...arc(0.24, 0.5, 0.5, 0.5, 90, -90, 14), [0, 0]]] },
          U: { w: 0.66, strokes: [[[0, 1], [0, 0.34], ...arc(0.33, 0.34, 0.33, 0.34, 180, 360, 12), [0.66, 1]]] },
          S: { w: 0.56, strokes: [[...arc(0.28, 0.75, 0.27, 0.25, 20, 270, 10), ...arc(0.28, 0.25, 0.28, 0.25, 90, -160, 10)]] },
          F: { w: 0.54, strokes: [[[0.54, 1], [0, 1], [0, 0]], [[0, 0.52], [0.46, 0.52]]] }
        };
        const ink = mat(0x2a2723, 0.7, 0.1);
        const LH = 0.95, STROKE = 0.085, RAISE = 0.05, TRACK = 0.42, SPACE = 0.9;
        const word = (text) => {
          const sg = new THREE.Group();
          let x = 0;
          for (const ch of text) {
            if (ch === ' ') { x += SPACE * LH; continue; }
            const gl = GLYPHS[ch];
            for (const line of gl.strokes) {
              for (let i = 0; i + 1 < line.length; i++) {
                const [ax, ay] = line[i], [bx, by] = line[i + 1];
                const len = Math.hypot(bx - ax, by - ay) * LH;
                if (len < 1e-3) continue;
                const seg = add(sg, new THREE.BoxGeometry(len + STROKE * 0.9, STROKE, RAISE), ink,
                  x + (ax + bx) / 2 * LH, (ay + by) / 2 * LH, RAISE / 2, false);
                seg.rotation.z = Math.atan2(by - ay, bx - ax);
              }
            }
            x += (gl.w + TRACK) * LH;
          }
          x -= TRACK * LH;
          for (const c of sg.children) c.position.x -= x / 2; // centred on the group's origin
          return sg;
        };
        const y = eave - 0.3 - LH; // the band's upper part, clear of the fins seen from the street
        // [face, position along it]
        for (const [f, t] of [[faces[2], 0], [faces[0], endEarth * (faces[0].half - 15)], [faces[1], endEarth * (faces[1].half - 15)],
          [faces[3], sideBlue * (faces[3].half - 12)]]) {
          const nx = f.alongX ? 0 : f.side, nz = f.alongX ? f.side : 0;
          const tx = f.alongX ? 1 : 0, tz = f.alongX ? 0 : 1;
          const sign = word('MERCAT DE RUSSAFA');
          sign.position.set(tx * t + nx * f.across, y, tz * t + nz * f.across);
          sign.rotation.y = Math.atan2(nx, nz);
          g.add(sign);
        }
      }
      // the roof: a gable prism over the walls, then the thin overhanging slab, its ridge along the length
      {
        const shape = new THREE.Shape([new THREE.Vector2(-ww / 2, 0), new THREE.Vector2(ww / 2, 0), new THREE.Vector2(0, rise * (ww / W))]);
        const prism = new THREE.ExtrudeGeometry(shape, { depth: wl, bevelEnabled: false });
        prism.translate(0, 0, -wl / 2);
        prism.rotateY(Math.PI / 2);
        add(g, prism, cream, 0, eave, 0);
        // the skylight lantern along the ridge: glazed sides, a flat white top (out of sight from the streets)
        const lw = Math.min(14, W * 0.26);
        box(g, L * 0.78, lanternTop - ridge + 0.25, lw, 0, ridge - 0.6, 0, backing);
        box(g, L * 0.8, 0.35, lw + 1.2, 0, lanternTop - 0.35, 0, soffit);
        const slope = Math.atan2(rise, W / 2);
        const half = W / 2 / Math.cos(slope);
        for (const s of [-1, 1]) {
          const slab = add(g, new THREE.BoxGeometry(L, 0.38, half), soffit, 0, eave + rise / 2, s * W / 4);
          slab.rotation.x = s * slope;
        }
      }
      collide(g, 2.4); // the stalls' walls (walk under the awnings & canopies)
      tops(name, g);
    }
  }
  // The church of Sant Valer i Sant Vicent Màrtir (Russafa, 17th–18th c.): its bell tower closes the view down the
  // Russafa streets. Not in LANDMARK_SITES (its OpenStreetMap outline, relation 9498243, comes with LANDMARK_SHAPES). The
  // nave, transept & chapels: the survey's roof on the outline, rendered ochre walls with tall arched windows; the
  // tower sized from the survey's profile round its peak (a square brick shaft to the cornice at ~33 m, the octagonal
  // belfry with its arched openings & corner pinnacles to ~38.5 m, the smaller octagonal lantern, the little tiled cupola
  // & the vane at ~45 m); the crossing dome & the communion chapel's dome in Valencian blue glazed tiles with their
  // lanterns (reference/v20-russafa-r1)
  {
    const name = 'Sant Valer';
    const shape = LANDMARK_SHAPES[name];
    if (shape?.ring) {
      const F = shape.features;
      const flat = shape.ring;
      const b = obb(flat);
      const T = F.tower, D1 = F.dome, D2 = F.chapelDome;
      const cuts = [{ x: T.x, z: T.z, r: 5.2, h: 14 }, { x: D1.x, z: D1.z, r: 6.6, h: D1.base }, { x: D2.x, z: D2.z, r: 5.4, h: D2.base }];
      const sampler = surveySampler(shape, cuts);
      const PXM = 40, BAY = 5.5, TEXH = 20;
      const facade = canvasTex(256, TEXH * PXM, (x, W, Hc) => {
        const Y = (m) => Hc - m * PXM;
        x.fillStyle = '#d4ad7e'; x.fillRect(0, 0, W, Hc);
        x.fillStyle = '#e0bf93'; x.fillRect(0, 0, 30, Hc); x.fillRect(W - 30, 0, 30, Hc); // pilasters
        x.fillStyle = '#b48c62'; x.fillRect(0, Y(16.6), W, 10); x.fillRect(0, Y(9.0), W, 6); // cornices
        x.fillStyle = '#9a8670'; x.fillRect(0, Y(1.0), W, 1.0 * PXM); // stone socle
        // a tall arched window in the clerestory, a smaller one below
        const win = (y0, y1, w) => {
          x.fillStyle = '#c69d70'; x.fillRect(W / 2 - w / 2 - 6, Y(y1) + w / 2 - 6, w + 12, Y(y0) - Y(y1) - w / 2 + 6);
          x.beginPath(); x.arc(W / 2, Y(y1) + w / 2, w / 2 + 6, Math.PI, 0); x.fill();
          x.fillStyle = '#3a3633'; x.fillRect(W / 2 - w / 2, Y(y1) + w / 2, w, Y(y0) - Y(y1) - w / 2);
          x.beginPath(); x.arc(W / 2, Y(y1) + w / 2, w / 2, Math.PI, 0); x.fill();
        };
        win(11.0, 15.6, 52);
        win(4.5, 7.8, 38);
      });
      const walls = surveyWalls(flat, sampler, mat(0xffffff, 0.88, 0, { map: facade }), BAY, TEXH);
      walls.name = name;
      const roof = surveyRoof(flat, shape, sampler, vcolMat(0.85), 0.85);
      collide(walls);
      const g = new THREE.Group();
      g.name = name;
      group.add(g);
      const brick = mat(0xc99a6c, 0.9), brickDark = mat(0xae8059, 0.9), blueTile = mat(0x24519c, 0.3, 0.1);
      // the tower, turned square to the church
      const t = new THREE.Group();
      t.position.set(T.x, 0, T.z);
      t.rotation.y = Math.atan2(-b.uz, b.ux);
      g.add(t);
      const SH = 7.2, CORN = 32.8;
      box(t, SH, CORN, SH, 0, 0, 0, brick);
      // corner pilasters, string courses, the shaft's windows
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(t, 1.0, CORN, 1.0, sx * (SH / 2 - 0.35), 0, sz * (SH / 2 - 0.35), brickDark);
      for (const y of [10.5, 20.5, CORN - 1.2]) box(t, SH + 0.5, y === CORN - 1.2 ? 1.2 : 0.5, SH + 0.5, 0, y, 0, brickDark);
      for (let f = 0; f < 4; f++) {
        const a = (f * Math.PI) / 2, nx = Math.cos(a), nz = Math.sin(a);
        for (const [y, h, w] of [[14.0, 3.0, 1.0], [24.0, 4.2, 1.4]]) {
          box(t, w, h, 0.2, nx * (SH / 2 + 0.02), y, nz * (SH / 2 + 0.02), M.pit).rotation.y = -a + Math.PI / 2;
        }
      }
      // the belfry: octagonal, arched openings on every face, corner pinnacles & a balustrade on the cornice
      const BR = 3.35, BT = 38.4;
      cyl(t, BR, BR, BT - CORN, 0, CORN, 0, brick, 8).rotation.y = Math.PI / 8;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        box(t, 1.25, 3.4, 0.25, Math.cos(a) * (BR * 0.93), CORN + 1.0, Math.sin(a) * (BR * 0.93), M.pit).rotation.y = -a + Math.PI / 2;
        cyl(t, 0.25, 0.12, 1.6, Math.cos(a + Math.PI / 8) * (BR + 0.3), BT, Math.sin(a + Math.PI / 8) * (BR + 0.3), brickDark, 6);
      }
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(t, 0.35, 0.1, 2.4, sx * (SH / 2 - 0.4), CORN, sz * (SH / 2 - 0.4), brickDark, 6);
      cyl(t, BR + 0.35, BR + 0.35, 0.6, 0, BT - 0.6, 0, brickDark, 8).rotation.y = Math.PI / 8;
      // the lantern & the cupola
      const LR = 2.2, LT = 41.6;
      cyl(t, LR, LR, LT - BT, 0, BT, 0, brick, 8).rotation.y = Math.PI / 8;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        box(t, 0.8, 1.9, 0.2, Math.cos(a) * (LR * 0.93), BT + 0.6, Math.sin(a) * (LR * 0.93), M.pit).rotation.y = -a + Math.PI / 2;
      }
      cyl(t, LR + 0.25, LR + 0.25, 0.4, 0, LT - 0.4, 0, brickDark, 8).rotation.y = Math.PI / 8;
      dome(t, LR, 0, LT, 0, blueTile, 0.9, 12);
      cyl(t, 0.35, 0.25, 0.9, 0, LT + LR * 0.9 - 0.1, 0, brickDark, 6);
      cyl(t, 0.06, 0.06, 2.0, 0, LT + LR * 0.9 + 0.8, 0, M.iron, 4);
      box(t, 0.9, 0.35, 0.05, 0.3, LT + LR * 0.9 + 2.2, 0, M.iron);
      // the two blue domes: a drum with windows, the tiled dome, a lantern
      for (const [D, R, spring, k] of [[D1, 6.2, 21.0, 0.85], [D2, 4.6, 21.6, 1.0]]) {
        cyl(g, R + 0.2, R + 0.2, spring - D.base, D.x, D.base, D.z, brick, 16);
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          box(g, 0.9, (spring - D.base) * 0.55, 0.2, D.x + Math.cos(a) * (R + 0.25), D.base + (spring - D.base) * 0.2, D.z + Math.sin(a) * (R + 0.25), M.pit).rotation.y = -a + Math.PI / 2;
        }
        dome(g, R, D.x, spring, D.z, blueTile, k, 24);
        const crown = spring + R * k;
        cyl(g, 0.9, 0.9, Math.max(1.2, D.top - crown - 0.6), D.x, crown - 0.2, D.z, brick, 8);
        add(g, new THREE.SphereGeometry(0.5, 8, 6), M.gold, D.x, Math.max(crown + 1.0, D.top - 0.3), D.z);
      }
      collide(g);
      tops(name, walls, roof, g);
    }
  }

  // =========================================================================
  // EL PLA DEL REAL: Mestalla, its stands raked up from the pitch to the outer wall (the survey's p90), a bowl built
  // between scaled copies of the stadium's own outline
  // =========================================================================
  {
    const name = 'Mestalla';
    const s = LANDMARK_SITES[name];
    if (s?.ring) {
      const b = obb(s.ring);
      const pts = ringPts(s.ring);
      const top = H(name, 'p90', 37.5);
      // [outline scale, height]: pitch edge, lower tier, upper tiers, the rim
      const rings = [[0.64, 1.5], [0.76, 12], [0.88, 25], [0.97, top], [1.0, top]];
      const pos = [];
      const quad = (a, b2, c, d) => pos.push(...a, ...b2, ...c, ...a, ...c, ...d);
      const at = (k, y, i) => {
        const [x, z] = pts[i % pts.length];
        return [b.x + (x - b.x) * k, y, b.z + (z - b.z) * k];
      };
      for (let r = 0; r + 1 < rings.length; r++) {
        const [k0, y0] = rings[r], [k1, y1] = rings[r + 1];
        for (let i = 0; i < pts.length; i++) quad(at(k0, y0, i), at(k0, y0, i + 1), at(k1, y1, i + 1), at(k1, y1, i));
      }
      // the outer wall down to the street
      for (let i = 0; i < pts.length; i++) quad(at(1, top, i), at(1, top, i + 1), at(1, 0, i + 1), at(1, 0, i));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      const bowl = add(group, geo, M.concreteDouble, 0, 0, 0);
      bowl.name = name;
      collide(bowl);
      const g = new THREE.Group();
      g.position.set(b.x, 0, b.z);
      g.rotation.y = Math.atan2(-b.uz, b.ux);
      box(g, b.L * 0.6, 0.3, b.W * 0.58, 0, 0, 0, M.pitch);
      group.add(g);
      tops(name, bowl);
    }
  }

  // =========================================================================
  // CIUTAT DE LES ARTS I LES CIÈNCIES (Calatrava)
  // =========================================================================
  // L'Hemisfèric (1998): the eye. Its shell fitted to the survey (landmark-lidar.py: the points > 1 m round it, their
  // principal axis, then the least median error over a grid of the shape's parameters): a lens 98 m long whose half-width
  // runs 27·(1 − s²) (s along the axis from tip to tip), its height 25·(1 − s²)·√(1 − t²) across it (t = v / half-width),
  // the opened eyelid a 5 m bump over the middle (to the survey's 29.8 m). The top in grey aluminium, the flanks glazed between
  // close white struts, the eyelid's white edge running along mid-height, a white concrete arm at each tip
  // (reference/v08-cac-2)
  {
    const name = "L'Hemisfèric";
    const s = LANDMARK_SITES[name];
    if (s) {
      const CX = 1004.8, CZ = 2202.1, UX = 0.354, UZ = 0.935; // the survey's centre & long axis
      const A = 49, W0 = 27, HS = 25, T0 = 0.45;
      const g = new THREE.Group();
      g.position.set(CX, 0, CZ);
      g.rotation.y = Math.atan2(-UZ, UX);
      g.name = name;
      group.add(g);
      const width = (sv) => W0 * Math.max(0, 1 - sv * sv);
      const height = (sv, tv) => {
        const u = sv * A, v = tv * width(sv);
        const shell = HS * (1 - sv * sv) * Math.sqrt(Math.max(0, 1 - tv * tv));
        const lid = Math.max(0, 1 - (u / 13) ** 2) * Math.max(0, 1 - (v / 13) ** 2);
        return shell + 5 * lid;
      };
      // a patch of the shell over |t| in [ta, tb] on both flanks, uv: struts every 2.4 m along, v across the band
      const patch = (ta, tb, m, nt) => {
        const NS = 72, pos = [], uv = [], idx = [];
        for (const side of [-1, 1]) {
          const base = pos.length / 3;
          for (let i = 0; i <= NS; i++) {
            const sv = -1 + (2 * i) / NS;
            for (let j = 0; j <= nt; j++) {
              const tv = side * (ta + ((tb - ta) * j) / nt);
              pos.push(sv * A, height(sv, tv), tv * width(sv));
              uv.push((sv * A) / 2.4, j / nt);
            }
          }
          for (let i = 0; i < NS; i++) {
            for (let j = 0; j < nt; j++) {
              const a = base + i * (nt + 1) + j, b2 = a + nt + 1;
              if (side > 0) idx.push(a, a + 1, b2, a + 1, b2 + 1, b2); else idx.push(a, b2, a + 1, a + 1, b2, b2 + 1);
            }
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        return add(g, geo, m, 0, 0, 0);
      };
      const zinc = mat(0x8d9093, 0.42, 0.55);
      // the top: one patch across the middle (t from -T0 to T0)
      {
        const NS = 72, NT = 18, pos = [], idx = [];
        for (let i = 0; i <= NS; i++) {
          const sv = -1 + (2 * i) / NS;
          for (let j = 0; j <= NT; j++) {
            const tv = -T0 + (2 * T0 * j) / NT;
            pos.push(sv * A, height(sv, tv), tv * width(sv));
          }
        }
        for (let i = 0; i < NS; i++) for (let j = 0; j < NT; j++) {
          const a = i * (NT + 1) + j, b2 = a + NT + 1;
          idx.push(a, a + 1, b2, a + 1, b2 + 1, b2);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        add(g, geo, zinc, 0, 0, 0);
      }
      // the flanks' glazing: v 0 at the grey top's edge, 1 at the ground; the eyelid's white edge at v ~0.45
      const glassTex = canvasTex(64, 256, (x, W, Hc) => {
        const grd = x.createLinearGradient(0, 0, 0, Hc);
        grd.addColorStop(0, '#9fb9bb'); grd.addColorStop(0.45, '#b7cfcf'); grd.addColorStop(1, '#c5d8d4');
        x.fillStyle = grd; x.fillRect(0, 0, W, Hc);
        x.strokeStyle = '#eef0ec'; x.lineWidth = 4;
        // the eyelid's louvre frames above the edge: diagonals
        x.beginPath(); x.moveTo(0, 0); x.lineTo(W, Hc * 0.42); x.stroke();
        x.fillStyle = '#f3f4f0';
        x.fillRect(W / 2 - 3, 0, 6, Hc); // the strut
        x.fillRect(0, Hc * 0.42, W, 12); // the eyelid's edge
        for (let y = Hc * 0.5; y < Hc; y += 22) x.fillRect(W / 2 - 12, y, 24, 4); // the struts' arms
        x.fillRect(0, Hc - 8, W, 8);
      }, false);
      const flank = mat(0xffffff, 0.15, 0.35, { map: glassTex });
      patch(T0, 1, flank, 24);
      // the white concrete arms at the tips & the white plinth round the rim
      for (const sx of [-1, 1]) {
        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(sx * (A + 6), 0.2, 0), new THREE.Vector3(sx * (A - 2), 4.5, 0),
          new THREE.Vector3(sx * (A - 12), height(sx * 0.76, 0) - 0.2, 0)
        ]);
        add(g, new THREE.TubeGeometry(curve, 16, 1.1, 6, false), M.calatrava, 0, 0, 0).scale.z = 2.2;
      }
      {
        const pts = [];
        for (let i = 0; i <= 64; i++) { const sv = -1 + (2 * i) / 64; pts.push(new THREE.Vector3(sv * A, 0.35, width(sv) + 0.2)); }
        for (let i = 63; i > 0; i--) { const sv = -1 + (2 * i) / 64; pts.push(new THREE.Vector3(sv * A, 0.35, -width(sv) - 0.2)); }
        add(g, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true), 160, 0.5, 4, true), M.calatrava, 0, 0, 0);
      }
      collide(g);
      tops(name, g);
    }
  }
  // Palau de les Arts Reina Sofia: the opera house, two white trencadís shells clasping a glazed body, and the great
  // crest: a blade rising from the back, arching over the top & cantilevered far out past the front (reference/v08b)
  {
    const name = 'Palau de les Arts Reina Sofia';
    const p = place(name);
    if (p) {
      const { g, b } = p;
      const L = Math.max(120, Math.min(170, b.L)), W = Math.max(60, Math.min(90, b.W));
      const top = H(name, 'top', 67);
      const shellTop = H(name, 'p50', 44) + 8;
      const body = dome(g, 1, 0, 0, 0, M.glass, 1, 32);
      body.scale.set(L * 0.4, shellTop * 0.92, W * 0.36);
      for (const sz of [-1, 1]) {
        const sh = dome(g, 1, -L * 0.03, 0, sz * W * 0.09, M.calatravaDouble, 1, 32);
        sh.scale.set(L * 0.46, shellTop, W * 0.3);
      }
      // the crest: a flattened tube along a curve from the back up over the top to the cantilevered front tip
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-L * 0.5, shellTop * 0.55, 0),
        new THREE.Vector3(-L * 0.32, top * 0.92, 0),
        new THREE.Vector3(-L * 0.05, top - 2.0, 0),
        new THREE.Vector3(L * 0.28, top * 0.86, 0),
        new THREE.Vector3(L * 0.58, top * 0.64, 0)
      ]);
      const crest = add(g, new THREE.TubeGeometry(curve, 48, 2.0, 6, false), M.calatrava, 0, 0, 0);
      crest.scale.z = 3.2;
      collide(g);
      tops(name, g);
    }
  }
  // Museu de les Ciències Príncep Felip (2000): the whale skeleton. Its cross-section is the survey's (landmark-lidar.py:
  // the median section across the long axis, 216 m of it; bays every 10 m, the spectrum's peak along it): the north face
  // a glazed slope rising ~70° from the esplanade to the ridge at ~57 m, its white concrete trees one per bay reaching
  // ~59 m; the roof falling south to the comb-topped south face at ~34.5 m; under it the terraces at ~17 m, a slab per
  // bay with the gaps between, on white struts (reference/v08-cac-0, v08-cac-8)
  {
    const name = 'Museu de les Ciències «Príncep Felip»';
    if (LANDMARK_SITES[name]) {
      const CX = 1128.5, CZ = 2379.4, UX = 0.3543, UZ = 0.9352; // the survey's centre of the body over 30 m & long axis
      const HALF = 106, BAYS = 21, BAY = 10;
      const g = new THREE.Group();
      g.position.set(CX, 0, CZ);
      g.rotation.y = Math.atan2(-UZ, UX);
      g.name = name;
      group.add(g);
      // the section: [v (+ towards the Umbracle, south-west), height], from the north foot round to the south foot;
      // each run's kind: n north glazing, r roof, s south face
      const SEC = [[-43, 0, 'n'], [-42, 9, 'n'], [-40, 17.3, 'n'], [-36, 30.1, 'n'], [-32, 41.5, 'n'], [-30, 45.4, 'n'],
        [-28, 47.5, 'r'], [-24, 48.0, 'r'], [-20, 50.5, 'r'], [-18, 55.2, 'r'], [-16, 56.9, 'r'], [-12, 56.2, 'r'], [-4, 54.0, 'r'],
        [0, 52.7, 'r'], [2, 48.3, 'r'], [12, 43.5, 'r'], [20, 39.1, 'r'], [28, 33.5, 'r'], [34, 34.2, 'r'], [37.5, 34.6, 's'],
        [38, 17.3, 's'], [38, 0, 's']];
      const roofTex = canvasTex(128, 64, (x, W, Hc) => {
        x.fillStyle = '#c9d4d6'; x.fillRect(0, 0, W, Hc);
        x.fillStyle = '#f2f2ee'; x.fillRect(0, 0, 14, Hc); x.fillRect(W - 14, 0, 14, Hc);
        x.fillStyle = '#dfe5e4'; for (let k = 1; k < 5; k++) x.fillRect((k * W) / 5 - 2, 0, 4, Hc);
      }, true);
      const glassTex = canvasTex(128, 128, (x, W, Hc) => {
        x.fillStyle = '#7f9ea6'; x.fillRect(0, 0, W, Hc);
        x.fillStyle = '#dfe6e6';
        for (let k = 0; k < 8; k++) x.fillRect((k * W) / 8, 0, 2, Hc);
        for (let k = 0; k < 8; k++) x.fillRect(0, (k * Hc) / 8, W, 2);
      }, true);
      const roofMat = mat(0xffffff, 0.45, 0.1, { map: roofTex, side: THREE.DoubleSide });
      const glassMat = mat(0xffffff, 0.12, 0.45, { map: glassTex, side: THREE.DoubleSide });
      // the skin: a strip along the length per section run
      const pos = { r: [], n: [], s: [] }, uvs = { r: [], n: [], s: [] };
      let along = 0;
      for (let i = 0; i + 1 < SEC.length; i++) {
        const [v0, y0, kind] = SEC[i], [v1, y1] = SEC[i + 1];
        const d = Math.hypot(v1 - v0, y1 - y0);
        const P = pos[kind], U = uvs[kind];
        const q = (a, b2, c, e) => P.push(...a, ...b2, ...c, ...a, ...c, ...e);
        q([-HALF, y0, v0], [HALF, y0, v0], [HALF, y1, v1], [-HALF, y1, v1]);
        const ua = -HALF / BAY, ub = HALF / BAY, va = along / 6, vb = (along + d) / 6;
        U.push(ua, va, ub, va, ub, vb, ua, va, ub, vb, ua, vb);
        along += d;
      }
      for (const [kind, m] of [['r', roofMat], ['n', glassMat], ['s', glassMat]]) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos[kind], 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs[kind], 2));
        geo.computeVertexNormals();
        add(g, geo, m, 0, 0, 0);
      }
      // the ends, closed by the section
      const shp = new THREE.Shape(SEC.map(([v, y]) => new THREE.Vector2(v, y)));
      for (const sx of [-1, 1]) {
        const cap = add(g, new THREE.ShapeGeometry(shp), M.calatravaDouble, sx * HALF, 0, 0);
        cap.rotation.y = Math.PI / 2;
        cap.scale.x = -1;
      }
      // per bay: the north face's tree, the roof's rib, the south face's comb, the terrace slab & its strut
      const beam = (v0, y0, v1, y1, w, t, x) => {
        const L = Math.hypot(v1 - v0, y1 - y0);
        const m = box(g, w, L, t, x, 0, 0, M.calatrava);
        m.position.set(x, (y0 + y1) / 2, (v0 + v1) / 2);
        m.rotation.x = Math.atan2(v1 - v0, y1 - y0);
        return m;
      };
      const comb = new THREE.Shape([new THREE.Vector2(38, 17.3), new THREE.Vector2(38, 35.2), new THREE.Vector2(41, 35.2), new THREE.Vector2(53, 17.3)]);
      const combGeo = new THREE.ExtrudeGeometry(comb, { depth: 1.4, bevelEnabled: false });
      combGeo.rotateY(-Math.PI / 2);
      for (let k = 0; k < BAYS; k++) {
        const x = -HALF + BAY / 2 + k * BAY;
        // the tree: a trunk leaning with the glazing, out in front of it, then its crown branching over the ridge
        beam(-46.5, 0, -33, 44, 1.8, 2.4, x);
        beam(-33, 44, -19, 59.0, 1.4, 2.0, x);
        beam(-33, 44, -26, 52, 1.0, 1.6, x + 1.6);
        // the roof's rib along the section
        for (let i = 6; i + 1 < SEC.length - 2; i++) beam(SEC[i][0], SEC[i][1] + 0.35, SEC[i + 1][0], SEC[i + 1][1] + 0.35, 1.0, 0.7, x);
        // the south comb & the terrace slab out to 56 m
        add(g, combGeo, M.calatrava, x + 0.7, 0, 0);
        box(g, BAY - 4, 0.8, 5, x, 16.5, 40.5, M.concrete); // between the combs: the light wells beside the face
        beam(38.5, 0, 50, 16.5, 1.2, 1.2, x);
      }
      box(g, 2 * HALF, 0.8, 13, 0, 16.5, 49.5, M.concrete); // the terrace walk along the outer edge
      collide(g);
      tops(name, g);
    }
  }
  // L'Umbracle: the garden walk under a long row of white arches, its height the survey's top
  {
    const name = "L'Umbracle";
    const p = place(name);
    if (p) {
      const { g, b } = p;
      const L = Math.max(200, Math.min(330, b.L)), W = Math.max(30, Math.min(60, b.W));
      const h = H(name, 'top', 18.5) - 0.8;
      const r = W * 0.45;
      const arch = new THREE.TorusGeometry(r, 0.55, 6, 20, Math.PI);
      for (let x = -L / 2 + 4; x <= L / 2 - 4; x += 8) {
        const a = add(g, arch, M.calatrava, x, 0, 0);
        a.rotation.y = Math.PI / 2;
        a.scale.set(1, h / r, 1);
      }
      box(g, L - 6, 0.8, 1.2, 0, h - 0.2, 0, M.calatrava);
      box(g, L, 0.25, W * 0.8, 0, 0, 0, M.stone);
      tops(name, g);
    }
  }
  // The Pont de l'Assut de l'Or: the cable-stayed bridge's 125 m curved pylon, its stays fanned down to the deck
  {
    const deck = ROADS.filter((r) => /Assut de l.Or/.test(r.name)).flatMap((r) => r.pts);
    const base = lonLatToWorld(-0.3513, 39.4539);
    let ux = 1, uz = 0;
    if (deck.length >= 2) {
      const a = deck[0], c = deck[deck.length - 1];
      const L = Math.hypot(c.x - a.x, c.z - a.z) || 1;
      ux = (c.x - a.x) / L; uz = (c.z - a.z) / L;
    }
    const g = new THREE.Group();
    g.position.set(base.x, 0, base.z);
    g.rotation.y = Math.atan2(-uz, ux);
    g.name = "Pont de l'Assut de l'Or";
    const pylon = new THREE.Group();
    pylon.rotation.z = 0.32; // leaning back over the deck
    for (let i = 0; i < 10; i++) {
      const k = 1 - i / 12;
      const seg = box(pylon, 5 * k, 12.8, 3.6 * k, 0, i * 12.5, 0, M.calatrava);
      seg.rotation.z = -i * 0.012;
    }
    g.add(pylon);
    for (let i = 3; i < 10; i++) {
      const top = new THREE.Vector3(Math.sin(-0.32) * i * 12.5, Math.cos(0.32) * i * 12.5, 0);
      const foot = new THREE.Vector3(-30 - i * 9, 9, 0);
      const len = top.distanceTo(foot);
      const stay = add(g, new THREE.CylinderGeometry(0.18, 0.18, len, 4), M.steel, (top.x + foot.x) / 2, (top.y + foot.y) / 2, 0, false);
      stay.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), top.clone().sub(foot).normalize());
    }
    group.add(g);
  }
  // L'Oceanogràfic's entrance: Candela's water-lily shell (hyperbolic paraboloid lobes)
  {
    const s = LANDMARK_SITES['Oceanogràfic de València'];
    if (s) {
      const g = new THREE.Group();
      g.position.set(s.x, 0, s.z);
      g.name = 'Oceanogràfic';
      for (let i = 0; i < 8; i++) {
        const lobe = dome(g, 1, 0, 0, 0, M.calatravaDouble, 1, 16);
        lobe.scale.set(18, 16, 7);
        lobe.rotation.y = (i / 8) * Math.PI;
      }
      group.add(g);
    }
  }

  // =========================================================================
  // TOWERS & THE MARINA
  // =========================================================================
  // Torre de França: the city's tallest residential tower by the Ciutat de les Arts, at the survey's top (107.5 m)
  {
    const name = 'Torre de Francia';
    const s = LANDMARK_SITES[name];
    if (s?.ring) {
      const top = H(name, 'top', 107.5);
      const body = extrude(s.ring, 0, top - 2.5, M.glass, [], name);
      const cap = extrude(s.ring, top - 2.5, 2.5, M.tileWhite);
      collide(body);
      tops(name, body, cap);
    }
  }
  // Veles e Vents: the America's Cup building, white decks stacked & slid past one another, to the survey's top
  {
    const name = 'Veles e Vents';
    const p = place(name);
    if (p) {
      const { g, b } = p;
      const L = Math.max(40, b.L), W = Math.max(30, b.W);
      const top = H(name, 'top', 26);
      const step = top / 4;
      for (let i = 0; i < 4; i++) {
        const off = (i % 2 ? 1 : -1) * 3.5;
        box(g, L * 0.72, step - 1.6, W * 0.6, off * 0.3, i * step, 0, M.darkGlass);
        box(g, L * (0.95 - i * 0.04), 1.6, W * (0.9 - i * 0.03), off, i * step + step - 1.6, (i % 2 ? -1 : 1) * 2, M.calatrava);
      }
      collide(g);
      tops(name, g);
    }
  }

  batchStaticGroupMeshes(group, new Set());
  scene.add(group);
  return { group, colliders };
}

export { buildLandmarks, bryantParkLawn, landmarkTops };
