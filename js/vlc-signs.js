import * as THREE from 'three/webgpu';
import { attribute, texture, uv, vec2, vec3, mix, float } from 'three/tsl';

// Spanish traffic signs, drawn by us after the Reglamento General de Circulación catalogue (Anexo I), for the plates
// of js/vlc-furniture.js: one 512 x 512 canvas atlas of 128 px cells, one instanced plate (front face from the atlas,
// galvanised back) and one instanced pole. Sizes are the urban ones: discs and squares 60 cm, triangles 70 cm a side;
// the plate's lower edge 2.2 m over the sidewalk (clear of pedestrians), on a 76 mm galvanised steel post.

// Cell order = tools/build-furniture.py SIGNS, then the EMT stop plate
export const SIGN_TYPES = ['R-1', 'R-2', 'R-101', 'R-308', 'S-13', 'S-11', 'EMT'];
export const SIGN_EMT = 6;
// Plate size (m) per type (the cell is square; the drawing fills it edge to edge)
export const SIGN_SIZE = [0.7, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6];
export const SIGN_CLEAR = 2.2; // lower edge over the ground
const CELLS = 4;
const PX = 128;

const RED = '#c8102e';
const BLUE = '#1f57a8';
const WHITE = '#f6f6f2';
const BLACK = '#1b1b1b';

function drawSign(ctx, type) {
  const s = PX;
  const c = s / 2;
  ctx.save();
  ctx.lineJoin = 'round';
  const disc = (r, fill) => { ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); };
  const roundRect = (x, y, w, h, r, fill) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = fill;
    ctx.fill();
  };
  switch (type) {
    case 'R-1': { // Ceda el paso: inverted triangle, red border, white field
      const tri = (inset, fill) => {
        const h = (s - 2 * inset) * Math.sqrt(3) / 2;
        const top = (s - h) / 2;
        ctx.beginPath();
        ctx.moveTo(inset, top);
        ctx.lineTo(s - inset, top);
        ctx.lineTo(c, top + h);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
      };
      tri(2, WHITE);
      tri(6, RED);
      tri(24, WHITE);
      break;
    }
    case 'R-2': { // STOP: red octagon, white rim and letters
      const oct = (r, fill) => {
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = Math.PI / 8 + (i * Math.PI) / 4;
          ctx.lineTo(c + r * Math.cos(a), c + r * Math.sin(a));
        }
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
      };
      oct(c - 1, WHITE);
      oct(c - 6, RED);
      ctx.fillStyle = WHITE;
      ctx.font = `bold ${Math.round(s * 0.3)}px Arial, Helvetica, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('STOP', c, c + 2, s * 0.78);
      break;
    }
    case 'R-101': // Entrada prohibida: red disc, white bar
      disc(c - 1, WHITE);
      disc(c - 4, RED);
      roundRect(s * 0.18, c - s * 0.09, s * 0.64, s * 0.18, 2, WHITE);
      break;
    case 'R-308': { // Estacionamiento prohibido: blue disc in a red ring, one red diagonal
      disc(c - 1, WHITE);
      disc(c - 3, RED);
      disc(c - 15, BLUE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(c, c, c - 14, 0, Math.PI * 2);
      ctx.clip();
      ctx.translate(c, c);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = RED;
      ctx.fillRect(-s * 0.5, -s * 0.07, s, s * 0.14);
      ctx.restore();
      break;
    }
    case 'S-13': { // Paso para peatones: blue square, white triangle, black pedestrian on a zebra
      roundRect(1, 1, s - 2, s - 2, 8, WHITE);
      roundRect(4, 4, s - 8, s - 8, 6, BLUE);
      ctx.beginPath();
      ctx.moveTo(c, s * 0.13);
      ctx.lineTo(s * 0.88, s * 0.84);
      ctx.lineTo(s * 0.12, s * 0.84);
      ctx.closePath();
      ctx.fillStyle = WHITE;
      ctx.fill();
      ctx.fillStyle = BLACK;
      for (let i = 0; i < 4; i++) ctx.fillRect(s * (0.3 + i * 0.11), s * 0.74, s * 0.07, s * 0.06); // zebra
      ctx.beginPath();
      ctx.arc(c + 2, s * 0.36, s * 0.045, 0, Math.PI * 2); // head
      ctx.fill();
      ctx.lineWidth = s * 0.05;
      ctx.lineCap = 'round';
      ctx.strokeStyle = BLACK;
      ctx.beginPath();
      ctx.moveTo(c + 1, s * 0.43); ctx.lineTo(c - 2, s * 0.58); // body
      ctx.moveTo(c - 2, s * 0.58); ctx.lineTo(c - 10, s * 0.71); // back leg
      ctx.moveTo(c - 2, s * 0.58); ctx.lineTo(c + 8, s * 0.70); // front leg
      ctx.moveTo(c + 1, s * 0.46); ctx.lineTo(c - 9, s * 0.54); // arm
      ctx.moveTo(c + 1, s * 0.46); ctx.lineTo(c + 10, s * 0.53); // arm
      ctx.stroke();
      break;
    }
    case 'S-11': { // Calzada de sentido único: tall blue rectangle, white arrow up
      const w = s * 0.62;
      const x0 = (s - w) / 2;
      roundRect(x0, 1, w, s - 2, 6, WHITE);
      roundRect(x0 + 3, 4, w - 6, s - 8, 5, BLUE);
      ctx.fillStyle = WHITE;
      ctx.beginPath();
      ctx.moveTo(c, s * 0.14);
      ctx.lineTo(c + w * 0.32, s * 0.42);
      ctx.lineTo(c + w * 0.1, s * 0.42);
      ctx.lineTo(c + w * 0.1, s * 0.86);
      ctx.lineTo(c - w * 0.1, s * 0.86);
      ctx.lineTo(c - w * 0.1, s * 0.42);
      ctx.lineTo(c - w * 0.32, s * 0.42);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'EMT': { // bus stop flag: red band with a white bus, white panel for the lines (no operator logo)
      roundRect(s * 0.14, 1, s * 0.72, s - 2, 4, WHITE);
      roundRect(s * 0.16, 3, s * 0.68, s * 0.5, 3, '#d22630');
      ctx.fillStyle = WHITE;
      roundRect(s * 0.28, s * 0.12, s * 0.44, s * 0.24, 4, WHITE); // bus body
      ctx.fillStyle = '#d22630';
      ctx.fillRect(s * 0.32, s * 0.16, s * 0.36, s * 0.08); // windows
      ctx.fillStyle = WHITE;
      ctx.beginPath(); ctx.arc(s * 0.36, s * 0.38, s * 0.035, 0, Math.PI * 2); ctx.arc(s * 0.64, s * 0.38, s * 0.035, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#333';
      for (let i = 0; i < 3; i++) ctx.fillRect(s * 0.24, s * (0.62 + i * 0.11), s * 0.52, s * 0.05); // line numbers
      break;
    }
  }
  ctx.restore();
}

let atlasTexture = null;
function signAtlas() {
  if (atlasTexture) return atlasTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = PX * CELLS;
  const ctx = canvas.getContext('2d');
  SIGN_TYPES.forEach((type, k) => {
    ctx.save();
    ctx.translate((k % CELLS) * PX, Math.floor(k / CELLS) * PX);
    drawSign(ctx, type);
    ctx.restore();
  });
  atlasTexture = new THREE.CanvasTexture(canvas);
  atlasTexture.colorSpace = THREE.SRGBColorSpace;
  atlasTexture.anisotropy = 4;
  return atlasTexture;
}

/** Texture bytes the atlas adds (RGBA8 with mipmaps) */
export const SIGN_ATLAS_BYTES = Math.round(PX * CELLS * PX * CELLS * 4 * 4 / 3);

/**
 * The plate: a unit square (1 x 1 m, centred, scaled per instance to the sign's size) with the face on +z and the
 * galvanised back on -z, a few millimetres apart. Per instance: `signCell` (float, the atlas cell).
 */
export function createSignPlateGeometry() {
  const front = new THREE.PlaneGeometry(1, 1).translate(0, 0, 0.006);
  const back = new THREE.PlaneGeometry(1, 1).rotateY(Math.PI).translate(0, 0, -0.006);
  // the back samples the same cell mirrored, so its outline matches the face's
  const bu = back.attributes.uv;
  for (let i = 0; i < bu.count; i++) bu.setX(i, 1 - bu.getX(i));
  const face = (g, v) => g.setAttribute('signFace', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count).fill(v), 1));
  face(front, 1);
  face(back, 0);
  const geo = new THREE.BufferGeometry();
  const merge = [front, back];
  const pos = [], nor = [], uvs = [], fc = [], idx = [];
  let base = 0;
  for (const g of merge) {
    pos.push(...g.attributes.position.array);
    nor.push(...g.attributes.normal.array);
    uvs.push(...g.attributes.uv.array);
    fc.push(...g.attributes.signFace.array);
    for (const i of g.index.array) idx.push(i + base);
    base += g.attributes.position.count;
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('signFace', new THREE.Float32BufferAttribute(fc, 1));
  geo.setIndex(idx);
  return geo;
}

export function createSignPlateMaterial() {
  const tex = signAtlas();
  const cell = attribute('signCell', 'float');
  const cx = cell.mod(CELLS);
  const cy = cell.div(CELLS).floor();
  // canvas textures are flipped: v runs up from the bottom of the canvas
  const atlasUv = vec2(cx.add(uv().x), float(CELLS - 1).sub(cy).add(uv().y)).div(CELLS);
  const t = texture(tex, atlasUv);
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.5, metalness: 0.15 });
  const face = attribute('signFace', 'float');
  mat.colorNode = mix(vec3(0.42, 0.44, 0.45), t.rgb, face);
  mat.opacityNode = t.a;
  mat.alphaTest = 0.5;
  mat.side = THREE.FrontSide;
  mat.name = 'TrafficSignPlate';
  return mat;
}

export function createSignPoleGeometry() {
  // 1 m tall, scaled per instance to the pole's height (base at y = 0)
  return new THREE.CylinderGeometry(0.038, 0.038, 1, 8, 1, false).translate(0, 0.5, 0);
}

export function createSignPoleMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x9da3a6, roughness: 0.42, metalness: 0.7 });
  mat.name = 'TrafficSignPole';
  return mat;
}
