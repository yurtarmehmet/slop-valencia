// Still game renders for checks: system Chrome with WebGPU, the ?debug camera (__slop.look), midday light.
//
// usage: node tools/realism/shot.mjs --port 8701 --out <dir> --poses <poses.json> [--w 1280 --h 720 --hfov 90]
//        [--wait 3500] [--time midday|dusk|night] [--fps] [--eval "<js run once after load>"]
// poses.json: [{ "id": "01", "v": [x, y, z, lx, ly, lz] }, ...]   (world metres; y = camera height)
// Serve the repo first:  python3 -m http.server 8701 --bind 127.0.0.1   (one port per person/agent)
// --fps measures frames per second over 3 s at each pose (only meaningful when nothing else is rendering).
// Writes <out>/<id>.png and <out>/shot.json (fps, console errors).
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
const W = +(a.w || 1280), H = +(a.h || 720), HFOV = +(a.hfov || 90), WAIT = +(a.wait || 3500);
const out = path.resolve(a.out || 'shots');
fs.mkdirSync(out, { recursive: true });
const poses = JSON.parse(fs.readFileSync(a.poses, 'utf8'));

// One renderer at a time on this machine: several people/agents share the GPU, and fps or memory would be meaningless
// otherwise. The lock is a directory holding the owner's pid; a lock whose owner is gone is taken over. Waiters queue
// first-come first-served: each writes a ticket <ms>-<pid> into gpu.lock.queue/ and may only take the lock when its
// ticket is the oldest live one (tickets of dead processes are dropped). Same protocol as DirLock in
// tools/realism/fidelity/seg.py: change both together.
const LOCK = path.join(ROOT, '.cache', 'gpu.lock');
const QUEUE = LOCK + '.queue';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
fs.mkdirSync(QUEUE, { recursive: true });
const ticket = path.join(QUEUE, `${String(Date.now()).padStart(15, '0')}-${process.pid}`);
fs.writeFileSync(ticket, '');
const dropTicket = () => { try { fs.rmSync(ticket, { force: true }); } catch { /* gone */ } };
const myTurn = () => {
  const live = fs.readdirSync(QUEUE).sort().filter((t) => {
    if (alive(+t.split('-')[1])) return true;
    try { fs.rmSync(path.join(QUEUE, t), { force: true }); } catch { /* raced */ }
    return false;
  });
  return live[0] === path.basename(ticket);
};
for (let waited = 0; ; waited += 0.5) {
  if (myTurn()) {
    try { fs.mkdirSync(LOCK, { recursive: false }); fs.writeFileSync(path.join(LOCK, 'pid'), String(process.pid)); dropTicket(); break; } catch {
      let owner = 0; try { owner = +fs.readFileSync(path.join(LOCK, 'pid'), 'utf8'); } catch { /* being written */ }
      if (owner && !alive(owner)) { fs.rmSync(LOCK, { recursive: true, force: true }); continue; }
    }
  }
  if (waited % 60 === 0) console.error(`waiting for the GPU lock (${fs.readdirSync(QUEUE).length} queued), ${waited}s`);
  await new Promise((r) => setTimeout(r, 500));
}
const release = () => { try { if (+fs.readFileSync(path.join(LOCK, 'pid'), 'utf8') === process.pid) fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', () => { dropTicket(); release(); });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { release(); process.exit(1); });

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: !a.headed,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:${a.port || 8701}/index.html?debug&v=${Date.now()}`, { timeout: 180000 });
await page.waitForFunction(() => window.__slop && window.__slop.scene && window.__slop.scene.children.length > 20,
  null, { timeout: 240000, polling: 1000 });
await page.waitForTimeout(6000);
await page.evaluate((t) => document.getElementById(`time-${t}`)?.click(), a.time || 'midday');
if (!a.hud) { await page.mouse.click(W / 2, H / 2); await page.keyboard.press('KeyH'); }  // H hides the HUD
await page.waitForTimeout(4000);  // let the loading overlay fade out
if (a.eval) await page.evaluate(a.eval);
const vfov = 2 * Math.atan(Math.tan((HFOV * Math.PI) / 360) * H / W) * 180 / Math.PI;
const result = { hfov: HFOV, w: W, h: H, poses: {} };
for (const { id, v } of poses) {
  await page.evaluate(([v, vf]) => {
    window.__slop.look(...v);
    const c = window.__slop.cameraSystem.camera; c.fov = vf; c.updateProjectionMatrix();
  }, [v, vfov]);
  await page.waitForTimeout(WAIT);
  await page.screenshot({ path: path.join(out, `${id}.png`) });
  const r = {};
  if (a.fps) {
    r.fps = await page.evaluate(() => new Promise((res) => {
      let n = 0; const t0 = performance.now();
      const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(+(n / ((performance.now() - t0) / 1000)).toFixed(1)); };
      requestAnimationFrame(f);
    }));
  }
  result.poses[id] = r;
}
result.errors = errors.slice(0, 50);
fs.writeFileSync(path.join(out, 'shot.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify({ out, shots: poses.length, errors: errors.length, fps: a.fps ? result.poses : undefined }));
await browser.close();
