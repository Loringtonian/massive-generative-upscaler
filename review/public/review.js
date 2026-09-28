(async () => {
  const $ = (id) => document.getElementById(id),
    stage = $('stage');
  const response = await fetch('/api/review');
  if (!response.ok) throw Error('Could not load review');
  const data = await response.json();
  const requestedComparison = new URLSearchParams(location.search).get('comparison');
  let defects = data.defects,
    revision = data.revision,
    current = data.comparisons.find((c) => c.id === requestedComparison) || data.comparisons.find((c) => c.history?.tile === 'full') || data.comparisons[0],
    selected = null,
    split = 0.5,
    marking = false,
    dirty = false,
    saving = false;
  const beforeViewer = OpenSeadragon({
    id: 'before',
    showNavigationControl: false,
    showNavigator: false,
    mouseNavEnabled: false,
    animationTime: 0,
    blendTime: 0.1,
    drawer: 'canvas',
    loadTilesWithAjax: false,
    crossOriginPolicy: false,
    maxImageCacheCount: 180,
    maxZoomPixelRatio: 8,
  });
  function sourceFor(side) {
    if (!side.tiles) return { type: 'image', url: side.url };
    const { baseUrl, ...properties } = side.tiles;
    return { ...properties, getTileUrl: (level, x, y) => baseUrl + level + '/' + x + '_' + y + '.jpeg' };
  }
  // Frames: every version is placed in the reference frame (x, y, width in reference-image widths) so any
  // two versions line up on the slider, whatever their crop or aspect. Versions without a frame fill the
  // reference exactly (x 0, y 0, width 1).
  const frames = {};
  try {
    const h = await (await fetch('/api/history')).json();
    for (const s of h.stages || []) if (s.frame) frames[s.id] = s.frame;
  } catch {}
  function placed(side, c) {
    const source = sourceFor(side),
      id = c.history?.tile === 'full' && side.version?.startsWith('full-') ? side.version.slice(5) : null,
      f = id && frames[id];
    return f ? { tileSource: source, x: f.x, y: f.y, width: f.width } : source;
  }
  function syncBefore() {
    if (viewer.world.getItemCount() && beforeViewer.world.getItemCount()) beforeViewer.viewport.fitBounds(viewer.viewport.getBounds(true), true);
  }
  beforeViewer.addHandler('open', syncBefore);
  const viewer = OpenSeadragon({
    id: 'viewer',
    showNavigationControl: false,
    showNavigator: false,
    animationTime: 0.25,
    blendTime: 0.1,
    minScrollDeltaTime: -1,
    maxZoomPixelRatio: 8,
    drawer: 'canvas',
    loadTilesWithAjax: false,
    crossOriginPolicy: false,
    gestureSettingsMouse: { scrollToZoom: false, clickToZoom: false, dblClickToZoom: true },
    gestureSettingsTouch: { pinchToZoom: true, clickToZoom: false },
  });
  function message(text) {
    $('message').textContent = text;
  }
  const filter = document.createElement('select');
  filter.id = 'review-filter';
  filter.setAttribute('aria-label', 'Defect review filter');
  for (const [value, label] of [
    ['active', 'To review / fix'],
    ['verified', 'Approved history'],
    ['all', 'All defects'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    filter.append(option);
  }
  $('list').before(filter);
  filter.onchange = () => select(null);
  const reviewActions = document.createElement('div');
  reviewActions.className = 'row review-actions';
  const focusButton = document.createElement('button');
  focusButton.type = 'button';
  focusButton.textContent = '⌕ Review repair';
  const approveButton = document.createElement('button');
  approveButton.type = 'button';
  approveButton.className = 'approve';
  approveButton.textContent = '✓ Approve & dismiss';
  const reopenButton = document.createElement('button');
  reopenButton.type = 'button';
  reopenButton.textContent = 'Needs more work';
  reviewActions.append(focusButton, approveButton, reopenButton);
  filter.after(reviewActions);
  reviewActions.hidden = true;
  let reviewedId = null;
  function reviewDefect(d) {
    const comparison = data.comparisons.find((c) => c.id === (d.repair?.comparison || d.comparison));
    const focus = () => {
      select(d.id);
      const q = projected(d),
        item = viewer.world.getItemAt(0);
      if (!q || !item) return;
      const size = item.getContentSize(),
        rx = Math.max(q.rx * 2, 0.012),
        ry = Math.max(q.ry * 2, 0.012);
      viewer.viewport.fitBounds(item.imageToViewportRectangle((q.x - rx) * size.x, (q.y - ry) * size.y, rx * 2 * size.x, ry * 2 * size.y));
      split = 0.5;
      $('divider').setAttribute('aria-valuenow', '50');
      reviewedId = d.id;
      approveButton.disabled = saving || d.status !== 'fixed';
      redraw();
      message('Inspect the repair on the right. Drag the divider to compare, then approve or request more work.');
    };
    if (comparison && comparison.id !== current.id) {
      openComparison(comparison);
      viewer.addOnceHandler('open', focus);
    } else if (viewer.world.getItemCount()) focus();
    else viewer.addOnceHandler('open', focus);
  }
  focusButton.onclick = () => {
    const d = defects.find((d) => d.id === selected);
    if (d) reviewDefect(d);
  };
  async function resolveDefect(status) {
    const d = defects.find((d) => d.id === selected);
    if (!d || saving) return;
    if (status === 'verified' && (d.status !== 'fixed' || reviewedId !== d.id)) return;
    const previous = structuredClone(d);
    d.status = status;
    d.review = { status, reviewedAt: new Date().toISOString(), comparison: current.id };
    dirty = true;
    if (await save()) {
      reviewedId = null;
      select(null);
      message(status === 'verified' ? 'Approved and dismissed. Kept in Approved history.' : 'Reopened.');
    } else {
      Object.assign(d, previous);
      if (!previous.review) delete d.review;
      select(d.id);
    }
  }
  approveButton.onclick = () => resolveDefect('verified');
  reopenButton.onclick = () => resolveDefect('open');
  function imageRect() {
    if (!viewer.world.getItemCount()) return null;
    const item = viewer.world.getItemAt(0),
      size = item.getContentSize();
    const a = viewer.viewport.pixelFromPoint(item.imageToViewportCoordinates(0, 0), true),
      b = viewer.viewport.pixelFromPoint(item.imageToViewportCoordinates(size.x, size.y), true);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }
  function updateOverview(r) {
    const overview = current.overview,
      img = $('overview-image'),
      box = $('overview-box');
    if (!overview || !img.naturalWidth) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const map = $('minimap'),
      scale = Math.min(map.clientWidth / img.naturalWidth, map.clientHeight / img.naturalHeight);
    const w = img.naturalWidth * scale,
      h = img.naturalHeight * scale,
      ox = (map.clientWidth - w) / 2,
      oy = (map.clientHeight - h) / 2;
    const clamp = (x) => Math.max(0, Math.min(1, x)),
      region = overview.region;
    const left = clamp(-r.x / r.w),
      right = clamp((stage.clientWidth - r.x) / r.w),
      top = clamp(-r.y / r.h),
      bottom = clamp((stage.clientHeight - r.y) / r.h);
    box.style.left = ox + (region.x + left * region.width) * w + 'px';
    box.style.top = oy + (region.y + top * region.height) * h + 'px';
    box.style.width = (right - left) * region.width * w + 'px';
    box.style.height = (bottom - top) * region.height * h + 'px';
  }
  function visibleRect() {
    const r = imageRect();
    if (!r) return null;
    return { left: Math.max(0, r.x), right: Math.min(stage.clientWidth, r.x + r.w), top: Math.max(0, r.y), bottom: Math.min(stage.clientHeight, r.y + r.h) };
  }
  function redraw() {
    const r = imageRect();
    if (!r) return;
    const w = stage.clientWidth,
      h = stage.clientHeight;
    syncBefore();
    updateOverview(r);
    const v = visibleRect();
    stage.style.setProperty('--split', `${v.left + (v.right - v.left) * split}px`);
    $('divider').style.top = v.top + 'px';
    $('divider').style.bottom = h - v.bottom + 'px';
    for (const pin of $('pins').children) {
      const d = defects.find((d) => d.id === pin.dataset.id);
      if (!d) continue;
      const q = projected(d);
      if (!q) continue;
      if (pin.classList.contains('region')) {
        pin.style.left = r.x + (q.x - q.rx) * r.w + 'px';
        pin.style.top = r.y + (q.y - q.ry) * r.h + 'px';
        pin.style.width = q.rx * 2 * r.w + 'px';
        pin.style.height = q.ry * 2 * r.h + 'px';
      } else {
        pin.style.left = r.x + q.x * r.w + 'px';
        pin.style.top = r.y + q.y * r.h + 'px';
      }
    }
  }
  function projected(d) {
    if (d.comparison === current.id) return { x: d.x, y: d.y, rx: d.radius, ry: d.radius };
    const old = data.comparisons.find((c) => c.id === d.comparison)?.overview?.region,
      now = current.overview?.region;
    if (!old || !now) return null;
    const x = (old.x + d.x * old.width - now.x) / now.width,
      y = (old.y + d.y * old.height - now.y) / now.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y, rx: (d.radius * old.width) / now.width, ry: (d.radius * old.height) / now.height };
  }
  function writeProjectedPosition(d, x, y) {
    if (d.comparison === current.id) {
      d.x = x;
      d.y = y;
      return;
    }
    const old = data.comparisons.find((c) => c.id === d.comparison).overview.region,
      now = current.overview.region;
    d.x = Math.max(0, Math.min(1, (now.x + x * now.width - old.x) / old.width));
    d.y = Math.max(0, Math.min(1, (now.y + y * now.height - old.y) / old.height));
  }
  function drawPins() {
    $('pins').replaceChildren();
    $('list').replaceChildren();
    const items = defects.filter(
      (d) => projected(d) && (filter.value === 'all' || (filter.value === 'verified' ? d.status === 'verified' : d.status !== 'verified')),
    );
    items.forEach((d, i) => {
      const pin = document.createElement('button');
      pin.className = 'pin' + (d.id === selected ? ' selected' : '');
      pin.dataset.id = d.id;
      pin.textContent = i + 1;
      pin.title = d.note || 'New defect';
      pin.setAttribute('aria-label', `Defect ${i + 1}: ${d.note || 'New note'}`);
      let moved = false,
        startX = 0,
        startY = 0;
      pin.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        startX = e.clientX;
        startY = e.clientY;
        moved = false;
        // Keep this DOM node alive until pointer capture ends.
        pin.setPointerCapture(e.pointerId);
      });
      pin.addEventListener('pointermove', (e) => {
        if (!pin.hasPointerCapture(e.pointerId)) return;
        if (!moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 3) return;
        const r = imageRect();
        if (!r) return;
        moved = true;
        const bounds = stage.getBoundingClientRect();
        writeProjectedPosition(
          d,
          Math.max(0, Math.min(1, (e.clientX - bounds.left - r.x) / r.w)),
          Math.max(0, Math.min(1, (e.clientY - bounds.top - r.y) / r.h)),
        );
        dirty = true;
        redraw();
        message('Pin moved · save the note to keep its new position.');
      });
      pin.addEventListener('pointerup', (e) => {
        if (!pin.hasPointerCapture(e.pointerId)) return;
        pin.releasePointerCapture(e.pointerId);
        select(d.id);
      });
      pin.addEventListener('pointercancel', () => {
        select(d.id);
      });
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.detail === 0) select(d.id);
      });
      pin.addEventListener('keydown', (e) => {
        const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (!directions[e.key]) return;
        e.preventDefault();
        e.stopPropagation();
        const step = e.shiftKey ? 0.01 : 0.001;
        d.x = Math.max(0, Math.min(1, d.x + directions[e.key][0] * step));
        d.y = Math.max(0, Math.min(1, d.y + directions[e.key][1] * step));
        dirty = true;
        redraw();
        message('Pin moved · save the note to keep its new position.');
      });
      $('pins').append(pin);
      const row = document.createElement('button');
      row.textContent = `${i + 1}. ${d.note || 'New defect'} · ${d.status === 'fixed' ? 'Ready to review' : d.status === 'verified' ? '✓ Approved' : 'Needs fixing'}`;
      row.onclick = () => reviewDefect(d);
      $('list').append(row);
      if (d.id === selected) {
        const region = document.createElement('div');
        region.className = 'region';
        region.dataset.id = d.id;
        $('pins').prepend(region);
      }
    });
    if (!items.length) $('list').textContent = filter.value === 'verified' ? 'No approved defects in this view.' : 'No pending defects in this view.';
    redraw();
  }
  function setMark(value) {
    marking = value;
    $('mark').setAttribute('aria-pressed', String(value));
    $('viewer').style.cursor = value ? 'crosshair' : 'grab';
    if (value) message('Click the image to place a defect pin.');
  }
  function showNotes(value) {
    $('notes').hidden = !value;
    $('notes-toggle').setAttribute('aria-expanded', String(value));
  }
  function select(id) {
    selected = id;
    const d = defects.find((d) => d.id === id);
    $('editor').hidden = !d;
    reviewActions.hidden = !d;
    if (d) {
      chooseHistoryTile(d);
      showNotes(true);
      for (const key of ['note', 'category', 'action', 'radius', 'status']) $(key).value = d[key];
    }
    approveButton.hidden = !d || d.status !== 'fixed';
    approveButton.disabled = saving || reviewedId !== id;
    reopenButton.hidden = !d || d.status === 'open';
    focusButton.textContent = d?.repair ? '⌕ Review repair' : '⌕ Zoom to defect';
    drawPins();
  }
  function openComparison(c) {
    const sameRegion = JSON.stringify(current.overview?.region) === JSON.stringify(c.overview?.region);
    const bounds = sameRegion && viewer.world.getItemCount() ? viewer.viewport.getBounds(true) : null;
    current = c;
    $('comparison').value = c.id;
    $('overview-image').src = c.overview?.url || '';
    $('minimap').hidden = !c.overview;
    $('history-tile').value = c.history?.tile || 'detail';
    for (const field of ['history-before', 'history-after'])
      for (const option of $(field).options) option.disabled = $('history-tile').value === 'full' && ['generated', 'aligned'].includes(option.value);
    selected = null;
    reviewedId = null;
    $('editor').hidden = true;
    reviewActions.hidden = true;
    $('before-label').textContent = 'LEFT · ' + c.before.label;
    $('after-label').textContent = 'RIGHT · ' + c.after.label;
    for (const [field, side] of [
      ['left-source', c.before],
      ['right-source', c.after],
    ]) {
      const dimensions = side.pixelWidth ? side.pixelWidth.toLocaleString() + ' × ' + side.pixelHeight.toLocaleString() + ' px' : '';
      $(field).textContent = [c.history?.tile === 'full' ? 'Full image' : 'Detail crop', dimensions, side.sourceFile?.split('/').pop()]
        .filter(Boolean)
        .join(' · ');
      $(field).title = $(field).textContent;
    }
    if (c.selection) {
      $('history-before').value = c.selection.left;
      $('history-after').value = c.selection.right;
    } else if (c.history?.before && c.history?.after) {
      $('history-before').value = c.history.before;
      $('history-after').value = c.history.after;
      $('history-tile').value = c.history.tile;
    } else {
      for (const [id, side] of [
        ['history-before', c.before],
        ['history-after', c.after],
      ]) {
        const value = 'saved-' + side.version;
        if (!Array.from($(id).options).some((o) => o.value === value)) {
          const o = document.createElement('option');
          o.value = value;
          o.textContent = side.label;
          o.dataset.saved = 'true';
          $(id).append(o);
        }
        $(id).value = value;
      }
    }
    if (bounds)
      viewer.addOnceHandler('open', () => {
        viewer.viewport.fitBounds(bounds, true);
        redraw();
      });
    beforeViewer.open(placed(c.before, c));
    viewer.open(placed(c.after, c));
    drawPins();
  }
  for (const c of data.comparisons) {
    const option = document.createElement('option');
    option.value = c.id;
    option.textContent = c.title;
    $('comparison').append(option);
  }
  $('comparison').onchange = () => openComparison(data.comparisons.find((c) => c.id === $('comparison').value));
  viewer.addHandler('update-viewport', redraw);
  viewer.addHandler('resize', redraw);
  viewer.addHandler('open', redraw);
  viewer.addHandler('open-failed', () => message('After image could not load.'));
  viewer.addHandler('canvas-scroll', (e) => {
    e.preventDefaultAction = true;
    e.preventDefault = true;
    const raw = e.originalEvent,
      unit = raw.deltaMode === 1 ? 16 : raw.deltaMode === 2 ? stage.clientHeight : 1;
    const delta = Number.isFinite(raw.deltaY) ? raw.deltaY * unit : -e.scroll * 60;
    viewer.viewport.zoomBy(Math.exp(-Math.max(-240, Math.min(240, delta)) * (raw.ctrlKey ? 0.006 : 0.0025)), viewer.viewport.pointFromPixel(e.position, true));
    viewer.viewport.applyConstraints();
  });
  viewer.addHandler('canvas-click', (e) => {
    if (!marking || !e.quick) return;
    e.preventDefaultAction = true;
    const r = imageRect();
    if (!r) return;
    const x = (e.position.x - r.x) / r.w,
      y = (e.position.y - r.y) / r.h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const d = {
      id: crypto.randomUUID(),
      comparison: current.id,
      x,
      y,
      radius: 0.035,
      note: '',
      category: 'geometry',
      action: 'rework',
      status: 'open',
      author: 'user',
      beforeVersion: current.before.version,
      afterVersion: current.after.version,
    };
    defects.push(d);
    dirty = true;
    setMark(false);
    select(d.id);
    $('note').focus();
    message('Describe this area and save your note.');
  });
  function move(e) {
    const v = visibleRect();
    if (!v || v.right <= v.left) return;
    split = Math.max(0, Math.min(1, (e.clientX - stage.getBoundingClientRect().left - v.left) / (v.right - v.left)));
    $('divider').setAttribute('aria-valuenow', Math.round(split * 100));
    redraw();
  }
  $('divider').onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    $('divider').setPointerCapture(e.pointerId);
    move(e);
  };
  $('divider').onpointermove = (e) => {
    if ($('divider').hasPointerCapture(e.pointerId)) move(e);
  };
  $('divider').onpointerup = (e) => {
    if ($('divider').hasPointerCapture(e.pointerId)) $('divider').releasePointerCapture(e.pointerId);
  };
  $('divider').onkeydown = (e) => {
    const changes = { ArrowLeft: split - 0.025, ArrowRight: split + 0.025, Home: 0, End: 1 };
    if (e.key in changes) {
      e.preventDefault();
      split = Math.max(0, Math.min(1, changes[e.key]));
      $('divider').setAttribute('aria-valuenow', Math.round(split * 100));
      redraw();
    }
  };
  $('fit').onclick = () => viewer.viewport.goHome();
  $('zoom-in').onclick = () => {
    viewer.viewport.zoomBy(1.35);
    viewer.viewport.applyConstraints();
  };
  $('zoom-out').onclick = () => {
    viewer.viewport.zoomBy(1 / 1.35);
    viewer.viewport.applyConstraints();
  };
  $('mark').onclick = () => setMark(!marking);
  $('notes-toggle').onclick = () => showNotes($('notes').hidden);
  $('editor').oninput = () => {
    const d = defects.find((d) => d.id === selected);
    if (!d) return;
    for (const key of ['note', 'category', 'action', 'status']) d[key] = $(key).value;
    d.radius = Number($('radius').value);
    dirty = true;
    drawPins();
    message('Unsaved changes');
  };
  async function save() {
    if (saving) return false;
    saving = true;
    $('save').disabled = true;
    $('delete').disabled = true;
    approveButton.disabled = true;
    reopenButton.disabled = true;
    const savedSnapshot = JSON.stringify(defects);
    try {
      const res = await fetch('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, defects }) });
      const result = await res.json();
      if (!res.ok) throw Error(result.error);
      revision = result.revision;
      dirty = JSON.stringify(defects) !== savedSnapshot;
      message(dirty ? 'Earlier changes saved; newer edits still need saving.' : 'Saved.');
      drawPins();
      return true;
    } catch (e) {
      message(e.message + ' Your notes remain here; use Export notes for a backup.');
      return false;
    } finally {
      saving = false;
      $('save').disabled = false;
      $('delete').disabled = false;
      approveButton.disabled = reviewedId !== selected;
      reopenButton.disabled = false;
    }
  }
  $('editor').onsubmit = (e) => {
    e.preventDefault();
    save();
  };
  $('delete').onclick = () => {
    defects = defects.filter((d) => d.id !== selected);
    dirty = true;
    select(null);
    save();
  };
  $('export').onclick = () => {
    const blob = new Blob([JSON.stringify({ revision, comparisons: data.comparisons, defects }, null, 2)], { type: 'application/json' }),
      url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = 'defect-review.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };
  window.addEventListener('beforeunload', (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  if (matchMedia('(max-width:650px)').matches) showNotes(false);

  let historyInfo = null,
    historyPoll,
    switching = false;
  async function refreshComparisons() {
    const state = await (await fetch('/api/review')).json();
    data.comparisons = state.comparisons;
    for (const c of state.comparisons)
      if (!Array.from($('comparison').options).some((o) => o.value === c.id)) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.title;
        $('comparison').append(o);
      }
  }
  function chooseHistoryTile(d) {
    if (!historyInfo) return;
    const region = data.comparisons.find((c) => c.id === d.comparison)?.overview?.region;
    if (!region) return;
    const x = (region.x + d.x * region.width) * historyInfo.reference.width,
      y = (region.y + d.y * region.height) * historyInfo.reference.height;
    const t = historyInfo.tiles.find((t) => x >= t.x && x <= t.x + t.width && y >= t.y && y <= t.y + t.height);
    if (t) $('history-tile').dataset.pinTile = t.id;
  }
  async function showHistoryComparison(id) {
    await refreshComparisons();
    const c = data.comparisons.find((c) => c.id === id);
    if (!c) throw Error('Comparison not ready');
    $('comparison').value = id;
    openComparison(c);
  }
  async function historyRequest(route, body) {
    const res = await fetch('/api/history/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await res.json();
    if (!res.ok) throw Error(result.error);
    return result;
  }
  function renderJob(job) {
    $('history-status').textContent =
      job.phase === 'complete'
        ? 'Rebuild ready for review. Current master unchanged.'
        : job.phase === 'failed'
          ? 'Rebuild failed: ' + job.error
          : job.phase + '…';
    $('history-rebuild').disabled = !['complete', 'failed'].includes(job.phase);
    $('history-results').replaceChildren();
    if (job.phase === 'complete') {
      for (const field of ['history-before', 'history-after']) {
        const id = 'rebuild-' + job.id;
        if (!Array.from($(field).options).some((o) => o.value === id)) {
          const o = document.createElement('option');
          o.value = id;
          o.textContent = `Rebuild · ${job.tile} from ${job.stage} · ${job.id.slice(0, 8)}`;
          $(field).append(o);
        }
      }
      job.comparisons.forEach((id, i) => {
        const b = document.createElement('button');
        b.textContent = i === 0 ? 'Review rebuilt tile' : 'Review seams and neighbors';
        b.onclick = () => showHistoryComparison(id).catch((e) => ($('history-status').textContent = e.message));
        $('history-results').append(b);
      });
      for (const out of job.outputs) {
        const a = document.createElement('a');
        a.href = `/job/${job.id}/${out.filename}`;
        a.download = out.filename;
        a.textContent = out.filename + ' · ' + (out.bytes / 1e6).toFixed(1) + ' MB';
        $('history-results').append(a);
      }
    }
  }
  async function pollHistory() {
    try {
      const res = await fetch('/api/history');
      if (!res.ok) throw Error('History service unavailable');
      historyInfo = await res.json();
      const job = historyInfo.jobs[0];
      if (job) {
        renderJob(job);
        if (!['complete', 'failed'].includes(job.phase)) historyPoll = setTimeout(pollHistory, 3000);
      }
    } catch (e) {
      $('history-status').textContent = e.message;
    }
  }
  async function changeSides() {
    if (switching) return;
    switching = true;
    stage.classList.add('switching');
    for (const id of ['history-before', 'history-after', 'history-tile', 'history-compare', 'swap']) $(id).disabled = true;
    message('Loading selected images…');
    try {
      const body = { tile: $('history-tile').value, before: $('history-before').value, after: $('history-after').value };
      if (body.tile === 'detail' || body.before.startsWith('saved-') || body.after.startsWith('saved-')) {
        const result = await fetch('/api/pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ left: body.before, right: body.after, comparison: current.id, keepRegion: body.tile === 'detail' }),
        });
        const pair = await result.json();
        if (!result.ok) throw Error(pair.error);
        await showHistoryComparison(pair.id);
      } else {
        const result = await historyRequest('compare', body);
        await showHistoryComparison(result.id);
      }
      message('');
    } catch (e) {
      $('history-before').value = current.selection?.left || current.history?.before || 'saved-' + current.before.version;
      $('history-after').value = current.selection?.right || current.history?.after || 'saved-' + current.after.version;
      if (current.history?.tile) $('history-tile').value = current.history.tile;
      message(e.message);
    } finally {
      switching = false;
      stage.classList.remove('switching');
      for (const id of ['history-before', 'history-after', 'history-tile', 'history-compare', 'swap']) $(id).disabled = false;
    }
  }
  $('history-compare').onclick = changeSides;
  $('history-before').onchange = changeSides;
  $('history-after').onchange = changeSides;
  $('swap').onclick = () => {
    const left = $('history-before').value;
    $('history-before').value = $('history-after').value;
    $('history-after').value = left;
    return changeSides();
  };
  $('history-tile').onchange = () => {
    const full = $('history-tile').value === 'full';
    for (const id of ['history-before', 'history-after']) {
      for (const option of $(id).options) option.disabled = full && ['generated', 'aligned'].includes(option.value);
      if ($(id).value.startsWith('saved-') || (full && ['generated', 'aligned'].includes($(id).value)))
        $(id).value = id === 'history-before' ? historyInfo.defaults.left : historyInfo.defaults.right;
    }
    return changeSides();
  };
  $('history-rebuild').onclick = async () => {
    if (dirty) {
      $('history-status').textContent = 'Save your defect notes first so the rebuild can preserve their current instructions.';
      return;
    }
    $('history-rebuild').disabled = true;
    try {
      const job = await historyRequest('rebuild', { tile: $('history-tile').value, stage: $('history-before').value });
      renderJob(job);
      clearTimeout(historyPoll);
      historyPoll = setTimeout(pollHistory, 2000);
    } catch (e) {
      $('history-status').textContent = e.message;
      $('history-rebuild').disabled = false;
    }
  };
  await pollHistory();
  if (historyInfo) {
    const whole = document.createElement('option');
    whole.value = 'full';
    whole.textContent = historyInfo.fullImageLabel;
    $('history-tile').append(whole);
    const detail = document.createElement('option');
    detail.value = 'detail';
    detail.textContent = 'Selected detail crop';
    detail.disabled = true;
    $('history-tile').append(detail);
    for (const t of historyInfo.tiles) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.id.toUpperCase().replaceAll('_', ' · ');
      $('history-tile').append(o);
    }
    for (const field of ['history-before', 'history-after'])
      for (const stage of historyInfo.stages) {
        if (Array.from($(field).options).some((o) => o.value === stage.id)) continue;
        const o = document.createElement('option');
        o.value = stage.id;
        o.textContent = stage.label;
        $(field).append(o);
      }
    for (const field of ['history-before', 'history-after'])
      for (const c of data.comparisons.filter((c) => !c.history && !c.selection))
        for (const side of [c.before, c.after]) {
          const value = 'saved-' + side.version;
          if (Array.from($(field).options).some((o) => o.value === value)) continue;
          const o = document.createElement('option');
          o.value = value;
          o.textContent = side.label + ' · saved detail';
          $(field).append(o);
        }
    $('history-tile').value = current?.history?.tile || 'full';
    $('history-before').value = historyInfo.defaults.left;
    $('history-after').value = historyInfo.defaults.right;
  }
  $('overview-image').onload = redraw;
  if (!current && historyInfo) {
    // Fresh data folder: open the default full-image pair.
    const made = await historyRequest('compare', { tile: 'full', before: historyInfo.defaults.left, after: historyInfo.defaults.right });
    await refreshComparisons();
    current = data.comparisons.find((c) => c.id === made.id);
    $('history-tile').value = 'full';
  }
  if (!current) throw Error('No comparisons yet. Add versions to the review config.');
  openComparison(current);
})().catch((e) => {
  document.getElementById('message').textContent = e.message;
});
