// València's facade rules (gaps #4 and #11), dependency-free so tests can run them: which window bays open onto a
// balcony (the same rule as tsl-materials.js balconyMask), each building's facade style by era, and where its
// balconies stand. Rules, not data: no open dataset maps balconies or blinds; learnt from the open reference photos
// (reference/f-*) and the Street View comparison pairs.

/** The rule shared with tsl-materials.js balconyMask: does window bay `b` of upper floor `f` open onto a balcony? */
export function hasBalcony(mode, phase, b, f) {
  if (f < 1 || b < 0) return false;
  switch (mode) {
    case 1: case 2: case 5: return true;
    case 3: return (b + phase) % 2 === 0;
    case 4: return (b + phase) % 3 === 1;
    case 6: return f === 1;
    default: return false;
  }
}

/**
 * A building's facade style [balcony mode, phase, persiana paint seed, ground-floor seed] from its facade material
 * (buildings.js facades), construction year, storeys and a 0..1 random `r` per building (rules, see the header)
 */
export function facadeStyle(mat, year, storeys, r) {
  const r2 = (r * 7.31) % 1, r3 = (r * 3.17) % 1, r4 = (r * 13.7) % 1;
  let mode = 0;
  if (mat === 1 || mat === 2 || mat === 6) mode = r2 < 0.8 ? 1 : 2;
  else if (mat === 0) mode = year && year >= 1950 ? (r2 < 0.5 ? 3 : 5) : r2 < 0.5 ? 2 : 1;
  else if (mat === 9) mode = r2 < 0.4 ? 5 : r2 < 0.7 ? 3 : r2 < 0.85 ? 1 : 0;
  else if (mat === 7) mode = r2 < 0.42 ? 4 : r2 < 0.57 ? 3 : r2 < 0.72 ? 5 : 0;
  else if (mat === 8) mode = r2 < 0.3 ? 3 : r2 < 0.55 ? 4 : 0;
  else if (mat === 10 || mat === 11) mode = storeys >= 3 ? (r2 < 0.6 ? 1 : 6) : storeys === 2 ? (r2 < 0.75 ? 6 : 0) : 0;
  return [mode, Math.floor(r3 * 3), r4, r3];
}

/** Railing pattern of a facade material: 0 plain old-town bars, 1 ornate Ensanche, 2 1960s square bars, 3 modern */
export function railStyle(mat) {
  if (mat === 0) return 1;
  if (mat === 7 || mat === 9) return 2;
  if (mat === 8) return 3;
  return 0;
}

/**
 * The balconies of facade box `item` ({ x, y, z, w, h, d, ry, faces, style, mat } after buildings.js placeInFrame)
 * appended to `out` as [x, y, z, ry, w, d, kind, seed] per balcony (slab top centre on the wall face, facing ry;
 * kind: rail style + 4 for a French railing with no slab). `spec`: { windowWidth, floorHeight, windowRatioX } of
 * the box's facade material; the bays follow tsl-materials.js facadeCell (1.2 m corner piers).
 */
export function boxBalconies(item, spec, out) {
  const style = item.style;
  if (!style || !style[0]) return;
  const mode = style[0], phase = Math.floor(style[1]); // (the phase's fraction is the graffiti level)
  const fh = spec.floorHeight;
  const floors = Math.floor((item.h + 0.05) / fh); // whole storeys (a partial top storey is solid)
  if (floors < 2) return;
  const cs = Math.cos(item.ry || 0), sn = Math.sin(item.ry || 0);
  const rail = railStyle(item.mat);
  const french = mode === 5;
  for (let side = 0; side < 4; side++) {
    if (item.faces[side] > 1) continue; // street fronts only (shopfront or residential entrance)
    const alongZ = side < 2;
    const W = alongZ ? item.d : item.w;
    const pier = Math.min(1.2, W * 0.2);
    const inner = W - 2 * pier;
    const bays = Math.max(Math.floor(inner / spec.windowWidth + 0.5), 1);
    const bw = inner / bays;
    if (bw < 1.1) continue;
    const win = bw * spec.windowRatioX;
    // wall face centre & outward normal in the box frame
    const nx = side === 0 ? -1 : side === 1 ? 1 : 0, nz = side === 2 ? -1 : side === 3 ? 1 : 0;
    const face = side === 0 ? Math.PI * -0.5 : side === 1 ? Math.PI * 0.5 : side === 2 ? Math.PI : 0;
    const ry = (item.ry || 0) + face;
    const put = (s, f, w, depth, kind) => {
      // s: metres along the wall from its -x / -z end
      const lx = alongZ ? nx * item.w * 0.5 : -item.w * 0.5 + s;
      const lz = alongZ ? -item.d * 0.5 + s : nz * item.d * 0.5;
      out.push(item.x + lx * cs + lz * sn, f * fh, item.z - lx * sn + lz * cs, ry, w, depth, kind,
        ((s * 7.13 + f * 3.71 + item.x * 0.37 + item.z * 0.11) % 1 + 1) % 1);
    };
    const seed = style[2];
    // one depth per building: old town shallow, Ensanche deeper, 1960s-on terraces deep
    const depth = french ? 0.08 : rail === 0 ? 0.45 + seed * 0.15 : rail === 1 ? 0.6 + seed * 0.2 : 0.9 + seed * 0.3;
    for (let f = 1; f < floors; f++) {
      if (mode === 2 && f === 1) {
        put(W * 0.5, f, inner - 0.2, depth + 0.15, rail);
        continue;
      }
      for (let b = 0; b < bays; b++) {
        if (!hasBalcony(mode, phase, b, f)) continue;
        const w = french ? win + 0.1 : Math.min(bw - 0.15, win + (rail >= 2 ? 0.9 : 0.5));
        put(pier + (b + 0.5) * bw, f, w, depth, rail + (french ? 4 : 0));
      }
    }
  }
}


const GLASSY = new Set([3, 4, 5, 8]);
const hash = (x, z, k) => { const v = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453; return v - Math.floor(v); };

/**
 * Overhead cables of facade box `item` (gap #11; { x, z, w, h, d, ry, faces, mat, year, fh } in world metres), appended
 * to `out` as [ax, ay, az, bx, by, bz, sag, wires, thickness, seed] per span. A bundle of 2-3 cables runs along every
 * street front built before 1985 (not glass or modern render) just above the ground floor, sagging between hooks
 * ~7 m apart; some fronts sling a cable across the street to the facade `opposite(x, z, nx, nz)` returns ({ x, z, h }).
 */
export function cableRuns(item, out, opposite) {
  if (!item.year || item.year >= 1985 || GLASSY.has(item.mat) || !item.fh || item.h < item.fh + 1.2) return;
  const cs = Math.cos(item.ry || 0), sn = Math.sin(item.ry || 0);
  const toWorld = (lx, lz) => [item.x + lx * cs + lz * sn, item.z - lx * sn + lz * cs];
  const y = Math.min(item.h - 0.4, item.fh - 0.35); // under the first-floor balconies
  const old = item.year < 1940;
  for (let side = 0; side < 4; side++) {
    if (item.faces[side] > 1) continue;
    const hw = item.w * 0.5, hd = item.d * 0.5;
    // wall ends (box frame) ordered so the span's left-hand perpendicular points out of the wall
    const [l0, l1, ln] = side === 0 ? [[-hw, hd], [-hw, -hd], [-1, 0]] : side === 1 ? [[hw, -hd], [hw, hd], [1, 0]]
      : side === 2 ? [[-hw, -hd], [hw, -hd], [0, -1]] : [[hw, hd], [-hw, hd], [0, 1]];
    const [ax, az] = toWorld(l0[0], l0[1]), [bx, bz] = toWorld(l1[0], l1[1]);
    const nx = ln[0] * cs + ln[1] * sn, nz = -ln[0] * sn + ln[1] * cs;
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 3) continue;
    const h0 = hash(ax, az, side);
    if (h0 < (old ? 0.12 : 0.3)) continue; // some fronts are clean (cables buried or re-routed)
    const wires = h0 > 0.6 ? 3 : 2;
    const k = Math.max(1, Math.round(L / 7));
    const off = 0.07;
    for (let i = 0; i < k; i++) {
      const t0 = i / k, t1 = (i + 1) / k;
      out.push(ax + (bx - ax) * t0 + nx * off, y, az + (bz - az) * t0 + nz * off,
        ax + (bx - ax) * t1 + nx * off, y, az + (bz - az) * t1 + nz * off,
        0.05 + hash(ax, az, i + 7) * 0.12, wires, 0.022, h0);
    }
    // a cable across the street from the middle of the front
    if (opposite && L > 6 && hash(bx, bz, side + 3) < (old ? 0.3 : 0.14)) {
      const mx = (ax + bx) * 0.5 + nx * off, mz = (az + bz) * 0.5 + nz * off;
      const yc = Math.min(item.h - 0.6, item.fh * 2 - 0.4);
      const o = opposite(mx, mz, nx, nz);
      if (o && o.h > 4) {
        const yo = Math.min(o.h - 0.6, yc + (hash(mx, mz, 5) - 0.5) * 2);
        const span = Math.hypot(o.x - mx, o.z - mz);
        out.push(mx, yc, mz, o.x, Math.max(3.5, yo), o.z, span * 0.025, hash(mx, mz, 9) < 0.5 ? 1 : 2, 0.026, h0);
      }
    }
  }
}

// Barris where the Street View pairs show graffiti and murals on most ground floors (gap #11), and some elsewhere
const GRAFFITI_BARRIS = { 'El Carme': 0.85, Benimaclet: 0.85, 'El Cabanyal': 0.75, 'El Mercat': 0.6, Russafa: 0.6, 'El Pilar': 0.55,
  'La Seu': 0.3, 'La Xerea': 0.3, Orriols: 0.5, Torrefiel: 0.45, 'La Malva-rosa': 0.45, 'El Grau': 0.45, Marxalenes: 0.4 };

/** Share (0..0.9) of a building's ground-floor bays tagged or painted, by barri name, construction year and facade */
export function graffitiLevel(barri, year, mat) {
  if (mat >= 3 && mat <= 5) return 0;
  const base = GRAFFITI_BARRIS[barri] ?? 0.22;
  const age = !year ? 0.8 : year < 1940 ? 1 : year < 1985 ? 0.85 : 0.35;
  return Math.min(0.9, base * age);
}
