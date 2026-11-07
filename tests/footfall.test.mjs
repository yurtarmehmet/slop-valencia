import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

// js/vlc-footfall.bin.gz (tools/build-footfall.py): people per metre of street from residents per block, workplaces,
// shops and bars; the sidewalk pedestrians and the open-ground crowd spawn by it.
const { GEO } = await import('../js/bcn-geodata.js');
const { lonLatToWorld } = await import('../js/city-config.js');
const { SHOP_COUNT, SHOP_DATA } = await import('../js/vlc-shops.js');
const { decodeFootfall, FOOTFALL_HOURS } = await import('../js/vlc-footfall.js');
const grid = decodeFootfall(new Uint8Array(gunzipSync(readFileSync(new URL('../js/vlc-footfall.bin.gz', import.meta.url)))));
const stats = JSON.parse(readFileSync(new URL('../tools/data/footfall-stats.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../tools/data/vlci-manifest.json', import.meta.url), 'utf8'));

const at = (lat, lon, hours = FOOTFALL_HOURS.midday) => {
  const p = lonLatToWorld(lon, lat);
  const i = Math.floor((p.x - grid.x0) / grid.cell), j = Math.floor((p.z - grid.z0) / grid.cell);
  if (i < 0 || j < 0 || i >= grid.nx || j >= grid.nz) return 0;
  const k = j * grid.nx + i;
  return (grid.home[k] * hours.home + grid.shop[k] * hours.shop + grid.food[k] * hours.food) * grid.scale;
};

test('the footfall map covers the detailed city in 20 m cells', () => {
  const D = GEO.frame.detail;
  assert.equal(grid.x0, D.x0);
  assert.equal(grid.z0, D.z0);
  assert.equal(grid.cell, 20);
  assert.ok(grid.x0 + grid.nx * grid.cell >= D.x1 && grid.z0 + grid.nz * grid.cell >= D.z1);
  assert.equal(grid.food.length, grid.nx * grid.nz);
  assert.ok(readFileSync(new URL('../js/vlc-footfall.bin.gz', import.meta.url)).length < 60000, 'within its byte budget');
});

test('every source is counted: blocks, barris, shops', () => {
  // the Ajuntament's block layer as pinned, all 4,929 blocks; its population fields are published empty
  assert.equal(stats.blocks, manifest['illa-de-cases-cadastrals-amb-dades-de-poblacio'].records);
  assert.equal(stats.blocks, 4929);
  assert.deepEqual(stats.block_population_fields_published, []);
  assert.ok(stats.blocks_in_detail_with_residents > 0.7 * stats.blocks_in_detail);
  // the barris' residents (padró) are shared out by Catastro dwellings: none lost
  assert.equal(stats.barris, manifest['barris-barrios'].records);
  assert.equal(stats.barris, manifest['car-parks-by-districts-neighborhoods'].records);
  assert.ok(stats.barri_residents_total > 780000 && stats.barri_residents_total < 820000, `${stats.barri_residents_total} residents`);
  assert.ok(stats.residents_in_detail_blocks > 400000 && stats.residents_in_detail_blocks <= stats.residents_placed_on_grid);
  // every shop of js/vlc-shops.js inside the grid
  const bytes = Buffer.from(SHOP_DATA, 'base64');
  let inside = 0;
  for (let i = 0; i < SHOP_COUNT; i++) {
    const x = bytes.readInt16LE(i * 6) / 4, z = bytes.readInt16LE(i * 6 + 2) / 4;
    const ci = Math.floor((x - grid.x0) / grid.cell), cj = Math.floor((z - grid.z0) / grid.cell);
    if (ci >= 0 && cj >= 0 && ci < grid.nx && cj < grid.nz) inside++;
  }
  assert.equal(stats.shops, SHOP_COUNT);
  assert.equal(stats.shops_on_grid, inside);
});

test('busy streets are busier than quiet ones, and the sea is empty', () => {
  const colon = at(39.4703, -0.3706), santVicent = at(39.4723, -0.3780), sueca = at(39.4618, -0.3735);
  const penyaRoja = at(39.4563, -0.3527);
  for (const [name, v] of [['Carrer de Colón', colon], ['Carrer de Sant Vicent Màrtir', santVicent], ['Carrer de Sueca (Russafa)', sueca]]) {
    assert.ok(v > 0.09 && v > 3 * penyaRoja, `${name}: ${v.toFixed(3)} people/m against Penya-roja's ${penyaRoja.toFixed(3)}`);
  }
  assert.ok(penyaRoja > 0.005, 'a residential street still has people');
  assert.equal(at(39.46, -0.30), 0, 'the sea');
});

test('midday is busy, the night thin, and bars outlast shops', () => {
  const { midday, midnight, golden, twilight } = FOOTFALL_HOURS;
  for (const h of [golden, twilight]) assert.ok(h.home + h.shop + h.food > 2.4);
  const sueca = (h) => at(39.4618, -0.3735, h);
  assert.ok(sueca(midnight) < 0.5 * sueca(midday));
  assert.ok(midnight.food > midnight.shop && midnight.food > midnight.home);
});
