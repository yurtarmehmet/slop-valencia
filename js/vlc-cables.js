import * as THREE from 'three/webgpu';
import { Fn, float, vec3, attribute, positionGeometry, positionLocal, step, mix, color } from 'three/tsl';
import { cableRuns } from './vlc-facade-rules.js';

// Overhead cables (gap #11): the bundles of telephone & power cables stapled along older facades just above the
// ground floor, sagging between their hooks, and the odd cable slung across the street to the facade opposite. Rules,
// not data (vlc-facade-rules.js cableRuns): no dataset maps them; the Street View pairs show them on most fronts built
// before ~1985 in Ciutat Vella, Russafa, Benimaclet, the Cabanyal and the 1960s-70s blocks, none on glass or modern
// fronts. Streamed around the camera like the balconies.

const MAX_SPANS = 16000;
const SEGMENTS = 8;
const WIRES = 3;
export const CABLE_RADIUS = 160;

// Unit span: t (0..1) along local x, each wire a vertical and a horizontal ribbon (seen from the street or the side)
function spanGeometry() {
  const pos = [], wire = [], side = [], idx = [];
  for (let w = 0; w < WIRES; w++) {
    for (const flat of [0, 1]) {
      const base = pos.length / 3;
      for (let i = 0; i <= SEGMENTS; i++) {
        const t = i / SEGMENTS;
        // at t along the span; side +-1 (the ribbon's half thickness) & the ribbon kind are resolved in the position
        // node, after the instance matrix has put t onto the span
        pos.push(t, 0, 0, t, 0, 0);
        side.push(-1, flat, 1, flat);
        wire.push(w, w);
      }
      for (let i = 0; i < SEGMENTS; i++) {
        const a = base + i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('cableWire', new THREE.Float32BufferAttribute(wire, 1));
  g.setAttribute('cableSide', new THREE.Float32BufferAttribute(side, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return g;
}

function flagRange(attr, count) {
  if (!count) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

/**
 * The streamed cable pool. Per update: begin(), addBlock(blk, focusX, focusZ) nearest first, end().
 * `opposite(x, z, nx, nz)`: the facade across the street from a wall point, { x, z } or null (buildings.js).
 */
export function createCables(group, opposite) {
  const geometry = spanGeometry();
  const data = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPANS * 4), 4);
  data.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('cable', data); // sag (m), wires, thickness (m), seed
  const perp = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPANS * 2), 2);
  perp.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('cablePerp', perp); // the horizontal unit vector across the span (out of the wall)
  const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.55, metalness: 0.0 });
  const c = attribute('cable', 'vec4');
  const wire = attribute('cableWire', 'float');
  // The instance matrix puts local x onto the span (A -> B); sag, wire spacing & ribbon thickness are added in metres
  // (three.js applies positionNode after the instancing, so it offsets the instanced position)
  const sideAttr = attribute('cableSide', 'vec2');
  const across = attribute('cablePerp', 'vec2');
  material.positionNode = Fn(() => {
    const t = positionGeometry.x;
    const side = sideAttr.x;
    const flat = sideAttr.y;
    const shown = step(wire, c.y.sub(0.5));
    const sag = c.x.mul(float(1.0).add(wire.mul(0.35))).mul(t).mul(float(1.0).sub(t)).mul(4.0);
    const half = c.z.mul(0.5).mul(shown);
    const y = wire.mul(-0.07).sub(sag).add(side.mul(half).mul(float(1.0).sub(flat)));
    const z = wire.mul(0.03).add(side.mul(half).mul(flat));
    return positionLocal.add(vec3(across.x.mul(z), y, across.y.mul(z)));
  })();
  material.colorNode = mix(color(0x141414), color(0x2a2724), step(1.5, wire));
  const mesh = new THREE.InstancedMesh(geometry, material, MAX_SPANS);
  mesh.name = 'OverheadCables';
  mesh.count = 0;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  group.add(mesh);

  const R2 = CABLE_RADIUS * CABLE_RADIUS;
  let n = 0;
  function blockData(blk) {
    if (!blk._cables) {
      const out = [];
      for (const item of blk.items || []) cableRuns(item, out, opposite);
      blk._cables = new Float32Array(out);
    }
    return blk._cables;
  }
  return {
    get count() { return n; },
    begin() { n = 0; },
    addBlock(blk, fx, fz) {
      if (n >= MAX_SPANS || !blk.items) return;
      const r = (blk.radius || 0) + CABLE_RADIUS;
      const dx = blk.cx - fx, dz = blk.cz - fz;
      if (dx * dx + dz * dz > r * r) return;
      const a = blockData(blk);
      const m = mesh.instanceMatrix.array, d = data.array;
      // per span: ax, ay, az, bx, by, bz, sag, wires, thickness, seed
      for (let i = 0; i < a.length && n < MAX_SPANS; i += 10) {
        const ax = a[i], ay = a[i + 1], az = a[i + 2], bx = a[i + 3], by = a[i + 4], bz = a[i + 5];
        const mx = (ax + bx) * 0.5 - fx, mz = (az + bz) * 0.5 - fz;
        if (mx * mx + mz * mz > R2) continue;
        const hx = bx - ax, hz = bz - az, hl = Math.hypot(hx, hz) || 1;
        const o = n * 16;
        m[o] = hx; m[o + 1] = by - ay; m[o + 2] = hz; m[o + 3] = 0;
        m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0; m[o + 7] = 0;
        m[o + 8] = -hz / hl; m[o + 9] = 0; m[o + 10] = hx / hl; m[o + 11] = 0;
        m[o + 12] = ax; m[o + 13] = ay; m[o + 14] = az; m[o + 15] = 1;
        d[n * 4] = a[i + 6]; d[n * 4 + 1] = a[i + 7]; d[n * 4 + 2] = a[i + 8]; d[n * 4 + 3] = a[i + 9];
        perp.array[n * 2] = -hz / hl; perp.array[n * 2 + 1] = hx / hl;
        n++;
      }
    },
    end() {
      mesh.count = n;
      flagRange(mesh.instanceMatrix, n);
      flagRange(data, n);
      flagRange(perp, n);
    }
  };
}
