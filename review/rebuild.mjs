// Rebuild worker: replaces one tile of the current master with the same area from an earlier
// version, as a new immutable candidate. Spawned by the review server.
// Usage: node review/rebuild.mjs <review.config.json> <job-id>
//
// 1. Crop the chosen version at the tile, resize to the master's tile size.
// 2. Keep the master's broad colour/lighting: replacement = crop - blur(crop) + blur(master tile).
// 3. Feather it into the master; every pixel outside the tile is copied from the master unchanged.
// 4. Write master.tif, optional JPEG exports, a preview, viewer tiles, and tile/seam comparisons.
// No new generative pass happens here: a fresh redraw goes through refine/ and is registered first.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { loadReviewConfig } from './config.mjs';
import { createHistory, JOB_ID } from './history.mjs';

const cfg = loadReviewConfig(process.argv[2]);
const jobId = process.argv[3];
if (!JOB_ID.test(jobId || '')) throw Error('Invalid job');
const history = createHistory(cfg);
const job = path.join(cfg.dataDir, 'jobs', jobId),
  request = JSON.parse(fs.readFileSync(path.join(job, 'request.json')));
const tile = history.resolveTile(request.tile);
history.resolveStage(request.stage);
sharp.cache({ memory: 128 });
sharp.concurrency(2);
const stateFile = path.join(job, 'status.json');
function status(phase, extra = {}) {
  const state = { id: jobId, tile: tile.id, stage: request.stage, phase, updatedAt: new Date().toISOString(), ...extra };
  fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(stateFile + '.tmp', stateFile);
}
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const tiff = { compression: 'lzw', predictor: 'horizontal' };

try {
  const current = history.resolveStage(cfg.current);
  const masterIn = current.path;
  const meta = await sharp(masterIn, { limitInputPixels: false }).metadata();
  const density = meta.density || 300;
  const kx = meta.width / cfg.reference.width,
    ky = meta.height / cfg.reference.height;
  const tx = Math.round(tile.x * kx),
    ty = Math.round(tile.y * ky);
  const tw = Math.round((tile.x + tile.width) * kx) - tx,
    th = Math.round((tile.y + tile.height) * ky) - ty;

  status('Preparing tile');
  const selected = await history.stageImage(tile.id, request.stage);
  fs.copyFileSync(selected, path.join(job, 'selected-source.png'));
  const raw = { raw: { width: tw, height: th, channels: 3 } };
  const src = await sharp(selected).resize(tw, th, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
  const mst = await sharp(masterIn, { limitInputPixels: false }).extract({ left: tx, top: ty, width: tw, height: th }).removeAlpha().raw().toBuffer();
  const sigma = Math.max(0.3, cfg.rebuild.colorMatchSigma * kx);
  const srcLow = await sharp(src, raw).blur(sigma).raw().toBuffer();
  const mstLow = await sharp(mst, raw).blur(sigma).raw().toBuffer();
  const F = Math.max(1, Math.min(cfg.rebuild.feather * kx, tw / 2, th / 2));
  const patch = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const p = y * tw + x;
      for (let c = 0; c < 3; c++) patch[p * 4 + c] = Math.max(0, Math.min(255, Math.round(src[p * 3 + c] - srcLow[p * 3 + c] + mstLow[p * 3 + c])));
      patch[p * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, x / F, y / F, (tw - 1 - x) / F, (th - 1 - y) / F)));
    }
  const patchFile = path.join(job, 'replacement-tile.png');
  await sharp(patch, { raw: { width: tw, height: th, channels: 4 } })
    .png()
    .toFile(patchFile);

  status('Building full-resolution TIFF');
  const master = path.join(job, 'master.tif');
  await sharp(masterIn, { limitInputPixels: false })
    .composite([{ input: patchFile, left: tx, top: ty }])
    .removeAlpha()
    .withMetadata({ density })
    .withIccProfile('srgb')
    .tiff(tiff)
    .toFile(master);
  const provenance = {
    ...request,
    jobId,
    createdAt: new Date().toISOString(),
    pipeline: 'Tile from chosen version -> low-frequency colour match to current master -> feathered composite -> master, exports, viewer tiles',
    selectedSourceSha256: hash(selected),
    replacementSha256: hash(patchFile),
    parentMasterSha256: hash(masterIn),
    tileInMasterPx: { left: tx, top: ty, width: tw, height: th },
    note: 'No new generative restoration is performed. Pixels outside the tile are copied unchanged from the current master.',
  };

  status('Exporting JPEGs');
  const outputs = [];
  for (const { name, width } of cfg.exports) {
    const filename = `export-${name}.jpg`;
    await sharp(master, { limitInputPixels: false })
      .resize({ width })
      .withMetadata({ density })
      .withIccProfile('srgb')
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4', mozjpeg: true })
      .toFile(path.join(job, filename));
    outputs.push({ filename, bytes: fs.statSync(path.join(job, filename)).size });
  }

  status('Building viewer tiles and comparisons');
  await history.buildPyramid(master, path.join(job, 'pyramid_files'));
  await sharp(master, { limitInputPixels: false })
    .resize({ width: Math.min(2400, meta.width) })
    .jpeg({ quality: 95 })
    .toFile(path.join(job, 'preview.jpg'));
  const RW = cfg.reference.width,
    RH = cfg.reference.height;
  const comparisons = [];
  for (const [suffix, pad] of [
    ['tile', 0],
    ['seams', cfg.rebuild.seamPad],
  ]) {
    const x = Math.max(0, tile.x - pad),
      y = Math.max(0, tile.y - pad),
      right = Math.min(RW, tile.x + tile.width + pad),
      bottom = Math.min(RH, tile.y + tile.height + pad);
    const left = Math.round(x * kx),
      top = Math.round(y * ky),
      width = Math.round(right * kx) - left,
      height = Math.round(bottom * ky) - top;
    for (const [side, input] of [
      ['before', masterIn],
      ['after', master],
    ])
      await sharp(input, { limitInputPixels: false })
        .extract({ left, top, width, height })
        .png()
        .toFile(path.join(job, `${suffix}-${side}.png`));
    comparisons.push({
      id: `rebuild-${jobId}-${suffix}`,
      title: `${tile.id} · rebuilt from ${request.stage} · ${suffix}`,
      before: { label: 'Current master', version: cfg.current, path: path.relative(cfg.dataDir, path.join(job, `${suffix}-before.png`)) },
      after: { label: `Rebuilt from ${request.stage}`, version: jobId, path: path.relative(cfg.dataDir, path.join(job, `${suffix}-after.png`)) },
      overview: history.overview(history.tileRegion({ x, y, width: right - x, height: bottom - y })),
      history: { tile: tile.id, job: jobId },
    });
  }
  // Re-read only at commit time to keep comparisons added while the worker ran.
  for (const c of comparisons) history.upsert(c);
  const out = await sharp(master, { limitInputPixels: false }).metadata();
  if (out.width !== meta.width || out.height !== meta.height) throw Error('Output verification failed');
  provenance.outputs = outputs;
  fs.writeFileSync(path.join(job, 'provenance.json'), JSON.stringify(provenance, null, 2));
  status('complete', { outputs, comparisons: comparisons.map((c) => c.id), requiresReview: true });
} catch (e) {
  status('failed', { error: e.message });
  process.exitCode = 1;
}
