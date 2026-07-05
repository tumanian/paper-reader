// Text-selection popover, selection classification (math / citation / other),
// math TeX capture, and the "discuss / explain math / open citation / read
// later / return" actions that spawn discussions from a selection.

import {
  pendingSel, pendingCitation, currentMode, currentDocId, docMeta, returnToDocId, returnToDocName, paperText,
  nextColor, addDiscussion, setPendingSel, setPendingCitation, setReturnToDocId, setReturnToDocName,
} from './state.js';
import { persistCurrentDoc, maybeUpdateSummary } from './persistence.js';
import { addToReadLater, reopenDoc } from './library.js';
import { loadWebPage, setStatus, buildPaperReferences } from './web-loader.js';
import { parseCitation, parseParentheticalAuthorYear, parseBibliographyMetadata } from './citation-parse.js';
import { loadCitationPreview, cancelCitationPreview } from './citation-resolve.js';
import { normalizePdfSelectionText } from './pdf.js';

// Chat deps not yet extracted — wired via setSelectionHooks (`_sel`-prefixed).
let _selOpenChat = () => {};
let _selSendMessage = () => {};
let _selPaintHighlight = () => {};
let _selRenderList = () => {};
export function setSelectionHooks({ openChat, sendMessage, paintHighlight, renderList } = {}) {
  if (openChat) _selOpenChat = openChat;
  if (sendMessage) _selSendMessage = sendMessage;
  if (paintHighlight) _selPaintHighlight = paintHighlight;
  if (renderList) _selRenderList = renderList;
}

let classifyTimer = null;
let classifyToken = 0;

export function updateMathButtons() {
  const show = !!(pendingSel && pendingSel.math && pendingSel.math.isMath);
  document.getElementById('explain-math-btn').style.display = show ? 'flex' : 'none';
  document.getElementById('to-code-btn').style.display = show ? 'flex' : 'none';
  repositionPopover();
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
  // "Read later" for a selection is only meaningful once the citation resolves
  // to a real title + link; loadCitationPreview() reveals it then.
  document.getElementById('read-later-sel-btn').style.display = 'none';
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

export function updateReturnButton() {
  const btn = document.getElementById('return-doc-btn');
  if (returnToDocId && returnToDocName) {
    btn.style.display = 'inline-block';
    btn.textContent = `← ${returnToDocName.length > 28 ? returnToDocName.slice(0, 28) + '…' : returnToDocName}`;
  } else {
    btn.style.display = 'none';
  }
}

export async function finishCitationNavigation(ctx) {
  setReturnToDocId(ctx.parentDocId);
  setReturnToDocName(ctx.parentName);
  updateReturnButton();

  const d = {
    id: PaperStore.newId(),
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
  _selRenderList();
  _selOpenChat(d.id);
}

function readLaterTitleForCitation(cite, fallbackText) {
  if (cite?.citedTitle?.trim()) return cite.citedTitle.trim();
  if (cite?.refText) {
    const title = parseBibliographyMetadata(cite.refText).title?.trim();
    if (title) return title;
  }
  return cite?.label || fallbackText.slice(0, 80);
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
  const citeForLater = { ...pendingCitation };

  setPendingSel(null);
  setPendingCitation(null);
  await maybeUpdateSummary(true);
  await persistCurrentDoc();

  try {
    await loadWebPage(ctx.url, null, ctx);
  } catch (e) {
    console.error(e);
    await addToReadLater({
      title: readLaterTitleForCitation(citeForLater, ctx.citationText),
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
  // Guard: only a citation resolved to a real bibliography title may be saved
  // (prevents dummy entries from pre-resolution clicks). A link is optional —
  // linkless items keep a docId fallback so the source paper can resolve them.
  const cite = pendingCitation;
  if (!cite?.citedTitle) return;
  hidePopover();
  window.getSelection()?.removeAllRanges();

  const added = await addToReadLater({
    title: readLaterTitleForCitation(cite, pendingSel.txt),
    url: cite.url || null,
    citationText: pendingSel.txt,
    sourceDoc: docMeta.name,
    refText: cite?.refText || null,
    docId: cite.url ? null : currentDocId,
    mode: cite.url ? 'web' : docMeta.mode,
  });

  setPendingSel(null);
  setPendingCitation(null);
  if (added) setStatus('Added to Read later');
}

// Remember the selection's anchor rect so the popover can be re-placed whenever
// its height changes (e.g. async citation preview + buttons appear later).
let popoverAnchor = null;

export function positionPopover(last) {
  popoverAnchor = last;
  const pop = document.getElementById('selection-popover');
  pop.style.display = 'block';
  requestAnimationFrame(() => repositionPopover());
}

// Clamp the popover fully inside the viewport: prefer below the selection, flip
// above when it doesn't fit, and never let the top/bottom spill off-screen (the
// popover scrolls internally if it's taller than the viewport).
export function repositionPopover() {
  const pop = document.getElementById('selection-popover');
  if (!popoverAnchor || pop.style.display === 'none') return;
  const last = popoverAnchor;
  const M = 8;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;

  let left = last.right - pw / 2;
  if (left < M) left = M;
  if (left + pw > window.innerWidth - M) left = window.innerWidth - pw - M;

  const spaceBelow = window.innerHeight - last.bottom;
  const spaceAbove = last.top;
  let top;
  if (ph + 10 <= spaceBelow - M) {
    top = last.bottom + 10;                 // fits below
  } else if (ph + 10 <= spaceAbove - M) {
    top = last.top - ph - 10;               // fits above
  } else {
    top = spaceBelow >= spaceAbove ? last.bottom + 10 : M;  // pick the roomier side
  }
  if (top + ph > window.innerHeight - M) top = window.innerHeight - ph - M;
  if (top < M) top = M;

  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

export function hidePopover() {
  popoverAnchor = null;
  document.getElementById('selection-popover').style.display = 'none';
  document.getElementById('explain-math-btn').style.display = 'none';
  document.getElementById('to-code-btn').style.display = 'none';
  document.getElementById('read-later-sel-btn').style.display = 'none';
  if (classifyTimer) { clearTimeout(classifyTimer); classifyTimer = null; }
  classifyToken++;  // invalidate any in-flight classification
  cancelCitationPreview();
  setPendingCitation(null);
  document.getElementById('cite-preview').style.display = 'none';
  document.getElementById('cite-preview').innerHTML = '';
}

// Seeded math discussions — reuse the exact discuss flow, but carry the formula
// kind + captured TeX and fire an opening request through the cached full-paper
// path in sendMessage().
function startMathDiscussion(kind) {
  if (!pendingSel) return;
  const sel = pendingSel;
  hidePopover();
  window.getSelection()?.removeAllRanges();

  const d = { id:PaperStore.newId(), txt:sel.txt, mode:sel.mode,
               pageNum:sel.pageNum, color:nextColor(), wrapper:sel.wrapper,
               relRects:sel.relRects, messages:[],
               mathKind:kind, mathTex:(sel.math && sel.math.tex) || null,
               _range: sel.mode === 'web' ? sel.range.cloneRange() : null };
  addDiscussion(d);
  setPendingSel(null);
  setPendingCitation(null);

  console.groupCollapsed(`[Math] ${kind} · selected formula`);
  console.log('rendered selection:', d.txt);
  console.log('captured TeX:', d.mathTex || '(none — using rendered text)');
  console.log('source mode:', d.mode);
  console.groupEnd();

  _selPaintHighlight(d);
  persistCurrentDoc();
  _selOpenChat(d.id);

  const input = document.getElementById('msg-input');
  input.value = kind === 'code' ? 'Translate this formula to code.' : 'Explain this math.';
  _selSendMessage();
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
export function captureSelectionTex(range, anchorEl) {
  const probes = [anchorEl, range && range.startContainer, range && range.endContainer,
                  range && range.commonAncestorContainer];
  let node = null;
  for (const p of probes) { node = findMathAncestor(p); if (node) break; }
  return node ? extractTexFromMathNode(node) : '';
}

export function initSelection() {
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

  document.getElementById('ask-btn').addEventListener('click', () => {
    if (!pendingSel) return;
    hidePopover();
    window.getSelection()?.removeAllRanges();

    const d = { id:PaperStore.newId(), txt:pendingSel.txt, mode:pendingSel.mode,
                 pageNum:pendingSel.pageNum, color:nextColor(), wrapper:pendingSel.wrapper,
                 relRects:pendingSel.relRects, messages:[],
                 _range: pendingSel.mode === 'web' ? pendingSel.range.cloneRange() : null };
    addDiscussion(d);
    setPendingSel(null);
    setPendingCitation(null);

    _selPaintHighlight(d);
    persistCurrentDoc();
    _selOpenChat(d.id);   // opens empty chat with the passage + input focused — NO auto-explain
  });
  document.getElementById('explain-math-btn').addEventListener('click', () => startMathDiscussion('explain'));
  document.getElementById('to-code-btn').addEventListener('click', () => startMathDiscussion('code'));

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
}
