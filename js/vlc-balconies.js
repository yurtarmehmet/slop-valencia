import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, attribute, positionGeometry, abs, fract, floor, step, fwidth, max, min, mix, clamp, smoothstep, sin,
  length, color, mx_noise_float
} from 'three/tsl';
import { filteredPulse, FACADE_DETAIL_LOD } from './tsl-materials.js';
import { boxBalconies } from './vlc-facade-rules.js';

// València's wrought-iron balconies (gap #4): a stone slab and an iron railing in front of every balcony door the facade
// shader opens (tsl-materials.js balconyMask), streamed around the camera out to FACADE_DETAIL_LOD (the facade paints
// the railings beyond it). Which buildings have which balconies is a rule by era and barri (facadeStyle), learnt
// from the open reference photos (reference/f-*): no dataset maps balconies (vlc-facade-rules.js).
//   pre-1900 & Ciutat Vella  a shallow balcony (~0.5 m) at every upper-floor door, plain bars over a lower band
//   1900-40 Ensanche          the same, ornate cast iron, often one long balcony across the first floor (principal)
//   1940-60 rationalist       French railings flush with the openings, or balconies on alternate bays
//   1960-85 desarrollismo     a column of deep terraces (every third bay) or none: roller blinds instead
//   1985 on                   alternate or every third bay, thin light metal bars
//   Poblats Marítims houses   a balcony at each first-floor door
// Plants on some balconies (gap #11): pots of geraniums and trailing green behind the railing.

const MAX_BALCONIES = 48000;
const SLAB = 0.15;
const RAIL = 1.0;

// Unit balcony: wall face at z = 0, out to z = 1 (scaled by the depth), x across [-0.5, 0.5] (scaled by the width),
// y in metres. part 0 slab, 1 front railing, 2 side railings, 3 plant row (gap #11)
function balconyGeometry() {
  const pos = [], part = [], idx = [];
  const quad = (a, b, c, d, p) => {
    const i = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    part.push(p, p, p, p);
    idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  const y0 = -SLAB, y1 = 0;
  quad([-0.5, y1, 0], [-0.5, y1, 1], [0.5, y1, 1], [0.5, y1, 0], 0); // top
  quad([-0.5, y0, 0], [0.5, y0, 0], [0.5, y0, 1], [-0.5, y0, 1], 0); // underside
  quad([-0.5, y0, 1], [0.5, y0, 1], [0.5, y1, 1], [-0.5, y1, 1], 0); // nose
  quad([-0.5, y0, 0], [-0.5, y0, 1], [-0.5, y1, 1], [-0.5, y1, 0], 0);
  quad([0.5, y0, 1], [0.5, y0, 0], [0.5, y1, 0], [0.5, y1, 1], 0);
  const z = 0.96, x = 0.48;
  quad([-x, 0, z], [x, 0, z], [x, RAIL, z], [-x, RAIL, z], 1);
  quad([-x, 0, 0], [-x, 0, z], [-x, RAIL, z], [-x, RAIL, 0], 2);
  quad([x, 0, z], [x, 0, 0], [x, RAIL, 0], [x, RAIL, z], 2);
  quad([-0.44, 0, 0.82], [0.44, 0, 0.82], [0.44, 0.75, 0.82], [-0.44, 0.75, 0.82], 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('balcPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function flagRange(attr, count) {
  if (!count) return;
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

/**
 * The streamed balcony pool. `specs[mat]` = { windowWidth, floorHeight, windowRatioX } per facade material.
 * Per update: begin(), addBlock(blk, focusX, focusZ) for the blocks nearest first (blk.items: its facade boxes), end().
 */
export function createBalconies(group, specs) {
  const geometry = balconyGeometry();
  const data = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BALCONIES * 4), 4);
  data.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('balc', data);
  const material = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaToCoverage: true, roughness: 0.62, metalness: 0.25 });

  const part = attribute('balcPart', 'float');
  const b = attribute('balc', 'vec4'); // width, depth, kind (rail style, +4 French), seed
  const kind = b.z;
  const french = step(3.5, kind);
  const rs = kind.sub(french.mul(4.0));
  const isRail = step(0.5, part).mul(step(part, 2.5));
  const isPlant = step(2.5, part);
  // metres along the railing (front: across the balcony; sides: out from the wall) and up it
  const isSide = step(1.5, part).mul(step(part, 2.5));
  const along = mix(positionGeometry.x.add(0.48).mul(b.x), positionGeometry.z.mul(b.y), isSide);
  const len = mix(b.x.mul(0.96), b.y.mul(0.96), isSide);
  const y = positionGeometry.y;
  const plants = step(0.7, fract(b.w.mul(5.3))).mul(step(rs, 1.5)).mul(float(1.0).sub(french)); // ~30% of the older ones

  material.opacityNode = Fn(() => {
    const fa = fwidth(along).max(0.0005);
    const fy = fwidth(y).max(0.0005);
    const bar = (coord, spacing, half, fw) => filteredPulse(fract(coord.div(spacing)), float(0.5).sub(half.div(spacing)), float(0.5).add(half.div(spacing)), fw.div(spacing));
    const hband = (y0, y1) => filteredPulse(y, y0, y1, fy);
    const top = hband(RAIL - 0.05, RAIL);
    const bottom = hband(0.03, 0.08);
    const posts = max(filteredPulse(along, 0.0, 0.035, fa), filteredPulse(along, len.sub(0.035), len, fa));
    // 0 old town: square bars every 11 cm over a band of short bars
    const old = max(bar(along, float(0.11), float(0.009), fa).mul(hband(0.0, RAIL)), hband(0.2, 0.23));
    // 1 Ensanche: turned balusters (thicker at the waist) every 13 cm, a frieze of rings under the handrail
    const waist = smoothstep(0.55, 0.0, abs(y.sub(0.45))).mul(0.012).add(0.009);
    const balusters = bar(along, float(0.13), waist, fa).mul(hband(0.08, 0.76));
    const ringU = fract(along.div(0.13)).sub(0.5).mul(0.13);
    const ring = abs(length(vec2(ringU, y.sub(0.84))).sub(0.05));
    const rings = filteredPulse(ring, 0.0, 0.009, max(fa, fy)).mul(hband(0.76, 0.95));
    const ornate = max(max(balusters, rings), hband(0.76, 0.785));
    // 2 1960s: plain square tube every 12 cm; 3 modern: thin bars every 10 cm
    const plain = bar(along, float(0.12), float(0.011), fa).mul(hband(0.0, RAIL));
    const modern = bar(along, float(0.1), float(0.007), fa).mul(hband(0.0, RAIL));
    const infill = mix(mix(old, ornate, step(0.5, rs)), mix(plain, modern, step(2.5, rs)), step(1.5, rs));
    const railing = clamp(max(max(top, bottom), max(posts, infill)), 0.0, 1.0);
    // Plant row: leafy clumps in pots along the slab, some trailing through the bars (gap #11)
    const leaf = mx_noise_float(vec2(along.mul(5.0), y.mul(6.0)).add(b.w.mul(41.0))).mul(0.5).add(0.5);
    const clump = mx_noise_float(vec2(along.mul(1.3).add(b.w.mul(17.0)), 0.5)).mul(0.5).add(0.5);
    const inClump = smoothstep(0.52, 0.6, clump); // pots stand apart along the slab
    const plantH = clump.sub(0.52).mul(1.6).add(0.3);
    const pot = hband(0.0, 0.2).mul(step(0.58, clump));
    const foliage = smoothstep(plantH, plantH.sub(0.1), y).mul(inClump).mul(step(0.32, leaf)).mul(step(0.16, y));
    const plant = max(pot, foliage).mul(plants);
    const slab = float(1.0).sub(french);
    return mix(mix(slab, railing, isRail), plant, isPlant);
  })();
  material.maskNode = material.opacityNode.greaterThan(0.02);
  material.maskShadowNode = material.opacityNode.greaterThan(0.5);
  material.colorNode = Fn(() => {
    const iron = mix(mix(color(0x1b1b1a), color(0x22302a), step(0.7, fract(b.w.mul(3.7)))), mix(color(0x6d6e6c), color(0xc9c8c2), step(0.5, fract(b.w.mul(2.3)))), step(2.5, rs));
    // slab: stone (older), concrete (1960s on); the underside in shade
    const stone = mix(color(0xd2c6ae), color(0xbdb6a8), step(1.5, rs));
    const under = step(positionGeometry.y, -SLAB + 0.01);
    const slabCol = stone.mul(mix(float(1.0), float(0.7), under));
    const leafCol = mix(color(0x3d5a2a), color(0x5f7d36), mx_noise_float(vec2(positionGeometry.x.mul(9.0), positionGeometry.y.mul(9.0)).add(b.w.mul(23.0))).mul(0.5).add(0.5));
    const flowers = step(0.72, mx_noise_float(vec2(positionGeometry.x.mul(23.0), positionGeometry.y.mul(23.0)).add(b.w.mul(7.0)))).mul(step(0.5, fract(b.w.mul(11.0))));
    const potCol = color(0xa65a3a);
    const plantCol = mix(mix(leafCol, color(0xc8283a), flowers), potCol, step(positionGeometry.y, 0.22).mul(0.85));
    return mix(mix(slabCol, iron, isRail), plantCol, isPlant);
  })();
  material.roughnessNode = mix(float(0.85), float(0.55), isRail);
  material.metalnessNode = mix(float(0.0), float(0.35), isRail);

  const mesh = new THREE.InstancedMesh(geometry, material, MAX_BALCONIES);
  mesh.name = 'Balconies';
  mesh.count = 0;
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  group.add(mesh);

  const R2 = FACADE_DETAIL_LOD * FACADE_DETAIL_LOD;
  let n = 0;
  function blockData(blk) {
    if (blk._balconies) return blk._balconies;
    const out = [];
    for (const item of blk.items || []) boxBalconies(item, specs[item.mat], out);
    blk._balconies = new Float32Array(out);
    return blk._balconies;
  }
  return {
    get count() { return n; },
    begin() { n = 0; },
    addBlock(blk, fx, fz) {
      if (n >= MAX_BALCONIES || !blk.items) return;
      const r = (blk.radius || 0) + FACADE_DETAIL_LOD;
      const dx = blk.cx - fx, dz = blk.cz - fz;
      if (dx * dx + dz * dz > r * r) return;
      const a = blockData(blk);
      const m = mesh.instanceMatrix.array, d = data.array;
      for (let i = 0; i < a.length && n < MAX_BALCONIES; i += 8) {
        const x = a[i], z = a[i + 2];
        if ((x - fx) * (x - fx) + (z - fz) * (z - fz) > R2) continue;
        const c = Math.cos(a[i + 3]), s = Math.sin(a[i + 3]), w = a[i + 4], dep = a[i + 5];
        const o = n * 16;
        m[o] = c * w; m[o + 1] = 0; m[o + 2] = -s * w; m[o + 3] = 0;
        m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0; m[o + 7] = 0;
        m[o + 8] = s * dep; m[o + 9] = 0; m[o + 10] = c * dep; m[o + 11] = 0;
        m[o + 12] = x; m[o + 13] = a[i + 1]; m[o + 14] = z; m[o + 15] = 1;
        d[n * 4] = w; d[n * 4 + 1] = dep; d[n * 4 + 2] = a[i + 6]; d[n * 4 + 3] = a[i + 7];
        n++;
      }
    },
    end() {
      mesh.count = n;
      flagRange(mesh.instanceMatrix, n);
      flagRange(data, n);
    }
  };
}
