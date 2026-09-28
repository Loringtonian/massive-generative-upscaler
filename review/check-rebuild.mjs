// Check a finished rebuild job. Usage: node review/check-rebuild.mjs <review.config.json> <job-id>
// Passes when: master dimensions and ppi match the parent, every pixel outside the tile is
// identical to the parent, the tile itself changed, and each JPEG export has the expected width.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { loadReviewConfig } from './config.mjs';
import { createHistory } from './history.mjs';

export async function checkRebuild(cfg, jobId) {
  const history = createHistory(cfg);
  const job = path.join(cfg.dataDir, 'jobs', jobId);
  const provenance = JSON.parse(fs.readFileSync(path.join(job, 'provenance.json')));
  const parent = history.resolveStage(cfg.current).path,
    master = path.join(job, 'master.tif');
  const pm = await sharp(parent, { limitInputPixels: false }).metadata(),
    mm = await sharp(master, { limitInputPixels: false }).metadata();
  assert.equal(mm.width, pm.width);
  assert.equal(mm.height, pm.height);
  assert.equal(mm.density, pm.density || 300);
  for (const { name, width } of cfg.exports) {
    const m = await sharp(path.join(job, `export-${name}.jpg`)).metadata();
    assert.equal(m.width, width, `export ${name} width`);
  }
  const { left, top, width, height } = provenance.tileInMasterPx;
  let outsideDiff = 0,
    insideDiff = 0;
  // Compare in horizontal bands so memory stays bounded on very large masters.
  for (let y0 = 0; y0 < pm.height; y0 += 512) {
    const r = { left: 0, top: y0, width: pm.width, height: Math.min(512, pm.height - y0) };
    const a = await sharp(parent, { limitInputPixels: false }).extract(r).removeAlpha().raw().toBuffer();
    const b = await sharp(master, { limitInputPixels: false }).extract(r).removeAlpha().raw().toBuffer();
    for (let dy = 0; dy < r.height; dy++)
      for (let x = 0; x < pm.width; x++) {
        const y = y0 + dy,
          i = (dy * pm.width + x) * 3;
        if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) continue;
        if (x >= left && x < left + width && y >= top && y < top + height) insideDiff++;
        else outsideDiff++;
      }
  }
  assert.equal(outsideDiff, 0, 'Pixels changed outside the selected tile');
  assert(insideDiff > 0, 'Rebuild did not change the selected tile');
  const result = {
    checkedAt: new Date().toISOString(),
    outsidePixelsChanged: outsideDiff,
    insidePixelsChanged: insideDiff,
    note: 'Checks validate processing, not restoration quality. Review the tile and seam comparisons.',
  };
  fs.writeFileSync(path.join(job, 'validation.json'), JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await checkRebuild(loadReviewConfig(process.argv[2]), process.argv[3])));
}
