// Local before/after review screen with defect pins and a version history.
// Usage: node review/server.mjs [review.config.json]   (PORT env overrides config.port, default 8779)
// Listens on localhost only; rejects foreign Host and Origin headers; serves images only from the registry.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { loadReviewConfig } from './config.mjs';
import { createHistory } from './history.mjs';
import { createHistoryApi } from './api.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const publicDir = path.join(here, 'public');
const vendor = path.join(path.dirname(createRequire(import.meta.url).resolve('openseadragon')), 'openseadragon.min.js');
const cfg = loadReviewConfig();
const port = cfg.port;
const history = createHistory(cfg);
const hosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];
const origins = () => hosts().map((h) => 'http://' + h);
const { handleHistory, jobAsset } = createHistoryApi(cfg, history, { includes: (o) => origins().includes(o) });
const file = path.join(cfg.dataDir, 'defects.json');
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ revision: 0, defects: [] }, null, 2));
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tif': 'image/tiff',
  '.json': 'application/json',
};
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
const server = http.createServer(async (req, res) => {
  try {
    if (!hosts().includes(req.headers.host)) return send(res, 403, { error: 'Invalid host' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (await handleHistory(req, res, url, send)) return;
    const comparisons = history.readRows();
    if (url.pathname === '/api/pair' && req.method === 'POST') {
      if (req.headers.origin && !origins().includes(req.headers.origin)) return send(res, 403, { error: 'Invalid origin' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) return send(res, 413, { error: 'Request too large' });
      }
      try {
        const data = JSON.parse(body);
        if (typeof data.left !== 'string' || typeof data.right !== 'string') throw Error('Choose both image versions');
        const c = await history.prepareMixedComparison(data.left, data.right, data.comparison, data.keepRegion === true);
        return send(res, 200, { id: c.id });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (url.pathname === '/api/review' && req.method === 'GET')
      return send(res, 200, {
        comparisons: comparisons.map((c) => ({
          ...c,
          before: { ...c.before, url: `/image/${c.id}/before` },
          after: { ...c.after, url: `/image/${c.id}/after` },
          overview: c.overview ? { ...c.overview, url: `/image/${c.id}/overview` } : null,
        })),
        ...JSON.parse(fs.readFileSync(file)),
      });
    if (url.pathname === '/api/review' && req.method === 'POST') {
      if (req.headers.origin && !origins().includes(req.headers.origin)) return send(res, 403, { error: 'Invalid origin' });
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1000000) return send(res, 413, { error: 'Too many notes' });
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return send(res, 400, { error: 'Invalid JSON' });
      }
      const current = JSON.parse(fs.readFileSync(file));
      if (data.revision !== current.revision) return send(res, 409, { error: 'Notes changed in another tab. Export your notes, then refresh before saving.' });
      if (!Array.isArray(data.defects) || data.defects.length > 1000) return send(res, 400, { error: 'Invalid notes' });
      const ids = new Set();
      for (const d of data.defects) {
        if (
          typeof d.id !== 'string' ||
          d.id.length > 100 ||
          ids.has(d.id) ||
          !comparisons.some((c) => c.id === d.comparison) ||
          ![d.x, d.y, d.radius].every(Number.isFinite) ||
          d.x < 0 ||
          d.x > 1 ||
          d.y < 0 ||
          d.y > 1 ||
          d.radius < 0.005 ||
          d.radius > 0.25 ||
          typeof d.note !== 'string' ||
          d.note.length > 4000 ||
          !['rework', 'restore-before'].includes(d.action) ||
          !['open', 'fixed', 'verified'].includes(d.status) ||
          !['geometry', 'texture', 'halo', 'other'].includes(d.category)
        )
          return send(res, 400, { error: 'Invalid defect data' });
        ids.add(d.id);
      }
      fs.mkdirSync(path.join(cfg.dataDir, 'history'), { recursive: true });
      fs.writeFileSync(path.join(cfg.dataDir, `history/notes-r${current.revision}.json`), JSON.stringify(current, null, 2));
      const next = {
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        defects: data.defects.map((d) => {
          const c = comparisons.find((c) => c.id === d.comparison);
          return { ...d, beforeVersion: c.before.version, afterVersion: c.after.version };
        }),
      };
      fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2));
      fs.renameSync(file + '.tmp', file);
      return send(res, 200, next);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    let target = jobAsset(url);
    const tileMatch = /^\/tiles\/([\w-]+)\/(\d+)\/(\d+_\d+\.jpeg)$/.exec(url.pathname);
    if (tileMatch) {
      try {
        target = path.join(history.pyramidDirectory(tileMatch[1]), tileMatch[2], tileMatch[3]);
      } catch {
        return send(res, 404, { error: 'Unknown image version' });
      }
    }
    if (!target) {
      if (url.pathname === '/') target = path.join(publicDir, 'index.html');
      else if (['/review.js', '/review.css'].includes(url.pathname)) target = path.join(publicDir, url.pathname.slice(1));
      else if (url.pathname === '/vendor.js') target = vendor;
      else {
        const match = /^\/image\/([\w-]+)\/(before|after|overview)$/.exec(url.pathname);
        const c = match && comparisons.find((c) => c.id === match[1]);
        if (c && c[match[2]]) target = path.resolve(cfg.dataDir, c[match[2]].path);
      }
    }
    if (!target || !fs.existsSync(target)) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': mime[path.extname(target)] || 'application/octet-stream',
      'Content-Length': fs.statSync(target).size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    await pipeline(fs.createReadStream(target), res);
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: 'Could not save or load review data' });
    else res.destroy();
    console.error(e.message);
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Image review: http://127.0.0.1:${port}`));
