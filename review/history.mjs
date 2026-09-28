// Version registry, per-tile stage crops, comparison preparation and deep-zoom pyramids.
// All coordinates of tiles and regions are in the reference frame (config.reference).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

export const JOB_ID = /^[a-f0-9-]{36}$/;
const FULL_FRAME = { x: 0, y: 0, width: 1 };
const FULL_REGION = { x: 0, y: 0, width: 1, height: 1 };
const PYRAMID_TILE = { size: 512, overlap: 1 };

export function createHistory(cfg) {
  const dataDir = cfg.dataDir;
  const registry = path.join(dataDir, 'comparisons.json');
  const RW = cfg.reference.width,
    RH = cfg.reference.height;
  const tiles = cfg.tiles;
  const tileStages = cfg.refineWorkDir
    ? [
        { id: 'generated', label: 'Generated crop · raw, before alignment' },
        { id: 'aligned', label: 'Generated crop · registered' },
      ]
    : [];
  const stages = [...cfg.versions, ...tileStages];
  const rel = (p) => path.relative(dataDir, p);
  const readRows = () => JSON.parse(fs.readFileSync(registry, 'utf8'));
  function upsert(c) {
    const rows = readRows(),
      i = rows.findIndex((r) => r.id === c.id);
    if (i < 0) rows.push(c);
    else rows[i] = c;
    fs.writeFileSync(registry + '.tmp', JSON.stringify(rows, null, 2));
    fs.renameSync(registry + '.tmp', registry);
    return c;
  }
  const overview = (region) => (cfg.overview ? { path: rel(cfg.overview), region } : null);
  const tileRegion = (t) => ({ x: t.x / RW, y: t.y / RH, width: t.width / RW, height: t.height / RH });

  function resolveTile(id) {
    const t = tiles.find((t) => t.id === id);
    if (!t) throw Error('Unknown tile');
    return t;
  }
  function allStages() {
    const jobs = path.join(dataDir, 'jobs');
    if (!fs.existsSync(jobs)) return stages;
    const completed = fs
      .readdirSync(jobs)
      .filter((id) => JOB_ID.test(id))
      .flatMap((id) => {
        try {
          const state = JSON.parse(fs.readFileSync(path.join(jobs, id, 'status.json')));
          return state.phase === 'complete'
            ? [
                {
                  id: 'rebuild-' + id,
                  label: `Rebuild · ${state.tile} replaced from ${state.stage} · ${id.slice(0, 8)}`,
                  path: path.join(jobs, id, 'master.tif'),
                },
              ]
            : [];
        } catch {
          return [];
        }
      });
    return [...stages, ...completed];
  }
  function resolveStage(id) {
    const s = allStages().find((s) => s.id === id);
    if (!s) throw Error('Unknown stage');
    return s;
  }
  function pyramidDirectory(stageId) {
    const stage = resolveStage(stageId);
    if (stage.pyramid) return stage.pyramid;
    if (stageId.startsWith('rebuild-')) return path.join(dataDir, 'jobs', stageId.slice(8), 'pyramid_files');
    return path.join(dataDir, 'pyramids', stageId, 'pyramid_files');
  }
  async function buildPyramid(input, folder) {
    const parent = path.dirname(folder);
    fs.mkdirSync(parent, { recursive: true });
    await sharp(input, { limitInputPixels: false })
      .withIccProfile('srgb')
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4', mozjpeg: true })
      .tile({ ...PYRAMID_TILE, layout: 'dz', depth: 'onepixel' })
      .toFile(path.join(parent, 'pyramid'));
  }
  async function fullVersion(id) {
    const stage = resolveStage(id);
    if (!stage.path) throw Error('This version exists only as a tile. Choose a tile to inspect it.');
    const meta = await sharp(stage.path, { limitInputPixels: false }).metadata();
    const entry = {
      label: stage.label,
      version: 'full-' + id,
      path: rel(stage.path),
      sourceFile: path.basename(stage.path),
      pixelWidth: meta.width,
      pixelHeight: meta.height,
    };
    if (meta.width > cfg.tileViewerThreshold || /\.tiff?$/i.test(stage.path)) {
      const folder = pyramidDirectory(id);
      if (!fs.existsSync(folder)) await buildPyramid(stage.path, folder);
      entry.tiles = {
        width: meta.width,
        height: meta.height,
        tileSize: PYRAMID_TILE.size,
        tileOverlap: PYRAMID_TILE.overlap,
        minLevel: 0,
        maxLevel: Math.ceil(Math.log2(Math.max(meta.width, meta.height))),
        baseUrl: `/tiles/${id}/`,
      };
    }
    return entry;
  }
  async function prepareFullComparison(beforeId, afterId) {
    const before = await fullVersion(beforeId),
      after = await fullVersion(afterId);
    return upsert({
      id: `full-${beforeId}-${afterId}`,
      title: `${cfg.fullImageLabel} · ${before.label} / ${after.label}`,
      before,
      after,
      overview: overview(FULL_REGION),
      history: { tile: 'full', before: beforeId, after: afterId },
    });
  }
  async function stageImage(tileId, stageId) {
    const tile = resolveTile(tileId),
      stage = resolveStage(stageId),
      out = path.join(dataDir, 'stages', tileId, stageId + '.png');
    if (fs.existsSync(out)) return out;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (stageId === 'generated' || stageId === 'aligned') {
      const f = path.join(cfg.refineWorkDir, stageId, tile.id + '.png');
      if (!fs.existsSync(f)) throw Error(`No ${stageId} crop exists for ${tile.id}`);
      await sharp(f).png().toFile(out);
    } else {
      const input = stage.path,
        meta = await sharp(input, { limitInputPixels: false }).metadata();
      const f = stage.frame || FULL_FRAME;
      // Reference px -> this version's px.
      const k = meta.width / (f.width * RW);
      const left = Math.round((tile.x - f.x * RW) * k),
        top = Math.round((tile.y - f.y * RW) * k);
      const right = Math.round((tile.x + tile.width - f.x * RW) * k),
        bottom = Math.round((tile.y + tile.height - f.y * RW) * k);
      if (left < 0 || top < 0 || right > meta.width || bottom > meta.height) throw Error(`${stage.label} does not cover ${tile.id}`);
      await sharp(input, { limitInputPixels: false })
        .extract({ left, top, width: right - left, height: bottom - top })
        .png()
        .toFile(out);
    }
    return out;
  }
  async function prepareComparison(tileId, beforeId, afterId) {
    const tile = resolveTile(tileId),
      before = resolveStage(beforeId),
      after = resolveStage(afterId);
    // Sequential preparation avoids large concurrent image decodes.
    const beforePath = await stageImage(tileId, beforeId),
      afterPath = await stageImage(tileId, afterId);
    const beforeMeta = await sharp(beforePath).metadata(),
      afterMeta = await sharp(afterPath).metadata();
    return upsert({
      id: `history-${tileId}-${beforeId}-${afterId}`,
      title: `${tileId} · ${before.label} → ${after.label}`,
      before: {
        label: before.label,
        version: `${tileId}-${beforeId}`,
        path: rel(beforePath),
        sourceFile: path.basename(before.path || beforePath),
        pixelWidth: beforeMeta.width,
        pixelHeight: beforeMeta.height,
      },
      after: {
        label: after.label,
        version: `${tileId}-${afterId}`,
        path: rel(afterPath),
        sourceFile: path.basename(after.path || afterPath),
        pixelWidth: afterMeta.width,
        pixelHeight: afterMeta.height,
      },
      overview: overview(tileRegion(tile)),
      history: { tile: tileId, before: beforeId, after: afterId },
    });
  }
  async function prepareMixedComparison(leftId, rightId, comparisonId, keepRegion = false) {
    const rows = readRows(),
      context = rows.find((c) => c.id === comparisonId);
    function resolve(id) {
      if (id.startsWith('saved-')) {
        const version = id.slice(6),
          ordered = context ? [context, ...rows] : rows;
        for (const c of ordered)
          for (const side of [c.before, c.after])
            if (side.version === version && c.overview?.region) return { ...side, absolute: path.resolve(dataDir, side.path), region: c.overview.region };
        throw Error('Saved image version not found');
      }
      const stage = resolveStage(id);
      if (stage.path) {
        const f = stage.frame || FULL_FRAME;
        return {
          label: stage.label,
          version: 'full-' + id,
          absolute: stage.path,
          sourceFile: path.basename(stage.path),
          region: { x: f.x, y: (f.y * RW) / RH, width: f.width, height: null },
          frame: f,
        };
      }
      const r = context?.overview?.region;
      if (!r) throw Error('Choose a tile for this image');
      const e = 1e-5;
      const tile = tiles.find(
        (t) => r.x >= t.x / RW - e && r.y >= t.y / RH - e && r.x + r.width <= (t.x + t.width) / RW + e && r.y + r.height <= (t.y + t.height) / RH + e,
      );
      if (!tile) throw Error('This tile-only version does not cover the current image. Choose a tile first.');
      return { label: stage.label, version: tile.id + '-' + id, tileStage: id, tileId: tile.id, region: tileRegion(tile) };
    }
    const left = resolve(leftId),
      right = resolve(rightId);
    for (const side of [left, right])
      if (side.region.height === null) {
        const meta = await sharp(side.absolute, { limitInputPixels: false }).metadata();
        side.region.height = (side.frame.width * RW * (meta.height / meta.width)) / RH;
      }
    const limit = keepRegion && context?.overview?.region ? context.overview.region : FULL_REGION;
    const x = Math.max(left.region.x, right.region.x, limit.x),
      y = Math.max(left.region.y, right.region.y, limit.y);
    const endX = Math.min(left.region.x + left.region.width, right.region.x + right.region.width, limit.x + limit.width);
    const endY = Math.min(left.region.y + left.region.height, right.region.y + right.region.height, limit.y + limit.height);
    if (endX <= x || endY <= y) throw Error('These two images show different areas with no overlap.');
    const region = { x, y, width: endX - x, height: endY - y };
    const id =
      'pair-' +
      crypto
        .createHash('sha256')
        .update(JSON.stringify([leftId, rightId, region]))
        .digest('hex')
        .slice(0, 20);
    const folder = path.join(dataDir, 'pairs', id);
    fs.mkdirSync(folder, { recursive: true });
    async function crop(side, name) {
      const input = side.absolute || (await stageImage(side.tileId, side.tileStage)),
        meta = await sharp(input, { limitInputPixels: false }).metadata(),
        r = side.region;
      const l = Math.max(0, Math.round(((x - r.x) / r.width) * meta.width)),
        t = Math.max(0, Math.round(((y - r.y) / r.height) * meta.height));
      const w = Math.min(meta.width - l, Math.round((region.width / r.width) * meta.width)),
        h = Math.min(meta.height - t, Math.round((region.height / r.height) * meta.height));
      const out = path.join(folder, name + '.png');
      if (!fs.existsSync(out)) await sharp(input, { limitInputPixels: false }).extract({ left: l, top: t, width: w, height: h }).png().toFile(out);
      return { label: side.label, version: side.version, path: rel(out), sourceFile: side.sourceFile || path.basename(input), pixelWidth: w, pixelHeight: h };
    }
    const before = await crop(left, 'left'),
      after = await crop(right, 'right');
    return upsert({ id, title: `${before.label} / ${after.label}`, before, after, overview: overview(region), selection: { left: leftId, right: rightId } });
  }

  return {
    tiles,
    stages,
    registry,
    readRows,
    upsert,
    overview,
    tileRegion,
    resolveTile,
    allStages,
    resolveStage,
    pyramidDirectory,
    buildPyramid,
    fullVersion,
    stageImage,
    prepareComparison,
    prepareFullComparison,
    prepareMixedComparison,
  };
}
