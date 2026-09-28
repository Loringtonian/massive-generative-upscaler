// Step 4: bounded high-frequency detail transfer.
// Usage: node refine/assemble.mjs <config.json> [--force]
//
// For each registered crop, only the difference in fine luminance detail (image minus its own
// blur) is added to the base, and only where the base already has an edge. Base colour, smooth
// areas and low-frequency geometry stay fixed. Each change is clamped to +/- transfer.maxDelta
// code values, scaled by transfer.strength, feathered at tile borders, and faded to zero near
// protected rectangles. Protected rectangles are then copied back from the base pixel for pixel.
import fs from 'node:fs';
import sharp from 'sharp';
import { loadConfig, transferWeight } from './config.mjs';
import { preserveProtected } from './preserve.mjs';

sharp.cache({ memory: 128, files: 10, items: 20 });
sharp.concurrency(2);

const cfg = loadConfig(process.argv[2]);
const force = process.argv.includes('--force');
const p = cfg.paths;
const t = cfg.transfer;
const manifest = JSON.parse(fs.readFileSync(p.manifest, 'utf8'));
const regs = fs.existsSync(p.registration) ? JSON.parse(fs.readFileSync(p.registration, 'utf8')) : [];
const protectedRects = cfg.protected;
const master = `${p.exports}/${cfg.output.name}.tif`;
if (fs.existsSync(master) && !force) throw new Error(`${master} exists; pass --force to replace it`);
fs.mkdirSync(p.qa, { recursive: true });

const layers = [];
const audit = [];
for (const tile of manifest.tiles) {
  const aligned = `${p.aligned}/${tile.id}.png`;
  if (!fs.existsSync(`${p.generated}/${tile.id}.png`)) {
    audit.push({ id: tile.id, status: 'unchanged (no generated crop)' });
    continue;
  }
  const r = regs.find((r) => r.id === tile.id);
  if (!r || !r.pass || !fs.existsSync(aligned))
    throw new Error(`registration failed or missing for ${tile.id}: run refine/register.py, or delete its generated crop`);
  const W = tile.width,
    H = tile.height;
  const raw = { raw: { width: W, height: H, channels: 3 } };
  const base = await sharp(`${p.inputs}/${tile.id}.png`).removeAlpha().raw().toBuffer();
  const gen = await sharp(aligned).removeAlpha().raw().toBuffer();
  const bb = await sharp(base, raw).blur(t.blur).raw().toBuffer();
  const gb = await sharp(gen, raw).blur(t.blur).raw().toBuffer();
  const out = Buffer.alloc(W * H * 4);
  let changed = 0,
    maxAdjust = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const px = y * W + x,
        j = px * 3,
        k = px * 4;
      let edge = 0;
      for (let c = 0; c < 3; c++) edge = Math.max(edge, Math.abs(base[j + c] - bb[j + c]));
      const weight = transferWeight({ edge, x, y, w: W, h: H, gx: tile.x + x, gy: tile.y + y }, t, protectedRects);
      const hf =
        (gen[j] - gb[j] + (gen[j + 1] - gb[j + 1]) + (gen[j + 2] - gb[j + 2]) - (base[j] - bb[j]) - (base[j + 1] - bb[j + 1]) - (base[j + 2] - bb[j + 2])) / 3;
      const delta = Math.max(-t.maxDelta, Math.min(t.maxDelta, hf));
      for (let c = 0; c < 3; c++) out[k + c] = Math.max(0, Math.min(255, Math.round(base[j + c] + delta * weight)));
      // Feathered alpha so overlapping tiles blend instead of overwriting each other.
      out[k + 3] = Math.round(255 * Math.max(0, Math.min(1, x / t.feather, y / t.feather, (W - 1 - x) / t.feather, (H - 1 - y) / t.feather)));
      const adj = Math.abs(delta * weight);
      if (adj >= 0.5) changed++;
      if (adj > maxAdjust) maxAdjust = adj;
    }
  const layer = `${p.aligned}/${tile.id}-layer.png`;
  await sharp(out, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toFile(layer);
  layers.push({ input: layer, left: tile.x, top: tile.y });
  audit.push({ id: tile.id, status: 'bounded luminance refinement', changedPixels: changed, maxAdjustment: +maxAdjust.toFixed(2), registration: r });
  console.log(`${tile.id}: ${changed} pixels adjusted (max ${maxAdjust.toFixed(1)} code values)`);
}

const assembled = `${p.qa}/assembled-before-preservation.tif`;
await sharp(p.base, { limitInputPixels: false }).composite(layers).removeAlpha().tiff({ compression: 'lzw', predictor: 'horizontal' }).toFile(assembled);
await preserveProtected({ from: assembled, base: p.base, rects: protectedRects, out: master, density: manifest.density });
if (cfg.output.jpeg)
  await sharp(master, { limitInputPixels: false })
    .withMetadata({ density: manifest.density })
    .withIccProfile('srgb')
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toFile(`${p.exports}/${cfg.output.name}.jpg`);
if (cfg.output.preview)
  await sharp(master, { limitInputPixels: false })
    .resize({ width: Math.min(cfg.output.preview, manifest.width) })
    .jpeg({ quality: 95 })
    .toFile(`${p.exports}/preview.jpg`);
fs.writeFileSync(`${p.qa}/assembly-audit.json`, JSON.stringify(audit, null, 2) + '\n');
console.log(`wrote ${master}`);
