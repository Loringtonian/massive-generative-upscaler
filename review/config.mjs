// Review screen configuration. Paths in the config are relative to the config file.
// Config file: argv[2], else $REVIEW_CONFIG, else ./review.config.json.
import fs from 'node:fs';
import path from 'node:path';

export function loadReviewConfig(file = process.argv[2] || process.env.REVIEW_CONFIG || 'review.config.json') {
  const configPath = path.resolve(file);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const base = path.dirname(configPath);
  const rel = (p) => (p ? path.resolve(base, p) : null);
  const dataDir = rel(raw.dataDir || 'review-data');
  const refineWorkDir = rel(raw.refineWorkDir);
  const manifestFile = refineWorkDir && path.join(refineWorkDir, 'manifest.json');
  const manifest = manifestFile && fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
  const versions = (raw.versions || []).map((v) => ({ ...v, path: rel(v.path), pyramid: rel(v.pyramid) || undefined }));
  const reference = raw.reference || (manifest ? { width: manifest.width, height: manifest.height } : null);
  if (!reference) throw new Error('config.reference {width, height} is required when no refine manifest is available');
  const cfg = {
    configPath,
    port: Number(process.env.PORT || raw.port || 8779),
    dataDir,
    overview: rel(raw.overview),
    reference,
    refineWorkDir,
    tiles: manifest ? manifest.tiles : [],
    versions,
    defaults: { left: 'source', right: 'current', ...raw.defaults },
    current: raw.current || 'current',
    exports: raw.exports || [],
    rebuild: { feather: 100, colorMatchSigma: 60, seamPad: 64, ...raw.rebuild },
    fullImageLabel: raw.fullImageLabel || 'Full image',
    tileViewerThreshold: raw.tileViewerThreshold || 6000,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  const registry = path.join(dataDir, 'comparisons.json');
  if (!fs.existsSync(registry)) {
    const seed = rel(raw.comparisons);
    fs.writeFileSync(registry, seed && fs.existsSync(seed) ? fs.readFileSync(seed) : '[]\n');
  }
  return cfg;
}
