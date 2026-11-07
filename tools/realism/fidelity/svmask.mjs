// Google UI masks for the Street View captures: every pixel Google draws on top of the imagery (search box, info
// panel, buttons, place pins, road-name labels, navigation arrows). Re-opens each viewpoint's pano URL exactly as
// sv.mjs did, then takes three screenshots:
//   N   = normal (what sv.mjs captured; also used to check the pano is the same one as the stored capture)
//   OV  = one WebGL draw program skipped at a time, canvas cleared to magenta (ov<program>.png); svmask.py keeps the
//         shot where the panorama vanished: everything not magenta is Google UI (HTML panels and buttons, and the
//         pins, labels and arrows drawn in the canvas)
//   DOM = all DOM except the canvas hidden, panorama drawn: N vs DOM differs exactly at the HTML UI
// mask = (OV not black) | (N differs from DOM), dilated 3 px. Writes .fidelity/uimask/<set>/<id>.png (255 = UI) and
// .fidelity/uimask/<set>.json (masked fraction, and the mean difference between N and the stored capture outside
// the mask, which must be small: same pano, same pose).
// LOCAL ONLY, like sv.mjs. usage: node tools/realism/fidelity/svmask.mjs [--set main|heldout] [--only 01,02]
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
const set = a.set || 'main';
const only = a.only ? new Set(String(a.only).split(',')) : null;
const VP = JSON.parse(fs.readFileSync(path.join(HERE, 'viewpoints.json'), 'utf8'));
const out = path.join(ROOT, '.fidelity', 'uimask', set);
const raw = path.join(out, 'raw');
fs.mkdirSync(raw, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: !a.headed,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--lang=en-US'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: 'en-US',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36' });
await ctx.addInitScript(() => {
  let pid = 0; const ids = new WeakMap(); window.__progStats = {}; window.__skip = null;
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue; const P = C.prototype;
    const use = P.useProgram; P.useProgram = function (p) { this.__cur = p; return use.call(this, p); };
    // while a program is skipped, clear to magenta: Google's overlays and its (semi-transparent) HTML UI then show
    // up as anything that isn't magenta
    const cc = P.clearColor, clr = P.clear;
    P.clearColor = function (...c) { this.__cc = c; return cc.apply(this, c); };
    P.clear = function (bits) {
      if (window.__skip !== null) { cc.call(this, 1, 0, 1, 1); const r = clr.call(this, bits); if (this.__cc) cc.apply(this, this.__cc); return r; }
      return clr.call(this, bits);
    };
    for (const fn of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
      const orig = P[fn]; if (!orig) continue;
      P[fn] = function (...args) {
        const p = this.__cur; if (p && !ids.has(p)) ids.set(p, ++pid);
        const id = p ? ids.get(p) : 0;
        window.__progStats[id] = (window.__progStats[id] || 0) + 1;
        if (window.__skip !== null && window.__skip === id) return;
        return orig.apply(this, args);
      };
    }
  }
});
const page = await ctx.newPage();
for (const p of VP.sets[set].filter((q) => !only || only.has(q.id))) {
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lon}&heading=${p.heading}&pitch=0&fov=90&hl=en`;
  await page.goto(url, { timeout: 60000 });
  for (let i = 0; i < 3; i++) {
    const clicked = await page.evaluate(() => {
      if (!/consent\./.test(location.host)) return false;
      const b = [...document.querySelectorAll('button, input[type=submit]')].find((e) => /reject all|rechazar todo/i.test(e.textContent || e.value || ''));
      if (b) { b.click(); return true; }
      return false;
    }).catch(() => false);
    if (!clicked) break;
    await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(9500);
  await page.screenshot({ path: path.join(raw, `${p.id}-n.png`) });
  const stats = await page.evaluate(() => window.__progStats);
  // skip each draw program in turn (most calls first); svmask.py keeps the shot where the panorama vanished
  for (const pid of Object.keys(stats).map(Number).filter((x) => x).sort((x, y) => stats[y] - stats[x]).slice(0, 4)) {
    await page.evaluate((id) => { window.__skip = id; }, pid);
    await page.mouse.move(3, 300); await page.waitForTimeout(400); await page.mouse.move(4, 302);  // redraw; cursor outside the crop
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(raw, `${p.id}-ov${pid}.png`) });
  }
  await page.evaluate(() => {
    window.__skip = null;
    const keep = new Set();
    for (const c of document.querySelectorAll('canvas')) { let e = c; while (e) { keep.add(e); e = e.parentElement; } }
    for (const e of document.querySelectorAll('body *')) if (!keep.has(e)) e.style.visibility = 'hidden';
  });
  await page.mouse.move(3, 300); await page.waitForTimeout(400); await page.mouse.move(4, 302);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(raw, `${p.id}-dom.png`) });
  console.log(p.id, JSON.stringify(stats));
}
await browser.close();
