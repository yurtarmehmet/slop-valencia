// Load budgets: the first download (every response until the city is up plus 10 s, sized as gzip would send it; files
// that are already .gz count as they are) and the GPU memory of the textures uploaded from data (images, data
// textures), apart from render targets (shadow maps, frame buffers). Counted by wrapping GPUDevice.createTexture and
// the two queue upload calls before the page runs, so it sees every texture three.js makes.
//
// usage: node tools/realism/budget.mjs --port 8701 [--out budget.json]
// Serve the repo first:  python3 -m http.server 8701 --bind 127.0.0.1
// Shares the GPU lock with shot.mjs only loosely: run it when nothing else renders.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const { chromium } = require(path.join(ROOT, '.cache/node/node_modules/playwright-core'));
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => {
  if (v.startsWith('--')) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: !a.headed,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  // bytes per texel (block formats: bytes per 4x4 block / 16)
  const bpp = (f) => {
    if (/^(bc1|bc4|etc2-rgb8|eac-r11)/.test(f)) return 0.5;
    if (/^(bc|astc-4x4|etc2-rgba8|eac-rg11)/.test(f)) return 1;
    if (/^astc/.test(f)) return 1;  // larger blocks are smaller still; an upper bound
    if (/^(r8|stencil8)/.test(f)) return 1;
    if (/^(rg8|r16|depth16)/.test(f)) return 2;
    if (/^(rgba8|bgra8|rg16|r32|rgb10a2|rg11b10|rgb9e5|depth24|depth32float$)/.test(f)) return 4;
    if (/^(rgba16|rg32|depth32float-stencil8)/.test(f)) return 8;
    if (/^rgba32/.test(f)) return 16;
    return 4;
  };
  const T = (window.__texBudget = { list: [] });
  const size = (d) => {
    const s = d.size, w = s.width ?? s[0], h = s.height ?? s[1] ?? 1, l = s.depthOrArrayLayers ?? s[2] ?? 1;
    let b = 0;
    for (let m = 0; m < (d.mipLevelCount || 1); m++) b += Math.max(1, w >> m) * Math.max(1, h >> m) * l * bpp(d.format);
    return { w, h, l, b: b * (d.sampleCount || 1) };
  };
  const make = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function (d) {
    const t = make.call(this, d);
    const e = { ...size(d), format: d.format, label: d.label || '', uploaded: false, destroyed: false };
    T.list.push(e); t.__budget = e;
    const destroy = t.destroy.bind(t);
    t.destroy = () => { e.destroyed = true; destroy(); };
    return t;
  };
  const mark = (dst) => { if (dst && dst.texture && dst.texture.__budget) dst.texture.__budget.uploaded = true; };
  const wt = GPUQueue.prototype.writeTexture;
  GPUQueue.prototype.writeTexture = function (dst, ...r) { mark(dst); return wt.call(this, dst, ...r); };
  const ce = GPUQueue.prototype.copyExternalImageToTexture;
  GPUQueue.prototype.copyExternalImageToTexture = function (src, dst, ...r) { mark(dst); return ce.call(this, src, dst, ...r); };
});

const files = [];
page.on('response', async (r) => {
  try {
    const url = r.url();
    if (r.status() >= 300 || url.startsWith('data:')) return;
    const body = await r.body();
    const gz = /\.gz(\?|$)/.test(url) || /^(image|font)\//.test(r.headers()['content-type'] || '') ? body.length : zlib.gzipSync(body, { level: 9 }).length;
    files.push({ url: url.replace(/\?.*$/, ''), raw: body.length, gz });
  } catch { /* redirects, aborted */ }
});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${a.port || 8701}/index.html?debug&v=${Date.now()}`, { timeout: 180000 });
await page.waitForFunction(() => window.__slop && window.__slop.scene && window.__slop.scene.children.length > 20,
  null, { timeout: 240000, polling: 500 });
const ready = (Date.now() - t0) / 1000;
await page.waitForTimeout(10000);
const tex = await page.evaluate(() => window.__texBudget.list.filter((e) => !e.destroyed));
await browser.close();

const MB = (b) => +(b / 1e6).toFixed(2), MiB = (b) => +(b / 2 ** 20).toFixed(1);
const sum = (l, k) => l.reduce((s, e) => s + e[k], 0);
const byHost = {};
for (const f of files) { const h = new URL(f.url).host; byHost[h] = (byHost[h] || 0) + f.gz; }
const data = tex.filter((e) => e.uploaded), targets = tex.filter((e) => !e.uploaded);
const result = {
  readySeconds: ready,
  download: { files: files.length, gzMB: MB(sum(files, 'gz')), rawMB: MB(sum(files, 'raw')),
    byHost: Object.fromEntries(Object.entries(byHost).map(([h, b]) => [h, MB(b)])),
    largest: files.sort((x, y) => y.gz - x.gz).slice(0, 15).map((f) => [f.url.replace(/^https?:\/\/[^/]+\//, ''), MB(f.gz)]) },
  textures: { dataCount: data.length, dataMiB: MiB(sum(data, 'b')), targetCount: targets.length, targetMiB: MiB(sum(targets, 'b')),
    largest: data.sort((x, y) => y.b - x.b).slice(0, 15).map((e) => [`${e.w}x${e.h}x${e.l} ${e.format} ${e.label}`.trim(), MiB(e.b)]) },
  errors,
};
if (a.out) fs.writeFileSync(a.out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
