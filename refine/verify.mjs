// Step 5: check the refined export. Usage: node refine/verify.mjs <config.json>
// Checks dimensions and ppi, that every protected rectangle is pixel-identical to the base,
// records sha256 hashes, and writes side-by-side before/after crops for eyeballing.
import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { loadConfig } from './config.mjs';

sharp.cache({ memory: 128 });
sharp.concurrency(2);
const cfg = loadConfig(process.argv[2]);
const p = cfg.paths;
const manifest = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
const master = `${p.exports}/${cfg.output.name}.tif`;
const problems = [];

const protectedRegions = [];
for (const [left, top, width, height] of cfg.protected) {
  const r = { left, top, width, height };
  const a = await sharp(p.base, { limitInputPixels: false }).extract(r).removeAlpha().raw().toBuffer();
  const b = await sharp(master, { limitInputPixels: false }).extract(r).removeAlpha().raw().toBuffer();
  protectedRegions.push({ region: r, identical: a.equals(b) });
  if (!a.equals(b)) problems.push(`protected region ${JSON.stringify(r)} changed`);
}

const size = Math.min(cfg.verify?.sampleSize ?? 512, manifest.width, manifest.height);
const samples = cfg.verify?.samples ?? [
  [0.25, 0.5],
  [0.5, 0.5],
  [0.75, 0.5],
];
const sampleFiles = [];
for (const [fx, fy] of samples) {
  const left = Math.max(0, Math.min(manifest.width - size, Math.round(fx * manifest.width - size / 2)));
  const top = Math.max(0, Math.min(manifest.height - size, Math.round(fy * manifest.height - size / 2)));
  const r = { left, top, width: size, height: size };
  const a = await sharp(p.base, { limitInputPixels: false }).extract(r).png().toBuffer();
  const b = await sharp(master, { limitInputPixels: false }).extract(r).png().toBuffer();
  const file = `${p.qa}/sample-${left}-${top}-before-after.png`;
  await sharp({ create: { width: size * 2, height: size, channels: 3, background: 'white' } })
    .composite([
      { input: a, left: 0, top: 0 },
      { input: b, left: size, top: 0 },
    ])
    .png()
    .toFile(file);
  sampleFiles.push(file);
}

const outputs = [];
for (const f of [p.base, master, `${p.exports}/${cfg.output.name}.jpg`]) {
  if (!fs.existsSync(f)) continue;
  const m = await sharp(f, { limitInputPixels: false }).metadata();
  const h = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(f)) h.update(c);
  outputs.push({ path: f, width: m.width, height: m.height, density: m.density, space: m.space, sha256: h.digest('hex') });
  if (m.width !== manifest.width || m.height !== manifest.height) problems.push(`${f}: ${m.width}x${m.height}, expected ${manifest.width}x${manifest.height}`);
  if (m.density !== manifest.density) problems.push(`${f}: density ${m.density}, expected ${manifest.density}`);
}

const report = { ok: problems.length === 0, problems, protectedRegions, outputs, samples: sampleFiles };
fs.writeFileSync(`${p.qa}/verification.json`, JSON.stringify(report, null, 2) + '\n');
console.log(report.ok ? `verified: ${outputs.length} files, ${protectedRegions.length} protected regions identical` : problems.join('\n'));
if (!report.ok) process.exit(1);
