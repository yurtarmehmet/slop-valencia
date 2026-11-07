import * as THREE from 'three/webgpu';
import { vec2, float, dot, min, smoothstep, texture, uniform } from 'three/tsl';
import { lonLatToWorld } from './city-config.js';
import { GROUND_PHOTO } from './vlc-ground.js';

// The PNOA orthophoto of the metropolitan area (vlc-ground.jpg; PNOA cedido por © IGN, CC BY 4.0 scne.es), shared by
// the land beyond the detailed city (boroughs.js) and the ground inside the city's blocks (city-grid.js).
// World (x, z) -> image (u, v): an affine map through three of its corners (u east, v south from the north-west one).
const G = GROUND_PHOTO;
const p0 = lonLatToWorld(G.lonW, G.latN), p1 = lonLatToWorld(G.lonE, G.latN), p2 = lonLatToWorld(G.lonW, G.latS);
const ax = p1.x - p0.x, az = p1.z - p0.z, bx = p2.x - p0.x, bz = p2.z - p0.z;
const det = ax * bz - az * bx;
const tex = new THREE.TextureLoader().load(new URL('./vlc-ground.jpg', import.meta.url).href);
tex.colorSpace = THREE.SRGBColorSpace;
tex.flipY = false;
tex.anisotropy = 4;
const origin = uniform(new THREE.Vector2(p0.x, p0.z));
const rowU = uniform(new THREE.Vector2(bz / det, -bx / det));
const rowV = uniform(new THREE.Vector2(-az / det, ax / det));

/** { color, inside } of the orthophoto at world xz (a vec2 node); inside fades to 0 over the image's outer 3% */
function groundPhotoAt(xz) {
  const d = xz.sub(origin);
  const uv = vec2(dot(rowU, d), dot(rowV, d));
  const edge = min(min(uv.x, float(1.0).sub(uv.x)), min(uv.y, float(1.0).sub(uv.y)));
  // (a photo is sunlit radiance, not albedo: scaled down & given a touch of contrast, it sits under the engine's own sun
  // like real ground, ~0.2-0.35 albedo, instead of glowing)
  const c = texture(tex, uv.clamp(0.0, 1.0)).rgb;
  return { color: c.mul(c).mul(0.35).add(c.mul(0.3)), inside: smoothstep(0.0, 0.03, edge) };
}

export { groundPhotoAt };
