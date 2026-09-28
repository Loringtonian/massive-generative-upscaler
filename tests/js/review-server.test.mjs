import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { loadReviewConfig } from '../../review/config.mjs';
import { checkRebuild } from '../../review/check-rebuild.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
let dir, port, server, base;

async function noise(w, h, seed) {
  const buf = Buffer.alloc(w * h * 3);
  let s = seed;
  for (let i = 0; i < buf.length; i++) buf[i] = (s = (s * 1103515245 + 12345) & 0x7fffffff) >> 23;
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).blur(1.2);
}
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
function request(method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode, text, json, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-review-'));
  const work = path.join(dir, 'refine');
  for (const d of ['generated', 'aligned', 'exports']) fs.mkdirSync(path.join(work, d), { recursive: true });
  await (await noise(300, 200, 1)).png().toFile(path.join(dir, 'source.png'));
  await (await noise(300, 200, 1)).resize(600, 400).png().toFile(path.join(dir, 'upscaled.png'));
  await (await noise(300, 200, 1)).resize(600, 400).sharpen().withMetadata({ density: 300 }).tiff().toFile(path.join(work, 'exports/refined.tif'));
  await sharp(path.join(dir, 'upscaled.png')).resize(300).jpeg().toFile(path.join(work, 'exports/preview.jpg'));
  const tiles = [
    { id: 'r01_c01', x: 0, y: 0, width: 320, height: 320 },
    { id: 'r01_c02', x: 280, y: 80, width: 320, height: 320 },
  ];
  for (const t of tiles)
    for (const d of ['generated', 'aligned'])
      await sharp(path.join(dir, 'upscaled.png'))
        .extract({ left: t.x, top: t.y, width: t.width, height: t.height })
        .png()
        .toFile(path.join(work, d, t.id + '.png'));
  fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({ width: 600, height: 400, density: 300, tiles }));
  port = await freePort();
  base = {
    port,
    dataDir: 'data',
    refineWorkDir: 'refine',
    overview: 'refine/exports/preview.jpg',
    versions: [
      { id: 'source', label: 'Original', path: 'source.png' },
      { id: 'upscaled', label: 'Upscaled', path: 'upscaled.png' },
      { id: 'current', label: 'Refined', path: 'refine/exports/refined.tif' },
    ],
    exports: [{ name: 'small', width: 200 }],
    rebuild: { feather: 20, seamPad: 20 },
  };
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify(base));
  server = spawn(process.execPath, [path.join(root, 'review/server.mjs'), path.join(dir, 'review.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => d.toString().includes('Image review') && resolve());
    server.on('exit', (code) => reject(new Error('server exited ' + code)));
    setTimeout(() => reject(new Error('server did not start')), 10000);
  });
});

after(() => {
  server?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('serves the page, script and zoom library', async () => {
  assert.equal((await request('GET', '/')).status, 200);
  assert.equal((await request('GET', '/review.js')).status, 200);
  const v = await request('GET', '/vendor.js');
  assert.equal(v.status, 200);
  assert.ok(v.text.length > 100000);
});

test('rejects foreign Host headers and cross-site writes', async () => {
  assert.equal((await request('GET', '/', { headers: { host: 'evil.example.com' } })).status, 403);
  assert.equal((await request('GET', '/', { headers: { host: `192.168.1.5:${port}` } })).status, 403);
  const r = await request('POST', '/api/review', { body: { revision: 0, defects: [] }, headers: { origin: 'https://evil.example.com' } });
  assert.equal(r.status, 403);
  const h = await request('POST', '/api/history/compare', {
    body: { tile: 'full', before: 'source', after: 'current' },
    headers: { origin: 'https://evil.example.com' },
  });
  assert.equal(h.status, 403);
});

test('serves only registry images, never arbitrary paths', async () => {
  assert.equal((await request('GET', '/image/nope/before')).status, 404);
  assert.equal((await request('GET', '/../package.json')).status, 404);
  assert.equal((await request('GET', '/tiles/nope/0/0_0.jpeg')).status, 404);
});

test('history lists tiles, reference size and versions', async () => {
  const r = await request('GET', '/api/history');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.reference, { width: 600, height: 400 });
  assert.equal(r.json.tiles.length, 2);
  assert.deepEqual(
    r.json.stages.map((s) => s.id),
    ['source', 'upscaled', 'current', 'generated', 'aligned'],
  );
});

test('prepares full-image, tile and mixed comparisons and serves their images', async () => {
  const full = await request('POST', '/api/history/compare', { body: { tile: 'full', before: 'source', after: 'current' } });
  assert.equal(full.status, 200);
  const tile = await request('POST', '/api/history/compare', { body: { tile: 'r01_c02', before: 'generated', after: 'upscaled' } });
  assert.equal(tile.status, 200);
  const pair = await request('POST', '/api/pair', { body: { left: 'source', right: 'current' } });
  assert.equal(pair.status, 200);
  const review = await request('GET', '/api/review');
  const c = review.json.comparisons.find((c) => c.id === tile.json.id);
  assert.equal(c.before.pixelWidth, 320);
  assert.equal((await request('GET', c.after.url)).status, 200);
  const unknown = await request('POST', '/api/history/compare', { body: { tile: 'r09_c09', before: 'source', after: 'current' } });
  assert.equal(unknown.status, 400);
});

test('saves notes with revision checks and validation', async () => {
  const state = (await request('GET', '/api/review')).json;
  const comparison = state.comparisons[0].id;
  const note = { id: 'n1', comparison, x: 0.5, y: 0.5, radius: 0.03, note: 'halo here', category: 'halo', action: 'rework', status: 'open' };
  const bad = await request('POST', '/api/review', { body: { revision: state.revision, defects: [{ ...note, x: 2 }] } });
  assert.equal(bad.status, 400);
  assert.equal((await request('POST', '/api/review', { body: '{nope' })).status, 400);
  const ok = await request('POST', '/api/review', { body: { revision: state.revision, defects: [note] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.revision, state.revision + 1);
  const stale = await request('POST', '/api/review', { body: { revision: state.revision, defects: [note] } });
  assert.equal(stale.status, 409);
  assert.ok(fs.existsSync(path.join(dir, 'data/history', `notes-r${state.revision}.json`)));
});

test('tile rebuild changes only the tile and passes the rebuild check', async () => {
  const r = await request('POST', '/api/history/rebuild', { body: { tile: 'r01_c02', stage: 'upscaled' } });
  assert.equal(r.status, 202);
  const statusFile = path.join(dir, 'data/jobs', r.json.id, 'status.json');
  let phase;
  for (let i = 0; i < 100; i++) {
    phase = JSON.parse(fs.readFileSync(statusFile)).phase;
    if (phase === 'complete' || phase === 'failed') break;
    await new Promise((res) => setTimeout(res, 200));
  }
  assert.equal(phase, 'complete', fs.readFileSync(path.join(dir, 'data/jobs', r.json.id, 'worker.log'), 'utf8'));
  const result = await checkRebuild(loadReviewConfig(path.join(dir, 'review.json')), r.json.id);
  assert.equal(result.outsidePixelsChanged, 0);
  assert.ok(result.insidePixelsChanged > 0);
  assert.equal((await request('GET', `/job/${r.json.id}/export-small.jpg`)).status, 200);
  assert.equal((await request('POST', '/api/history/rebuild', { body: { tile: 'r01_c02', stage: 'current' } })).status, 400);
});
