import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';

// js/vlc-buildings.bin.gz (tools/realism/build-buildings.py): Catastro footprints at PNOA-LiDAR heights
const { GEO } = await import('../js/bcn-geodata.js');
const raw = gunzipSync(readFileSync(new URL('../js/vlc-buildings.bin.gz', import.meta.url)));
const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);

test('the real-building file is well formed and covers the detailed city', () => {
  assert.equal(raw.subarray(0, 4).toString(), 'VLB3');
  const n = view.getUint32(4, true);
  const nb = view.getUint32(8, true);
  const nh = view.getUint32(12, true);
  const lens = Array.from({ length: 10 }, (_, k) => view.getUint32(16 + k * 4, true));
  assert.equal(56 + lens.reduce((a, b) => a + b, 0), raw.length, 'sections fill the file');
  assert.equal(lens[9], nb * 3 + ((-(nb * 3)) & 3), 'a roof colour per box');
  assert.ok(n > 15000 && nb > 100000, `${n} buildings, ${nb} boxes`);
  assert.ok(nh > 1000, `${nh} roof houses`);
  assert.equal(lens[5], nb + ((-nb) & 3), 'a roof kind per box');
  let at = 56;
  const take = (len) => { const b = raw.subarray(at, at + len); at += len; return Buffer.from(b); };
  const frames = new Float32Array(take(lens[0]).buffer.slice(0), 0, n * 3);
  take(lens[1]);
  const countsBuf = take(lens[2]);
  const counts = new Uint16Array(countsBuf.buffer, countsBuf.byteOffset, n);
  const boxBuf = take(lens[3]);
  const boxes = new Int16Array(boxBuf.buffer, boxBuf.byteOffset, nb * 5);
  assert.equal(counts.reduce((a, b) => a + b, 0), nb, 'box counts add up');
  const D = GEO.frame.detail;
  let k = 0, tall = 0;
  for (let i = 0; i < n; i++) {
    const [px, pz] = [frames[i * 3], frames[i * 3 + 1]];
    assert.ok(px > D.x0 - 200 && px < D.x1 + 200 && pz > D.z0 - 200 && pz < D.z1 + 200, `building ${i} inside the detailed city`);
    for (let j = 0; j < counts[i]; j++, k++) {
      const [x0, x1, z0, z1, h] = boxes.subarray(k * 5, k * 5 + 5);
      assert.ok(x1 > x0 && z1 > z0, 'a box has extent');
      assert.ok(h >= 20 && h <= 1600, `height ${h / 10} m`);
      if (h > 600) tall++;
    }
  }
  // València's tallest are a few dozen towers over 60 m, not thousands
  assert.ok(tall > 5 && tall < 2000, `${tall} boxes over 60 m`);
});
