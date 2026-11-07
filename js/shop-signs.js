import * as THREE from 'three/webgpu';
import { attribute, color, float, mix, smoothstep, texture, uv } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { SHOP_KINDS } from './shop-signs-kinds.js';
import { SHOP_COUNT, SHOP_DATA } from './vlc-shops.js';

// Shop fascia signs where OpenStreetMap has a shop, bar or restaurant (js/vlc-shops.js, tools/build-shops.mjs). Each
// sign spells the trade in the shop's place (FORN, FARMÀCIA, BAR...), never the business's name (SHOP_KINDS), on the
// ground floor of the nearest street front of a real building. Pharmacies also get the green cross on a bracket, as
// every Spanish pharmacy has; empty shopfronts get an ES LLOGA / SE ALQUILA placard behind the glass.
//
// planShopSigns(walls, boxes) is called by buildings.js before the facades are built: `walls` are the street-front walls
// of the real buildings, { ax, az, bx, bz (world ends), nx, nz (outward normal), storey (ground floor height), shop
// (true if already a shopfront), id, item (its facade box) }; `boxes` every facade box as an oriented rect { cx, cz,
// hx, hz, cs, sn, item } (a sign is never put where another box stands in front of the wall: overlapping Catastro
// parts). It returns { group, used }, `used` the ids of the walls given a sign (buildings.js glazes their ground
// floors as shopfronts).

const BOARD_H = 0.62; // fascia board height (m)
const MIN_BOARD_H = 0.42; // shrunk to fit a short wall down to this
const BOARD_D = 0.09;
const PLACARD_H = 0.36;
const MAX_SNAP_IN = 12; // a shop point may lie this far inside its building (OSM points sit anywhere in the premises)
const MAX_SNAP_OUT = 7; // or this far out on the sidewalk
const GAP = 0.6; // free wall between two signs
const END_MARGIN = 0.35; // and at the ends of a wall

// --- the atlas: every label of every trade, shelf-packed ----------------------------------------------------------
const ROW_PX = 56;
const ATLAS_W = 2048;
const PAD = 3; // bleed between entries (filled with the board colour, so mipmaps don't mix in a neighbour)

function fontFor(kind, px) {
  return kind.serif ? `700 ${px}px Georgia, "Times New Roman", serif` : `800 ${px}px "Helvetica Neue", Arial, sans-serif`;
}

function buildAtlas() {
  const measure = document.createElement('canvas').getContext('2d');
  const entries = [];
  for (const [k, kind] of SHOP_KINDS.entries()) {
    kind.labels.forEach((label, v) => {
      const px = Math.round(ROW_PX * (kind.small ? 0.5 : 0.56));
      measure.font = fontFor(kind, px);
      const tw = measure.measureText(label).width + label.length * px * 0.08; // letter-spaced
      const w = Math.ceil(tw + ROW_PX * (kind.small ? 0.7 : 1.1));
      entries.push({ k, v, label, px, w, aspect: w / ROW_PX });
    });
  }
  // shelf packing, widest first
  const order = [...entries].sort((a, b) => b.w - a.w);
  let x = 0, y = 0;
  for (const e of order) {
    if (x + e.w + PAD * 2 > ATLAS_W) {
      x = 0;
      y += ROW_PX + PAD * 2;
    }
    e.x = x + PAD;
    e.y = y + PAD;
    x += e.w + PAD * 2;
  }
  const H = 2 ** Math.ceil(Math.log2(y + ROW_PX + PAD * 2));
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  for (const e of entries) {
    const kind = SHOP_KINDS[e.k];
    ctx.fillStyle = kind.bg;
    ctx.fillRect(e.x - PAD, e.y - PAD, e.w + PAD * 2, ROW_PX + PAD * 2);
    if (kind.edge) {
      ctx.strokeStyle = kind.edge;
      ctx.lineWidth = kind.small ? 3 : 2.5;
      const m = kind.small ? 4 : 5;
      ctx.strokeRect(e.x + m, e.y + m, e.w - m * 2, ROW_PX - m * 2);
    }
    ctx.fillStyle = kind.fg;
    ctx.font = fontFor(kind, e.px);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(e.px * 0.08)}px`;
    ctx.fillText(e.label, e.x + e.w / 2 + (('letterSpacing' in ctx) ? e.px * 0.04 : 0), e.y + ROW_PX * 0.53);
    // the atlas rect in uv space (canvas textures are flipped: v up from the bottom)
    e.rect = [e.x / ATLAS_W, 1 - (e.y + ROW_PX) / H, e.w / ATLAS_W, ROW_PX / H];
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const byKind = SHOP_KINDS.map(() => []);
  for (const e of entries) byKind[e.k][e.v] = e;
  return { tex, byKind };
}

// --- geometry: a unit board, its front (+z) carrying the atlas rect, every other side the board's edge colour ------
function boardGeometry() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const uvs = g.attributes.uv;
  for (let i = 0; i < uvs.count; i++) {
    if (i >= 16 && i < 20) continue; // +z face
    uvs.setXY(i, 0.004, 0.5);
  }
  return g;
}

// the green cross: two bars, its faces along ±z (up & down the street), and its bracket back to the wall at +x
function crossGeometry() {
  const parts = [
    new THREE.BoxGeometry(0.24, 0.72, 0.13),
    new THREE.BoxGeometry(0.72, 0.24, 0.13)
  ];
  const cross = parts.map((p) => p.toNonIndexed());
  const arm = new THREE.BoxGeometry(0.42, 0.05, 0.05).toNonIndexed();
  arm.translate(0.46, 0, 0);
  const all = [...cross, arm];
  // merge by hand (positions & normals only; the material is plain)
  const pos = [], nor = [], tag = [];
  all.forEach((g, gi) => {
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
    for (let i = 0; i < g.attributes.position.count; i++) tag.push(gi < 2 ? 1 : 0);
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('crossLit', new THREE.Float32BufferAttribute(tag, 1));
  return out;
}

function decodeShops() {
  const bin = atob(SHOP_DATA);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const shops = [];
  for (let i = 0; i < SHOP_COUNT; i++) {
    const o = i * 6;
    shops.push({ x: view.getInt16(o, true) / 4, z: view.getInt16(o + 2, true) / 4, k: bytes[o + 4], h: bytes[o + 5] });
  }
  return shops;
}

function planShopSigns(walls, boxes = []) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'ShopSigns';
  if (!walls.length) return { group, used: new Set(), count: 0 };
  const { tex, byKind } = buildAtlas();

  // wall grid (20 m cells), each wall in every cell its bounds (+ the snap reach) touch
  const CELL = 20;
  const grid = new Map();
  const key = (i, j) => i * 100003 + j;
  for (const w of walls) {
    w.len = Math.hypot(w.bx - w.ax, w.bz - w.az);
    w.tx = (w.bx - w.ax) / w.len;
    w.tz = (w.bz - w.az) / w.len;
    w.taken = [];
    const r = MAX_SNAP_IN;
    for (let i = Math.floor((Math.min(w.ax, w.bx) - r) / CELL); i <= Math.floor((Math.max(w.ax, w.bx) + r) / CELL); i++) {
      for (let j = Math.floor((Math.min(w.az, w.bz) - r) / CELL); j <= Math.floor((Math.max(w.az, w.bz) + r) / CELL); j++) {
        const kk = key(i, j);
        if (!grid.has(kk)) grid.set(kk, []);
        grid.get(kk).push(w);
      }
    }
  }

  // the boxes by grid cell, to keep signs out of other buildings
  const boxGrid = new Map();
  for (const b of boxes) {
    const r = Math.hypot(b.hx, b.hz);
    for (let i = Math.floor((b.cx - r) / CELL); i <= Math.floor((b.cx + r) / CELL); i++) {
      for (let j = Math.floor((b.cz - r) / CELL); j <= Math.floor((b.cz + r) / CELL); j++) {
        const kk = key(i, j);
        if (!boxGrid.has(kk)) boxGrid.set(kk, []);
        boxGrid.get(kk).push(b);
      }
    }
  }
  const inBox = (x, z, own) => (boxGrid.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) || []).some((b) => {
    if (b.item === own) return false;
    const dx = x - b.cx, dz = z - b.cz;
    return Math.abs(dx * b.cs - dz * b.sn) < b.hx && Math.abs(dx * b.sn + dz * b.cs) < b.hz;
  });
  // is the sidewalk in front of wall w clear of other buildings from t0 to t1 (out to `out` m)?
  const clearInFront = (w, t0, t1, out) => {
    for (let t = t0; t <= t1 + 1e-6; t += Math.max(0.25, (t1 - t0) / 6)) {
      for (const o of [0.12, out]) {
        if (inBox(w.ax + w.tx * t + w.nx * o, w.az + w.tz * t + w.nz * o, w.item)) return false;
      }
    }
    return true;
  };

  // free spot of width `width` on wall w nearest to t (or null)
  function freeSpot(w, t, width) {
    const lo = END_MARGIN + width / 2, hi = w.len - END_MARGIN - width / 2;
    if (hi < lo) return null;
    const clear = (c) => w.taken.every(([a, b]) => c + width / 2 + GAP <= a || c - width / 2 - GAP >= b)
      && clearInFront(w, c - width / 2, c + width / 2, 0.8);
    t = Math.min(hi, Math.max(lo, t));
    for (let s = 0; s <= 8; s += 0.25) {
      if (t + s <= hi && clear(t + s)) return t + s;
      if (t - s >= lo && clear(t - s)) return t - s;
    }
    return null;
  }

  const shops = decodeShops();
  // pharmacies & food first: they get the best spots when shops crowd a short front
  const priority = (s) => (SHOP_KINDS[s.k].key === 'farmacia' ? 0 : SHOP_KINDS[s.k].small ? 2 : 1);
  shops.sort((a, b) => priority(a) - priority(b));

  const boards = []; // { x, y, z, ry, w, h, d, rect, lit }
  const crosses = []; // { x, y, z, ry }
  const used = new Set();
  for (const s of shops) {
    const kind = SHOP_KINDS[s.k];
    const cands = [];
    for (const w of grid.get(key(Math.floor(s.x / CELL), Math.floor(s.z / CELL))) || []) {
      const dx = s.x - w.ax, dz = s.z - w.az;
      const t = dx * w.tx + dz * w.tz;
      const n = dx * w.nx + dz * w.nz; // > 0: out on the street side
      if (n > MAX_SNAP_OUT || n < -MAX_SNAP_IN) continue;
      const along = t < 0 ? -t : t > w.len ? t - w.len : 0;
      if (along > 4) continue;
      cands.push({ w, t, score: Math.abs(n) + along * 2 + (w.shop ? 0 : 1.5) });
    }
    cands.sort((a, b) => a.score - b.score);
    let placed = false;
    for (const { w, t } of cands.slice(0, 3)) {
      // the shop's own wording first, then shorter ones if the front is narrow; a board shrinks to fit too
      const labels = kind.labels.map((_, i) => byKind[s.k][(s.h + i) % kind.labels.length]);
      for (const e of [labels[0], ...labels.slice(1).sort((a, b) => a.aspect - b.aspect)]) {
        const fullH = kind.small ? PLACARD_H : BOARD_H;
        let h = fullH;
        let width = e.aspect * h;
        const room = w.len - 2 * END_MARGIN;
        if (width > room) {
          h = room / e.aspect;
          if (h < (kind.small ? PLACARD_H : MIN_BOARD_H)) continue;
          width = room;
        }
        const c = freeSpot(w, t, width + (kind.key === 'farmacia' ? 1.0 : 0));
        if (c === null) continue;
        w.taken.push([c - width / 2 - (kind.key === 'farmacia' ? 1.0 : 0) / 2, c + width / 2 + (kind.key === 'farmacia' ? 1.0 : 0) / 2]);
        const cx = w.ax + w.tx * c, cz = w.az + w.tz * c;
        const ry = Math.atan2(w.nx, w.nz);
        if (kind.small) {
          // a placard taped inside the shop window
          boards.push({ x: cx - w.nx * 0.02, y: 1.55, z: cz - w.nz * 0.02, ry, w: width, h, d: 0.01, rect: e.rect, lit: 0 });
        } else {
          const y = Math.max(2.7, w.storey) - 0.12 - h / 2;
          boards.push({ x: cx + w.nx * (BOARD_D / 2 + 0.02), y, z: cz + w.nz * (BOARD_D / 2 + 0.02), ry, w: width, h, d: BOARD_D, rect: e.rect, lit: kind.lit });
          if (kind.key === 'farmacia') {
            // the cross on its bracket just past the board's end, faces up & down the street
            const off = width / 2 + 0.5;
            crosses.push({ x: cx + w.tx * off + w.nx * 0.66, y: y + 0.45, z: cz + w.tz * off + w.nz * 0.66, nx: w.nx, nz: w.nz });
          }
        }
        used.add(w.id);
        placed = true;
        break;
      }
      if (placed) break;
    }
  }

  // --- boards: one instanced mesh (scene-culling.js cuts it into culled chunks), the atlas rect & glow per instance
  const geo = boardGeometry();
  const n = boards.length;
  const rectAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  const litAttr = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  geo.setAttribute('signRect', rectAttr);
  geo.setAttribute('signLit', litAttr);
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.0 });
  const rect = attribute('signRect', 'vec4');
  const signColor = texture(tex, rect.xy.add(uv().mul(rect.zw)));
  mat.colorNode = signColor;
  // backlit after dusk (as the street lamps come on)
  const glow = smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow).mul(attribute('signLit', 'float'));
  mat.emissiveNode = signColor.rgb.mul(glow.mul(0.85));
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
  mesh.name = 'ShopSignBoards';
  mesh.receiveShadow = true;
  const dummy = new THREE.Object3D();
  boards.forEach((b, i) => {
    dummy.position.set(b.x, b.y, b.z);
    dummy.rotation.set(0, b.ry, 0);
    dummy.scale.set(b.w, b.h, b.d);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    rectAttr.setXYZW(i, ...b.rect);
    litAttr.setX(i, b.lit);
  });
  mesh.count = n;
  mesh.computeBoundingSphere();
  group.add(mesh);

  // --- pharmacy crosses: green LED crosses, lit day and night
  const cgeo = crossGeometry();
  const cmat = new THREE.MeshStandardNodeMaterial({ roughness: 0.4, metalness: 0.2 });
  const lit = attribute('crossLit', 'float');
  cmat.colorNode = mix(color(0x2d2f31), color(0x0b9a48), lit);
  cmat.emissiveNode = color(0x19d66a).mul(lit.mul(float(0.55).add(smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow).mul(1.1))));
  const cmesh = new THREE.InstancedMesh(cgeo, cmat, Math.max(1, crosses.length));
  cmesh.name = 'PharmacyCrosses';
  cmesh.castShadow = true;
  crosses.forEach((c, i) => {
    // the bracket (+x) points back at the wall
    dummy.position.set(c.x, c.y, c.z);
    dummy.rotation.set(0, Math.atan2(c.nz, -c.nx), 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    cmesh.setMatrixAt(i, dummy.matrix);
  });
  cmesh.count = crosses.length;
  cmesh.computeBoundingSphere();
  if (crosses.length) group.add(cmesh);

  console.log(`[shops] ${n} signs (${crosses.length} pharmacy crosses) from ${shops.length} OpenStreetMap shops in ${(performance.now() - t0).toFixed(0)} ms`);
  return { group, used, count: n };
}

export { planShopSigns };
