import * as THREE from 'three/webgpu';
import { createRoadPaintMaterial, createStoneLaneMaterial } from './tsl-materials.js';
import { buildGroundDecals } from './vlc-ground-decals.js';
import { REAL_MARKINGS } from './vlc-markings.js';
import { STONE_LANES } from './vlc-stone-lanes.js';
import { laneProfile } from './city-config.js';

// València's road markings where the city painted them (js/vlc-markings.js: the Ajuntament's Senyalització
// horitzontal, rebuilt as strokes & polygons by tools/build-markings.py): white lane lines, zebra crossings, stop bars,
// bus & bike lane lines, parking bays (white, ORA blue / orange / green), yellow no-parking lines & bus-stop zigzags,
// red bike-lane & raised-crossing paint, each in its real width and dash pattern (Norma 8.2-IC, as painted).
// Vertex-coloured strips (a `paint` attribute with metres along the stroke, dash period & duty, and a `side` offset
// the material widens to a pixel at distance), cut into 400 m cells, each dropped beyond ~650 m (a THREE.LOD).

const HEIGHT = 0.012; // above the asphalt
const CELL = 400;
const DRAW_DISTANCE = 650;

// The old town's stone lanes & the streets paved in setts or slabs (js/vlc-stone-lanes.js, tools/build-kerbs.py): flat
// strips between the facades (kerb-free shared lanes) or the kerbs, just over the asphalt and under the paint. The
// single-level pedestrian streets (`s`) lie level with the sidewalks (city-config.js laneProfile: ramped down at open
// ends), hiding the kerbs, with a skirt down each edge to the asphalt.
function buildStoneLanes(scene) {
  const position = [];
  const paving = [];
  const index = [];
  for (const lane of STONE_LANES) {
    const p = lane.pts;
    const n = p.length;
    if (n < 2) continue;
    const level = lane.s === 1;
    const prof = level ? laneProfile(lane) : null;
    const base = position.length / 3;
    const edges = [];
    for (let i = 0; i < n; i++) {
      // mitred normal (to the right of the lane's direction: x = -dz, z = dx), miters clamped to twice the width
      let nx = 0, nz = 0, ax = 0, az = 0;
      for (const [j, k] of [[i - 1, i], [i, i + 1]]) {
        if (j < 0 || k >= n) continue;
        const dx = p[k][0] - p[j][0], dz = p[k][1] - p[j][1];
        const L = Math.hypot(dx, dz) || 1;
        nx += -dz / L; nz += dx / L;
        ax = -dz / L; az = dx / L;
      }
      const ml = Math.hypot(nx, nz) || 1;
      nx /= ml; nz /= ml;
      const m = 1 / Math.max(0.5, nx * ax + nz * az);
      // a little past the kerbs & facades, which hide the edges
      const l = (lane.l + 0.3) * m, r = (lane.r + 0.3) * m;
      const y = level ? prof[i][1] : 0.006;
      position.push(p[i][0] - nx * l, y, p[i][1] - nz * l, p[i][0] + nx * r, y, p[i][1] + nz * r);
      paving.push(lane.p, lane.p);
      edges.push([p[i][0] - nx * l, p[i][1] - nz * l, p[i][0] + nx * r, p[i][1] + nz * r, y]);
      if (i > 0) {
        const a = base + (i - 1) * 2;
        index.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }
    if (!level) continue;
    // skirts: each edge dropped to the asphalt (seen where the lane runs past a gap in the facades)
    for (const side of [0, 1]) {
      const sb = position.length / 3;
      for (const e of edges) {
        const ex = side ? e[2] : e[0], ez = side ? e[3] : e[1];
        position.push(ex, e[4], ez, ex, 0, ez);
        paving.push(lane.p, lane.p);
      }
      for (let i = 1; i < edges.length; i++) {
        const a = sb + (i - 1) * 2;
        // outward-facing either way round: the material is double-sided
        index.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }
  }
  if (!index.length) return null;
  const geometry = new THREE.BufferGeometry();
  const normal = new Float32Array(position.length);
  for (let i = 1; i < normal.length; i += 3) normal[i] = 1;
  const uv = new Float32Array((position.length / 3) * 2);
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('paving', new THREE.Float32BufferAttribute(paving, 1));
  geometry.setIndex(index);
  const material = createStoneLaneMaterial();
  material.name = 'stonelane';
  material.side = THREE.DoubleSide; // the level lanes' skirts
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'StoneLanes';
  mesh.receiveShadow = true;
  // a few thousand triangles: one mesh under CityGrid
  (scene.getObjectByName('CityGrid') || scene).add(mesh);
  return mesh;
}

function buildRoadPaint(scene, network) {
  // Storm drains, manholes & utility lids, under CityGrid so the scene culling chunks them
  buildGroundDecals(scene.getObjectByName('CityGrid') || scene, network);
  buildStoneLanes(scene);

  const { styles, strokes, polys } = REAL_MARKINGS;
  const colours = styles.map((s) => new THREE.Color().setRGB(s.r / 255, s.g / 255, s.b / 255, THREE.SRGBColorSpace));
  const cells = new Map();
  const cellOf = (x, z) => {
    const key = Math.floor(x / CELL) * 65536 + Math.floor(z / CELL);
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { x: (Math.floor(x / CELL) + 0.5) * CELL, z: (Math.floor(z / CELL) + 0.5) * CELL, position: [], side: [], paint: [], color: [], index: [] }));
    return c;
  };

  // A stroke: a strip along its centre polyline with mitred joints (miters clamped to twice the half width)
  for (const s of strokes) {
    const p = s.pts;
    const n = p.length / 2;
    if (n < 2) continue;
    const c = cellOf(p[0], p[1]);
    const col = colours[s.style];
    const period = s.period > 0 ? s.period : 1;
    const duty = s.period > 0 ? s.duty : 1;
    const hw = s.width / 2;
    const base = c.position.length / 3;
    let u = 0;
    for (let i = 0; i < n; i++) {
      const x = p[i * 2], z = p[i * 2 + 1];
      if (i > 0) u += Math.hypot(x - p[i * 2 - 2], z - p[i * 2 - 1]);
      // unit normals of the segments before & after this point
      let nx = 0, nz = 0, cnt = 0, ax = 0, az = 0;
      for (const [j, k] of [[i - 1, i], [i, i + 1]]) {
        if (j < 0 || k >= n) continue;
        const dx = p[k * 2] - p[j * 2], dz = p[k * 2 + 1] - p[j * 2 + 1];
        const L = Math.hypot(dx, dz) || 1;
        nx += -dz / L; nz += dx / L; cnt++;
        ax = -dz / L; az = dx / L;
      }
      const ml = Math.hypot(nx, nz) || 1;
      nx /= ml; nz /= ml;
      const cos = Math.max(0.5, nx * ax + nz * az);
      const ox = nx * hw / cos, oz = nz * hw / cos;
      for (const sgn of [-1, 1]) {
        c.position.push(x + ox * sgn - c.x, HEIGHT, z + oz * sgn - c.z);
        c.side.push(ox * sgn, oz * sgn);
        c.paint.push(u, period, duty);
        c.color.push(col.r, col.g, col.b);
      }
      if (i > 0) {
        const a = base + (i - 1) * 2;
        c.index.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }
  }

  // Filled shapes (arrows, triangles, hatched islands): earcut
  for (const poly of polys) {
    const p = poly.pts;
    const n = p.length / 2;
    if (n < 3) continue;
    const c = cellOf(p[0], p[1]);
    const col = colours[poly.style];
    const contour = [];
    for (let i = 0; i < n; i++) contour.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const base = c.position.length / 3;
    for (let i = 0; i < n; i++) {
      c.position.push(p[i * 2] - c.x, HEIGHT, p[i * 2 + 1] - c.z);
      c.side.push(0, 0);
      c.paint.push(0, 1, 1);
      c.color.push(col.r, col.g, col.b);
    }
    for (const t of tris) c.index.push(base + t[0], base + t[1], base + t[2]);
  }

  const material = createRoadPaintMaterial();
  material.name = 'roadpaint';
  const group = new THREE.Group();
  group.name = 'RoadMarkings';
  for (const c of cells.values()) {
    const geometry = new THREE.BufferGeometry();
    const normal = new Float32Array(c.position.length);
    for (let i = 1; i < normal.length; i += 3) normal[i] = 1;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(c.position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(c.color, 3));
    geometry.setAttribute('side', new THREE.Float32BufferAttribute(c.side, 2));
    geometry.setAttribute('paint', new THREE.Float32BufferAttribute(c.paint, 3));
    geometry.setIndex(c.index);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'RoadMarkings';
    mesh.receiveShadow = true;
    mesh.renderOrder = -1; // under the other see-through ground effects (contact shadows, headlight beams)
    const lod = new THREE.LOD();
    lod.position.set(c.x, 0, c.z);
    lod.addLevel(mesh, 0);
    lod.addLevel(new THREE.Object3D(), DRAW_DISTANCE);
    group.add(lod);
  }
  scene.add(group);
  console.info(`[markings] ${strokes.length} strokes, ${polys.length} shapes in ${cells.size} cells`);
  return group;
}

export { buildRoadPaint };
