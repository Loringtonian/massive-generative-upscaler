// Copy protected rectangles back from the base, pixel for pixel.
// Library use: preserveProtected({from, base, rects, out, density})
// CLI:         node refine/preserve.mjs <config.json>   (re-applies to the existing export)
import fs from 'node:fs';
import sharp from 'sharp';
import { pathToFileURL } from 'node:url';

export async function preserveProtected({ from, base, rects, out, density = 300 }) {
  const layers = [];
  for (const [left, top, width, height] of rects) {
    const data = await sharp(base, { limitInputPixels: false }).extract({ left, top, width, height }).removeAlpha().raw().toBuffer();
    layers.push({ input: data, raw: { width, height, channels: 3 }, left, top });
  }
  const tmp = out + '.tmp.tif';
  await sharp(from, { limitInputPixels: false })
    .composite(layers)
    .removeAlpha()
    .withMetadata({ density })
    .withIccProfile('srgb')
    .tiff({ compression: 'lzw', predictor: 'horizontal' })
    .toFile(tmp);
  fs.renameSync(tmp, out);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadConfig } = await import('./config.mjs');
  const cfg = loadConfig(process.argv[2]);
  const manifest = JSON.parse(fs.readFileSync(cfg.paths.manifest, 'utf8'));
  const master = `${cfg.paths.exports}/${cfg.output.name}.tif`;
  await preserveProtected({ from: master, base: cfg.paths.base, rects: cfg.protected, out: master, density: manifest.density });
  console.log(`protected regions restored in ${master}`);
}
