// Fidelity run: render the game at a viewpoint set, segment it, compare with Street View (docs/fidelity-gaps.md).
//
// usage: node tools/realism/fidelity/run.mjs [--set main|heldout|both] [--site current|baseline|<dir>]
//        [--criteria 1,5] [--only 01,02] [--port 8701] [--batch 10] [--renders <dir>] [--tag name]
//
// --site current = the repo root (default), baseline = .fidelity/baseline-site/ (the game before the gap work).
// Renders go through tools/realism/shot.mjs in batches of <= 10 poses (each batch takes and releases the shared GPU
// lock). --renders <dir> skips rendering and re-segments PNGs already there (e.g. a previous run's renders/).
// Writes .fidelity/out/<set>-<site>-<timestamp>/{renders/, seg.json, compare.json, report.txt} and prints the table.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..', '..');
const FID = path.join(ROOT, '.fidelity');
const PY = path.join(ROOT, '.cache/segenv/bin/python');
const a = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => {
  if (v.startsWith('--')) acc.push([v.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));
const SETS = a.set === 'both' ? ['main', 'heldout'] : [a.set || 'main'];
const site = a.site || 'current';
const siteDir = site === 'current' ? ROOT : site === 'baseline' ? path.join(FID, 'baseline-site') : path.resolve(site);
const BATCH = Math.min(10, +(a.batch || 10));
const only = a.only ? new Set(String(a.only).split(',')) : null;
const VP = JSON.parse(fs.readFileSync(path.join(HERE, 'viewpoints.json'), 'utf8'));
const SV_DIR = { main: path.join(FID, 'sv'), heldout: path.join(FID, 'sv-heldout') };
const SV_SEG = { main: path.join(FID, 'sv-seg.json'), heldout: path.join(FID, 'sv-heldout-seg.json') };
if (!fs.existsSync(PY)) throw new Error(`no segmentation venv at ${PY}: see tools/realism/fidelity/README.md`);
if (!fs.existsSync(path.join(siteDir, 'index.html'))) throw new Error(`no site at ${siteDir}`);

const now = new Date(), p2 = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args[0]} failed (${r.status})`);
  return r.stdout;
};
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

let server = null;
const t0 = Date.now();
try {
  const port = +(a.port || 0) || await freePort();
  for (const set of SETS) {
    const vps = (VP.sets[set] || []).filter((p) => !only || only.has(p.id));
    if (!vps.length) { console.error(`set '${set}': no viewpoints${only ? ' matching --only' : ''}`); continue; }
    if (!fs.existsSync(SV_DIR[set])) { console.error(`set '${set}': no Street View captures at ${SV_DIR[set]}`); continue; }
    const out = path.join(FID, 'out', `${set}-${a.tag || (site.includes('/') ? 'site' : site)}-${stamp}`);
    fs.mkdirSync(out, { recursive: true });
    let renders = a.renders ? path.resolve(a.renders) : path.join(out, 'renders');
    if (!a.renders) {
      if (!server) {
        server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: siteDir, stdio: 'ignore' });
        for (let i = 0; i < 50; i++) {  // wait for the server
          const ok = await new Promise((res) => { const c = net.connect(port, '127.0.0.1', () => { c.end(); res(true); }); c.on('error', () => res(false)); });
          if (ok) break;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      for (let i = 0; i < vps.length; i += BATCH) {
        const f = path.join(out, `poses-${i / BATCH}.json`);
        fs.writeFileSync(f, JSON.stringify(vps.slice(i, i + BATCH).map(({ id, v }) => ({ id, v }))));
        console.error(`[${set}] rendering ${i + 1}-${Math.min(i + BATCH, vps.length)} of ${vps.length} (${site})`);
        run('node', [path.join(ROOT, 'tools/realism/shot.mjs'), '--port', String(port), '--out', renders, '--poses', f, '--time', 'midday']);
        fs.renameSync(path.join(renders, 'shot.json'), path.join(out, `shot-${i / BATCH}.json`));
      }
    }
    const ids = vps.map((p) => p.id).join(',');
    // Google UI masks (svmask.mjs + svmask.py): excluded from Street View and from the game render of the same view
    const UIM = path.join(FID, 'uimask', set);
    const uim = fs.existsSync(path.join(UIM, 'READY')) ? ['--uimask', UIM] : [];  // READY: all masks checked
    if (!uim.length) console.error(`WARNING: no Google UI masks at ${UIM}: Street View numbers include Google's overlays`);
    const svMasked = fs.existsSync(SV_SEG[set]) && !!JSON.parse(fs.readFileSync(SV_SEG[set], 'utf8')).uiMask;
    if (!fs.existsSync(SV_SEG[set]) || (uim.length && !svMasked)) {
      const dir = path.join(FID, `svseg-${set}`);
      fs.mkdirSync(dir, { recursive: true });
      console.error(`[${set}] segmenting the Street View captures once -> ${SV_SEG[set]}`);
      run(PY, [path.join(HERE, 'seg.py'), SV_DIR[set], path.join(dir, 'seg.json'), '--masks', ...uim]);
      fs.copyFileSync(path.join(dir, 'seg.json'), SV_SEG[set]);
    }
    console.error(`[${set}] segmenting ${vps.length} renders`);
    run(PY, [path.join(HERE, 'seg.py'), renders, path.join(out, 'seg.json'), '--only', ids, '--masks', ...uim]);
    const args = [path.join(HERE, 'compare.py'), '--game', path.join(out, 'seg.json'), '--sv', SV_SEG[set], '--set', set,
      '--json', path.join(out, 'compare.json')];
    if (a.criteria) args.push('--criteria', String(a.criteria));
    if (only) args.push('--only', ids);
    const report = run(PY, args, { capture: true });
    fs.writeFileSync(path.join(out, 'report.txt'), `site ${site} (${siteDir})\n${report}`);
    process.stdout.write(`\nsite ${site} -> ${path.relative(ROOT, out)}\n${report}`);
  }
} finally {
  if (server) server.kill();
  console.error(`done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}
