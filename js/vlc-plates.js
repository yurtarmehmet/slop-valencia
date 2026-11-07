import * as THREE from 'three/webgpu';
import { attribute, color, float, min, mix, normalLocal, step, texture, uv } from 'three/tsl';
import { REAL_BUILDINGS } from './vlc-buildings.js';
import { loadPlates } from './vlc-plates-data.js';

// Street-name plates at the corners and door numbers over the doors (gap #12; data: js/vlc-plates-data.js,
// tools/build-plates.py). Drawn as we see them in Street View and the reference photos:
// - street plates: the city's standard dark-blue enamel plate with a white rule inset from its edge and white capitals
//   on three lines, type / particle / name ("CARRER / DE / LA BOATELLA"); without the city's coat of arms
// - door numbers: a small dark-blue enamel plate with white numerals, or a white tile with blue numerals (commoner on
//   old houses), centred above the door
// The plates themselves (instanced boxes, procedural face) are culled by scene-culling.js like any small prop (group
// 'StreetPlates' is one of main.js's culling roots). Their lettering is glyph quads from one canvas atlas, built per
// 48 m chunk only near the camera (update(), every frame): street plates within TEXT_FAR, door numbers within
// DOOR_TEXT_FAR, so far plates cost nothing but their box.

const FONT_PX = 44;
const ROW = Math.ceil(FONT_PX * 1.34);
const BASE = Math.round(FONT_PX * 1.02); // baseline below the cell's top
const PAD = 5;
const ATLAS = 512;
const FONT = `700 ${FONT_PX}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
const CAP = 0.716; // cap height / em (Arial)

const CELL = 48;
const TEXT_FAR = 75;
const DOOR_TEXT_FAR = 35;
const DROP_FAR = 170; // glyph meshes of chunks further than this are freed
const BUILDS_PER_FRAME = 3;

const PLATE_D = 0.012;
const DOOR_D = 0.01;
const DOOR_H = 0.15;

// sRGB colours, sampled from the Street View captures & reference photos (style index = attribute value)
const STYLE_BG = [0x22336f, 0x1c2754, 0xefece4];
const STYLE_FG = [0xf3f2ec, 0xf3f2ec, 0x26449a];

function buildAtlas(chars) {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS;
  canvas.height = ATLAS;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, ATLAS, ATLAS);
  ctx.font = FONT;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  const glyphs = new Map();
  let x = 0, y = 0;
  for (const ch of chars) {
    const adv = Math.max(4, ctx.measureText(ch).width);
    const w = Math.ceil(adv) + PAD * 2;
    if (x + w > ATLAS) {
      x = 0;
      y += ROW + PAD * 2;
    }
    if (y + ROW + PAD * 2 > ATLAS) break; // (never at these sizes: ~70 glyphs)
    ctx.fillText(ch, x + PAD, y + PAD + BASE);
    // uv rect of the advance box (canvas textures: v up from the bottom)
    glyphs.set(ch, { adv: adv / FONT_PX, rect: [(x + PAD) / ATLAS, 1 - (y + PAD + ROW) / ATLAS, adv / ATLAS, ROW / ATLAS] });
    x += w;
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace; // coverage, not colour
  tex.anisotropy = 4;
  return { tex, glyphs };
}

// --- layout: runs of text on lines, in metres; returns { w, h, glyphs: [{ x, y (quad centre), w, h, rect }] } ---------
function measure(glyphs, text, cap, squeeze) {
  const em = cap / CAP;
  let w = 0;
  for (const ch of text) w += (glyphs.get(ch)?.adv ?? 0.3) * em * squeeze;
  return w;
}

function layoutLines(glyphs, lines, width, height, squeeze, top) {
  // lines: [{ runs: [{ text, cap }], pitch }], centred, from `top` (local y of the first line box's top) down
  const out = [];
  let yTop = top;
  for (const line of lines) {
    const caps = line.runs.map((r) => r.cap);
    const capMax = Math.max(...caps);
    const baseline = yTop - (line.pitch + capMax) / 2;
    const gap = capMax * 0.35;
    const total = line.runs.reduce((t, r) => t + measure(glyphs, r.text, r.cap, squeeze), 0) + gap * (line.runs.length - 1);
    let x = -total / 2;
    for (const r of line.runs) {
      const em = r.cap / CAP;
      const qh = (em * ROW) / FONT_PX;
      const below = (em * (ROW - BASE)) / FONT_PX;
      for (const ch of r.text) {
        const g = glyphs.get(ch);
        const qw = (g?.adv ?? 0.3) * em * squeeze;
        if (g && ch !== ' ') out.push({ x: x + qw / 2, y: baseline - below + qh / 2, w: qw, h: qh, rect: g.rect });
        x += qw;
      }
      x += gap;
    }
    yTop -= line.pitch;
  }
  return out;
}

function splitName(name) {
  const words = name.split(' ');
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const d = Math.max(a.length, b.length);
    if (!best || d < best.d) best = { d, lines: [a, b] };
  }
  return best ? best.lines : [name];
}

// a street plate: [type, particle, name, subtitle] -> { w, h, glyphs }
function layoutPlate(glyphs, [type, particle, name, sub], room) {
  const SMALL = 0.036, BIG = 0.07, SIDE = 0.05, MARGIN = 0.035;
  const maxW = Math.max(0.45, Math.min(room - 0.05, 1.05));
  const build = (nameLines, big) => {
    const lines = [{ runs: [{ text: type, cap: SMALL }], pitch: SMALL * 1.9 }];
    if (particle) lines.push({ runs: [{ text: particle, cap: SMALL }], pitch: SMALL * 1.9 });
    for (const t of nameLines) lines.push({ runs: [{ text: t, cap: big }], pitch: big * 1.55 });
    if (sub) lines.push({ runs: [{ text: sub, cap: SMALL * 0.85 }], pitch: SMALL * 1.8 });
    const textW = Math.max(...lines.map((l) => l.runs.reduce((t, r) => t + measure(glyphs, r.text, r.cap, 1), 0)));
    return { lines, textW, h: lines.reduce((t, l) => t + l.pitch, 0) + MARGIN * 2 };
  };
  let L = build([name], BIG);
  if (L.textW + SIDE * 2 > maxW && name.includes(' ')) L = build(splitName(name), BIG * 0.85);
  const w = Math.min(maxW, Math.max(0.55, L.textW + SIDE * 2));
  const squeeze = Math.min(1, (w - SIDE * 2) / L.textW);
  return { w, h: L.h, glyphs: layoutLines(glyphs, L.lines, w, L.h, squeeze, L.h / 2 - MARGIN) };
}

function layoutDoor(glyphs, text, suffix) {
  const runs = [{ text, cap: 0.072 }];
  if (suffix) runs.push({ text: suffix, cap: 0.045 });
  const tw = runs.reduce((t, r) => t + measure(glyphs, r.text, r.cap, 1), 0) + (suffix ? 0.072 * 0.35 : 0);
  const w = Math.max(0.13, tw + 0.05);
  return { w, h: DOOR_H, glyphs: layoutLines(glyphs, [{ runs, pitch: DOOR_H }], w, DOOR_H, 1, DOOR_H / 2) };
}

// colours of a style attribute (0 street plate, 1 navy door number, 2 white tile door number)
function styleColors(style) {
  const is2 = step(1.5, style);
  const is1 = step(0.5, style).sub(is2);
  const is0 = float(1).sub(is1).sub(is2);
  const pick = (list) => color(list[0]).mul(is0).add(color(list[1]).mul(is1)).add(color(list[2]).mul(is2));
  return { bg: pick(STYLE_BG), fg: pick(STYLE_FG) };
}

function plateMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.32, metalness: 0.0 });
  const dims = attribute('plateDims', 'vec4'); // w, h, rule inset, rule width (m)
  const { bg, fg } = styleColors(attribute('plateStyle', 'float'));
  const u = uv();
  const px = u.x.mul(dims.x), py = u.y.mul(dims.y);
  const e = min(min(px, dims.x.sub(px)), min(py, dims.y.sub(py)));
  const rule = step(dims.z, e).mul(float(1).sub(step(dims.z.add(dims.w), e)));
  const front = step(0.5, normalLocal.z);
  mat.colorNode = mix(bg.mul(mix(float(0.75), float(1), front)), fg, rule.mul(front));
  return mat;
}

function glyphMaterial(tex) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.32, metalness: 0.0 });
  const rect = attribute('glyphRect', 'vec4');
  const { bg, fg } = styleColors(attribute('glyphStyle', 'float'));
  const cov = texture(tex, rect.xy.add(uv().mul(rect.zw))).r;
  mat.colorNode = mix(bg, fg, cov);
  return mat;
}

/** Builds the plates; returns { group, update(cameraPosition), count } (resolves to an empty group without data). */
async function buildStreetPlates(scene) {
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'StreetPlates';
  const textGroup = new THREE.Group();
  textGroup.name = 'StreetPlateText';
  scene.add(group, textGroup);
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('noplates')) {
    return { group, update() {}, count: 0 }; // for fps comparisons
  }
  let data;
  try {
    data = await loadPlates(REAL_BUILDINGS);
  } catch (err) {
    console.warn('[plates] no plate data', err);
    return { group, update() {}, count: 0 };
  }
  if (data.stale) {
    console.warn('[plates] js/vlc-buildings.bin.gz changed since the plates were built: run tools/build-plates.py');
    return { group, update() {}, count: 0 };
  }
  const chars = new Set('0123456789 ');
  for (const n of data.head.names) for (const s of n) for (const ch of s) chars.add(ch);
  for (const s of data.head.suffixes) for (const ch of s) chars.add(ch);
  const { tex, glyphs } = buildAtlas([...chars]);

  // every plate's place & layout (the glyphs are laid out again when its chunk is built)
  const items = []; // { kind: 0 plate / 1 door, cx, cy, cz, ry, nx, nz, rx, rz, w, h, d, style, layout() }
  for (const p of data.plates) {
    const L = layoutPlate(glyphs, p.name, p.room);
    const off = PLATE_D / 2 + 0.004;
    items.push({
      kind: 0, cx: p.x + p.sx * (L.w / 2) + p.nx * off, cy: p.y, cz: p.z + p.sz * (L.w / 2) + p.nz * off,
      nx: p.nx, nz: p.nz, w: L.w, h: L.h, d: PLATE_D, style: 0, inset: 0.013, rule: 0.007,
      layout: () => layoutPlate(glyphs, p.name, p.room).glyphs
    });
  }
  for (const q of data.doors) {
    const L = layoutDoor(glyphs, q.text, q.suffix);
    const off = DOOR_D / 2 + 0.004;
    items.push({
      kind: 1, cx: q.x + q.nx * off, cy: q.y, cz: q.z + q.nz * off, nx: q.nx, nz: q.nz, w: L.w, h: L.h, d: DOOR_D,
      style: q.style ? 2 : 1, inset: q.style ? 0 : 0.006, rule: q.style ? 0 : 0.004,
      layout: () => layoutDoor(glyphs, q.text, q.suffix).glyphs
    });
  }

  // --- the plates: one instanced mesh per kind (scene-culling.js chunks them) ------------------------------------------
  const dummy = new THREE.Object3D();
  const plateMat = plateMaterial();
  for (const kind of [0, 1]) {
    const list = items.filter((it) => it.kind === kind);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const dims = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
    const style = new THREE.InstancedBufferAttribute(new Float32Array(list.length), 1);
    geo.setAttribute('plateDims', dims);
    geo.setAttribute('plateStyle', style);
    const mesh = new THREE.InstancedMesh(geo, plateMat, Math.max(1, list.length));
    mesh.name = kind ? 'DoorNumberPlates' : 'StreetNamePlates';
    mesh.receiveShadow = true;
    list.forEach((it, i) => {
      dummy.position.set(it.cx, it.cy, it.cz);
      dummy.rotation.set(0, Math.atan2(it.nx, it.nz), 0);
      dummy.scale.set(it.w, it.h, it.d);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      dims.setXYZW(i, it.w, it.h, it.inset, it.rule);
      style.setX(i, it.style);
    });
    mesh.count = list.length;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }

  // --- the lettering: glyph quads per chunk, near the camera only ---------------------------------------------------
  const glyphMat = glyphMaterial(tex);
  const quad = new THREE.PlaneGeometry(1, 1);
  const chunks = new Map();
  for (const it of items) {
    const key = `${Math.floor(it.cx / CELL)},${Math.floor(it.cz / CELL)},${it.kind}`;
    let c = chunks.get(key);
    if (!c) {
      chunks.set(key, (c = {
        kind: it.kind, x: (Math.floor(it.cx / CELL) + 0.5) * CELL, z: (Math.floor(it.cz / CELL) + 0.5) * CELL, items: [], mesh: null
      }));
    }
    c.items.push(it);
  }
  const chunkList = [...chunks.values()];
  let warm = null;
  const _q = new THREE.Quaternion();
  const _up = new THREE.Vector3(0, 1, 0);
  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  function glyphMesh(list) {
    const quads = [];
    for (const it of list) {
      const rx = it.nz, rz = -it.nx; // the plate's right (its local +x) seen from the street
      const fwd = it.d / 2 + 0.003;
      for (const g of it.layout()) {
        quads.push(it.cx + rx * g.x + it.nx * fwd, it.cy + g.y, it.cz + rz * g.x + it.nz * fwd,
          Math.atan2(it.nx, it.nz), g.w, g.h, it.style, ...g.rect);
      }
    }
    const n = quads.length / 11;
    const geo = quad.clone(); // its own buffers, so a dropped chunk can free them
    const rect = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    const style = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    geo.setAttribute('glyphRect', rect);
    geo.setAttribute('glyphStyle', style);
    const mesh = new THREE.InstancedMesh(geo, glyphMat, Math.max(1, n));
    mesh.name = 'PlateLettering';
    mesh.receiveShadow = true;
    for (let i = 0; i < n; i++) {
      const o = i * 11;
      _q.setFromAxisAngle(_up, quads[o + 3]);
      _m.compose(_p.set(quads[o], quads[o + 1], quads[o + 2]), _q, _s.set(quads[o + 4], quads[o + 5], 1));
      mesh.setMatrixAt(i, _m);
      style.setX(i, quads[o + 6]);
      rect.setXYZW(i, quads[o + 7], quads[o + 8], quads[o + 9], quads[o + 10]);
    }
    mesh.count = n;
    mesh.computeBoundingSphere();
    if (warm) mesh.userData.sharesPipelineWith = warm;
    return mesh;
  }
  // one always-present lettering mesh (under the ground), so the pipeline compiles behind the loading screen
  warm = glyphMesh([{ cx: 0, cy: -60, cz: 0, nx: 0, nz: 1, d: 0.01, style: 1, layout: () => layoutDoor(glyphs, '1', '').glyphs }]);
  textGroup.add(warm);

  function update(cam) {
    let budget = BUILDS_PER_FRAME;
    for (const c of chunkList) {
      const d = Math.hypot(c.x - cam.x, c.z - cam.z) - CELL * 0.71;
      const far = c.kind ? DOOR_TEXT_FAR : TEXT_FAR;
      const want = d < far && cam.y < 120;
      if (want && !c.mesh && budget > 0) {
        budget--;
        c.mesh = glyphMesh(c.items);
        textGroup.add(c.mesh);
        c.mesh.updateMatrixWorld(true);
      }
      if (c.mesh) {
        c.mesh.visible = want;
        if (d > DROP_FAR) {
          textGroup.remove(c.mesh);
          c.mesh.geometry.dispose();
          c.mesh = null;
        }
      }
    }
  }
  textGroup.updateMatrixWorld(true);
  console.log(`[plates] ${data.plates.length} street-name plates & ${data.doors.length} door numbers, ${chars.size} glyphs, in ${(performance.now() - t0).toFixed(0)} ms`);
  return { group, update, count: items.length };
}

export { buildStreetPlates, layoutPlate, layoutDoor };
