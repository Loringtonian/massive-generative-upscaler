// Step 1: build the working base at the target size and cut it into overlapping crops.
// Usage: node refine/prepare.mjs <config.json>
// Writes <workDir>/base.tif, inputs/<id>.png, an empty generated/ folder and manifest.json.
import fs from 'node:fs';
import sharp from 'sharp';
import { loadConfig, tileGrid } from './config.mjs';

sharp.cache({ memory: 128 });
sharp.concurrency(2);

const cfg = loadConfig(process.argv[2]);
const p = cfg.paths;
for (const d of [cfg.workDir, p.inputs, p.generated, p.aligned, p.exports, p.qa]) fs.mkdirSync(d, { recursive: true });

const src = await sharp(cfg.input, { limitInputPixels: false }).metadata();
const width = cfg.target?.width ?? src.width;
const height = cfg.target?.height ?? src.height;

if (!fs.existsSync(p.base)) {
  let img = sharp(cfg.input, { limitInputPixels: false }).removeAlpha();
  if (width !== src.width || height !== src.height) img = img.resize(width, height, { fit: 'fill', kernel: 'lanczos3' });
  await img.withMetadata({ density: cfg.density }).withIccProfile('srgb').tiff({ compression: 'lzw', predictor: 'horizontal' }).toFile(p.base);
}

const tiles = tileGrid(width, height, cfg.tile, cfg.regions, cfg.skip);
for (const t of tiles) {
  const file = `${p.inputs}/${t.id}.png`;
  if (!fs.existsSync(file))
    await sharp(p.base, { limitInputPixels: false }).extract({ left: t.x, top: t.y, width: t.width, height: t.height }).png().toFile(file);
}

const manifest = {
  input: cfg.input,
  base: p.base,
  width,
  height,
  scaleX: width / src.width,
  scaleY: height / src.height,
  density: cfg.density,
  tile: cfg.tile,
  tiles,
};
fs.writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + '\n');
console.log(`base ${width} x ${height}; ${tiles.length} crops in ${p.inputs}`);
console.log(`next: redraw each crop with your image model into ${p.generated}/<same name>.png`);
