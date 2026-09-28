(() => {
  'use strict';
  const SITE = window.SITE || {};
  const W = SITE.width,
    H = SITE.height;
  const stage = document.getElementById('stage');
  const divider = document.getElementById('divider');
  const beforeCanvas = document.getElementById('before');
  const ctx = beforeCanvas.getContext('2d', { alpha: false });
  const smoothingBox = document.getElementById('smoothing');
  const getYoursBox = document.getElementById('get-yours');
  const actions = document.getElementById('actions');
  const coarse = matchMedia('(pointer: coarse)').matches;

  function showError(message) {
    const el = document.getElementById('error');
    el.textContent = message;
    el.style.display = 'block';
  }

  // Settings survive a reload: both checkboxes and the divider position.
  const STORE = 'viewer.v1';
  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(STORE)) || {};
    } catch {
      return {};
    }
  }
  let saveTimer = 0;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORE, JSON.stringify({ smoothing: smoothingBox.checked, split }));
      } catch {}
    }, 150);
  }
  const saved = loadSettings();
  let split = Number.isFinite(saved.split) ? Math.max(0, Math.min(100, saved.split)) : 10;
  smoothingBox.checked = saved.smoothing === true; // starts off
  getYoursBox.checked = false; // starts off on every visit, never remembered
  actions.hidden = !getYoursBox.checked;

  // "Get yours" actions.
  const downloads = SITE.downloads || {};
  for (const key of ['jpeg', 'tiff']) {
    const link = document.getElementById('dl-' + key);
    const file = downloads[key];
    if (!file) {
      link.hidden = true;
      continue;
    }
    link.href = file.url;
    link.setAttribute('download', file.name);
    document.querySelector(`[data-mb="${key}"]`).textContent = file.mb;
    if (SITE.protectedDownloads)
      link.addEventListener('click', (event) => {
        event.preventDefault();
        protectedDownload(link, file);
      });
  }

  // Deployed site: an invisible Cloudflare "are you human" check, then a short-lived link.
  let turnstileReady = null,
    turnstileWidget = null,
    tokenWaiter = null;
  function loadTurnstile() {
    turnstileReady ??= new Promise((resolve, reject) => {
      window.onTurnstileLoad = () => {
        // Sits inside the panel; stays empty unless Cloudflare wants one tick from this visitor.
        const box = document.getElementById('human-check');
        turnstileWidget = turnstile.render(box, {
          sitekey: SITE.turnstileSiteKey,
          execution: 'execute',
          appearance: 'interaction-only',
          callback: (token) => {
            box.hidden = true;
            tokenWaiter?.resolve(token);
          },
          'before-interactive-callback': () => {
            box.hidden = false;
          },
          'error-callback': () => {
            tokenWaiter?.reject(new Error('check failed'));
            return true;
          },
        });
        resolve();
      };
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit';
      s.async = true;
      s.onerror = () => reject(new Error('check unavailable'));
      document.head.appendChild(s);
    });
    return turnstileReady;
  }
  async function humanToken() {
    await loadTurnstile();
    const token = new Promise((resolve, reject) => {
      tokenWaiter = { resolve, reject };
    });
    turnstile.reset(turnstileWidget);
    turnstile.execute(turnstileWidget);
    return token;
  }
  async function protectedDownload(link, file) {
    if (link.dataset.busy) return;
    link.dataset.busy = '1';
    const label = link.innerHTML;
    link.textContent = 'Preparing…';
    try {
      const token = SITE.turnstileSiteKey ? await humanToken().catch(() => humanToken()) : ''; // one quiet retry
      const res = await fetch('/api/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: file.name, token }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'download failed');
      const { url } = await res.json();
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      showError('The download could not start. Please try again.');
    } finally {
      link.innerHTML = label;
      delete link.dataset.busy;
    }
  }
  const tip = document.getElementById('tip');
  if (SITE.tipUrl) tip.href = SITE.tipUrl;
  else tip.hidden = true;
  const print = document.getElementById('print');
  if (SITE.printUrl) {
    print.href = SITE.printUrl;
    print.target = '_blank';
    print.rel = 'noopener noreferrer';
    print.removeAttribute('aria-disabled');
    print.querySelector('small')?.remove();
  } else {
    print.addEventListener('click', (event) => event.preventDefault());
  }

  // Viewer: the restored image as a tile pyramid.
  const viewer = OpenSeadragon({
    id: 'viewer',
    showNavigationControl: false,
    showNavigator: false,
    animationTime: 0.32,
    springStiffness: 7,
    blendTime: 0.15,
    minScrollDeltaTime: -1,
    immediateRender: false,
    visibilityRatio: 0.8,
    constrainDuringPan: true,
    maxZoomPixelRatio: 2,
    imageLoaderLimit: coarse ? 4 : 6,
    maxImageCacheCount: coarse ? 90 : 220, // phones keep fewer decoded tiles so Safari does not drop the tab
    drawer: 'canvas',
    gestureSettingsMouse: { scrollToZoom: false, clickToZoom: false, dblClickToZoom: true, dragToPan: true },
    gestureSettingsTouch: { pinchToZoom: true, dragToPan: true, clickToZoom: false, dblClickToZoom: true },
    tileSources: 'tiles/poster.dzi',
  });

  // The original is drawn on a canvas under the same camera, clipped by the divider.
  const original = new Image();
  let originalReady = false;
  original.onload = () => {
    originalReady = true;
    drawOriginal();
  };
  original.onerror = () => showError('The original photo could not load. Please refresh the page.');
  original.src = 'original.jpg';

  function imageRect() {
    const item = viewer.world.getItemAt(0);
    const a = viewer.viewport.pixelFromPoint(item.imageToViewportCoordinates(0, 0), true);
    const b = viewer.viewport.pixelFromPoint(item.imageToViewportCoordinates(W, H), true);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  }

  function drawOriginal() {
    positionDivider();
    if (!originalReady || !viewer.world.getItemCount()) return;
    const cw = stage.clientWidth,
      ch = stage.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const pw = Math.round(cw * dpr),
      ph = Math.round(ch * dpr);
    if (beforeCanvas.width !== pw || beforeCanvas.height !== ph) {
      beforeCanvas.width = pw;
      beforeCanvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#101113';
    ctx.fillRect(0, 0, cw, ch);
    const r = imageRect();
    const nw = original.naturalWidth,
      nh = original.naturalHeight;
    const sx = nw / r.w,
      sy = nh / r.h; // original pixels per CSS pixel
    const x0 = Math.max(0, r.x),
      y0 = Math.max(0, r.y);
    const x1 = Math.min(cw, r.x + r.w),
      y1 = Math.min(ch, r.y + r.h);
    if (x1 <= x0 || y1 <= y0) return;
    // Hard-edged pixels only mean something when the photo is enlarged on screen.
    // Shrunk below one device pixel per photo pixel, it is always smoothed to avoid shimmer.
    const enlarged = (1 / sx) * dpr >= 1;
    const smooth = smoothingBox.checked || !enlarged;
    const pad = smooth ? 2 : 0;
    // Draw only the on-screen part of the photo, snapped to whole photo pixels.
    const ix0 = Math.max(0, Math.floor((x0 - r.x) * sx) - pad);
    const iy0 = Math.max(0, Math.floor((y0 - r.y) * sy) - pad);
    const ix1 = Math.min(nw, Math.ceil((x1 - r.x) * sx) + pad);
    const iy1 = Math.min(nh, Math.ceil((y1 - r.y) * sy) + pad);
    ctx.imageSmoothingEnabled = smooth;
    if (smooth) ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(original, ix0, iy0, ix1 - ix0, iy1 - iy0, r.x + ix0 / sx, r.y + iy0 / sy, (ix1 - ix0) / sx, (iy1 - iy0) / sy);
  }
  viewer.addHandler('update-viewport', drawOriginal);
  viewer.addHandler('open', drawOriginal);
  viewer.addHandler('open-failed', () => showError('The image could not load. Please refresh the page.'));

  smoothingBox.addEventListener('change', () => {
    drawOriginal();
    saveSettings();
  });
  getYoursBox.addEventListener('change', () => {
    actions.hidden = !getYoursBox.checked;
    saveSettings();
    if (getYoursBox.checked && SITE.turnstileSiteKey) loadTurnstile().catch(() => {});
  });
  if (getYoursBox.checked && SITE.turnstileSiteKey) loadTurnstile().catch(() => {});

  // Zooming out past the full view snaps back to it, and a rotation re-fits a fitted view.
  let atHome = true;
  function isAtHome() {
    return viewer.viewport.getZoom() <= viewer.viewport.getHomeZoom() * 1.015;
  }
  function centerAtFit() {
    if (!viewer.world.getItemCount() || !isAtHome()) return;
    const vp = viewer.viewport,
      home = vp.getHomeZoom();
    const target = vp.getBounds(),
      fit = vp.getHomeBounds();
    if (Math.abs(target.x - fit.x) > 1e-6 || Math.abs(target.y - fit.y) > 1e-6 || Math.abs(vp.getZoom() - home) > 1e-6) vp.goHome();
  }
  viewer.addHandler('animation', centerAtFit);
  viewer.addHandler('animation-finish', () => {
    atHome = isAtHome();
  });
  viewer.addHandler('resize', () => {
    if (atHome) viewer.viewport.goHome(true);
    drawOriginal();
  });

  // Mouse wheel: proportional zoom.
  viewer.addHandler('canvas-scroll', (event) => {
    event.preventDefaultAction = true;
    event.preventDefault = true;
    const raw = event.originalEvent;
    const unit = raw.deltaMode === 1 ? 16 : raw.deltaMode === 2 ? viewer.container.clientHeight : 1;
    const delta = Number.isFinite(raw.deltaY) ? raw.deltaY * unit : -event.scroll * 60;
    const factor = Math.exp(-Math.max(-240, Math.min(240, delta)) * (raw.ctrlKey ? 0.006 : 0.0025));
    viewer.viewport.zoomBy(factor, viewer.viewport.pointFromPixel(event.position, true));
    viewer.viewport.applyConstraints();
  });

  // Divider. The split is a share of the visible image, not of the window.
  function visibleImageBounds() {
    if (!viewer.world.getItemCount()) return null;
    const r = imageRect();
    return { left: Math.max(0, r.x), right: Math.min(stage.clientWidth, r.x + r.w), top: Math.max(0, r.y), bottom: Math.min(stage.clientHeight, r.y + r.h) };
  }
  function positionDivider() {
    const b = visibleImageBounds();
    if (!b || b.right <= b.left || b.bottom <= b.top) {
      divider.style.visibility = 'hidden';
      return;
    }
    divider.style.visibility = 'visible';
    stage.style.setProperty('--split', `${b.left + ((b.right - b.left) * split) / 100}px`);
    divider.style.top = `${b.top}px`;
    divider.style.bottom = `${stage.clientHeight - b.bottom}px`;
  }
  function setSplit(value) {
    split = Math.max(0, Math.min(100, value));
    positionDivider();
    divider.setAttribute('aria-valuenow', String(Math.round(split)));
    saveSettings();
  }
  function moveDivider(event) {
    const b = visibleImageBounds();
    if (!b || b.right <= b.left) return;
    const x = event.clientX - stage.getBoundingClientRect().left;
    setSplit(((x - b.left) / (b.right - b.left)) * 100);
  }
  divider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    divider.classList.remove('attention');
    divider.focus({ preventScroll: true });
    divider.setPointerCapture(event.pointerId);
    moveDivider(event);
  });
  divider.addEventListener('pointermove', (event) => {
    if (divider.hasPointerCapture(event.pointerId)) moveDivider(event);
  });
  divider.addEventListener('pointerup', (event) => {
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
  });
  divider.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 10 : 2;
    const values = { ArrowLeft: split - step, ArrowRight: split + step, Home: 0, End: 100 };
    if (event.key in values) {
      event.preventDefault();
      event.stopPropagation();
      setSplit(values[event.key]);
    }
  });
  document.getElementById('handle').addEventListener('animationend', () => divider.classList.remove('attention'));
  setSplit(split);

  // "Drag to compare" once, when the visitor first zooms in to 2.5 times the full view.
  let compareHintShown = false;
  viewer.addHandler('animation', () => {
    if (compareHintShown || !viewer.world.getItemCount()) return;
    if (viewer.viewport.getZoom(true) / viewer.viewport.getHomeZoom() < 2.5) return;
    compareHintShown = true;
    divider.classList.add('attention');
  });

  // Keyboard (desktop).
  function pan(x, y) {
    viewer.viewport.panBy(viewer.viewport.deltaPointsFromPixels(new OpenSeadragon.Point(x, y)));
    viewer.viewport.applyConstraints();
  }
  function zoomBy(f) {
    viewer.viewport.zoomBy(f);
    viewer.viewport.applyConstraints();
  }
  viewer.element.addEventListener('keydown', (event) => {
    const keys = {
      '+': () => zoomBy(1.25),
      '=': () => zoomBy(1.25),
      '-': () => zoomBy(0.8),
      0: () => viewer.viewport.goHome(),
      ArrowLeft: () => pan(-60, 0),
      ArrowRight: () => pan(60, 0),
      ArrowUp: () => pan(0, -60),
      ArrowDown: () => pan(0, 60),
    };
    if (keys[event.key]) {
      event.preventDefault();
      keys[event.key]();
    }
  });

  // Fullscreen, only where the browser supports it (not on iPhone).
  const fullscreenButton = document.getElementById('fullscreen');
  if (document.fullscreenEnabled && stage.requestFullscreen) {
    fullscreenButton.hidden = false;
    fullscreenButton.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await stage.requestFullscreen();
      } catch {
        showError('Fullscreen is not available in this browser.');
      }
    });
  }

  // One-time cues. An upright phone gets "rotate your phone" first, then "zoom in".
  // Neither is forced and neither blocks touch.
  const rotateCue = document.getElementById('rotate-cue');
  const zoomCue = document.getElementById('zoom-cue');
  const uprightPhone = matchMedia('(orientation: portrait) and (pointer: coarse)');
  let cueTimer = 0,
    cueStage = 'waiting';
  function playCue(el, ms, next) {
    clearTimeout(cueTimer);
    for (const cue of [rotateCue, zoomCue]) cue.classList.remove('visible');
    void el.offsetWidth;
    el.style.setProperty('--cue-ms', ms + 'ms');
    el.classList.add('visible');
    cueTimer = setTimeout(() => {
      el.classList.remove('visible');
      if (next) next();
    }, ms);
  }
  function showZoomCue() {
    cueStage = 'zoom';
    if (viewer.viewport.getZoom() > viewer.viewport.getHomeZoom() * 1.05) {
      cueStage = 'done';
      return;
    } // already zooming
    playCue(zoomCue, 2000, () => {
      cueStage = 'done';
    });
  }
  function startCues() {
    if (cueStage !== 'waiting' || document.hidden || !viewer.world.getItemCount()) return;
    if (uprightPhone.matches) {
      cueStage = 'rotate';
      playCue(rotateCue, 2800, showZoomCue);
    } else showZoomCue();
  }
  uprightPhone.addEventListener('change', (event) => {
    if (!event.matches && cueStage === 'rotate') showZoomCue();
  });
  viewer.addHandler('open', startCues);
  document.addEventListener('visibilitychange', startCues);
})();
