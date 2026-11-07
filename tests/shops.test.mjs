import assert from 'node:assert/strict';
import test from 'node:test';

// The shop & bus sign data (js/vlc-shops.js, tools/build-shops.mjs) and the trades the signs spell (shop-signs-kinds.js)
const { SHOP_COUNT, SHOP_DATA, BUS_LINES } = await import('../js/vlc-shops.js');
const { SHOP_KINDS } = await import('../js/shop-signs-kinds.js');

test('every shop point decodes to a known trade inside the city', () => {
  const bytes = Buffer.from(SHOP_DATA, 'base64');
  assert.equal(bytes.length, SHOP_COUNT * 6);
  assert.ok(SHOP_COUNT > 4000, `${SHOP_COUNT} shops`);
  const kinds = new Set();
  for (let i = 0; i < SHOP_COUNT; i++) {
    const x = bytes.readInt16LE(i * 6) / 4, z = bytes.readInt16LE(i * 6 + 2) / 4, k = bytes[i * 6 + 4];
    assert.ok(k < SHOP_KINDS.length, `kind ${k}`);
    assert.ok(Math.abs(x) < 8000 && Math.abs(z) < 8000);
    kinds.add(SHOP_KINDS[k].key);
  }
  for (const key of ['farmacia', 'forn', 'bar', 'restaurant', 'fruiteria']) assert.ok(kinds.has(key), key);
});

test('signs spell trades only: every trade has wording, colours and no duplicate key', () => {
  assert.equal(new Set(SHOP_KINDS.map((k) => k.key)).size, SHOP_KINDS.length);
  for (const k of SHOP_KINDS) {
    assert.ok(k.labels.length > 0 && k.labels.every((l) => l === l.toUpperCase() && l.length <= 26), k.key);
    assert.match(k.bg, /^#[0-9a-f]{6}$/i);
    assert.match(k.fg, /^#[0-9a-f]{6}$/i);
  }
});

test('the bus signs show real EMT lines and destinations', () => {
  assert.ok(BUS_LINES.length >= 12);
  for (const [line, to] of BUS_LINES) {
    assert.match(line, /^[0-9A-Z]{1,3}$/);
    assert.ok(to.length > 2 && !/=>/.test(to), to);
  }
  assert.ok(BUS_LINES.some(([line, to]) => line === '35' && /Estació del Nord/.test(to)));
});
