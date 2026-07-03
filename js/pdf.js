import { discussions, pdfDoc, paperText, MAX_PAPER_CHARS, setPdfDoc, setCurrentMode, setCurrentDocId, setDocMeta, replaceDiscussions, setCitationFormat, setPaperText, setPaperRefText } from './state.js';
import { docIdFor, loadStore, restoreDiscussions, loadDocSummary, persistCurrentDoc } from './persistence.js';
import { renderLibrary, updateAuthBar } from './library.js';

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
  setDocMeta({ name, mode:'pdf', badge:'PDF', url:null });

  // restore prior discussions for this doc, if any
  const store = loadStore();
  const saved = store[id];
  replaceDiscussions(saved ? restoreDiscussions(saved.discussions) : []);
  loadDocSummary(saved);
  setCitationFormat(saved?.citationFormat || null);

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

export function normalizePdfSelectionText(text) {
  const t = sanitizePdfString(text).replace(/\s+/g, ' ').trim();
  if (!t) return t;
  const parts = t.split(' ').filter(Boolean);
  if (parts.length >= 3 && parts.every((p) => p.length === 1)) return parts.join('');
  const singles = parts.filter((p) => p.length === 1).length;
  if (parts.length >= 4 && singles / parts.length >= 0.55) return parts.join('');
  return t;
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
      const task = pdfjsLib.renderTextLayer({
        textContentSource: layerContent,
        container: txtLayer,
        viewport: vp,
        textDivs: [],
      });
      await (task && task.promise ? task.promise : task);
    } catch(e) { console.warn('Text layer p.'+i, e); }

    wrap.appendChild(canvas); wrap.appendChild(hlLayer); wrap.appendChild(txtLayer);
    container.appendChild(wrap);
    if (i === 1) _pdfShowViewer('pdf');
  }
  setPaperText(textChunks.join('').slice(0, MAX_PAPER_CHARS));
  setPaperRefText(_pdfExtractReferencesSection(paperText));
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
