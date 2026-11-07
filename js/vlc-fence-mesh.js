import * as THREE from 'three/webgpu';
import { Fn, float, attribute, positionGeometry, abs, fract, step, fwidth, max, mix, clamp, color } from 'three/tsl';
import { filteredPulse } from './tsl-materials.js';
import { FENCES } from './vlc-fences.js';

// València's mapped fences and railings (gap #4): park and school railings, sports-ground and building-site fences,
// bridge and stair railings from OpenStreetMap (vlc-fences.js, tools/build-fences.py). One instanced see-through
// panel per segment (alpha to coverage, so distant bars blend to their mean coverage instead of shimmering), static:
// scene-culling.js chunks it with the city's other small props.

/** The fence segments: [ax, az, bx, bz, height, kind] per segment (world metres) */
export function fenceSegments() {
  const b = Uint8Array.from(atob(FENCES), (c) => c.charCodeAt(0));
  const v = new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
  const out = [];
  for (let i = 0; i < v.length;) {
    const n = v[i], kind = v[i + 1], h = v[i + 2] / 10;
    const p = i + 3;
    for (let k = 0; k < n - 1; k++) {
      out.push(v[p + k * 2] / 4, v[p + k * 2 + 1] / 4, v[p + k * 2 + 2] / 4, v[p + k * 2 + 3] / 4, h, kind);
    }
    i = p + n * 2;
  }
  return out;
}

export function createFences() {
  const seg = fenceSegments();
  const n = seg.length / 6;
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.translate(0.5, 0.5, 0); // x 0..1 along the segment, y 0..1 up
  const data = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  geometry.setAttribute('fence', data); // length, height, kind, seed
  const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaToCoverage: true, roughness: 0.6, metalness: 0.4 });
  const f = attribute('fence', 'vec4');
  const u = positionGeometry.x.mul(f.x); // metres along
  const y = positionGeometry.y.mul(f.y); // metres up
  const kind = f.z;
  material.opacityNode = Fn(() => {
    const fu = fwidth(u).max(0.0005), fy = fwidth(y).max(0.0005);
    const bars = (spacing, half) => filteredPulse(fract(u.div(spacing)), float(0.5 - half / spacing), float(0.5 + half / spacing), fu.div(spacing));
    const band = (y0, y1) => filteredPulse(y, y0, y1, fy);
    const top = f.y;
    const posts = bars(2.5, 0.035);
    const rails = max(band(top.sub(0.06), top.sub(0.02)), band(0.06, 0.1));
    // 0 iron bars (park & school railings), 2 railing: vertical bars between rails
    const iron = max(max(bars(0.12, 0.009), rails), posts);
    // 1 chain-link: a diamond mesh of 6 cm on posts every 3 m, a top rail
    const d1 = fract(u.add(y).div(0.06)), d2 = fract(u.sub(y).div(0.06));
    const fd = fu.add(fy).div(0.06);
    const mesh = max(filteredPulse(d1, 0.46, 0.54, fd), filteredPulse(d2, 0.46, 0.54, fd));
    const chain = max(max(mesh.mul(0.85), bars(3.0, 0.03)), band(top.sub(0.05), top));
    // 3 guard rail: a corrugated band on posts every 2 m
    const guard = max(band(0.45, 0.78), bars(2.0, 0.06));
    const pick = mix(mix(iron, chain, step(0.5, kind)), mix(iron, guard, step(2.5, kind)), step(1.5, kind));
    return clamp(pick, 0.0, 1.0).mul(step(y, top));
  })();
  material.maskNode = material.opacityNode.greaterThan(0.02);
  material.maskShadowNode = material.opacityNode.greaterThan(0.5);
  const dark = mix(color(0x1d2621), color(0x1a1a1a), step(0.5, fract(f.w.mul(3.1))));
  const galv = mix(color(0x8c9190), color(0x3b5a44), step(0.75, fract(f.w.mul(5.7))));
  material.colorNode = mix(dark, galv, step(0.5, kind).mul(step(kind, 1.5)).add(step(2.5, kind)));

  const inst = new THREE.InstancedMesh(geometry, material, n);
  inst.name = 'Fences';
  const m = inst.instanceMatrix.array;
  for (let i = 0; i < n; i++) {
    const ax = seg[i * 6], az = seg[i * 6 + 1], bx = seg[i * 6 + 2], bz = seg[i * 6 + 3], h = seg[i * 6 + 4];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    const o = i * 16;
    m[o] = dx; m[o + 1] = 0; m[o + 2] = dz; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = h; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = -dz / L; m[o + 9] = 0; m[o + 10] = dx / L; m[o + 11] = 0;
    m[o + 12] = ax; m[o + 13] = 0; m[o + 14] = az; m[o + 15] = 1;
    data.setXYZW(i, L, h, seg[i * 6 + 5], ((ax * 0.137 + az * 0.071) % 1 + 1) % 1);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.castShadow = inst.receiveShadow = true;
  inst.computeBoundingSphere();
  return inst;
}
