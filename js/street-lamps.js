// València's street lamps (gap #9): our own models of the city's lamp families, placed by street-lamps-plan.js (mapped
// lamps first, then by rule along every street) and built as one instanced mesh per model & material (scene-culling.js
// chunks them).
//
// The models, drawn from the Street View pairs and the reference photos (not from any third-party model):
//   wallLantern  the Fernandine lantern of Ciutat Vella, the Ensanche's narrow streets and the old village cores: a
//                hexagonal lantern flaring to a crowned roof, upright on a scrolled iron wall bracket ~4.6 m up
//   column       the same lantern on a ~4.5 m cast-iron column (moulded plinth, ringed shaft, capital), dark iron grey
//   candelabra   the boulevards' ~5.5 m column with a scrolled cross-arm and three lanterns (Plaça de l'Ajuntament, the
//                Gran Vies, the Serrans & Quart squares)
//   modernWall   the newer barris' functional wall arm with a flat LED head ~6.4 m up
//   streetPole   an 8 m tapered grey steel pole, a short rising arm and a round disc luminaire
//   avenuePole   the avenues' 11 m twin-headed pole: a disc over the roadway and a smaller one over the sidewalk
import * as THREE from 'three/webgpu';
import { color, mix, smoothstep } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { REAL_BUILDINGS } from './vlc-buildings.js';
import { LAMPS } from './vlc-lamps.js';
import { cityUniforms } from './tsl-materials.js';
import { planStreetLamps, streetWallsFrom, LAMP_TYPES, T } from './street-lamps-plan.js';

const cyl = (rt, rb, h, seg, x, y, z) => new THREE.CylinderGeometry(rt, rb, h, seg).translate(x, y, z);
const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

// The Fernandine lantern, base at y = 0: cup, hexagonal glass and roof. Kept to the fewest parts that still read as the
// lantern (frame rate: ~29,000 lamps, the costliest street detail when they were modelled with rings & curls)
function lantern(s = 1) {
  const frame = [
    cyl(0.13, 0.07, 0.1, 6, 0, 0.03, 0),
    cyl(0.05, 0.245, 0.22, 6, 0, 0.59, 0)
  ];
  const glass = [cyl(0.2, 0.125, 0.4, 6, 0, 0.28, 0)];
  const sc = (g) => g.scale(s, s, s);
  return { frame: frame.map(sc), glass: glass.map(sc) };
}

const nonIndexed = (gs) => mergeGeometries(gs.map((g) => (g.index ? g.toNonIndexed() : g)));

// Each model: { body: BufferGeometry (iron / steel), glass: BufferGeometry (lit), lights: [[x, y, z], ...] (lamp
// centres in the model frame) }. +x is the reach toward the street; wall models have their origin on the wall at the
// bracket's height, standing models at the foot of the post. Low detail on purpose: the silhouette only.
function buildModels() {
  const models = [];
  // wallLantern: plate, arm and the lantern
  {
    const L = lantern(1);
    const body = [
      box(0.04, 0.46, 0.13, 0.02, -0.14, 0),
      box(0.74, 0.035, 0.04, 0.38, 0, 0),
      ...L.frame.map((g) => g.translate(0.7, 0.1, 0))
    ];
    models[T.WALL_LANTERN] = { body: nonIndexed(body), glass: nonIndexed(L.glass.map((g) => g.translate(0.7, 0.1, 0))), lights: [[0.7, 0.38, 0]] };
  }
  // column: plinth, tapered shaft, capital, lantern
  {
    const L = lantern(1.08);
    const top = 3.72;
    const body = [
      cyl(0.17, 0.21, 0.6, 6, 0, 0.3, 0),
      cyl(0.058, 0.11, 3.1, 6, 0, 2.15, 0),
      cyl(0.13, 0.06, 0.18, 6, 0, 3.6, 0),
      ...L.frame.map((g) => g.translate(0, top, 0))
    ];
    models[T.COLUMN] = { body: nonIndexed(body), glass: nonIndexed(L.glass.map((g) => g.translate(0, top, 0))), lights: [[0, top + 0.32, 0]] };
  }
  // candelabra: tall plinth, shaft, cross-arm with two lanterns and one on top
  {
    const body = [
      cyl(0.22, 0.29, 1.0, 6, 0, 0.5, 0),
      cyl(0.07, 0.14, 3.7, 6, 0, 2.85, 0),
      box(1.56, 0.045, 0.045, 0, 4.62, 0),
      cyl(0.04, 0.06, 0.45, 4, 0, 4.85, 0)
    ];
    const glass = [];
    const lights = [];
    for (const [x, y] of [[0.76, 4.72], [-0.76, 4.72], [0, 5.07]]) {
      const L = lantern(1.12);
      body.push(...L.frame.map((g) => g.translate(x, y, 0)));
      glass.push(...L.glass.map((g) => g.translate(x, y, 0)));
      lights.push([x, y + 0.34, 0]);
    }
    models[T.CANDELABRA] = { body: nonIndexed(body), glass: nonIndexed(glass), lights: [[0, 5.0, 0]] };
  }
  // modernWall: wall plate, rising arm, flat head with its lens underneath
  {
    const tilt = 0.17;
    const body = [
      box(0.05, 0.26, 0.16, 0.025, 0, 0),
      cyl(0.03, 0.03, 1.05, 4, 0, 0, 0).rotateZ(Math.PI / 2 - tilt).translate(0.55, 0.52 * Math.sin(tilt) + 0.02, 0),
      box(0.62, 0.1, 0.28, 0, 0, 0).rotateZ(tilt * 0.4).translate(1.28, 0.21, 0)
    ];
    const glass = [new THREE.PlaneGeometry(0.54, 0.22).rotateX(Math.PI / 2).rotateZ(tilt * 0.4).translate(1.28, 0.155, 0)];
    models[T.MODERN_WALL] = { body: nonIndexed(body), glass: nonIndexed(glass), lights: [[1.3, 0.1, 0]] };
  }
  // streetPole: tapered pole, rising arm, disc
  {
    const H = 8;
    const body = [
      cyl(0.055, 0.09, H, 6, 0, H / 2, 0),
      cyl(0.03, 0.035, 1.3, 4, 0, 0, 0).rotateZ(Math.PI / 2 - 0.14).translate(0.64, H - 0.05 + 0.09, 0),
      cyl(0.3, 0.27, 0.12, 8, 1.38, H + 0.1, 0)
    ];
    const glass = [new THREE.CircleGeometry(0.255, 8).rotateX(Math.PI / 2).translate(1.38, H + 0.035, 0)];
    models[T.STREET_POLE] = { body: nonIndexed(body), glass: nonIndexed(glass), lights: [[1.38, H, 0]] };
  }
  // avenuePole: tall pole, roadway arm & disc, a lower sidewalk arm & disc on the other side
  {
    const H = 11;
    const body = [
      cyl(0.07, 0.125, H, 6, 0, H / 2, 0),
      cyl(0.035, 0.04, 1.9, 4, 0, 0, 0).rotateZ(Math.PI / 2 - 0.12).translate(0.94, H - 0.04 + 0.11, 0),
      cyl(0.37, 0.33, 0.14, 8, 1.95, H + 0.17, 0),
      cyl(0.025, 0.03, 0.85, 4, 0, 0, 0).rotateZ(Math.PI / 2).translate(-0.45, 4.6, 0),
      cyl(0.24, 0.215, 0.09, 8, -0.98, 4.62, 0)
    ];
    const glass = [
      new THREE.CircleGeometry(0.315, 8).rotateX(Math.PI / 2).translate(1.95, H + 0.095, 0),
      new THREE.CircleGeometry(0.2, 8).rotateX(Math.PI / 2).translate(-0.98, 4.57, 0)
    ];
    models[T.AVENUE_POLE] = { body: nonIndexed(body), glass: nonIndexed(glass), lights: [[1.95, H + 0.05, 0], [-0.98, 4.5, 0]] };
  }
  return models;
}

/**
 * Plans and builds every street lamp. `opts.isClearOfPoles(x, z, r)` keeps lamps off the signal poles and
 * `opts.addPole(x, z, width)` records each standing lamp as a pole. Returns { meshes, spotSites, pointSites, lamps, stats }:
 * spotSites { x, y, z, tx, tz } for the modern heads (spot lights aimed down & out), pointSites { x, y, z, color,
 * intensity, dist } for the lanterns.
 */
export function buildStreetLamps(opts = {}) {
  const walls = REAL_BUILDINGS ? streetWallsFrom(REAL_BUILDINGS) : [];
  const { lamps, stats } = planStreetLamps(walls, LAMPS || [], { isClearOfPoles: opts.isClearOfPoles });
  const models = buildModels();

  const ironMat = new THREE.MeshStandardNodeMaterial({ color: 0x24282c, roughness: 0.55, metalness: 0.55 });
  const steelMat = new THREE.MeshStandardNodeMaterial({ color: 0x70767b, roughness: 0.5, metalness: 0.6 });
  // lantern glass: pale and clear by day, warm sodium-like gold after dusk; LED lenses: grey by day, warm white at night
  const lanternGlass = new THREE.MeshBasicNodeMaterial();
  lanternGlass.colorNode = mix(color(0xb9bcb4), color(0xffcf86).mul(2.2), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const ledGlass = new THREE.MeshBasicNodeMaterial();
  ledGlass.colorNode = mix(color(0x8e918f), color(0xfff0d8).mul(2.3), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const HISTORIC = new Set([T.WALL_LANTERN, T.COLUMN, T.CANDELABRA]);

  const byType = LAMP_TYPES.map(() => []);
  const spotSites = [];
  const pointSites = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();
  for (const l of lamps) {
    q.setFromAxisAngle(up, l.yaw);
    pos.set(l.x, l.y, l.z);
    byType[l.type].push(m.compose(pos, q, one).clone());
    if (opts.addPole && !(l.type === T.WALL_LANTERN || l.type === T.MODERN_WALL)) opts.addPole(l.x, l.z, l.type === T.CANDELABRA ? 0.6 : 0.4);
    const c = Math.cos(l.yaw), s = Math.sin(l.yaw);
    // model (x, y, z) -> world: rotation about y by yaw maps +x to (cos, -sin)
    const toWorld = ([x, y, z]) => [l.x + x * c + z * s, l.y + y, l.z - x * s + z * c];
    for (const p of models[l.type].lights) {
      const [wx, wy, wz] = toWorld(p);
      if (HISTORIC.has(l.type)) {
        pointSites.push({ x: wx, y: wy, z: wz, color: 0xffd08c, intensity: l.type === T.CANDELABRA ? 40 : 26, dist: l.type === T.CANDELABRA ? 17 : 13 });
      } else {
        // aimed down and a little toward the street (the model's +x for the roadway head, -x for the sidewalk head)
        const out = p[0] >= 0 ? 2.5 : -1.5;
        const [tx, , tz] = toWorld([p[0] + out, 0, p[2]]);
        spotSites.push({ x: wx, y: wy - 0.05, z: wz, tx, tz, low: wy < 7 });
      }
    }
  }

  const meshes = [];
  const instanced = (geo, mat, list, shadow) => {
    if (!list.length) return;
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((mx, i) => inst.setMatrixAt(i, mx));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = shadow;
    inst.receiveShadow = shadow;
    inst.computeBoundingSphere();
    inst.name = 'StreetLamps';
    // Draw distance (scene-culling.js): a 0.3 m post is under a pixel wide beyond ~300 m, yet the island's ~29,000 lamps
    // drawn out to the far plane cost a quarter of the frame; the lit lanterns read further at night
    inst.userData.cullDistance = shadow ? 300 : 600;
    meshes.push(inst);
  };
  byType.forEach((list, t) => {
    const historic = HISTORIC.has(t);
    instanced(models[t].body, historic ? ironMat : steelMat, list, true);
    instanced(models[t].glass, historic ? lanternGlass : ledGlass, list, false);
  });
  console.info(`[streetLamps] ${lamps.length} lamps: ${stats.data} mapped (OSM & Ajuntament; ${stats.dataWall} on facades, ` +
    `${stats.dataSnapped} snapped to the kerb, ${stats.dataDropped} off the engine's kerbs dropped), ${stats.rule} by rule on ` +
    `${stats.ruleStreets.size} streets · ${LAMP_TYPES.map((n, i) => `${n} ${stats.byType[i]}`).join(', ')}`);
  return { meshes, spotSites, pointSites, lamps, stats };
}
