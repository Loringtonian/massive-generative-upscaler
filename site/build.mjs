// Builds dist/ from the master named in the site config.
// Usage: node site/build.mjs [config.json]   (default: site/config.json; paths relative to the config)
// Re-run after a new master lands: tiles are rebuilt only when the master's hash changes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const here = path.dirname(new URL(import.meta.url).pathname);
const configPath = path.resolve(process.argv[2] || path.join(here, 'config.json'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
for (const key of ['masterTiff', 'masterJpeg', 'original']) config[key] = path.resolve(path.dirname(configPath), config[key]);
const src = path.join(here, 'src');
const dist = config.distDir ? path.resolve(path.dirname(configPath), config.distDir) : path.join(here, 'dist');
sharp.cache({ memory: 256 });
sharp.concurrency(2);

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

for (const key of ['masterTiff', 'masterJpeg', 'original']) {
  if (!fs.existsSync(config[key])) throw new Error(`${key} not found: ${config[key]}`);
}
fs.mkdirSync(dist, { recursive: true });

const meta = await sharp(config.masterTiff, { limitInputPixels: false }).metadata();
const originalMeta = await sharp(config.original).metadata();
const masterHash = await sha256(config.masterTiff);
console.log(`master ${config.version}: ${meta.width} x ${meta.height}, sha256 ${masterHash.slice(0, 12)}…`);

// Zoom tiles: maximum-quality JPEG, same settings as the prototype viewer's pyramid.
const tilesDir = path.join(dist, 'tiles');
const stampFile = path.join(tilesDir, 'master.sha256');
const stamp = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : '';
if (stamp !== masterHash) {
  fs.rmSync(tilesDir, { recursive: true, force: true });
  fs.mkdirSync(tilesDir, { recursive: true });
  const started = Date.now();
  await sharp(config.masterTiff, { limitInputPixels: false })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4', mozjpeg: true })
    .tile({ size: 512, overlap: 1, layout: 'dz', depth: 'onepixel' })
    .toFile(path.join(tilesDir, 'poster.dzi'));
  // libvips may name the outputs poster.dzi.dzi / poster.dzi_files; normalise.
  if (fs.existsSync(path.join(tilesDir, 'poster.dzi_files'))) fs.renameSync(path.join(tilesDir, 'poster.dzi_files'), path.join(tilesDir, 'poster_files'));
  if (fs.existsSync(path.join(tilesDir, 'poster.dzi.dzi'))) fs.renameSync(path.join(tilesDir, 'poster.dzi.dzi'), path.join(tilesDir, 'poster.dzi'));
  fs.writeFileSync(stampFile, masterHash + '\n');
  console.log(`tiles rebuilt in ${Math.round((Date.now() - started) / 1000)} s`);
} else {
  console.log('tiles unchanged (same master)');
}

// The original photo, byte for byte.
fs.copyFileSync(config.original, path.join(dist, 'original.jpg'));

// Link-preview image for X and messaging apps.
await sharp(config.masterJpeg, { limitInputPixels: false })
  .resize(1200, 630, { fit: 'contain', background: '#101113', kernel: 'lanczos3' }) // whole image, labels included
  .jpeg({ quality: 88, mozjpeg: true })
  .toFile(path.join(dist, 'og.jpg'));

// Download files. Local preview links them in; production serves them from R2.
const stem = config.downloadName || 'your-image';
const downloads = [
  { key: 'jpeg', from: config.masterJpeg, name: `${stem}_${config.version}.jpg` },
  { key: 'tiff', from: config.masterTiff, name: `${stem}_${config.version}.tif` },
];
const filesDir = path.join(dist, 'files');
fs.rmSync(filesDir, { recursive: true, force: true });
fs.mkdirSync(filesDir, { recursive: true });
const site = {
  version: config.version,
  width: meta.width,
  height: meta.height,
  originalWidth: originalMeta.width,
  originalHeight: originalMeta.height,
  tipUrl: config.tipUrl,
  printUrl: config.printUrl,
  turnstileSiteKey: config.humanCheck ? config.turnstileSiteKey : '',
  protectedDownloads: Boolean(config.protectedDownloads),
  downloads: {},
};
for (const d of downloads) {
  fs.symlinkSync(d.from, path.join(filesDir, d.name));
  site.downloads[d.key] = { url: config.downloadBase + d.name, name: d.name, mb: Math.round(fs.statSync(d.from).size / 1e6) };
}

// Page, script, styles, vendor.
const base = config.siteUrl ? config.siteUrl.replace(/\/$/, '') + '/' : '';
const html = fs
  .readFileSync(path.join(src, 'index.html'), 'utf8')
  .replace('/*SITE*/{}', JSON.stringify(site))
  .replaceAll('{{OG_IMAGE}}', base + 'og.jpg')
  .replaceAll('{{SITE_URL}}', config.siteUrl || '')
  .replaceAll('{{TITLE}}', escapeHtml(config.title || 'Before / after'))
  .replaceAll('{{DESCRIPTION}}', escapeHtml(config.description || ''))
  .replaceAll('{{TIP_LABEL}}', escapeHtml(config.tipLabel || 'Support this work'))
  .replaceAll('{{NOTE}}', escapeHtml(config.note || 'The fine detail in this image is AI-generated: plausible, not recovered from the original.'));
fs.writeFileSync(path.join(dist, 'index.html'), html);
for (const f of ['app.js', 'style.css']) fs.copyFileSync(path.join(src, f), path.join(dist, f));
// Zoom library from npm, with its license.
const osdDir = path.dirname(createRequire(import.meta.url).resolve('openseadragon'));
fs.mkdirSync(path.join(dist, 'vendor'), { recursive: true });
fs.copyFileSync(path.join(osdDir, 'openseadragon.min.js'), path.join(dist, 'vendor/openseadragon.min.js'));
fs.copyFileSync(path.join(osdDir, '../../LICENSE.txt'), path.join(dist, 'vendor/OPENSEADRAGON-LICENSE.txt'));

fs.writeFileSync(
  path.join(dist, 'build.json'),
  JSON.stringify({ builtAt: new Date().toISOString(), masterTiff: path.basename(config.masterTiff), masterSha256: masterHash, ...site }, null, 2),
);
console.log('dist ready');

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
