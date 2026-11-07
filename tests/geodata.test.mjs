import assert from 'node:assert/strict';
import test from 'node:test';

// The generated geography (js/bcn-geodata.js, tools/build-bcn-geodata.mjs) in the frame the city is built in
const { GEO } = await import('../js/bcn-geodata.js');
const { BLOCKS, ROADS, LANDMARK_SITES, TELEPORT_LOCATIONS, blockAt, onLand, lonLatToWorld, districtAt } = await import('../js/city-config.js');

test('the frame is turned to the Ensanche grid and centred on Plaça de l\'Ajuntament', () => {
  assert.ok(GEO.frame.bearingDeg > -30 && GEO.frame.bearingDeg < -27, `grid north bearing ${GEO.frame.bearingDeg}°`);
  const origin = lonLatToWorld(GEO.frame.lon0, GEO.frame.lat0);
  assert.ok(Math.hypot(origin.x, origin.z) < 0.01);
  // Ciril Amorós runs along grid x; Comte de Salvatierra, Cadis & Cuba (Pla del Remei, Russafa) along grid z
  for (const [name, along] of [['Carrer de Ciril Amorós', 'x'], ['Carrer del Comte de Salvatierra', 'z'], ['Carrer de Cadis', 'z'], ['Carrer de Cuba', 'z']]) {
    let ax = 0, az = 0;
    for (const r of ROADS.filter((road) => road.name === name)) {
      for (let i = 1; i < r.pts.length; i++) {
        ax += Math.abs(r.pts[i].x - r.pts[i - 1].x);
        az += Math.abs(r.pts[i].z - r.pts[i - 1].z);
      }
    }
    assert.ok(ax + az > 300, `${name} is in the city`);
    const ratio = along === 'x' ? az / ax : ax / az;
    assert.ok(ratio < 0.03, `${name} runs along the grid's ${along} axis (cross ratio ${ratio.toFixed(3)})`);
  }
});

test('the Ensanche has chamfered illes with València\'s 14 m xaflans', () => {
  const illes = BLOCKS.filter((b) => b.illa);
  assert.ok(illes.length >= 20, `${illes.length} illes`);
  for (const b of illes) {
    const [x0, x1, z0, z1, c] = b.illa;
    assert.ok(x1 - x0 > 50 && x1 - x0 < 140 && z1 - z0 > 50 && z1 - z0 < 140, 'a building-line square');
    assert.ok(Math.abs(c - 9.9) < 0.01, 'the xaflà leg');
  }
});

test('the road graph links real nodes, and every link keeps to the land', () => {
  const { nodes, links, names } = GEO.roadGraph;
  const n = nodes.length / 2;
  assert.ok(links.length > 3000);
  for (const [a, b, name, w, , dir] of links) {
    assert.ok(a >= 0 && a < n && b >= 0 && b < n && a !== b);
    assert.ok(name >= 0 && name < names.length);
    assert.ok(w >= 2 && w <= 60, `width ${w}`);
    assert.ok([-1, 0, 1].includes(dir));
  }
});

test('landmarks, teleports & districts sit where they are', () => {
  for (const name of ['Catedral de València', 'el Micalet', 'Torres dels Serrans', 'Torres de Quart', 'Mercat Central', 'Estació del Nord', "L'Hemisfèric"]) {
    assert.ok(LANDMARK_SITES[name], name);
    assert.ok(onLand(LANDMARK_SITES[name].x, LANDMARK_SITES[name].z), `${name} stands on the detailed city's land`);
  }
  const m = LANDMARK_SITES['el Micalet'];
  const expected = lonLatToWorld(-0.3757, 39.4753);
  assert.ok(Math.hypot(m.x - expected.x, m.z - expected.z) < 30, 'the Micalet at its real coordinates');
  for (const [name, p] of Object.entries(TELEPORT_LOCATIONS)) assert.ok(onLand(p.x, p.z), `${name} lands on land`);
  const cat = LANDMARK_SITES['Catedral de València'];
  assert.equal(districtAt(cat.x, cat.z), 'gotic');
  const colon = LANDMARK_SITES['Mercat de Colón'];
  assert.equal(districtAt(colon.x, colon.z), 'eixample');
  // the sea off the Malva-rosa is not land
  const sea = lonLatToWorld(-0.3, 39.475);
  assert.equal(onLand(sea.x, sea.z), false);
});
