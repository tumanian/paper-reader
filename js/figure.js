// Figure capture: a macOS-⌘⇧4-style one-shot rectangle screenshot of a figure
// (from the PDF page canvas or the web article), which seeds a figure-explain
// discussion. Also renders the captured image inside the chat.

import { currentDocId, currentMode, docMeta, addDiscussion, nextColor } from './state.js';
import { persistCurrentDoc } from './persistence.js';
import { hidePopover } from './selection.js';
import { normalizePdfSelectionText } from './pdf.js';
import { resolveMediaUrl } from './util.js';

// Chat deps not yet extracted — wired via setFigureHooks (`_fig`-prefixed).
let _figOpenChat = () => {};
let _figPaintHighlight = () => {};
export function setFigureHooks({ openChat, paintHighlight } = {}) {
  if (openChat) _figOpenChat = openChat;
  if (paintHighlight) _figPaintHighlight = paintHighlight;
}

// Figure capture can be disabled via FIGURE_CAPTURE_ENABLED=false. Rendering
// previously-captured figures stays enabled regardless.
export const FIGURE_CAPTURE_ENABLED = true;

const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
const FIGURE_MOD_LABEL = IS_MAC ? '⌘⇧F' : 'Ctrl⇧F';

function articlePageUrl() {
  return docMeta?.url
    || document.getElementById('article-source-url')?.querySelector('a')?.href
    || window.location.href;
}

let captureArmed = false;
let _captureEls = null;       // { overlay, banner } while armed
let _captureDrag = null;      // { startX, startY, rect } during a drag

export function figureToast(msg, ms = 2600) {
  let el = document.getElementById('figure-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'figure-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

// Only meaningful while a paper is open in the reader.
function isFigureCaptureAvailable() {
  return !!currentDocId && (currentMode === 'pdf' || currentMode === 'web');
}

export function armFigureCapture() {
  if (!FIGURE_CAPTURE_ENABLED) return;
  if (captureArmed || !isFigureCaptureAvailable()) return;
  captureArmed = true;
  hidePopover();
  window.getSelection()?.removeAllRanges();

  const overlay = document.createElement('div');
  overlay.id = 'figure-capture-overlay';
  const banner = document.createElement('div');
  banner.id = 'figure-capture-banner';
  banner.innerHTML = `Drag a box around a figure &nbsp;·&nbsp; <kbd>Esc</kbd> to cancel`;

  overlay.addEventListener('mousedown', onCaptureMouseDown);
  document.body.appendChild(overlay);
  document.body.appendChild(banner);
  _captureEls = { overlay, banner };
}

function disarmFigureCapture() {
  captureArmed = false;
  if (_captureDrag?.rect) _captureDrag.rect.remove();
  _captureDrag = null;
  if (_captureEls) {
    _captureEls.overlay.removeEventListener('mousedown', onCaptureMouseDown);
    _captureEls.overlay.remove();
    _captureEls.banner.remove();
    _captureEls = null;
  }
  window.removeEventListener('mousemove', onCaptureMouseMove);
  window.removeEventListener('mouseup', onCaptureMouseUp);
}

function onCaptureMouseDown(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const rect = document.createElement('div');
  rect.className = 'fig-capture-rect';
  document.body.appendChild(rect);
  _captureDrag = { startX: e.clientX, startY: e.clientY, rect };
  positionCaptureRect(e.clientX, e.clientY);
  window.addEventListener('mousemove', onCaptureMouseMove);
  window.addEventListener('mouseup', onCaptureMouseUp);
}

function positionCaptureRect(curX, curY) {
  if (!_captureDrag) return;
  const left = Math.min(_captureDrag.startX, curX);
  const top = Math.min(_captureDrag.startY, curY);
  const width = Math.abs(curX - _captureDrag.startX);
  const height = Math.abs(curY - _captureDrag.startY);
  Object.assign(_captureDrag.rect.style, {
    left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px',
  });
  return { left, top, width, height };
}

function onCaptureMouseMove(e) { positionCaptureRect(e.clientX, e.clientY); }

async function onCaptureMouseUp(e) {
  if (!_captureDrag) { disarmFigureCapture(); return; }
  e.preventDefault();
  e.stopPropagation();
  const box = positionCaptureRect(e.clientX, e.clientY);
  // Tear the overlay down BEFORE reading pixels: the capture works off source
  // canvases / <img> elements (not the composited screen), and removing it lets
  // us probe the real DOM underneath. One-shot — we always return to reading.
  disarmFigureCapture();

  if (!box || box.width < 6 || box.height < 6) return; // a click, not a drag
  figureToast('Capturing figure…', 1600);
  let result = null;
  try {
    result = currentMode === 'pdf' ? capturePdfRegion(box) : await captureWebRegion(box);
  } catch (err) {
    console.warn('[Figure] capture failed:', err);
  }
  if (!result || !result.dataUrl) {
    figureToast('Couldn’t capture that figure — try reloading the page.');
    return;
  }
  await startFigureDiscussion(result);
}

// ── PDF: crop from the rendered page canvas(es) ──────────
// Composites every intersecting .pdf-canvas into one output canvas. Same-origin
// canvas → toDataURL never taints.
function capturePdfRegion(box) {
  const canvases = [...document.querySelectorAll('#pdf-pages .pdf-canvas')];
  const hits = [];
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    const ix = Math.max(box.left, r.left), iy = Math.max(box.top, r.top);
    const ax = Math.min(box.left + box.width, r.left + r.width);
    const ay = Math.min(box.top + box.height, r.top + r.height);
    if (ax - ix > 2 && ay - iy > 2) hits.push({ c, r, ix, iy, ax, ay, area: (ax - ix) * (ay - iy) });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.area - a.area);
  const primary = hits[0];
  const scale = primary.c.width / primary.r.width; // output device-px per CSS-px

  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(box.width * scale));
  out.height = Math.max(1, Math.round(box.height * scale));
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);

  for (const h of hits) {
    const sx = h.c.width / h.r.width, sy = h.c.height / h.r.height;
    ctx.drawImage(
      h.c,
      (h.ix - h.r.left) * sx, (h.iy - h.r.top) * sy,
      (h.ax - h.ix) * sx, (h.ay - h.iy) * sy,
      (h.ix - box.left) * scale, (h.iy - box.top) * scale,
      (h.ax - h.ix) * scale, (h.ay - h.iy) * scale,
    );
  }

  const wrapper = primary.c.closest('.pdf-page-wrapper');
  const wr = wrapper.getBoundingClientRect();
  return {
    dataUrl: out.toDataURL('image/png'),
    mediaType: 'image/png',
    caption: pdfCaptionForRect(wrapper, box),
    pageNum: +wrapper.dataset.page || null,
    wrapper,
    relRects: [{ left: box.left - wr.left, top: box.top - wr.top, width: box.width, height: box.height }],
    w: out.width, h: out.height,
  };
}

// Grab text-layer spans inside the box plus a band just below it — figure
// captions usually sit beneath the artwork.
function pdfCaptionForRect(wrapper, box) {
  const layer = wrapper.querySelector('.textLayer');
  if (!layer) return '';
  const band = {
    left: box.left, top: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height + Math.min(140, box.height * 0.7),
  };
  const spans = [...layer.querySelectorAll('span, div')]
    .map((s) => ({ s, r: s.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.right > band.left && r.left < band.right && r.bottom > band.top && r.top < band.bottom)
    .sort((a, b) => (a.r.top - b.r.top) || (a.r.left - b.r.left));
  return normalizePdfSelectionText(spans.map(({ s }) => s.textContent).join(' ')).slice(0, 400);
}

// ── Web/arXiv: rasterize the boxed region ────────────────
// Primary path (covers ar5iv figures, which are <img>): find the media element
// with the largest overlap and crop the box∩element region. <canvas>/<svg> are
// rasterized directly; cross-origin <img> taint is worked around by reloading
// with CORS, then by fetching the bytes through the existing CORS-proxy chain.
// Fallback for pure HTML/CSS figures: a best-effort <foreignObject> snapshot.
async function captureWebRegion(box) {
  const aw = document.getElementById('article-wrapper');
  const body = document.getElementById('article-body');
  if (!aw || !body) return null;

  const media = [...body.querySelectorAll('img, canvas, svg')];
  let best = null;
  for (const el of media) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const ix = Math.max(box.left, r.left), iy = Math.max(box.top, r.top);
    const ax = Math.min(box.left + box.width, r.left + r.width);
    const ay = Math.min(box.top + box.height, r.top + r.height);
    const w = ax - ix, h = ay - iy;
    if (w > 2 && h > 2) {
      const area = w * h;
      if (!best || area > best.area) best = { el, r, area };
    }
  }

  const ar = aw.getBoundingClientRect();
  const relRects = [{ left: box.left - ar.left, top: box.top - ar.top, width: box.width, height: box.height }];

  let dataUrl = null, caption = '';
  if (best) {
    dataUrl = await rasterizeElementCrop(best.el, best.r, box);
    caption = webCaptionFor(best.el);
    // Cropping can fail when the on-screen <img> is cross-origin (canvas taint).
    // Fetch the full source image server-side rather than falling back to a DOM
    // snapshot, which often captures surrounding text instead of the figure.
    if (!dataUrl) dataUrl = await captureFullMediaElement(best.el, best.r);
  }
  if (!dataUrl && !best) {
    dataUrl = await captureDomRegionFallback(box).catch(() => null);
  }
  if (!dataUrl) return null;
  return { dataUrl, mediaType: 'image/png', caption, pageNum: null, wrapper: aw, relRects, w: box.width, h: box.height };
}

function loadImage(src, crossOrigin) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Crop the box∩element region out of an already-drawable source (image/canvas),
// mapping CSS coords → the source's natural pixel grid. Throws if the source
// canvas is tainted (cross-origin) — callers catch and retry.
function cropDrawableToDataUrl(drawable, natW, natH, elRect, box) {
  const sxScale = natW / elRect.width, syScale = natH / elRect.height;
  const ix = Math.max(box.left, elRect.left), iy = Math.max(box.top, elRect.top);
  const ax = Math.min(box.left + box.width, elRect.left + elRect.width);
  const ay = Math.min(box.top + box.height, elRect.top + elRect.height);
  const sw = Math.max(1, Math.round((ax - ix) * sxScale));
  const sh = Math.max(1, Math.round((ay - iy) * syScale));
  const out = document.createElement('canvas');
  out.width = sw; out.height = sh;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sw, sh);
  ctx.drawImage(drawable, Math.round((ix - elRect.left) * sxScale), Math.round((iy - elRect.top) * syScale), sw, sh, 0, 0, sw, sh);
  return out.toDataURL('image/png');
}

async function rasterizeElementCrop(el, elRect, box) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'canvas') {
    try { return cropDrawableToDataUrl(el, el.width, el.height, elRect, box); } catch (_) { return null; }
  }
  if (tag === 'svg') {
    try {
      const clone = el.cloneNode(true);
      clone.setAttribute('width', elRect.width);
      clone.setAttribute('height', elRect.height);
      const xml = new XMLSerializer().serializeToString(clone);
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      const img = await loadImage(url);
      return cropDrawableToDataUrl(img, elRect.width, elRect.height, elRect, box);
    } catch (_) { return null; }
  }
  // <img> — on-screen pixels are usually cross-origin (ar5iv etc.), so draw via
  // a same-origin blob fetched through our server proxy.
  const natW = el.naturalWidth || elRect.width, natH = el.naturalHeight || elRect.height;
  const src = resolveMediaUrl(el.currentSrc || el.src, articlePageUrl());
  const blobUrl = await fetchImageViaProxy(src).catch(() => null);
  if (blobUrl) {
    try {
      const img = await loadImage(blobUrl);
      const u = cropDrawableToDataUrl(
        img,
        img.naturalWidth || natW,
        img.naturalHeight || natH,
        elRect,
        box,
      );
      URL.revokeObjectURL(blobUrl);
      return u;
    } catch (_) { URL.revokeObjectURL(blobUrl); }
  }
  return null;
}

async function captureFullMediaElement(el, elRect) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'canvas') {
    try {
      const out = document.createElement('canvas');
      out.width = el.width; out.height = el.height;
      out.getContext('2d').drawImage(el, 0, 0);
      return out.toDataURL('image/png');
    } catch (_) { return null; }
  }
  if (tag === 'svg') {
    try {
      const clone = el.cloneNode(true);
      clone.setAttribute('width', elRect.width);
      clone.setAttribute('height', elRect.height);
      const xml = new XMLSerializer().serializeToString(clone);
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      const img = await loadImage(url);
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(elRect.width));
      out.height = Math.max(1, Math.round(elRect.height));
      out.getContext('2d').drawImage(img, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    } catch (_) { return null; }
  }
  if (tag !== 'img') return null;
  const src = resolveMediaUrl(el.currentSrc || el.src, articlePageUrl());
  const blobUrl = await fetchImageViaProxy(src).catch(() => null);
  if (!blobUrl) return null;
  try {
    const img = await loadImage(blobUrl);
    const out = document.createElement('canvas');
    out.width = Math.max(1, img.naturalWidth || Math.round(elRect.width));
    out.height = Math.max(1, img.naturalHeight || Math.round(elRect.height));
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(blobUrl);
    return out.toDataURL('image/png');
  } catch (_) {
    URL.revokeObjectURL(blobUrl);
    return null;
  }
}

// Fetch image bytes through our server proxy (same-origin blob, no canvas taint).
async function fetchImageViaProxy(url) {
  const resolved = resolveMediaUrl(url, articlePageUrl());
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined;
  try {
    const r = await fetch(`/api/fetch-image?url=${encodeURIComponent(resolved)}`, { signal: timeout });
    if (!r.ok) return null;
    const blob = await r.blob();
    if (blob && blob.size > 64) return URL.createObjectURL(blob);
  } catch (_) {}
  return null;
}

// Best-effort rasterization of an arbitrary DOM region via an SVG
// <foreignObject> clone. This is the documented imperfect fallback for figures
// that aren't a single <img>/<canvas>/<svg>; external CSS and cross-origin
// images may not survive, in which case it throws and the caller shows a toast.
async function captureDomRegionFallback(box) {
  const body = document.getElementById('article-body');
  if (!body) return null;
  const clone = body.cloneNode(true);
  clone.querySelectorAll('script, .highlights-layer').forEach((n) => n.remove());
  const br = body.getBoundingClientRect();
  const w = Math.max(1, Math.round(box.width));
  const h = Math.max(1, Math.round(box.height));
  const offX = Math.round(box.left - br.left);
  const offY = Math.round(box.top - br.top);
  const html = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<foreignObject x="${-offX}" y="${-offY}" width="${br.width}" height="${br.height}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${br.width}px;background:#fff">${html}</div>` +
    `</foreignObject></svg>`;
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const img = await loadImage(url);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0);
  return out.toDataURL('image/png');
}

// Nearest caption for a captured web element: a <figure>'s <figcaption>, else a
// neighbouring caption-ish element.
function webCaptionFor(el) {
  const fig = el.closest('figure');
  const cap = fig?.querySelector('figcaption')
    || el.parentElement?.querySelector('figcaption')
    || el.nextElementSibling;
  const txt = cap && /caption|figure|fig/i.test((cap.className || '') + ' ' + (cap.tagName || ''))
    ? cap.textContent
    : (fig?.querySelector('figcaption')?.textContent || '');
  return (txt || '').replace(/\s+/g, ' ').trim().slice(0, 400);
}

// Create a figure discussion: behaves like any other (highlight, persistence,
// list/restore), but carries a captured image (stored in IndexedDB, NOT in the
// localStorage doc state) and a figure-explanation framing. Seeded, NOT
// auto-sent — clicking Send starts the conversation, matching the discuss flow.
async function startFigureDiscussion(result) {
  const id = Date.now();
  const imageKey = `fig::${currentDocId || 'nodoc'}::${id}`;
  const cap = result.caption || '';
  const d = {
    id,
    txt: cap || (result.pageNum ? `Figure (captured region, p.${result.pageNum})` : 'Figure (captured region)'),
    mode: currentMode,
    pageNum: result.pageNum ?? null,
    color: nextColor(),
    wrapper: result.wrapper || null,
    relRects: result.relRects || [],
    messages: [],
    figure: { kind: 'explain', imageKey, mediaType: result.mediaType || 'image/png', w: result.w || null, h: result.h || null },
    figureCaption: cap || null,
  };
  d._figureDataUrl = result.dataUrl; // in-memory cache; persisted bytes live in IDB

  try { await PaperStore.putFigure(imageKey, { dataUrl: result.dataUrl, mediaType: d.figure.mediaType, w: d.figure.w, h: d.figure.h }); }
  catch (e) { console.warn('[Figure] could not store image in IndexedDB:', e); }

  addDiscussion(d);
  if (d.wrapper && d.relRects.length) _figPaintHighlight(d);
  persistCurrentDoc();
  _figOpenChat(id);

  const input = document.getElementById('msg-input');
  input.value = 'Explain this figure.';
  input.focus();
}

// Lazy-load a figure's captured image (dataURL) from IndexedDB, caching it on
// the discussion so repeated sends/renders don't re-read.
export async function ensureFigureImage(d) {
  if (!d || !d.figure) return null;
  if (d._figureDataUrl) return d._figureDataUrl;
  try {
    const rec = await PaperStore.getFigure(d.figure.imageKey);
    if (rec && rec.dataUrl) { d._figureDataUrl = rec.dataUrl; return rec.dataUrl; }
  } catch (e) { console.warn('[Figure] could not load image:', e); }
  return null;
}

export function renderChatFigure(box, d) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-figure';
  const img = document.createElement('img');
  img.className = 'chat-figure-img';
  img.alt = 'Captured figure';
  wrap.appendChild(img);
  box.appendChild(wrap);
  ensureFigureImage(d).then((url) => { if (url) img.src = url; });
}

export function initFigure() {
  // Disabled: hide the affordance and skip wiring the shortcut/click entirely.
  if (!FIGURE_CAPTURE_ENABLED) {
    const hintEl = document.getElementById('figure-hint');
    if (hintEl) hintEl.style.display = 'none';
    return;
  }
  // Shortcut + hint affordance. Toggle arm on ⌘⇧F (Ctrl⇧F elsewhere); Esc cancels.
  document.addEventListener('keydown', (e) => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (mod && e.shiftKey && (e.key === 'f' || e.key === 'F') && !e.altKey) {
      if (!isFigureCaptureAvailable() && !captureArmed) return;
      e.preventDefault();
      if (captureArmed) disarmFigureCapture(); else armFigureCapture();
      return;
    }
    if (e.key === 'Escape' && captureArmed) { e.preventDefault(); disarmFigureCapture(); }
  });

  const hint = document.getElementById('figure-hint');
  const keys = document.getElementById('figure-hint-keys');
  if (keys) keys.textContent = FIGURE_MOD_LABEL;
  // Clicking the hint arms the same one-shot capture as the shortcut.
  // TODO(touch/iPad): the keyboard shortcut doesn't exist on touch devices — a
  // touch capture button would arm here and drive the drag from touchstart/
  // touchmove/touchend instead of mouse events. Not implemented yet.
  if (hint) hint.addEventListener('click', () => { if (!captureArmed) armFigureCapture(); });
}
