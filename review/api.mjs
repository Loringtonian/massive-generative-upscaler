// /api/history routes: tile list, version list, comparisons, and immutable tile rebuild jobs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { JOB_ID } from './history.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);

// Reads a request body as text; null once it passes `limit` characters.
export async function readBody(req, limit) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > limit) return null;
  }
  return text;
}

export function createHistoryApi(cfg, history, allowedOrigins) {
  const jobsDir = path.join(cfg.dataDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  const { tiles, allStages, resolveTile, resolveStage, prepareComparison, prepareFullComparison } = history;
  let preparing = false;
  function listJobs() {
    return fs
      .readdirSync(jobsDir)
      .filter((id) => JOB_ID.test(id))
      .map((id) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(jobsDir, id, 'status.json')));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async function handleHistory(req, res, url, send) {
    if (!url.pathname.startsWith('/api/history')) return false;
    if (req.method === 'GET' && url.pathname === '/api/history') {
      send(res, 200, {
        tiles: tiles.map((t) => ({ id: t.id, x: t.x, y: t.y, width: t.width, height: t.height })),
        reference: cfg.reference,
        defaults: cfg.defaults,
        fullImageLabel: cfg.fullImageLabel,
        stages: allStages().map(({ id, label, frame }) => ({ id, label, frame })),
        jobs: listJobs(),
      });
      return true;
    }
    if (req.method !== 'POST') {
      send(res, 405, { error: 'Method not allowed' });
      return true;
    }
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) {
      send(res, 403, { error: 'Invalid origin' });
      return true;
    }
    const text = await readBody(req, 4096);
    if (text === null) {
      send(res, 413, { error: 'Request too large' });
      return true;
    }
    let data;
    try {
      data = JSON.parse(text);
      if (data.tile !== 'full') resolveTile(data.tile);
    } catch (e) {
      send(res, 400, { error: e.message });
      return true;
    }
    if (url.pathname === '/api/history/compare') {
      if (preparing) {
        send(res, 429, { error: 'A comparison is being prepared. Try again shortly.' });
        return true;
      }
      try {
        resolveStage(data.before);
        resolveStage(data.after);
        preparing = true;
        const c = data.tile === 'full' ? await prepareFullComparison(data.before, data.after) : await prepareComparison(data.tile, data.before, data.after);
        send(res, 200, { id: c.id });
      } catch (e) {
        send(res, 400, { error: e.message });
      } finally {
        preparing = false;
      }
      return true;
    }
    if (url.pathname === '/api/history/rebuild') {
      if (data.tile === 'full') {
        send(res, 400, { error: 'Select a tile before rebuilding.' });
        return true;
      }
      try {
        resolveStage(data.stage);
        if (data.stage === cfg.current) throw Error('Choose an earlier stage to rebuild.');
      } catch (e) {
        send(res, 400, { error: e.message });
        return true;
      }
      if (listJobs().some((j) => !['complete', 'failed'].includes(j.phase))) {
        send(res, 429, { error: 'A rebuild is already running.' });
        return true;
      }
      const id = crypto.randomUUID(),
        job = path.join(jobsDir, id);
      fs.mkdirSync(job);
      const defectsFile = path.join(cfg.dataDir, 'defects.json');
      const noteSnapshot = fs.existsSync(defectsFile) ? JSON.parse(fs.readFileSync(defectsFile)) : { revision: 0, defects: [] };
      const comparisonSnapshot = history.readRows();
      const tile = resolveTile(data.tile);
      const relevantNotes = noteSnapshot.defects.filter((d) => {
        const r = comparisonSnapshot.find((c) => c.id === d.comparison)?.overview?.region;
        if (!r) return false;
        const x = (r.x + d.x * r.width) * cfg.reference.width,
          y = (r.y + d.y * r.height) * cfg.reference.height;
        return x >= tile.x && x <= tile.x + tile.width && y >= tile.y && y <= tile.y + tile.height;
      });
      fs.writeFileSync(
        path.join(job, 'request.json'),
        JSON.stringify(
          {
            tile: data.tile,
            stage: data.stage,
            requestedAt: new Date().toISOString(),
            intent: 'Rebuild one tile as an immutable review candidate',
            reviewRevision: noteSnapshot.revision,
            defects: relevantNotes,
          },
          null,
          2,
        ),
      );
      const initial = { id, tile: data.tile, stage: data.stage, phase: 'queued', updatedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(job, 'status.json'), JSON.stringify(initial));
      const log = fs.openSync(path.join(job, 'worker.log'), 'a');
      const child = spawn(process.execPath, [path.join(here, 'rebuild.mjs'), cfg.configPath, id], { stdio: ['ignore', log, log] });
      fs.closeSync(log);
      const failed = (message) => {
        const state = JSON.parse(fs.readFileSync(path.join(job, 'status.json')));
        if (!['complete', 'failed'].includes(state.phase))
          fs.writeFileSync(path.join(job, 'status.json'), JSON.stringify({ ...state, phase: 'failed', error: message, updatedAt: new Date().toISOString() }));
      };
      child.on('error', (e) => failed(e.message));
      child.on('exit', (code, signal) => {
        if (code !== 0) failed(`Worker stopped (${signal || code}).`);
      });
      send(res, 202, initial);
      return true;
    }
    send(res, 404, { error: 'Not found' });
    return true;
  }
  function jobAsset(url) {
    const m = /^\/job\/([a-f0-9-]{36})\/(export-[\w-]+\.jpg|master\.tif|preview\.jpg|provenance\.json)$/.exec(url.pathname);
    return m ? path.join(jobsDir, m[1], m[2]) : null;
  }
  return { handleHistory, jobAsset, listJobs };
}
