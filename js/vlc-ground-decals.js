import * as THREE from 'three/webgpu';
import { REAL_DRAINS } from './vlc-drains.js';
import { createGroundDecalMaterial } from './tsl-materials.js';

// Cast-iron covers on the roadway, one instanced decal mesh (scene-culling.js chunks & distance-culls it under
// CityGrid):
// - storm drains at their real places and kinds (js/vlc-drains.js: the Ajuntament's Embornals / Imbornales, turned
//   along the nearest real kerb line)
// - sewer manholes (rule, no open data: the Ajuntament publishes no manhole layer) down the middle of every street of
//   the road network, one every 30-55 m, and small utility covers near the kerbs, one every 25-50 m
// kind: 0 Valencian kerb inlet, 1 small grate, 2 large grate, 3 square grate, 4 round grate, 5 manhole, 6 utility lid
const SIZE = [[0.85, 0.4], [0.6, 0.3], [1.0, 0.5], [0.5, 0.5], [0.6, 0.6], [0.66, 0.66], [0.45, 0.45]];
const HEIGHT = 0.016; // over the asphalt (y = 0) and the paint (0.012)

function hash(x, z, k) {
  const s = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

function buildGroundDecals(parent, network) {
  const items = []; // [x, z, yaw, kind]
  for (const d of REAL_DRAINS) items.push([d.x, d.z, d.yaw, d.kind]);
  let manholes = 0;
  let lids = 0;
  if (network) {
    // one directed edge per street between two junctions
    const seen = new Set();
    for (const e of network.paintEdges || network.edges) {
      const key = Math.min(e.from.id, e.to.id) * 65536 + Math.max(e.from.id, e.to.id);
      if (seen.has(key)) continue;
      seen.add(key);
      const at = (s, o) => [e.sx + e.dx * s + e.rx * o, e.sz + e.dz * s + e.rz * o];
      const yaw = Math.atan2(e.dz, e.dx);
      for (let s = 4 + hash(e.sx, e.sz, 1) * 20; s < e.len - 4; s += 30 + hash(e.sx, s, 2) * 25) {
        const o = (hash(s, e.sz, 3) - 0.5) * Math.min(3, Math.max(0, e.half * 2 - 4));
        items.push([...at(s, o), yaw, 5]);
        manholes++;
      }
      for (let s = 3 + hash(e.sz, e.sx, 4) * 20; s < e.len - 3; s += 25 + hash(s, e.sx, 5) * 25) {
        if (e.half < 3) break;
        const side = hash(e.sx, s, 6) < 0.5 ? -1 : 1;
        items.push([...at(s, side * (e.half - 0.7 - hash(s, e.sz, 7) * 0.8)), yaw, 6]);
        lids++;
      }
    }
  }

  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const kinds = new Float32Array(items.length);
  const mesh = new THREE.InstancedMesh(geo, createGroundDecalMaterial(), items.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  items.forEach(([x, z, yaw, kind], i) => {
    const [w, d] = SIZE[kind];
    q.setFromAxisAngle(up, -yaw);
    m.compose(p.set(x, HEIGHT, z), q, sc.set(w, 1, d));
    mesh.setMatrixAt(i, m);
    kinds[i] = kind;
  });
  geo.setAttribute('kind', new THREE.InstancedBufferAttribute(kinds, 1));
  mesh.instanceMatrix.needsUpdate = true;
  mesh.name = 'GroundDecals';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.computeBoundingSphere();
  parent.add(mesh);
  console.info(`[decals] ${REAL_DRAINS.length} storm drains, ${manholes} manholes, ${lids} utility lids`);
  return mesh;
}

export { buildGroundDecals };
