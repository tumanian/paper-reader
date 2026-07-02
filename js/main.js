import { esc, renderPreviewHtml, md, timeAgo, simpleHash, asGlobalRegex, isTodoValue, normalizeForMatch, decodeXmlText } from './util.js';
import { pdfDoc, discussions, activeId, pendingSel, pendingCitation, currentDocId, currentMode, docMeta, conversationSummary, summaryMessageCount, summaryDirty, returnToDocId, returnToDocName, bibByNumber, paperReferences, citationFormat, paperText, paperRefText, MAX_PAPER_CHARS, citationFormatPromise, setCitationFormatPromise } from './state.js';
import { addDiscussion, removeDiscussion, clearDiscussions, replaceDiscussions, setPdfDoc, setActiveId, setPendingSel, setPendingCitation, setCurrentDocId, setCurrentMode, setDocMeta, setConversationSummary, setSummaryMessageCount, setSummaryDirty, setReturnToDocId, setReturnToDocName, setBibByNumber, setPaperReferences, setCitationFormat, setPaperText, setPaperRefText } from './state.js';
import { initStorage, loadStore, persistCurrentDoc, docIdFor, restoreDiscussions, loadDocSummary, scheduleSummaryUpdate, maybeUpdateSummary, setPersistenceHooks, clearScheduledSummaryUpdate } from './persistence.js';
import { renderLibrary, renderReadLater, addToReadLater, reopenDoc, updateAuthBar, updateLogoutFab, initLibrary, setLibraryHooks } from './library.js';
import { initPdf, setPdfHooks, loadPDF, renderFromBuffer, renderPDFPages, restoreHighlightsForLoadedPages, sanitizePdfString, pdfFontSize, combinePdfTextItems, pdfTextItemsToString, normalizePdfSelectionText } from './pdf.js';
import { extractReferencesSection, resolveReferenceEntry, extractRefNumber, findReferenceInPaper, authorLastNames, scoreCrossrefItem, verifyFetchedPaperAgainstBib, parseAuthorYearFromSelection, parseAuthorYearCitation, parseParentheticalAuthorYear, parseCitation, parseBibliographyMetadata, sanitizeCitationFormat, buildFallbackCitationFormat, matchCitationToReferences } from './citation-parse.js';
import { initWebLoader, setWebLoaderHooks, loadWebPage, loadArxivPdf, startApp, setStatus, showViewer, parseArxivId, arxivIdFromUrl, fetchViaProxy, buildPaperReferences, expandSelectionText } from './web-loader.js';
import { setCitationResolveHooks, logCitation, ensureCitationFormat, loadCitationPreview, cancelCitationPreview } from './citation-resolve.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ═══════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════
// Shared, cross-cutting app state lives in state.js (single source of truth).
// Reads use the imported live bindings; writes go through the imported writer
// functions. Only feature-local plumbing remains declared here.
let classifyTimer = null;
let classifyToken = 0;

const COLORS = [
  { bg:'rgba(255,215,0,.45)',   dot:'#c9a000' },
  { bg:'rgba(80,210,130,.45)',  dot:'#1a9950' },
  { bg:'rgba(100,165,255,.45)', dot:'#2e72e0' },
  { bg:'rgba(255,110,150,.45)', dot:'#d02060' },
  { bg:'rgba(195,115,255,.45)', dot:'#8830d8' },
  { bg:'rgba(255,145,60,.45)',  dot:'#d05010' },
];
function nextColor() { return COLORS[discussions.length % COLORS.length]; }




function updateMathButtons() {
  const show = !!(pendingSel && pendingSel.math && pendingSel.math.isMath);
  document.getElementById('explain-math-btn').style.display = show ? 'flex' : 'none';
  document.getElementById('to-code-btn').style.display = show ? 'flex' : 'none';
}

// Ask Haiku to classify the raw selection. Returns 'math' | 'citation' | 'other'.
async function classifySelection(text) {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'classify-selection', selection: text }),
  });
  const data = await r.json();
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.message);
  return data.kind || 'other';
}

// Single source of truth for which extra buttons show: hand the raw selection
// to Haiku and route on its answer. Plain "Discuss" is always available.
function updatePopoverButtons() {
  const citeBtn = document.getElementById('cite-open-btn');
  const previewEl = document.getElementById('cite-preview');

  // Reset to the neutral state; classification will reveal the right controls.
  document.getElementById('explain-math-btn').style.display = 'none';
  document.getElementById('to-code-btn').style.display = 'none';
  citeBtn.style.display = 'none';
  previewEl.style.display = 'none';
  cancelCitationPreview();
  if (classifyTimer) { clearTimeout(classifyTimer); classifyTimer = null; }
  setPendingCitation(null);

  if (!pendingSel) return;
  const sel = pendingSel;
  const text = (sel.txt || '').trim();
  // Long prose isn't a formula or a citation — skip the roundtrip, Discuss only.
  if (!text || text.length > 500) return;

  buildPaperReferences();

  const token = ++classifyToken;
  classifyTimer = setTimeout(async () => {
    classifyTimer = null;
    let kind = 'other';
    try { kind = await classifySelection(text); }
    catch (e) { console.warn('[Classify] failed:', e.message); }
    // Stale guard: bail if the selection changed while we were waiting.
    if (token !== classifyToken || pendingSel !== sel) return;
    console.info('[Classify]', { selection: text.slice(0, 120), kind });

    sel.math = { isMath: kind === 'math', tex: sel.mathTex || '' };
    if (kind === 'math') {
      updateMathButtons();
    } else if (kind === 'citation') {
      loadCitationPreview();
    }
  }, 180);
}

function updateReturnButton() {
  const btn = document.getElementById('return-doc-btn');
  if (returnToDocId && returnToDocName) {
    btn.style.display = 'inline-block';
    btn.textContent = `← ${returnToDocName.length > 28 ? returnToDocName.slice(0, 28) + '…' : returnToDocName}`;
  } else {
    btn.style.display = 'none';
  }
}

async function finishCitationNavigation(ctx) {
  setReturnToDocId(ctx.parentDocId);
  setReturnToDocName(ctx.parentName);
  updateReturnButton();

  const d = {
    id: Date.now(),
    txt: `Citation: ${ctx.citationText}`,
    mode: currentMode,
    pageNum: null,
    color: nextColor(),
    wrapper: currentMode === 'web' ? document.getElementById('article-wrapper') : null,
    relRects: [],
    messages: [],
    citationMeta: {
      parentDocId: ctx.parentDocId,
      parentName: ctx.parentName,
      citationText: ctx.citationText,
      refText: ctx.refText || '',
    },
  };
  addDiscussion(d);
  await persistCurrentDoc();
  renderList();
  openChat(d.id);
}

async function openCitationPaper() {
  if (!pendingSel || !pendingCitation?.url) return;
  hidePopover();
  window.getSelection()?.removeAllRanges();

  const ctx = {
    parentDocId: currentDocId,
    parentName: docMeta.name,
    citationText: pendingSel.txt,
    refText: pendingCitation.refText || '',
    url: pendingCitation.url,
  };
  const citeLabel = pendingCitation.label;

  setPendingSel(null);
  setPendingCitation(null);
  await maybeUpdateSummary(true);
  await persistCurrentDoc();

  try {
    await loadWebPage(ctx.url, null, ctx);
  } catch (e) {
    console.error(e);
    await addToReadLater({
      title: citeLabel || ctx.citationText,
      url: ctx.url,
      citationText: ctx.citationText,
      sourceDoc: ctx.parentName,
      refText: ctx.refText,
    });
    alert(`Couldn't load the cited paper. It was added to Read later.`);
    if (ctx.parentDocId) await reopenDoc(ctx.parentDocId);
  }
}

async function addSelectionToReadLater() {
  if (!pendingSel) return;
  hidePopover();
  window.getSelection()?.removeAllRanges();

  const cite = pendingCitation || parseCitation(pendingSel.txt);
  const added = await addToReadLater({
    title: cite?.label || pendingSel.txt.slice(0, 80),
    url: cite?.url || null,
    citationText: pendingSel.txt,
    sourceDoc: docMeta.name,
    refText: cite?.refText || null,
    docId: cite?.url ? null : currentDocId,
    mode: cite?.url ? 'web' : docMeta.mode,
  });

  setPendingSel(null);
  setPendingCitation(null);
  if (added) setStatus('Added to Read later');
}

// ═══════════════════════════════════════════════════════
//  TEXT SELECTION
// ═══════════════════════════════════════════════════════
document.addEventListener('mouseup', e => {
  if (e.target.closest('#selection-popover') || e.target.closest('#sidebar')) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const txt = sel?.toString().trim();
    if (!txt) { hidePopover(); return; }

    const range    = sel.getRangeAt(0);
    const selEl    = range.commonAncestorContainer.nodeType === 3
                     ? range.commonAncestorContainer.parentElement
                     : range.commonAncestorContainer;
    const rawRects = Array.from(range.getClientRects()).filter(r => r.width > 1);
    if (!rawRects.length) { hidePopover(); return; }

    setPendingCitation(parseCitation(txt));
    if (!pendingCitation) setPendingCitation(parseParentheticalAuthorYear(txt));
    if (txt.length < 2 && !pendingCitation) { hidePopover(); return; }

    const pageWrap = selEl.closest('.pdf-page-wrapper');
    if (pageWrap) {
      const pr = pageWrap.getBoundingClientRect();
      const cleanTxt = normalizePdfSelectionText(txt);
      setPendingSel({
        txt: cleanTxt, range: range.cloneRange(), mode:'pdf', pageNum:+pageWrap.dataset.page, wrapper: pageWrap,
        relRects: rawRects.map(r => ({ left:r.left-pr.left, top:r.top-pr.top, width:r.width, height:r.height })),
        mathTex: captureSelectionTex(range, selEl), math: null
      });
      positionPopover(rawRects[rawRects.length-1]);
      updatePopoverButtons();
      return;
    }

    const aw = document.getElementById('article-wrapper');
    if (aw && selEl.closest('#article-body, #article-heading')) {
      const ar = aw.getBoundingClientRect();
      setPendingSel({
        txt, range: range.cloneRange(), mode:'web', pageNum:null, wrapper:aw,
        relRects: rawRects.map(r => ({ left:r.left-ar.left, top:r.top-ar.top, width:r.width, height:r.height })),
        mathTex: captureSelectionTex(range, selEl), math: null
      });
      positionPopover(rawRects[rawRects.length-1]);
      updatePopoverButtons();
      return;
    }
    hidePopover();
  }, 5);
});
document.addEventListener('mousedown', e => { if (!e.target.closest('#selection-popover')) hidePopover(); });

function positionPopover(last) {
  const pop = document.getElementById('selection-popover');
  pop.style.display = 'block';
  requestAnimationFrame(() => {
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = last.right - pw/2, top = last.bottom + 10;
    if (left < 8) left = 8;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top  + ph > window.innerHeight - 8) top = last.top - ph - 8;
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  });
}
function hidePopover() {
  document.getElementById('selection-popover').style.display = 'none';
  document.getElementById('explain-math-btn').style.display = 'none';
  document.getElementById('to-code-btn').style.display = 'none';
  if (classifyTimer) { clearTimeout(classifyTimer); classifyTimer = null; }
  classifyToken++;  // invalidate any in-flight classification
  cancelCitationPreview();
  setPendingCitation(null);
  document.getElementById('cite-preview').style.display = 'none';
  document.getElementById('cite-preview').innerHTML = '';
}

// ═══════════════════════════════════════════════════════
//  CREATE DISCUSSION  (no auto-answer — waits for question)
// ═══════════════════════════════════════════════════════
document.getElementById('ask-btn').addEventListener('click', () => {
  if (!pendingSel) return;
  hidePopover();
  window.getSelection()?.removeAllRanges();

  const d = { id:Date.now(), txt:pendingSel.txt, mode:pendingSel.mode,
               pageNum:pendingSel.pageNum, color:nextColor(), wrapper:pendingSel.wrapper,
               relRects:pendingSel.relRects, messages:[] };
  addDiscussion(d);
  setPendingSel(null);
  setPendingCitation(null);

  paintHighlight(d);
  persistCurrentDoc();
  openChat(d.id);   // opens empty chat with the passage + input focused — NO auto-explain
});
// Seeded math discussions — reuse the exact discuss flow, but carry the formula
// kind + captured TeX and fire an opening request through the cached full-paper
// path in sendMessage().
function startMathDiscussion(kind) {
  if (!pendingSel) return;
  const sel = pendingSel;
  hidePopover();
  window.getSelection()?.removeAllRanges();

  const d = { id:Date.now(), txt:sel.txt, mode:sel.mode,
               pageNum:sel.pageNum, color:nextColor(), wrapper:sel.wrapper,
               relRects:sel.relRects, messages:[],
               mathKind:kind, mathTex:(sel.math && sel.math.tex) || null };
  addDiscussion(d);
  setPendingSel(null);
  setPendingCitation(null);

  console.groupCollapsed(`[Math] ${kind} · selected formula`);
  console.log('rendered selection:', d.txt);
  console.log('captured TeX:', d.mathTex || '(none — using rendered text)');
  console.log('source mode:', d.mode);
  console.groupEnd();

  paintHighlight(d);
  persistCurrentDoc();
  openChat(d.id);

  const input = document.getElementById('msg-input');
  input.value = kind === 'code' ? 'Translate this formula to code.' : 'Explain this math.';
  sendMessage();
}
document.getElementById('explain-math-btn').addEventListener('click', () => startMathDiscussion('explain'));
document.getElementById('to-code-btn').addEventListener('click', () => startMathDiscussion('code'));

// ═══════════════════════════════════════════════════════
//  FIGURE CAPTURE  (one-shot rectangle screenshot → explain)
// ═══════════════════════════════════════════════════════
// Modeled on macOS ⌘⇧4: a shortcut ARMS a single capture (crosshair + dim
// overlay), the user drags ONE box, and on mouse-up we crop those pixels and
// auto-return to normal reading. Esc / re-pressing the shortcut cancels. While
// not armed, nothing changes — the overlay is the only thing intercepting
// pointer events, so text selection, the discuss/math popover, etc. are
// untouched, and tearing the overlay down restores the page exactly.
const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
const FIGURE_MOD_LABEL = IS_MAC ? '⌘⇧F' : 'Ctrl⇧F';

let captureArmed = false;
let _captureEls = null;       // { overlay, banner } while armed
let _captureDrag = null;      // { startX, startY, rect } during a drag

function figureToast(msg, ms = 2600) {
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

function armFigureCapture() {
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
    figureToast('Couldn’t capture that region — try boxing a single figure.');
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
  }
  if (!dataUrl) {
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
  // <img>
  const natW = el.naturalWidth || elRect.width, natH = el.naturalHeight || elRect.height;
  try { return cropDrawableToDataUrl(el, natW, natH, elRect, box); } catch (_) {}
  const src = el.currentSrc || el.src;
  const viaCors = await loadImage(src, 'anonymous').catch(() => null);
  if (viaCors) {
    try { return cropDrawableToDataUrl(viaCors, viaCors.naturalWidth || natW, viaCors.naturalHeight || natH, elRect, box); } catch (_) {}
  }
  const blobUrl = await fetchImageViaProxy(src).catch(() => null);
  if (blobUrl) {
    try {
      const img = await loadImage(blobUrl);
      const u = cropDrawableToDataUrl(img, img.naturalWidth || natW, img.naturalHeight || natH, elRect, box);
      URL.revokeObjectURL(blobUrl);
      return u;
    } catch (_) { URL.revokeObjectURL(blobUrl); }
  }
  return null;
}

// Reuse the same CORS-proxy hosts the article fetcher uses, but for image
// BYTES → an object URL we can draw without tainting the canvas.
async function fetchImageViaProxy(url) {
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined;
  const attempts = [
    async () => { const r = await fetch(url, { signal: timeout }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); },
    async () => { const r = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, { signal: timeout }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); },
    async () => { const r = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(url)}`, { signal: timeout }); if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); },
  ];
  for (const attempt of attempts) {
    try {
      const blob = await attempt();
      if (blob && blob.size > 64 && /^image\//.test(blob.type || 'image/')) return URL.createObjectURL(blob);
    } catch (_) {}
  }
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
  if (d.wrapper && d.relRects.length) paintHighlight(d);
  persistCurrentDoc();
  openChat(id);

  const input = document.getElementById('msg-input');
  input.value = 'Explain this figure.';
  input.focus();
}

// Lazy-load a figure's captured image (dataURL) from IndexedDB, caching it on
// the discussion so repeated sends/renders don't re-read.
async function ensureFigureImage(d) {
  if (!d || !d.figure) return null;
  if (d._figureDataUrl) return d._figureDataUrl;
  try {
    const rec = await PaperStore.getFigure(d.figure.imageKey);
    if (rec && rec.dataUrl) { d._figureDataUrl = rec.dataUrl; return rec.dataUrl; }
  } catch (e) { console.warn('[Figure] could not load image:', e); }
  return null;
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

(function initFigureHint() {
  const hint = document.getElementById('figure-hint');
  const keys = document.getElementById('figure-hint-keys');
  if (keys) keys.textContent = FIGURE_MOD_LABEL;
  // Clicking the hint arms the same one-shot capture as the shortcut.
  // TODO(touch/iPad): the keyboard shortcut doesn't exist on touch devices — a
  // touch capture button would arm here and drive the drag from touchstart/
  // touchmove/touchend instead of mouse events. Not implemented yet.
  if (hint) hint.addEventListener('click', () => { if (!captureArmed) armFigureCapture(); });
})();

// Onboarding demo highlights auto-run the feature they advertise on first click,
// so a first-time visitor sees citations / explain-math / to-code in action
// without having to discover the gesture. After the demo has run once (math/code
// leave a chat behind) clicks fall through to the normal discussion.
const FEATURE_CTA = { math: '✨ Explain math', code: '{ } To code', citation: '📚 Show citation', figure: '🖼 Explain a figure' };
function runOnboardingDemo(d) {
  if (!d || !d.feature || d.feature === 'discuss') return false;
  if (d.messages && d.messages.length) return false;
  // Figure can't be auto-run (it needs a real drag) — clicking the teaching
  // highlight arms the one-shot capture so the user performs the gesture.
  if (d.feature === 'figure') {
    armFigureCapture();
    figureToast('Drag a box around the figure above to capture it.');
    return true;
  }
  if (d.feature === 'citation') { showOnboardingCitationDemo(d); return true; }
  if (d.feature === 'math' || d.feature === 'code') {
    d.mathKind = d.feature === 'code' ? 'code' : 'explain';
    d.mathTex = d.tex || d.mathTex || null;
    openChat(d.id);
    const input = document.getElementById('msg-input');
    input.value = d.feature === 'code' ? 'Translate this formula to code.' : 'Explain this math.';
    sendMessage();
    return true;
  }
  return false;
}

// Replay the real citation flow: re-locate the snippet, synthesize the same
// pendingSel a live selection would produce, then show the preview popover.
function showOnboardingCitationDemo(d) {
  const aw = document.getElementById('article-wrapper');
  const body = document.getElementById('article-body');
  const range = (aw && body) ? locateTextRange(body, d.txt) : null;
  if (!range) { openChat(d.id); return; }
  const anchor = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
  anchor?.scrollIntoView({ block: 'center' });
  const rects = Array.from(range.getClientRects()).filter(r => r.width > 1);
  if (!rects.length) { openChat(d.id); return; }
  const ar = aw.getBoundingClientRect();
  // d.cite (e.g. "[13]") drives the matcher directly; passing range:null skips
  // expandSelectionText so the marker isn't clobbered by the prose anchor text.
  const txt = d.cite || range.toString();
  setPendingSel({
    txt, range: d.cite ? null : range.cloneRange(), mode: 'web', pageNum: null, wrapper: aw,
    relRects: rects.map(r => ({ left: r.left - ar.left, top: r.top - ar.top, width: r.width, height: r.height })),
    mathTex: null, math: null,
  });
  setPendingCitation(parseCitation(txt) || parseParentheticalAuthorYear(txt));
  document.getElementById('explain-math-btn').style.display = 'none';
  document.getElementById('to-code-btn').style.display = 'none';
  positionPopover(rects[rects.length - 1]);
  loadCitationPreview();
}
document.getElementById('cite-open-btn').addEventListener('click', () => { openCitationPaper(); });
document.getElementById('read-later-sel-btn').addEventListener('click', () => { addSelectionToReadLater(); });
document.getElementById('read-later-paper-btn').addEventListener('click', async () => {
  if (!currentDocId) return;
  const added = await addToReadLater({
    id: 'rl::' + currentDocId,
    title: docMeta.name,
    url: docMeta.url,
    mode: docMeta.mode,
    docId: currentDocId,
  });
  if (added) setStatus('Added to Read later');
});
document.getElementById('return-doc-btn').addEventListener('click', async () => {
  if (!returnToDocId) return;
  const target = returnToDocId;
  const targetName = returnToDocName;
  setReturnToDocId(null);
  setReturnToDocName(null);
  updateReturnButton();
  await maybeUpdateSummary(true);
  persistCurrentDoc();
  await reopenDoc(target);
});

function paintHighlight(d) {
  const layer = d.wrapper?.querySelector('.highlights-layer');
  if (!layer) return;
  for (const r of d.relRects) {
    const div = document.createElement('div');
    div.className = 'hl-rect';
    div.dataset.discId = d.id;
    if (d.onboarding) div.dataset.onboarding = '1';
    const cta = d.feature && FEATURE_CTA[d.feature] ? FEATURE_CTA[d.feature] + ' — click to try' : '';
    if (cta || d.note) div.title = [cta, d.note].filter(Boolean).join('  ·  ');
    Object.assign(div.style, { left:r.left+'px', top:r.top+'px', width:r.width+'px', height:r.height+'px', background:d.color.bg });
    div.addEventListener('click', () => { if (!runOnboardingDemo(d)) openChat(d.id); });
    layer.appendChild(div);
  }
}

// ═══════════════════════════════════════════════════════
//  DISCUSSION LIST
// ═══════════════════════════════════════════════════════
function renderList() {
  const panel = document.getElementById('disc-list-panel');
  document.getElementById('disc-count').textContent = discussions.length;
  panel.innerHTML = '';
  if (!discussions.length) {
    panel.innerHTML = `<div class="empty-state"><div class="e-icon">💬</div>
      <p>Select any text to start a discussion with Claude</p></div>`;
    return;
  }
  for (const d of discussions) {
    const vis  = d.messages.filter(m => !m.hidden);
    const last = vis[vis.length-1];
    const lbl  = d.mode === 'pdf' ? `Page ${d.pageNum}` : 'Web';
    const card = document.createElement('div');
    card.className = 'disc-card' + (activeId === d.id ? ' active' : '');
    card.innerHTML = `
      <div class="dc-top">
        <div class="dc-dot" style="background:${d.color.dot}"></div>
        <span class="dc-meta">${lbl} · ${vis.length} msg</span>
        <button class="dc-del" title="Delete">×</button>
      </div>
      <div class="dc-quote">${esc(d.txt.slice(0,110))}${d.txt.length>110?'…':''}</div>
      ${ d.note ? `<div class="dc-note">💡 ${esc(d.note)}</div>` : '' }
      ${ last ? `<div class="dc-preview">${esc(last.content.slice(0,70))}…</div>`
              : (d.feature && FEATURE_CTA[d.feature]
                  ? `<span class="dc-cta">${FEATURE_CTA[d.feature]} →</span>`
                  : `<span class="dc-unanswered">${d.note ? 'Tap to discuss' : 'No question yet'}</span>`) }`;
    card.addEventListener('click', e => {
      if (e.target.classList.contains('dc-del')) return;
      if (!runOnboardingDemo(d)) openChat(d.id);
    });
    card.querySelector('.dc-del').addEventListener('click', e => {
      e.stopPropagation(); deleteDiscussion(d.id);
    });
    panel.appendChild(card);
  }
}

function deleteDiscussion(id) {
  const d = discussions.find(x => x.id === id);
  if (d && d.wrapper) {
    // remove painted rects for this highlight (repaint all to be safe)
    const layer = d.wrapper.querySelector('.highlights-layer');
    if (layer) layer.innerHTML = '';
  }
  removeDiscussion(id);
  // repaint remaining on this wrapper
  const wraps = new Set(discussions.map(x => x.wrapper).filter(Boolean));
  wraps.forEach(w => { const l = w.querySelector('.highlights-layer'); if (l) l.innerHTML=''; });
  discussions.forEach(x => { if (x.wrapper) paintHighlight(x); });
  persistCurrentDoc();
  if (activeId === id) showList(); else renderList();
}

// ═══════════════════════════════════════════════════════
//  CHAT
// ═══════════════════════════════════════════════════════
function openChat(id) {
  setActiveId(id);
  const d = discussions.find(x => x.id === id); if (!d) return;
  document.getElementById('disc-list-panel').style.display = 'none';
  document.getElementById('chat-panel').style.display = 'flex';
  document.getElementById('chat-hl-text').textContent =
    `"${d.txt.slice(0,180)}${d.txt.length>180?'…':''}"`;
  rebuildChat(d);
  scrollHighlightIntoView(d);
  const input = document.getElementById('msg-input');
  input.focus();
}

// Bring the reader to the highlight for a discussion (PDF page or web article).
function scrollHighlightIntoView(d) {
  if (!d) return;
  const rect = document.querySelector(`.hl-rect[data-disc-id="${d.id}"]`);
  if (rect && typeof rect.scrollIntoView === 'function') {
    rect.scrollIntoView({ block: 'center' });
  }
}
function showList() {
  setActiveId(null);
  document.getElementById('chat-panel').style.display = 'none';
  document.getElementById('disc-list-panel').style.display = 'flex';
  renderList();
}
document.getElementById('back-btn').addEventListener('click', showList);

// ═══════════════════════════════════════════════════════
//  RESPONSE RATINGS — "golden set" capture (separate IDB)
// ═══════════════════════════════════════════════════════
// Stored in their OWN IndexedDB database, independent of paperReader.files
// (PDF bytes). Clearing the library or a document only touches the pdfs store,
// so collected ratings are never deleted as a side effect.
const RATINGS_DB = 'paperReader.ratings';
const RATINGS_STORE = 'ratings';
const RATING_SCHEMA_VERSION = 1;
const RATING_REASONS = ['incorrect', 'too verbose', 'missed the point', 'other'];
// A constant per page load; lets later analysis group by session without a schema change.
const SESSION_ID = (crypto?.randomUUID?.() || ('s' + Date.now() + Math.random().toString(36).slice(2)));

function openRatingsDB() {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) { resolve(null); return; }
    const req = indexedDB.open(RATINGS_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RATINGS_STORE)) {
        db.createObjectStore(RATINGS_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}
function ratingsTx(mode) {
  return openRatingsDB().then(db => db ? db.transaction(RATINGS_STORE, mode).objectStore(RATINGS_STORE) : null);
}
async function getRatingRecord(id) {
  const store = await ratingsTx('readonly'); if (!store) return null;
  return new Promise((res) => { const r = store.get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
}
async function putRatingRecord(rec) {
  const store = await ratingsTx('readwrite');
  if (store) await new Promise((res) => { const r = store.put(rec); r.onsuccess = () => res(true); r.onerror = () => res(false); });
  // Mirror to the backend (best-effort; local copy is the source of truth offline).
  try { await PaperStore.saveRating?.(rec); }
  catch (e) { console.warn('[Rating] cloud save failed (kept locally):', e.message); }
  return true;
}
async function deleteRatingRecord(id) {
  const store = await ratingsTx('readwrite');
  if (store) await new Promise((res) => { const r = store.delete(id); r.onsuccess = () => res(true); r.onerror = () => res(false); });
  try { await PaperStore.deleteRating?.(id); }
  catch (e) { console.warn('[Rating] cloud delete failed:', e.message); }
  return true;
}
async function getAllRatingRecords() {
  const store = await ratingsTx('readonly'); if (!store) return [];
  return new Promise((res) => {
    const r = store.getAll ? store.getAll() : null;
    if (r) { r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); return; }
    res([]);
  });
}

function ratingIdFor(d, msgIndex) {
  return `${currentDocId || 'nodoc'}::${d.id}::m${msgIndex}`;
}

// Capture the full reproducible context for one assistant response.
function buildRatingRecord(d, msgIndex, rating, reason) {
  let question = '';
  for (let i = msgIndex - 1; i >= 0; i--) {
    if (d.messages[i] && d.messages[i].role === 'user') { question = d.messages[i].content; break; }
  }
  let userId = null;
  try { userId = PaperStore.getEmail?.() || null; } catch (_) {}
  return {
    id: ratingIdFor(d, msgIndex),
    schemaVersion: RATING_SCHEMA_VERSION,
    rating,
    reason: reason || null,
    selectedText: d.mathTex || d.txt || '',
    selectedTextKind: d.mathTex ? 'latex' : 'text',
    mathKind: d.mathKind || null,
    question,
    response: d.messages[msgIndex]?.content || '',
    model: CHAT_MODEL,
    docId: currentDocId || null,
    paperTitle: docMeta?.name || null,
    paperUrl: docMeta?.url || null,
    discussionId: d.id,
    messageIndex: msgIndex,
    citationMeta: d.citationMeta || null,
    sessionId: SESSION_ID,
    userId,
  };
}

// Subtle thumbs row appended BELOW the message body so it never overlaps the
// selectable response text. Reflects saved state and allows change/clear.
function renderRatingControl(msgDiv, d, msgIndex) {
  if (!msgDiv) return;
  const id = ratingIdFor(d, msgIndex);
  const row = document.createElement('div');
  row.className = 'msg-rate';
  row.innerHTML =
    `<button class="msg-rate-btn up" title="Good response">👍</button>` +
    `<button class="msg-rate-btn down" title="Bad response">👎</button>` +
    `<span class="msg-rate-thanks"></span>` +
    `<div class="msg-rate-reasons" style="display:none"></div>`;
  msgDiv.appendChild(row);

  const upBtn = row.querySelector('.up');
  const downBtn = row.querySelector('.down');
  const thanks = row.querySelector('.msg-rate-thanks');
  const reasons = row.querySelector('.msg-rate-reasons');

  RATING_REASONS.forEach((reason) => {
    const b = document.createElement('button');
    b.className = 'msg-rate-reason';
    b.dataset.reason = reason;
    b.textContent = reason;
    reasons.appendChild(b);
  });

  function paint(rec) {
    upBtn.classList.toggle('active', rec?.rating === 'up');
    downBtn.classList.toggle('active', rec?.rating === 'down');
    if (rec?.rating === 'down') {
      reasons.style.display = 'flex';
      reasons.querySelectorAll('.msg-rate-reason').forEach((b) =>
        b.classList.toggle('active', b.dataset.reason === rec.reason));
    } else {
      reasons.style.display = 'none';
    }
    thanks.textContent = rec ? 'saved' : '';
  }

  let current = null;
  getRatingRecord(id).then((rec) => { current = rec; paint(rec); });

  async function setRating(rating) {
    // Toggle off if clicking the already-active vote → clear the record.
    if (current && current.rating === rating) {
      await deleteRatingRecord(id);
      current = null; paint(null);
      return;
    }
    const now = Date.now();
    const rec = buildRatingRecord(d, msgIndex, rating, rating === 'down' ? (current?.reason || null) : null);
    rec.createdAt = current?.createdAt || now;
    rec.updatedAt = now;
    await putRatingRecord(rec);
    current = rec; paint(rec);
  }

  upBtn.addEventListener('click', () => setRating('up'));
  downBtn.addEventListener('click', () => setRating('down'));
  reasons.addEventListener('click', async (e) => {
    const b = e.target.closest('.msg-rate-reason');
    if (!b || !current) return;
    const reason = current.reason === b.dataset.reason ? null : b.dataset.reason; // toggle
    current.reason = reason;
    current.updatedAt = Date.now();
    await putRatingRecord(current);
    paint(current);
  });
}

async function exportRatings() {
  const local = await getAllRatingRecords();
  let cloud = [];
  try { cloud = await PaperStore.getRatingsFromCloud?.() || []; }
  catch (e) { console.warn('[Rating] cloud fetch for export failed; exporting local only:', e.message); }
  // Merge by id, preferring the most recently updated copy.
  const byId = new Map();
  for (const rec of [...local, ...cloud]) {
    const prev = byId.get(rec.id);
    if (!prev || (rec.updatedAt || 0) >= (prev.updatedAt || 0)) byId.set(rec.id, rec);
  }
  const records = [...byId.values()];
  const btn = document.getElementById('export-ratings-btn');
  if (!records.length) {
    if (btn) { const t = btn.textContent; btn.textContent = 'No rated responses yet'; setTimeout(() => { btn.textContent = t; }, 1600); }
    return;
  }
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `paper-reader-ratings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.getElementById('export-ratings-btn')?.addEventListener('click', exportRatings);

function rebuildChat(d) {
  const box = document.getElementById('chat-messages');
  box.innerHTML = '';
  // Captured figures show a thumbnail at the top of the thread (lazy-loaded
  // from IndexedDB), so the discussion always carries its image — fresh or
  // restored — even before the first message.
  if (d.figure) renderChatFigure(box, d);
  const vis = d.messages.filter(m => !m.hidden);
  if (!vis.length) {
    const citeHint = d.figure
      ? `${d.figureCaption ? '💡 ' + esc(d.figureCaption) + '<br><br>' : ''}Press Send to have Claude explain the captured figure above.`
      : d.note
      ? `💡 ${esc(d.note)}<br><br>Ask anything about this passage — try “Explain this”, or select a formula for the math tools.`
      : d.citationMeta
      ? `Opened from a citation in “${esc(d.citationMeta.parentName)}”.<br>Ask anything about this paper.`
      : `Ask anything about this highlight.<br>Claude has the context of your earlier highlights in this document.`;
    box.insertAdjacentHTML('beforeend', `<div id="chat-empty-hint">
      <div class="ceh-icon">✦</div>
      ${citeHint}
    </div>`);
    return;
  }
  d.messages.forEach((m, idx) => {
    if (m.hidden) return;
    const div = addMsg(m.role, m.content);
    if (m.role === 'assistant') renderRatingControl(div, d, idx);
  });
  box.scrollTop = box.scrollHeight;
}

// Render the captured figure thumbnail at the top of a figure discussion.
function renderChatFigure(box, d) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-figure';
  const img = document.createElement('img');
  img.className = 'chat-figure-img';
  img.alt = 'Captured figure';
  wrap.appendChild(img);
  box.appendChild(wrap);
  ensureFigureImage(d).then((url) => { if (url) img.src = url; });
}
function addMsg(role, content, typing=false) {
  const box = document.getElementById('chat-messages');
  const hint = document.getElementById('chat-empty-hint');
  if (hint) hint.remove();
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.innerHTML = typing
    ? `<div class="msg-role">${role==='assistant'?'Claude':'You'}</div>
       <div class="msg-body"><div class="typing-dots"><div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div></div></div>`
    : `<div class="msg-role">${role==='assistant'?'Claude':'You'}</div>
       <div class="msg-body">${md(esc(content))}</div>`;
  box.appendChild(div); box.scrollTop = box.scrollHeight;
  return div;
}

// Build cross-highlight context from OTHER discussions in this doc
function buildDocContext(currentId) {
  const others = discussions.filter(d => d.id !== currentId && d.messages.some(m => !m.hidden));
  if (!others.length) return '';
  let ctx = `\n\nEarlier highlights and discussions from THIS SAME DOCUMENT (the researcher may build on them):\n`;
  others.forEach((d, i) => {
    ctx += `\n[Highlight ${i+1}] "${d.txt.slice(0,200)}${d.txt.length>200?'…':''}"\n`;
    const vis = d.messages.filter(m => !m.hidden);
    vis.forEach(m => {
      ctx += `  ${m.role === 'user' ? 'Researcher' : 'You'}: ${m.content.slice(0,300)}${m.content.length>300?'…':''}\n`;
    });
  });
  return ctx;
}

// ═══════════════════════════════════════════════════════
//  MATH DETECTION & CAPTURE
// ═══════════════════════════════════════════════════════
// Climb from a node to the nearest rendered-math container, if any.
function findMathAncestor(node) {
  let el = node && node.nodeType === 3 ? node.parentElement : node;
  for (let i = 0; el && el !== document.body && i < 12; i++, el = el.parentElement) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'math' || tag === 'mjx-container') return el;
    // className can be an SVGAnimatedString on MathML/SVG nodes
    const cls = el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className;
    if (typeof cls === 'string' && /\b(MathJax|katex)\b|\bmjx-/.test(cls)) return el;
  }
  return null;
}

// Pull the real TeX source for a rendered formula. ar5iv / MathJax / KaTeX all
// embed it in <annotation encoding="application/x-tex">; KaTeX also exposes
// data-tex / aria attributes as a fallback.
function extractTexFromMathNode(node) {
  let el = node;
  for (let i = 0; el && el !== document.body && i < 6; i++, el = el.parentElement) {
    if (!el.querySelector) continue;
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    if (ann && ann.textContent.trim()) return ann.textContent.trim();
    const dataTex = el.getAttribute && el.getAttribute('data-tex');
    if (dataTex && dataTex.trim()) return dataTex.trim();
    const nested = el.querySelector('[data-tex]');
    if (nested && nested.getAttribute('data-tex').trim()) return nested.getAttribute('data-tex').trim();
  }
  return '';
}

// Capture the real TeX for a selection if it intersects a rendered-math node.
// This is just source extraction — whether the selection *is* math is decided
// by Haiku (classify-selection), not here.
function captureSelectionTex(range, anchorEl) {
  const probes = [anchorEl, range && range.startContainer, range && range.endContainer,
                  range && range.commonAncestorContainer];
  let node = null;
  for (const p of probes) { node = findMathAncestor(p); if (node) break; }
  return node ? extractTexFromMathNode(node) : '';
}

// Locate the highlight inside the full paper text and return the surrounding
// window. Used as a fallback when the full paper is too big to send, and also
// helps Claude resolve references like "this", "the above equation", etc.
function findNearbyContext(highlightText, radius = 1500) {
  if (!paperText) return '';
  // normalize whitespace for a forgiving match
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const hay = norm(paperText);
  const needle = norm(highlightText).slice(0, 120); // first chunk is enough to locate
  let idx = hay.indexOf(needle);
  if (idx === -1) {
    // try a shorter, distinctive slice
    idx = hay.indexOf(needle.slice(0, 50));
  }
  if (idx === -1) return '';
  const start = Math.max(0, idx - radius);
  const end   = Math.min(hay.length, idx + needle.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < hay.length ? '…' : '';
  return prefix + hay.slice(start, end) + suffix;
}

// Decide what document context to attach, given the "full if it fits" policy.
// Returns { block, cacheable } where block is the text to send.
function buildPaperBlock() {
  // Rough token estimate: ~4 chars/token. Send full paper if under ~150k tokens.
  if (paperText && paperText.length <= MAX_PAPER_CHARS) {
    return { text: paperText, kind: 'full' };
  }
  return { text: '', kind: 'none' };
}

async function sendMessage() {
  const input = document.getElementById('msg-input');
  const txt   = input.value.trim();
  if (!txt || !activeId) return;
  const d = discussions.find(x => x.id === activeId); if (!d) return;

  input.value=''; input.style.height='auto';
  d.messages.push({role:'user',content:txt}); addMsg('user',txt);
  persistCurrentDoc();
  scheduleSummaryUpdate();

  const loader = addMsg('assistant','',true);
  document.getElementById('send-btn').disabled = true;

  // ── Assemble system as content blocks so the paper can be cached ──
  const systemBlocks = [];

  // 1) Instruction block (small, not cached separately)
  systemBlocks.push({
    type: 'text',
    text:
      `You are a sharp, concise research assistant helping someone read a paper or article. ` +
      `Answer using the FULL DOCUMENT provided below as your source of truth — resolve references ` +
      `like "this", "the above equation", or "the previous section" against it. ` +
      `Lead with the core point, then briefly elaborate. Use plain language even for dense technical content. ` +
      `If something genuinely isn't in the document, say so rather than guessing.`,
  });

  // 2) Full-paper block (CACHED — same text on every question → cheap repeats)
  const paper = buildPaperBlock();
  if (paper.kind === 'full') {
    systemBlocks.push({
      type: 'text',
      text: `=== FULL DOCUMENT: ${docMeta.name} ===\n\n${paper.text}`,
      cache_control: { type: 'ephemeral' },
    });
  } else {
    // Fallback: paper too large or unavailable → send nearby context only
    const near = findNearbyContext(d.txt, 2500);
    if (near) {
      systemBlocks.push({
        type: 'text',
        text: `=== NEARBY CONTEXT (full paper too large to include) ===\n\n${near}`,
      });
    }
  }

  // 3) Citation navigation context (when opened from another paper)
  if (d.citationMeta) {
    systemBlocks.push({
      type: 'text',
      text:
        `=== CITATION CONTEXT ===\n` +
        `The researcher opened this paper from a citation while reading "${d.citationMeta.parentName}".\n` +
        `Selected citation: "${d.citationMeta.citationText}"\n` +
        (d.citationMeta.refText ? `Bibliography entry: ${d.citationMeta.refText}\n` : '') +
        `Answer in light of both this paper and why they followed the citation.`,
    });
  }

  // 3b) Math framing (when the thread was started from a formula). Sits next to
  // the cached full-document block so notation resolves against the whole paper.
  if (d.mathKind) {
    const texLine = d.mathTex ? `\nLaTeX source of the selected formula:\n${d.mathTex}\n` : '';
    if (d.mathKind === 'code') {
      systemBlocks.push({
        type: 'text',
        text:
          `=== MATH-TO-CODE REQUEST ===\n` +
          `The highlighted passage is a mathematical formula from this paper.${texLine}` +
          `Translate it into readable PyTorch/NumPy-style code with named variables and tensor ` +
          `shapes in comments; use einsum where it maps cleanly. Lead with the code block, then ` +
          `one or two lines mapping the code back to the notation. Resolve every symbol against the ` +
          `FULL DOCUMENT above.`,
      });
    } else {
      systemBlocks.push({
        type: 'text',
        text:
          `=== MATH EXPLANATION REQUEST ===\n` +
          `The highlighted passage is a mathematical formula from this paper.${texLine}` +
          `Explain it tightly in three tiers, skipping obvious terms:\n` +
          `1. One sentence in plain language: what the formula does.\n` +
          `2. Term-by-term breakdown: for each symbol, what it is, its shape/dimensions if inferable, ` +
          `and where it was defined earlier in THIS paper (name the section or equation if findable).\n` +
          `3. Why it's here: what it accomplishes in the paper's argument.\n` +
          `Resolve every symbol against the FULL DOCUMENT above.`,
      });
    }
  }

  // 3c) Figure framing (when the thread was started from a captured figure). The
  // captured image rides on the first user turn (below); this block tells Claude
  // how to explain it, grounded in the cached full document above.
  if (d.figure) {
    const capLine = d.figureCaption ? `\nNearby caption / context text: "${d.figureCaption}"\n` : '';
    systemBlocks.push({
      type: 'text',
      text:
        `=== FIGURE EXPLANATION REQUEST ===\n` +
        `The researcher captured a figure (a diagram, plot, or attention/feature map) from this ` +
        `paper; it is attached as an image on their message.${capLine}` +
        `First, say in ONE line what the figure shows. Then walk through the key elements — axes, ` +
        `components, what is being compared, and the takeaway — in plain language, tying it directly ` +
        `to the paper's argument (use the FULL DOCUMENT above to ground it). Skip the obvious and be concise.`,
    });
  }

  // 4) The specific highlight + cross-highlight memory (small, dynamic)
  systemBlocks.push({
    type: 'text',
    text:
      `=== THE RESEARCHER HIGHLIGHTED THIS PASSAGE ===\n"${d.txt}"\n` +
      buildDocContext(d.id),
  });

  const apiMessages = d.messages.filter(m=>!m.hidden).slice(-14).map(({role,content})=>({role,content}));

  // Attach the captured figure to the FIRST user turn as an image content block.
  // handler.js forwards `messages` verbatim, so array content with a
  // {type:'image'} block reaches the API unchanged — no key handling touched.
  // Stored messages stay plain strings (cloud-safe); the image is materialized
  // here, at send time, from IndexedDB.
  if (d.figure) {
    const dataUrl = await ensureFigureImage(d);
    const firstUser = apiMessages.findIndex(m => m.role === 'user');
    if (dataUrl && firstUser !== -1) {
      const comma = dataUrl.indexOf(',');
      const mediaType = dataUrl.slice(5, dataUrl.indexOf(';')) || d.figure.mediaType || 'image/png';
      const userText = typeof apiMessages[firstUser].content === 'string' ? apiMessages[firstUser].content : 'Explain this figure.';
      apiMessages[firstUser] = {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: dataUrl.slice(comma + 1) } },
          { type: 'text', text: userText },
        ],
      };
    }
  }
  if (d.mathKind) {
    const mathBlock = systemBlocks.find(b => /=== MATH/.test(b.text || ''));
    console.groupCollapsed(`[Math] ${d.mathKind} · → Claude`);
    console.log('user message:', txt);
    console.log('math system block:', mathBlock?.text);
    console.log('TeX sent:', d.mathTex || '(none)');
    console.log('paper context:', paper.kind === 'full' ? `full (${paper.text.length} chars, cached)` : paper.kind);
    console.log('conversation turns sent:', apiMessages.length);
    console.groupEnd();
  }
  try {
    const reply = await callClaude(systemBlocks, apiMessages);
    if (d.mathKind) {
      console.groupCollapsed(`[Math] ${d.mathKind} · ← Claude`);
      console.log(reply);
      console.groupEnd();
    }
    d.messages.push({role:'assistant',content:reply});
    loader.remove();
    const replyDiv = addMsg('assistant',reply);
    renderRatingControl(replyDiv, d, d.messages.length - 1);
    persistCurrentDoc(); renderList();
    scheduleSummaryUpdate();
  } catch(e) {
    if (d.mathKind) console.warn(`[Math] ${d.mathKind} · roundtrip failed:`, e.message);
    loader.remove(); addMsg('assistant',`Error: ${e.message}`);
  }
  document.getElementById('send-btn').disabled = false;
}

const CHAT_MODEL = 'claude-sonnet-4-6';
async function callClaude(system, messages) {
  const r = await fetch('/api/chat', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:CHAT_MODEL,max_tokens:1000,system,messages})
  });
  const data = await r.json();
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.message);
  return data.content?.[0]?.text ?? 'No response.';
}

document.getElementById('send-btn').addEventListener('click', sendMessage);
document.getElementById('msg-input').addEventListener('keydown', e => {
  if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}
});
document.getElementById('msg-input').addEventListener('input', function() {
  this.style.height='auto'; this.style.height=Math.min(this.scrollHeight,100)+'px';
});

// ═══════════════════════════════════════════════════════
//  NAV: back to library
// ═══════════════════════════════════════════════════════
document.getElementById('new-btn').addEventListener('click', async () => {
  await maybeUpdateSummary(true);
  backToUpload();
});
function backToUpload() {
  cancelOnboardingPlacement();
  persistCurrentDoc();
  clearScheduledSummaryUpdate();
  setPdfDoc(null); clearDiscussions(); setActiveId(null); setPendingSel(null);
  setCurrentDocId(null); setCurrentMode(null);
  setConversationSummary(null); setSummaryMessageCount(0); setSummaryDirty(false);
  setReturnToDocId(null); setReturnToDocName(null);
  updateReturnButton();
  document.getElementById('pdf-pages').innerHTML='';
  document.getElementById('pdf-pages').style.display='none';
  document.getElementById('web-reader').style.display='none';
  document.getElementById('article-body').innerHTML='';
  document.getElementById('article-heading').textContent='';
  document.getElementById('article-source-url').innerHTML='';
  document.getElementById('main-app').style.display='none';
  document.getElementById('url-input').value='';
  document.getElementById('pdf-input').value='';
  document.getElementById('upload-screen').style.display='flex';
  showList();
  renderLibrary();
}

// ═══════════════════════════════════════════════════════
//  ONBOARDING  (first-time guided tour — paints from static curation)
// ═══════════════════════════════════════════════════════
let onboardingData = null;
// Tear-down handle for an in-flight onboarding highlight placement (its
// MutationObserver + safety timer). Called when a new paper starts loading so
// a stale observer can't fire against the next paper's DOM.
let _onboardingCancel = null;
function cancelOnboardingPlacement() {
  if (_onboardingCancel) { try { _onboardingCancel(); } catch (_) {} _onboardingCancel = null; }
}
let pendingOnboarding = null;

// Defensive parse: tolerate malformed entries without losing the rest.
function sanitizeOnboarding(json) {
  const out = { tracks: [], papers: {}, featured: '' };
  if (!json || typeof json !== 'object') return out;
  if (typeof json.featured === 'string') out.featured = json.featured;
  if (json.papers && typeof json.papers === 'object') {
    for (const [k, v] of Object.entries(json.papers)) {
      if (!v || typeof v !== 'object') continue;
      const items = Array.isArray(v.items)
        ? v.items.filter((it) => it && typeof it.snippet === 'string')
                 .map((it) => ({
                   snippet: it.snippet,
                   type: it.type || 'prose',
                   note: typeof it.note === 'string' ? it.note : '',
                   feature: ['math', 'code', 'citation', 'discuss', 'figure'].includes(it.feature) ? it.feature : 'discuss',
                   tex: typeof it.tex === 'string' ? it.tex : null,
                   cite: typeof it.cite === 'string' ? it.cite : null,
                 }))
        : [];
      out.papers[k] = { paperId: k, title: v.title || k, url: v.url || '', hook: v.hook || '', startLabel: typeof v.startLabel === 'string' ? v.startLabel : '', items };
    }
  }
  if (Array.isArray(json.tracks)) {
    for (const t of json.tracks) {
      if (!t || typeof t !== 'object') continue;
      const paperIds = Array.isArray(t.paperIds) ? t.paperIds.filter((id) => out.papers[id]) : [];
      out.tracks.push({ id: t.id || '', label: t.label || 'Untitled', blurb: t.blurb || '', paperIds });
    }
  }
  return out;
}

async function loadOnboardingData() {
  if (onboardingData) return onboardingData;
  try {
    const r = await fetch('/onboarding-curation.json', { cache: 'no-cache' });
    onboardingData = sanitizeOnboarding(await r.json());
  } catch (e) {
    console.warn('[Onboarding] could not load curation:', e?.message);
    onboardingData = { tracks: [], papers: {} };
  }
  return onboardingData;
}

// The featured annotated paper, surfaced as a sparkled card in the library
// for everyone. Reads the cached curation (preloaded at boot); returns null
// until loaded.
function getFeaturedPaper() {
  const data = onboardingData;
  if (!data || !data.papers) return null;
  return data.papers[data.featured]
    || data.papers['attention-is-all-you-need']
    || Object.values(data.papers)[0]
    || null;
}

// Open the featured annotated example. Its pre-placed annotations are applied
// via maybeApplyOnboardingCuration once the page renders.
async function openFeaturedExample() {
  await loadOnboardingData();
  await openOnboardingPaper(getFeaturedPaper());
}

async function openOnboardingPaper(paper) {
  if (!paper || isTodoValue(paper.url)) {
    alert('This example has no URL yet — add a real one in onboarding-curation.json.');
    return;
  }
  pendingOnboarding = paper;
  await loadWebPage(paper.url);
}

// Locate a verbatim snippet in a rendered container and return a DOM Range.
// Walks text nodes, builds a whitespace-normalized concatenation with a char→
// (node, offset) map, finds the snippet, and rebuilds a Range. Returns null if
// not found (caller skips silently).
function locateTextRange(root, snippet) {
  const target = normalizeForMatch(snippet).toLowerCase();
  if (!root || target.length < 4) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (p && p.closest('script,style,.highlights-layer')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let full = '';
  const map = [];
  let n;
  while ((n = walker.nextNode())) {
    const raw = n.nodeValue;
    let prevSpace = full.length > 0 && full[full.length - 1] === ' ';
    for (let i = 0; i < raw.length; i++) {
      if (/\s/.test(raw[i])) {
        if (prevSpace) continue;
        full += ' '; map.push({ node: n, offset: i }); prevSpace = true;
      } else {
        full += raw[i].toLowerCase(); map.push({ node: n, offset: i }); prevSpace = false;
      }
    }
    if (!prevSpace) { full += ' '; map.push({ node: n, offset: raw.length }); }
  }
  const idx = full.indexOf(target);
  if (idx === -1) return null;
  const startPos = map[idx];
  const endPos = map[idx + target.length - 1];
  if (!startPos || !endPos) return null;
  try {
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset + 1);
    return range;
  } catch (_) { return null; }
}

function rectsForRange(range, wrapperEl) {
  const wrap = wrapperEl.getBoundingClientRect();
  return Array.from(range.getClientRects())
    .filter((r) => r.width > 1)
    .map((r) => ({ left: r.left - wrap.left, top: r.top - wrap.top, width: r.width, height: r.height }));
}

// Paint precomputed highlights for the just-opened onboarding paper. Reuses the
// normal discussion + paintHighlight path; skips unmatched snippets silently.
function maybeApplyOnboardingCuration() {
  const paper = pendingOnboarding;
  pendingOnboarding = null;
  if (!paper || currentMode !== 'web' || !Array.isArray(paper.items)) return;
  if (discussions.length > 0) {
    // Reopened. If the visitor never engaged (every highlight is an untouched
    // onboarding demo), refresh from the latest curation so edits/new feature
    // demos show up. If they have a real discussion going, leave it alone.
    const refreshable = discussions.every(d => d.onboarding && (!d.messages || d.messages.length === 0));
    if (!refreshable) return;
    const layer = document.getElementById('article-wrapper')?.querySelector('.highlights-layer');
    if (layer) layer.innerHTML = '';
    clearDiscussions();
  }
  applyOnboardingItems(paper.items.slice());
}

// Place curated highlights, reusing the normal discussion + paintHighlight path.
// Some sites (e.g. Distill) hydrate custom elements (<d-cite>, math) well after
// first render, so a snippet may not be locatable for several seconds. We do an
// immediate pass for what's ready, then re-attempt the rest on every DOM
// mutation (debounced) until everything places or a 20s safety deadline hits.
// Unmatched snippets are skipped silently — partial success is fine.
function applyOnboardingItems(items) {
  cancelOnboardingPlacement();
  const startedAt = Date.now();
  let remaining = items.slice();
  let observer = null, debounce = null, finished = false;

  function attempt() {
    const aw = document.getElementById('article-wrapper');
    const body = document.getElementById('article-body');
    if (!aw || !body) return;
    const stillMissing = [];
    let placedAny = false;
    for (const item of remaining) {
      try {
        if (!item || typeof item.snippet !== 'string' || isTodoValue(item.snippet)) continue;
        const range = locateTextRange(body, item.snippet);
        const relRects = range ? rectsForRange(range, aw) : [];
        if (!relRects.length) { stillMissing.push(item); continue; }
        const feature = ['math', 'code', 'citation', 'discuss', 'figure'].includes(item.feature) ? item.feature : 'discuss';
        const d = {
          id: Date.now() + discussions.length + Math.floor(Math.random() * 1000),
          txt: normalizeForMatch(range.toString()),
          mode: 'web', pageNum: null, color: nextColor(), wrapper: aw,
          relRects, messages: [],
          note: item.note || null, onboarding: true,
          feature, tex: item.tex || null, cite: item.cite || null,
        };
        addDiscussion(d);
        paintHighlight(d);
        placedAny = true;
      } catch (e) { console.warn('[Onboarding] skipped a curation item:', e?.message); }
    }
    remaining = stillMissing;
    if (placedAny) { renderList(); persistCurrentDoc(); maybeShowOnboardingHint(); }
    if (!remaining.length || Date.now() - startedAt > 20000) finish();
  }

  function finish() {
    if (finished) return;
    finished = true;
    if (observer) observer.disconnect();
    if (debounce) clearTimeout(debounce);
    if (_onboardingCancel === finish) _onboardingCancel = null;
    if (remaining.length) console.info('[Onboarding]', remaining.length, 'snippet(s) never matched the rendered page.');
  }
  _onboardingCancel = finish;

  attempt();
  if (finished) return;

  const body = document.getElementById('article-body');
  if (body && 'MutationObserver' in window) {
    observer = new MutationObserver(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(attempt, 250);
    });
    observer.observe(body, { childList: true, subtree: true, characterData: true });
  }
  setTimeout(finish, 20000);
}

function maybeShowOnboardingHint() {
  const rect = document.querySelector('#article-wrapper .hl-rect[data-onboarding="1"]');
  if (!rect) return;
  document.getElementById('ob-hint')?.remove();
  const hint = document.createElement('div');
  hint.id = 'ob-hint';
  hint.textContent = 'Tap a highlight to discuss it with Claude →';
  document.body.appendChild(hint);
  const r = rect.getBoundingClientRect();
  hint.style.top = Math.max(8, r.top - 4) + 'px';
  hint.style.left = Math.min(r.right + 12, window.innerWidth - 236) + 'px';
  const dismiss = () => {
    hint.remove();
    document.removeEventListener('click', dismiss, true);
    document.removeEventListener('keydown', dismiss, true);
  };
  setTimeout(() => {
    document.addEventListener('click', dismiss, true);
    document.addEventListener('keydown', dismiss, true);
  }, 60);
  setTimeout(dismiss, 9000);
}


setPersistenceHooks({
  onCloudSaveError: () => updateAuthBar(PaperStore.getSyncStatus()),
  onAfterSummaryPersist: () => renderLibrary(),
});

setLibraryHooks({
  loadWebPage,
  loadArxivPdf,
  startApp,
  setStatus,
  renderFromBuffer,
  restoreHighlightsForLoadedPages,
  renderList,
  showList,
  parseArxivId,
  getFeaturedPaper,
  openFeaturedExample,
  backToUpload,
});

setPdfHooks({
  startApp,
  setStatus,
  showViewer,
  renderList,
  extractReferencesSection,
  buildPaperReferences,
  ensureCitationFormat,
  paintHighlight,
});

setWebLoaderHooks({
  renderList,
  paintHighlight,
  ensureCitationFormat,
  logCitation,
  maybeApplyOnboardingCuration,
  finishCitationNavigation,
  cancelOnboardingPlacement,
  backToUpload,
});

setCitationResolveHooks({
  findNearbyContext,
});

(async function boot() {
  initStorage();
  initLibrary();
  initPdf();
  initWebLoader();
  const info = await PaperStore.init();
  updateAuthBar(info);
  await loadOnboardingData();
  renderLibrary();
  renderReadLater();
  renderList();
  // Everyone — logged in or not — lands on the upload/library page. The
  // annotated Transformer example is available to all via the explore button.
  updateLogoutFab();
})();
