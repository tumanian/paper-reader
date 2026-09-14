import { discussions, pdfDoc, paperText, docMeta, MAX_PAPER_CHARS, setPdfDoc, setCurrentMode, setCurrentDocId, setDocMeta, replaceDiscussions, setCitationFormat, setExtractedReferences, setPaperText, setPaperRefText } from './state.js';
import { docIdFor, loadStore, restoreDiscussions, loadDocSummary, persistCurrentDoc } from './persistence.js';
import { renderLibrary, updateAuthBar } from './library.js';
import { abstractFromText } from './util.js';

// Cross-module deps still owned by main.js (web-loader / chat / citation /
// references) until those modules are extracted. Wired via setPdfHooks().
// Private holders are prefixed `_pdf` so the test harness's shared-scope vm
// bundle (which strips module boundaries) doesn't collide with other modules'
// hook holders; real ESM scopes these per-module.
let _pdfStartApp = () => {};
let _pdfSetStatus = () => {};
let _pdfShowViewer = () => {};
let _pdfRenderList = () => {};
let _pdfExtractReferencesSection = () => '';
let _pdfBuildPaperReferences = () => {};
let _pdfEnsureCitationFormat = () => {};
let _pdfPaintHighlight = () => {};

export function setPdfHooks({
  startApp, setStatus, showViewer, renderList,
  extractReferencesSection, buildPaperReferences, ensureCitationFormat, paintHighlight,
} = {}) {
  if (startApp) _pdfStartApp = startApp;
  if (setStatus) _pdfSetStatus = setStatus;
  if (showViewer) _pdfShowViewer = showViewer;
  if (renderList) _pdfRenderList = renderList;
  if (extractReferencesSection) _pdfExtractReferencesSection = extractReferencesSection;
  if (buildPaperReferences) _pdfBuildPaperReferences = buildPaperReferences;
  if (ensureCitationFormat) _pdfEnsureCitationFormat = ensureCitationFormat;
  if (paintHighlight) _pdfPaintHighlight = paintHighlight;
}

export function initPdf() {
  const dropZone  = document.getElementById('drop-zone');
  const fileInput = document.getElementById('pdf-input');
  const attachBtn = document.getElementById('attach-btn');

  if (attachBtn) attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => { if (e.target.files[0]) loadPDF(e.target.files[0]); });
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f && f.type === 'application/pdf') loadPDF(f);
  });
}

export async function loadPDF(file) {
  const name = file.name.replace(/\.pdf$/i,'');
  const id = docIdFor('pdf', name + ':' + file.size);
  _pdfStartApp(name, 'PDF');
  setCurrentMode('pdf'); setCurrentDocId(id);
  // restore prior discussions for this doc, if any
  const store = loadStore();
  const saved = store[id];
  setDocMeta({ name, mode:'pdf', badge:'PDF', url:null, description: saved?.description || null });
  replaceDiscussions(saved ? restoreDiscussions(saved.discussions) : []);
  loadDocSummary(saved);
  setCitationFormat(saved?.citationFormat || null);
  setExtractedReferences(saved?.references || null);

  _pdfSetStatus('Rendering PDF…');
  const buf = await file.arrayBuffer();

  // Persist the bytes so this PDF reopens automatically from the library.
  // (Copy the buffer before pdf.js detaches it.)
  PaperStore.putPdf(id, new Blob([buf.slice(0)], { type:'application/pdf' }))
    .catch(e => { console.warn('PDF cloud upload failed:', e); updateAuthBar(PaperStore.getSyncStatus()); });

  await renderFromBuffer(buf);
  restoreHighlightsForLoadedPages();
  _pdfRenderList();
  await persistCurrentDoc();
  renderLibrary();
}

// Render a PDF from an ArrayBuffer (shared by fresh open and library reopen)
export async function renderFromBuffer(buf) {
  setPdfDoc(await pdfjsLib.getDocument({ data: buf }).promise);
  await renderPDFPages();
}

export function sanitizePdfString(s) {
  return String(s || '').replace(/\u0000/g, '');
}

export function pdfFontSize(item) {
  if (!item?.transform) return 10;
  return Math.hypot(item.transform[0], item.transform[1]) || 10;
}

export function combinePdfTextItems(items) {
  if (!items?.length) return [];
  const out = [];
  let cur = null;

  const pushCur = () => {
    if (cur?.str) out.push(cur);
    cur = null;
  };

  for (const item of items) {
    const str = sanitizePdfString(item.str);
    if (!str) {
      if (item.hasEOL) pushCur();
      continue;
    }

    if (!cur) {
      cur = {
        str,
        transform: item.transform.slice(),
        width: item.width,
        height: item.height,
        fontName: item.fontName,
        hasEOL: false,
      };
    } else {
      const fontSize = pdfFontSize(cur);
      const lineH = Math.max(cur.height || 0, item.height || 0, fontSize) * 0.65;
      const sameLine = Math.abs(cur.transform[5] - item.transform[5]) <= lineH;
      const gap = item.transform[4] - (cur.transform[4] + (cur.width || 0));

      if (sameLine && gap <= fontSize * 1.35) {
        if (gap > fontSize * 0.18) cur.str += ' ';
        cur.str += str;
        cur.width = item.transform[4] + (item.width || 0) - cur.transform[4];
        cur.height = Math.max(cur.height || 0, item.height || 0);
      } else {
        pushCur();
        cur = {
          str,
          transform: item.transform.slice(),
          width: item.width,
          height: item.height,
          fontName: item.fontName,
          hasEOL: false,
        };
      }
    }

    if (item.hasEOL) {
      if (cur) cur.hasEOL = true;
      pushCur();
    }
  }
  pushCur();
  return out;
}

export function pdfTextItemsToString(items) {
  const merged = combinePdfTextItems(items);
  if (!merged.length) return '';

  let result = '';
  let lastY = null;
  for (const item of merged) {
    const y = item.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > pdfFontSize(item) * 0.6) {
      if (!result.endsWith('\n')) result += '\n';
    } else if (result && !result.endsWith('\n') && !result.endsWith(' ')) {
      result += ' ';
    }
    result += item.str;
    if (item.hasEOL && !result.endsWith('\n')) result += '\n';
    lastY = y;
  }
  return result
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ── Title recovery from the PDF itself ───────────────────────────────────
// Used when the arXiv API can't tell us the paper's title. Two sources, in
// order of trust: the document's metadata Title (often real, often a LaTeX
// leftover like "main.dvi"), then the largest-font text block on page 1.

const PDF_TITLE_MIN = 8;
const PDF_TITLE_MAX = 300;

function cleanPdfTitleCandidate(raw) {
  const t = String(raw || '')
    .replace(/\u00ad/g, '')   // soft hyphens from justified text
    .replace(/\s+/g, ' ')
    // Trailing footnote / affiliation markers ("Title∗", "Title 1,2").
    .replace(/[\s*∗†‡§¶]+$/g, '')
    .trim();
  if (t.length < PDF_TITLE_MIN || t.length > PDF_TITLE_MAX) return null;
  if (!/[A-Za-z]/.test(t)) return null;
  if (!/\s/.test(t)) return null;                  // real titles have ≥ 2 words
  if (/^arxiv:/i.test(t)) return null;             // the arXiv stamp
  return t;
}

// Metadata Title from pdf.js `getMetadata()`: `info.Title` first, then the XMP
// dc:title. Rejects the placeholders LaTeX/Word toolchains leave behind.
export function titleFromPdfMetadata(info, metadata) {
  const candidates = [];
  if (info?.Title) candidates.push(info.Title);
  try {
    const dc = metadata?.get?.('dc:title');
    if (dc) candidates.push(Array.isArray(dc) ? dc[0] : dc);
  } catch (_) {}
  for (const c of candidates) {
    const t = cleanPdfTitleCandidate(c);
    if (!t) continue;
    if (/\.(dvi|tex|pdf|ps|docx?|md|txt)$/i.test(t)) continue;
    if (/^microsoft word\b/i.test(t)) continue;
    if (/^(untitled|main|paper|manuscript|draft|template|article|document)\b/i.test(t) && t.split(' ').length <= 2) continue;
    return t;
  }
  return null;
}

// Largest-font text block on the first page. arXiv PDFs stamp
// "arXiv:NNNN.NNNNNvN [cs.XX] D Mon YYYY" rotated along the left margin — that
// run is excluded by rotation and by text.
export function titleFromPdfTextItems(items) {
  const lines = combinePdfTextItems(items || [])
    .map((it) => ({
      str: it.str.replace(/\s+/g, ' ').trim(),
      size: pdfFontSize(it),
      x: it.transform[4],
      y: it.transform[5],
      rotated: Math.abs(it.transform[1]) > Math.abs(it.transform[0]),
    }))
    .filter((l) => l.str.length >= 2 && !l.rotated && /[A-Za-z]/.test(l.str) && !/^arXiv:\d/i.test(l.str));
  if (!lines.length) return null;

  const sizes = lines.map((l) => l.size).sort((a, b) => a - b);
  const maxSize = sizes[sizes.length - 1];
  const median = sizes[Math.floor(sizes.length / 2)];
  // A heading has to stand out from body text; a uniformly-sized page (scans,
  // missing font metrics) has no heading we can trust.
  if (maxSize < median * 1.15) return null;

  const big = lines
    .filter((l) => l.size >= maxSize * 0.94)
    .sort((a, b) => b.y - a.y || a.x - b.x);

  // Title lines wrap tightly; a big-font line further down (a section head,
  // a banner) is a different block. Keep only the first vertical cluster.
  const cluster = [big[0]];
  for (let i = 1; i < big.length; i++) {
    const prev = cluster[cluster.length - 1];
    if (prev.y - big[i].y > big[i].size * 2.2) break;
    cluster.push(big[i]);
  }

  // The title sits in the upper part of the page.
  const ys = lines.map((l) => l.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (maxY > minY && cluster[0].y < minY + (maxY - minY) * 0.45) return null;

  let text = '';
  for (const l of cluster) {
    if (!text) text = l.str;
    else if (/[A-Za-z]-$/.test(text)) text = text.slice(0, -1) + l.str;
    else text += ' ' + l.str;
  }
  return cleanPdfTitleCandidate(text);
}

// Fallback chain over a loaded pdf.js document: metadata, then page-1 heading.
export async function titleFromPdfDoc(doc) {
  if (!doc) return null;
  try {
    const meta = await doc.getMetadata?.();
    const t = titleFromPdfMetadata(meta?.info, meta?.metadata);
    if (t) return t;
  } catch (e) { console.warn('PDF metadata title failed:', e); }
  try {
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();
    return titleFromPdfTextItems(tc.items);
  } catch (e) {
    console.warn('PDF heading title failed:', e);
    return null;
  }
}

export function normalizePdfSelectionText(text) {
  const t = sanitizePdfString(text).replace(/\s+/g, ' ').trim();
  if (!t) return t;
  const parts = t.split(' ').filter(Boolean);
  if (parts.length >= 3 && parts.every((p) => p.length === 1)) return parts.join('');
  const singles = parts.filter((p) => p.length === 1).length;
  if (parts.length >= 4 && singles / parts.length >= 0.55) return parts.join('');
  return t;
}

// ── Selection ↔ text-layer geometry ──────────────────────────────────────
// pdf.js 3.x positions each text-layer span at the glyph run's left edge, sizes
// it with `calc(var(--scale-factor) * <font px>)`, then applies
// `scaleX(runWidth·scale / measuredWidth)` so the invisible text covers exactly
// the glyphs painted on the canvas. If `--scale-factor` is missing the calc()
// is invalid and every span falls back to the inherited font size: left edges
// stay put but the text inside is stretched by (inherited / intended). A drag
// over "DINOv3" near the end of a merged line then lands on characters several
// positions earlier ("s on DIN"). The highlight — painted from the range's own
// client rects — still looks right; only the text is wrong.
//
// renderPDFPages() sets the variable (the real fix) and records each span's
// intended width in data-w so the mouseup handler can detect any residual
// stretch and re-derive the text from the highlighted rects instead.
export const TEXT_LAYER_STRETCH_TOLERANCE = 0.02;

// Rendered width / intended width for a span; 1 when it can't be judged
// (pdf.js only scaleX-fits runs longer than one glyph).
function textLayerSpanStretch(span) {
  if (!(span.trueWidth > 0) || !(span.box.width > 0) || span.text.length < 2) return 1;
  return span.box.width / span.trueWidth;
}

// Re-derive selected text from the selection's client rects and the text-layer
// spans they touch. `spans` is the model built by collectPdfSelectionSpans():
//   { text, box:{left,top,right,bottom,width,height}, trueWidth, charBoxes() }
// where charBoxes() yields the rendered {left,right} of every character.
// Returns null when every span is aligned (the DOM's own selection text is
// then correct and should be used as-is).
export function pdfSelectionTextFromRects(rects, spans, tolerance = TEXT_LAYER_STRETCH_TOLERANCE) {
  if (!rects?.length || !spans?.length) return null;
  if (!spans.some((s) => Math.abs(textLayerSpanStretch(s) - 1) > tolerance)) return null;

  const lines = [];
  for (const span of spans) {
    const { box } = span;
    // Rects on this span's line: at least half the rect overlaps it vertically.
    const hits = rects.filter((r) => {
      const overlap = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
      return overlap >= 0.5 * Math.min(r.height, box.height);
    });
    if (!hits.length) continue;

    const k = textLayerSpanStretch(span);
    const boxes = span.charBoxes();
    let out = '';
    for (let i = 0; i < span.text.length && i < boxes.length; i++) {
      // Undo the stretch: the span's left edge is exact, every character to the
      // right of it sits k× too far along.
      const mid = box.left + ((boxes[i].left + boxes[i].right) / 2 - box.left) / k;
      if (hits.some((r) => mid >= r.left && mid <= r.right)) out += span.text[i];
    }
    if (out.trim()) lines.push(out.trim());
  }
  return lines.length ? lines.join(' ') : null;
}

// Build the geometry model for every text-layer span a Range touches.
export function collectPdfSelectionSpans(range, pageWrap) {
  const out = [];
  for (const span of pageWrap.querySelectorAll('.textLayer span')) {
    const tn = span.firstChild;
    if (!tn || tn.nodeType !== 3 || !tn.nodeValue || !range.intersectsNode(span)) continue;
    const b = span.getBoundingClientRect();
    // A rotated run's bounding box is not its width; leave it unjudged.
    const rotated = /rotate\(/.test(span.style?.transform || '');
    out.push({
      text: tn.nodeValue,
      box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height },
      trueWidth: rotated ? 0 : parseFloat(span.dataset.w) || 0,
      charBoxes() {
        const r = document.createRange();
        const boxes = [];
        for (let i = 0; i < tn.length; i++) {
          r.setStart(tn, i); r.setEnd(tn, i + 1);
          const cb = r.getBoundingClientRect();
          boxes.push({ left: cb.left, right: cb.right });
        }
        return boxes;
      },
    });
  }
  return out;
}

export async function renderPDFPages() {
  const container = document.getElementById('pdf-pages');
  container.innerHTML = '';
  setPaperText('');
  const textChunks = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const vp   = page.getViewport({ scale: 1.5 });

    const wrap = document.createElement('div');
    wrap.className = 'pdf-page-wrapper';
    wrap.dataset.page = i;
    wrap.style.width  = vp.width  + 'px';
    wrap.style.height = vp.height + 'px';
    // pdf.js 3.x sizes text-layer spans as calc(var(--scale-factor) * px);
    // without this the spans render at the inherited font size and drift from
    // the glyphs on the canvas (see pdfSelectionTextFromRects).
    wrap.style.setProperty('--scale-factor', String(vp.scale));

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    const hlLayer  = document.createElement('div'); hlLayer.className  = 'highlights-layer';
    const txtLayer = document.createElement('div'); txtLayer.className = 'textLayer';
    txtLayer.style.width = vp.width + 'px'; txtLayer.style.height = vp.height + 'px';

    try {
      const tc = await page.getTextContent();
      const mergedItems = combinePdfTextItems(tc.items);
      const pageStr = pdfTextItemsToString(tc.items);
      textChunks.push(`\n\n[Page ${i}]\n${pageStr}`);
      const layerContent = { ...tc, items: mergedItems.length ? mergedItems : tc.items };
      const textDivs = [];
      const task = pdfjsLib.renderTextLayer({
        textContentSource: layerContent,
        container: txtLayer,
        viewport: vp,
        textDivs,
      });
      await (task && task.promise ? task.promise : task);
      // pdf.js pushes one span per item, in order. Record the width each span
      // is meant to cover so the selection handler can detect a stretched layer.
      textDivs.forEach((div, idx) => {
        const it = layerContent.items[idx];
        if (it?.width > 0 && div?.dataset) div.dataset.w = (it.width * vp.scale).toFixed(2);
      });
    } catch(e) { console.warn('Text layer p.'+i, e); }

    wrap.appendChild(canvas); wrap.appendChild(hlLayer); wrap.appendChild(txtLayer);
    container.appendChild(wrap);
    if (i === 1) _pdfShowViewer('pdf');
  }
  setPaperText(textChunks.join('').slice(0, MAX_PAPER_CHARS));
  setPaperRefText(_pdfExtractReferencesSection(paperText));
  // Library-card blurb for PDFs with no other source (uploaded files; arXiv
  // while its API is unreachable): the abstract from the page text. Never
  // replaces a description the doc already has.
  if (!docMeta.description) docMeta.description = abstractFromText(paperText);
  _pdfBuildPaperReferences();
  void _pdfEnsureCitationFormat();
}

export function restoreHighlightsForLoadedPages() {
  for (const d of discussions) {
    if (d.mode !== 'pdf') continue;
    const wrap = document.querySelector(`.pdf-page-wrapper[data-page="${d.pageNum}"]`);
    if (wrap) { d.wrapper = wrap; _pdfPaintHighlight(d); }
  }
}
