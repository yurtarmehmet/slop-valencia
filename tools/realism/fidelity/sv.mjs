// Street View captures for a viewpoint set, the way docs/fidelity-gaps.md's were taken: Google Maps pano URL at the
// point's position and heading (map_action=pano, 90 deg FOV, pitch 0), 1280x720, EU consent rejected, a screenshot
// once the imagery has loaded, plus the snapped pano pose and the "Image capture" date.
// LOCAL COMPARISON ONLY: captures go to .fidelity/ (gitignored) and never into the repo, the game or a committed file.
//
// usage: node tools/realism/fidelity/sv.mjs [--set heldout] [--only h01,h02] [--headed]
// Writes .fidelity/sv-<set>/<id>.png (main: .fidelity/sv/), .fidelity/sv-<set>.json, and fills each viewpoint's
// svDate / svPano / snapped and, when the pano snapped, its game pose v (eye 2.5 m, looking 30 m ahead) in
// viewpoints.json. Holds the shared GPU lock per batch of 10 captures.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..', '..');
const { chromium } = require(path.join(ROOT, '.cache/node/node_modules/playwright-core'));
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => {
  if (v.startsWith('--')) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));
const set = a.set || 'heldout';
const only = a.only ? new Set(String(a.only).split(',')) : null;
const VPF = path.join(HERE, 'viewpoints.json');
const VP = JSON.parse(fs.readFileSync(VPF, 'utf8'));
const out = path.join(ROOT, '.fidelity', set === 'main' ? 'sv' : `sv-${set}`);
const metaF = path.join(ROOT, '.fidelity', `sv-${set}.json`);
fs.mkdirSync(out, { recursive: true });
const meta = fs.existsSync(metaF) ? JSON.parse(fs.readFileSync(metaF, 'utf8')) : {};

const base = path.join(ROOT, '.fidelity/baseline-site/js');
const JS = fs.existsSync(base) ? base : path.join(ROOT, 'js');
const { GEO } = await import(path.join(JS, 'bcn-geodata.js'));
const { lonLatToWorld } = await import(path.join(JS, 'city-config.js'));
const th = GEO.frame.bearingDeg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
const poseOf = (lat, lon, heading) => {  // same as the main set's poses.mjs
  const { x, z } = lonLatToWorld(lon, lat);
  const h = heading * Math.PI / 180, de = Math.sin(h), dn = Math.cos(h);
  const dx = de * c - dn * s, dz = -de * s - dn * c;
  return [x, 2.5, z, x + dx * 30, 2.3, z + dz * 30].map((v) => +v.toFixed(3));
};

const LOCK = path.join(ROOT, '.cache', 'gpu.lock');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lock = async () => {
  for (let waited = 0; ; waited += 2) {
    try { fs.mkdirSync(LOCK); fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid)); return; } catch {
      let owner = 0; try { owner = +fs.readFileSync(path.join(LOCK, 'pid'), 'utf8'); } catch { /* being written */ }
      if (owner && !alive(owner)) { fs.rmSync(LOCK, { recursive: true, force: true }); continue; }
      if (waited % 60 === 0) console.error(`waiting for the GPU lock (held by pid ${owner || '?'}), ${waited}s`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
};
const release = () => { try { if (+fs.readFileSync(path.join(LOCK, 'pid'), 'utf8') === process.pid) fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', release);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(1); });

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: !a.headed,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--lang=en-US'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: 'en-US',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
const pts = VP.sets[set].filter((p) => !only || only.has(p.id));
let n = 0;
for (const p of pts) {
  if (n % 10 === 0) await lock();
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lon}&heading=${p.heading}&pitch=0&fov=90&hl=en`;
  await page.goto(url, { timeout: 60000 });
  for (let i = 0; i < 3; i++) {  // EU consent wall
    const clicked = await page.evaluate(() => {
      if (!/consent\./.test(location.host)) return false;
      const b = [...document.querySelectorAll('button, input[type=submit]')].find((e) => /reject all|rechazar todo|tümünü reddet|alle ablehnen/i.test(e.textContent || e.value || ''));
      if (b) { b.click(); return true; }
      return false;
    }).catch(() => false);
    if (!clicked) break;
    await page.waitForTimeout(3000);
  }
  let pose = null;
  for (let i = 0; i < 20; i++) {  // the pano URL (…/@lat,lng,3a,…) appears once the imagery is placed
    const u = await page.evaluate(() => location.href).catch(() => '');
    const m = u.match(/@(-?[\d.]+),(-?[\d.]+),3a,([\d.]+)y,([\d.]+)h,([\d.]+)t/);
    if (m) { pose = { lat: +m[1], lon: +m[2], fov: +m[3], heading: +m[4], tilt: +m[5] }; break; }
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(4500);
  const date = await page.evaluate(() => { const t = document.body.innerText; const m = t.match(/Image capture:\s*([A-Za-z]{3,9} \d{4})/); return m ? m[1] : null; }).catch(() => null);
  await page.screenshot({ path: path.join(out, `${p.id}.png`) });
  meta[p.id] = { pose, date };
  // record in viewpoints.json (pano lat/lon/heading and date only: no imagery)
  p.svDate = date;
  p.svPano = pose ? { lat: pose.lat, lon: pose.lon, heading: pose.heading } : null;
  p.snapped = !!pose;
  if (pose) p.v = poseOf(pose.lat, pose.lon, pose.heading);
  console.log(p.id, p.name, pose ? `${pose.lat},${pose.lon} h${pose.heading}` : 'NO PANO URL', date);
  fs.writeFileSync(metaF, JSON.stringify(meta, null, 1));
  fs.writeFileSync(VPF, JSON.stringify(VP, null, 1));
  n++;
  if (n % 10 === 0) release();
}
release();
await browser.close();
