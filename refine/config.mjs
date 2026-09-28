// Shared config loading and pure helpers for the tile-refinement tools.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  workDir: 'work/refine',
  density: 300,
  tile: { size: 1024, overlap: 256 },
  regions: null,
  skip: [],
  protected: [],
  registration: {
    minInliers: 50,
    maxMedianErrorPx: 1.5,
    maxScaleDeviation: 0.025,
    maxTranslationPx: 25,
    ratio: 0.7,
    ransacThreshold: 3,
    nfeatures: 8000,
    contrastThreshold: 0.012,
  },
  transfer: {
    blur: 3,
    edgeThreshold: 3,
    edgeRange: 15,
    strength: 0.45,
    maxDelta: 18,
    feather: 100,
    protectFeather: 45,
  },
  output: { name: 'refined', jpeg: true, preview: 2400 },
};

export function loadConfig(file) {
  if (!file) throw new Error('usage: node <tool> <config.json>');
  const configPath = path.resolve(file);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const base = path.dirname(configPath);
  const cfg = {
    ...DEFAULTS,
    ...raw,
    tile: { ...DEFAULTS.tile, ...raw.tile },
    registration: { ...DEFAULTS.registration, ...raw.registration },
    transfer: { ...DEFAULTS.transfer, ...raw.transfer },
    output: { ...DEFAULTS.output, ...raw.output },
  };
  if (!cfg.input) throw new Error('config.input is required');
  cfg.input = path.resolve(base, cfg.input);
  cfg.workDir = path.resolve(base, cfg.workDir);
  if (cfg.tile.overlap >= cfg.tile.size) throw new Error('tile.overlap must be smaller than tile.size');
  for (const r of cfg.protected) validateRect(r, 'protected');
  for (const r of cfg.regions || []) validateRect(r, 'regions');
  cfg.paths = {
    manifest: path.join(cfg.workDir, 'manifest.json'),
    base: path.join(cfg.workDir, 'base.tif'),
    inputs: path.join(cfg.workDir, 'inputs'),
    generated: path.join(cfg.workDir, 'generated'),
    aligned: path.join(cfg.workDir, 'aligned'),
    registration: path.join(cfg.workDir, 'registration.json'),
    exports: path.join(cfg.workDir, 'exports'),
    qa: path.join(cfg.workDir, 'qa'),
  };
  return cfg;
}

function validateRect(r, key) {
  if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isInteger) || r[2] <= 0 || r[3] <= 0)
    throw new Error(`${key}: each rectangle must be [x, y, width, height] in whole pixels`);
}

// Overlapping grid over one region. The last row/column snaps to the region's far edge,
// so every tile has the full size (unless the region itself is smaller).
export function axisStarts(start, length, size, overlap) {
  if (length <= size) return [{ at: start, len: length }];
  const step = size - overlap;
  const out = [];
  for (let p = start; ; p += step) {
    if (p + size >= start + length) {
      out.push({ at: start + length - size, len: size });
      break;
    }
    out.push({ at: p, len: size });
  }
  return out;
}

export function tileGrid(width, height, { size, overlap }, regions = null, skip = []) {
  const areas = regions && regions.length ? regions : [[0, 0, width, height]];
  const tiles = [];
  areas.forEach(([rx, ry, rw, rh], a) => {
    if (rx < 0 || ry < 0 || rx + rw > width || ry + rh > height) throw new Error(`region ${a} lies outside the image`);
    const xs = axisStarts(rx, rw, size, overlap);
    const ys = axisStarts(ry, rh, size, overlap);
    ys.forEach((y, row) =>
      xs.forEach((x, col) => {
        const id = `${areas.length > 1 ? `a${a + 1}_` : ''}r${String(row + 1).padStart(2, '0')}_c${String(col + 1).padStart(2, '0')}`;
        if (!skip.includes(id)) tiles.push({ id, x: x.at, y: y.at, width: x.len, height: y.len });
      }),
    );
  });
  return tiles;
}

// Linear ramp from 0 at a tile's border to 1 at `feather` px inside it (capped at 1, not floored).
export function edgeFeather(x, y, w, h, feather) {
  return Math.min(1, x / feather, y / feather, (w - 1 - x) / feather, (h - 1 - y) / feather);
}

// Weight of the detail transfer at one pixel: edge gate x strength x tile feather x protected falloff.
export function transferWeight({ edge, x, y, w, h, gx, gy }, t, protectedRects) {
  let weight = Math.min(1, Math.max(0, (edge - t.edgeThreshold) / t.edgeRange)) * t.strength * edgeFeather(x, y, w, h, t.feather);
  for (const [rx, ry, rw, rh] of protectedRects) {
    const dx = Math.max(rx - gx, 0, gx - (rx + rw - 1));
    const dy = Math.max(ry - gy, 0, gy - (ry + rh - 1));
    weight *= Math.min(1, Math.hypot(dx, dy) / t.protectFeather);
  }
  return Math.max(0, weight);
}
