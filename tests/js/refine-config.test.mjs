import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { axisStarts, tileGrid, transferWeight, loadConfig, DEFAULTS } from '../../refine/config.mjs';

test('axis starts cover the length with the requested overlap', () => {
  const s = axisStarts(0, 1350, 448, 112);
  assert.deepEqual(
    s.map((a) => a.at),
    [0, 336, 672, 902],
  );
  assert.ok(s.every((a) => a.len === 448));
  assert.equal(s.at(-1).at + s.at(-1).len, 1350);
  for (let i = 1; i < s.length; i++) assert.ok(s[i - 1].at + s[i - 1].len - s[i].at >= 112);
});

test('region smaller than a tile gives one tile of the region size', () => {
  assert.deepEqual(axisStarts(10, 300, 512, 128), [{ at: 10, len: 300 }]);
});

test('tile grid covers every pixel of each region, honours skip', () => {
  const tiles = tileGrid(1000, 700, { size: 400, overlap: 100 });
  const covered = new Uint8Array(1000 * 700);
  for (const t of tiles) for (let y = t.y; y < t.y + t.height; y++) covered.fill(1, y * 1000 + t.x, y * 1000 + t.x + t.width);
  assert.ok(covered.every((v) => v === 1));
  const skipped = tileGrid(1000, 700, { size: 400, overlap: 100 }, null, ['r01_c01']);
  assert.equal(skipped.length, tiles.length - 1);
  const two = tileGrid(1000, 700, { size: 200, overlap: 50 }, [
    [0, 0, 300, 300],
    [600, 400, 200, 200],
  ]);
  assert.ok(two.some((t) => t.id.startsWith('a1_')) && two.some((t) => t.id.startsWith('a2_')));
  assert.throws(() => tileGrid(100, 100, { size: 50, overlap: 10 }, [[80, 80, 40, 40]]), /outside/);
});

test('transfer weight is zero inside protected rectangles and at tile borders', () => {
  const t = DEFAULTS.transfer;
  const base = { edge: 50, w: 400, h: 400 };
  assert.equal(transferWeight({ ...base, x: 0, y: 200, gx: 0, gy: 200 }, t, []), 0);
  const mid = transferWeight({ ...base, x: 200, y: 200, gx: 200, gy: 200 }, t, []);
  assert.equal(mid, t.strength);
  assert.equal(transferWeight({ ...base, x: 200, y: 200, gx: 200, gy: 200 }, t, [[190, 190, 20, 20]]), 0);
  const near = transferWeight({ ...base, x: 200, y: 200, gx: 200, gy: 200 }, t, [[210, 190, 20, 20]]);
  assert.ok(near > 0 && near < mid);
  assert.equal(transferWeight({ ...base, edge: 0, x: 200, y: 200, gx: 200, gy: 200 }, t, []), 0);
});

test('config loader resolves paths and validates rectangles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-'));
  const f = path.join(dir, 'c.json');
  fs.writeFileSync(f, JSON.stringify({ input: 'a.png', protected: [[1, 2, 3, 4]] }));
  const cfg = loadConfig(f);
  assert.equal(cfg.input, path.join(dir, 'a.png'));
  assert.equal(cfg.paths.manifest, path.join(dir, 'work/refine/manifest.json'));
  fs.writeFileSync(f, JSON.stringify({ input: 'a.png', protected: [[1, 2, 3]] }));
  assert.throws(() => loadConfig(f), /rectangle/);
  fs.writeFileSync(f, JSON.stringify({ input: 'a.png', tile: { size: 100, overlap: 100 } }));
  assert.throws(() => loadConfig(f), /overlap/);
});
