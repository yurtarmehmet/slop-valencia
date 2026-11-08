// Frame cost by part: at each pose, the frame rate with one part of the frame switched off at a time (post-processing,
// shadows, the big scene groups, a shorter far plane, fewer pixels), in a visible Chrome window like a player's.
//
// usage: node tools/realism/perf.mjs --port 8701 --poses <poses.json> [--w 1280 --h 720] [--only base,noPost]
// poses.json: [{ "id": "34", "v": [x, y, z, lx, ly, lz] }, ...] as for shot.mjs. Close other tabs running the game first.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const { chromium } = require(path.join(ROOT, '.cache/node/node_modules/playwright-core'));
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => {
  if (v.startsWith('--')) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));
const W = +(a.w || 1280), H = +(a.h || 720);
const poses = JSON.parse(fs.readFileSync(a.poses, 'utf8'));

// [name, on (switch the part off), off (put it back)]: run in the page with S = window.__slop
const hide = (...names) => [
  `for (const n of ${JSON.stringify(names)}) S.scene.traverse((o) => { if (o.name === n) { o.userData.perfVis = o.visible; o.visible = false; } })`,
  `for (const n of ${JSON.stringify(names)}) S.scene.traverse((o) => { if (o.name === n && o.userData.perfVis !== undefined) { o.visible = o.userData.perfVis; delete o.userData.perfVis; } })`,
];
const LAMP_SHADOW = (on) => `S.scene.getObjectByName('StreetDetails').traverse((o) => { if (o.isMesh && o.parent && o.parent.name === 'StreetLamps') { if (o.userData.perfCs === undefined) o.userData.perfCs = o.castShadow; o.castShadow = ${on} ? o.userData.perfCs : false; } })`;
const FAR = (m) => [`S.perfFar = S.cameraSystem.camera.far; S.cameraSystem.camera.far = ${m}; S.cameraSystem.camera.updateProjectionMatrix()`,
  'S.cameraSystem.camera.far = S.perfFar; S.cameraSystem.camera.updateProjectionMatrix()'];
const SCENARIOS = {
  base: ['', ''],
  base2: ['', ''],
  noPost: ['S.perfRender = S.renderPipeline.render; S.renderPipeline.render = () => S.renderer.render(S.scene, S.cameraSystem.camera)',
    'S.renderPipeline.render = S.perfRender'],
  noShadows: ['S.renderer.shadowMap.enabled = false', 'S.renderer.shadowMap.enabled = true'],
  far600: ['S.perfFar = S.cameraSystem.camera.far; S.cameraSystem.camera.far = 600; S.cameraSystem.camera.updateProjectionMatrix()',
    'S.cameraSystem.camera.far = S.perfFar; S.cameraSystem.camera.updateProjectionMatrix()'],
  far350: ['S.perfFar = S.cameraSystem.camera.far; S.cameraSystem.camera.far = 350; S.cameraSystem.camera.updateProjectionMatrix()',
    'S.cameraSystem.camera.far = S.perfFar; S.cameraSystem.camera.updateProjectionMatrix()'],
  pixels75: [`S.renderer.setPixelRatio(0.75); S.renderer.setSize(${W}, ${H})`, `S.renderer.setPixelRatio(1); S.renderer.setSize(${W}, ${H})`],
  noCityBlocks: hide('CityBlocks'),
  noLandmarks: hide('Landmarks'),
  noBoroughs: hide('Boroughs'),
  noCityGrid: hide('CityGrid'),
  noStreetDetails: hide('StreetDetails'),
  noTraffic: hide('TrafficAndPedestrians', 'HighwayTraffic'),
  noCrowd: hide('PeopleNear', 'PeopleFar'),
  noLights: hide('StoreClusteredLights', 'StreetClusteredLights', 'TrafficClusteredLights', 'HighwayClusteredLights'),
  noShadowProxies: hide('ShadowProxy'),
  lampsNoShadow: [LAMP_SHADOW(false), LAMP_SHADOW(true)],
  far800: FAR(800),
  shadowFar150: ['S.perfLU = S.lightingSystem.update; S.lightingSystem.update = function (f) { S.perfLU.call(this, f); this.sunLight.shadow.camera.far = 150; }',
    'S.lightingSystem.update = S.perfLU'],
  shadowMap1024: ['const sh = S.lightingSystem.sunLight.shadow; S.perfMS = sh.mapSize.x; sh.mapSize.set(1024, 1024); if (sh.map) { sh.map.dispose(); sh.map = null; }',
    'const sh = S.lightingSystem.sunLight.shadow; sh.mapSize.set(S.perfMS, S.perfMS); if (sh.map) { sh.map.dispose(); sh.map = null; }'],
  far800LampsNoShadow: [FAR(800)[0] + ';' + LAMP_SHADOW(false), FAR(800)[1] + ';' + LAMP_SHADOW(true)],
  far600LampsNoShadow: [FAR(600)[0] + ';' + LAMP_SHADOW(false), FAR(600)[1] + ';' + LAMP_SHADOW(true)],
};
const pick = a.only ? String(a.only).split(',') : Object.keys(SCENARIOS);

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${a.port || 8701}/index.html?debug&v=${Date.now()}`, { timeout: 180000 });
await page.waitForFunction(() => window.__slop && window.__slop.renderPipeline && window.__slop.scene.children.length > 20,
  null, { timeout: 240000, polling: 1000 });
await page.waitForTimeout(6000);
await page.evaluate(() => document.getElementById('time-midday')?.click());
await page.mouse.click(W / 2, H / 2); await page.keyboard.press('KeyH');
await page.waitForTimeout(4000);
const fps = () => page.evaluate(() => new Promise((res) => {
  let n = 0; const t0 = performance.now();
  const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(+(n / ((performance.now() - t0) / 1000)).toFixed(1)); };
  requestAnimationFrame(f);
}));
const result = {};
for (const p of poses) {
  await page.evaluate((v) => window.__slop.look(...v), p.v);
  await page.waitForTimeout(4000);
  const out = {};
  out.info = await page.evaluate(() => {
    const i = window.__slop.renderer.info.render;
    return { drawCalls: i.drawCalls, triangles: i.triangles, far: window.__slop.cameraSystem.camera.far };
  });
  for (const k of pick) {
    const [on, off] = SCENARIOS[k];
    await page.evaluate((js) => { const S = window.__slop; new Function('S', js)(S); }, on);
    await page.waitForTimeout(2000);
    await fps();
    out[k] = await fps();
    await page.evaluate((js) => { const S = window.__slop; new Function('S', js)(S); }, off);
    console.log(p.id, k, out[k]);
  }
  result[p.id] = out;
}
result.errors = errors;
console.log(JSON.stringify(result));
await browser.close();
