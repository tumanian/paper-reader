import { esc, renderPreviewHtml, md, timeAgo, simpleHash, asGlobalRegex, isTodoValue, normalizeForMatch, decodeXmlText } from './util.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ═══════════════════════════════════════════════════════
//  PERSISTENCE LAYER  (localStorage)
// ═══════════════════════════════════════════════════════
const STORE_KEY = 'paperReader.docs.v1';
const READ_LATER_KEY = 'paperReader.readLater.v1';
const SCHEMA_META_KEY = 'paperReader.schema.v1';
const SCHEMA_VERSION = 2;

// docs = { [docId]: { id, name, mode, badge, url, updated, discussions: [...] } }
function migrateDoc(doc, docId) {
  if (!doc || typeof doc !== 'object') return null;
  const m = { ...doc };
  let changed = false;

  const setDefault = (key, value) => {
    if (m[key] === undefined) { m[key] = value; changed = true; }
  };

  setDefault('id', docId);
  setDefault('name', docId);
  setDefault('mode', docId.startsWith('web::') ? 'web' : 'pdf');
  setDefault('badge', m.mode === 'pdf' ? 'PDF' : 'Web');
  setDefault('url', null);
  setDefault('updated', Date.now());
  setDefault('conversationSummary', null);
  setDefault('summaryMessageCount', 0);

  if (!Array.isArray(m.discussions)) {
    m.discussions = [];
    changed = true;
  }

  m.discussions = m.discussions.map(d => {
    if (!d || typeof d !== 'object') { changed = true; return null; }
    const nd = { ...d };
    const setDefaultOn = (obj, key, val) => {
      if (obj[key] === undefined) { obj[key] = val; changed = true; }
    };
    setDefaultOn(nd, 'id', Date.now());
    setDefaultOn(nd, 'txt', '');
    setDefaultOn(nd, 'mode', m.mode);
    setDefaultOn(nd, 'pageNum', null);
    setDefaultOn(nd, 'citationMeta', null);
    setDefaultOn(nd, 'relRects', []);
    setDefaultOn(nd, 'color', { bg:'rgba(255,215,0,.45)', dot:'#c9a000' });

    if (!Array.isArray(nd.messages)) {
      nd.messages = [];
      changed = true;
    } else {
      nd.messages = nd.messages.map(msg => {
        if (!msg || typeof msg !== 'object') { changed = true; return null; }
        const nm = { ...msg };
        if (nm.role !== 'assistant' && nm.role !== 'user') {
          nm.role = 'user';
          changed = true;
        }
        if (typeof nm.content !== 'string') {
          nm.content = nm.content == null ? '' : String(nm.content);
          changed = true;
        }
        return nm;
      }).filter(Boolean);
    }
    return nd;
  }).filter(Boolean);

  return { doc: m, changed };
}

function migrateStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { store: {}, changed: !!raw };
  }
  const store = {};
  let changed = false;
  for (const [docId, doc] of Object.entries(raw)) {
    const result = migrateDoc(doc, docId);
    if (!result) { changed = true; continue; }
    store[docId] = result.doc;
    if (result.changed) changed = true;
  }
  if (Object.keys(raw).length !== Object.keys(store).length) changed = true;
  return { store, changed };
}

function migrateReadLaterList(raw) {
  if (raw == null) return { items: [], changed: false };
  if (!Array.isArray(raw)) return { items: [], changed: true };
  const items = [];
  let changed = false;
  for (const item of raw) {
    if (!item || typeof item !== 'object') { changed = true; continue; }
    const m = { ...item };
    if (!m.id) {
      m.id = 'rl::' + simpleHash(m.url || m.citationText || m.title || String(m.addedAt || Date.now()));
      changed = true;
    }
    if (!m.title) { m.title = 'Untitled'; changed = true; }
    if (m.url === undefined) { m.url = null; changed = true; }
    if (m.mode === undefined) { m.mode = m.url ? 'web' : null; changed = true; }
    if (m.docId === undefined) { m.docId = null; changed = true; }
    if (m.citationText === undefined) { m.citationText = null; changed = true; }
    if (m.sourceDoc === undefined) { m.sourceDoc = null; changed = true; }
    if (m.refText === undefined) { m.refText = null; changed = true; }
    if (!m.addedAt) { m.addedAt = Date.now(); changed = true; }
    items.push(m);
  }
  if (items.length !== raw.length) changed = true;
  return { items, changed };
}

function initStorage() {
  let anyChanged = false;

  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const { store, changed } = migrateStore(parsed);
      if (changed) {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
        anyChanged = true;
        console.info('Paper Reader: migrated library store to schema v' + SCHEMA_VERSION);
      }
    }
  } catch (e) {
    console.warn('Paper Reader: library migration skipped — existing data left untouched:', e);
  }

  try {
    const raw = localStorage.getItem(READ_LATER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const { items, changed } = migrateReadLaterList(parsed);
      if (changed) {
        localStorage.setItem(READ_LATER_KEY, JSON.stringify(items));
        anyChanged = true;
        console.info('Paper Reader: migrated read-later list to schema v' + SCHEMA_VERSION);
      }
    }
  } catch (e) {
    console.warn('Paper Reader: read-later migration skipped — existing data left untouched:', e);
  }

  if (anyChanged) {
    try {
      localStorage.setItem(SCHEMA_META_KEY, JSON.stringify({
        version: SCHEMA_VERSION,
        migratedAt: Date.now(),
      }));
    } catch (e) { console.warn('Could not save schema metadata:', e); }
  }
}

function loadStore() { return PaperStore.getStore(); }

async function persistCurrentDoc() {
  if (!currentDocId) return;
  const store = loadStore();
  const prior = store[currentDocId];
  if (prior && prior.discussions && prior.discussions.length > 0 && discussions.length === 0) {
    console.warn('persistCurrentDoc: refusing to overwrite saved discussions with empty set');
    return;
  }
  const doc = {
    id: currentDocId,
    name: docMeta.name,
    mode: docMeta.mode,
    badge: docMeta.badge,
    url: docMeta.url || null,
    updated: Date.now(),
    conversationSummary,
    summaryMessageCount,
    citationFormat: citationFormat || null,
    discussions: discussions.map(d => ({
      id: d.id, txt: d.txt, mode: d.mode, pageNum: d.pageNum,
      color: d.color, relRects: d.relRects, messages: d.messages,
      citationMeta: d.citationMeta || null,
      mathKind: d.mathKind || null, mathTex: d.mathTex || null,
      note: d.note || null, onboarding: d.onboarding || false,
      feature: d.feature || null, tex: d.tex || null, cite: d.cite || null,
      // Figure metadata only — the captured pixels live in IndexedDB (keyed by
      // figure.imageKey), never in this localStorage/cloud doc state.
      figure: d.figure || null, figureCaption: d.figureCaption || null,
    })),
  };
  try {
    await PaperStore.saveDoc(doc);
  } catch (e) {
    console.warn('Cloud save failed (local backup kept):', e);
    updateAuthBar(PaperStore.getSyncStatus());
  }
}
function docIdFor(mode, key) {
  // stable id: web → url, pdf → name+size proxy (name only here)
  return mode + '::' + key;
}

// Restore discussions from a saved doc, hardening against any missing fields
// so a partial record can never blank out a thread or throw.
function restoreDiscussions(saved) {
  return (saved || []).map(d => ({
    ...d,
    wrapper: null,
    messages: Array.isArray(d.messages) ? d.messages : [],
    relRects: Array.isArray(d.relRects) ? d.relRects : [],
    color: d.color || { bg:'rgba(255,215,0,.45)', dot:'#c9a000' },
    citationMeta: d.citationMeta || null,
  }));
}

function loadDocSummary(saved) {
  conversationSummary = saved?.conversationSummary || null;
  summaryMessageCount = saved?.summaryMessageCount || 0;
  summaryDirty = conversationMessageCount() > summaryMessageCount;
}

function conversationMessageCount() {
  return discussions.reduce((n, d) => n + d.messages.filter(m => !m.hidden).length, 0);
}

function buildSummarySource() {
  const blocks = [];
  for (const d of discussions) {
    const vis = d.messages.filter(m => !m.hidden);
    if (!vis.length) continue;
    blocks.push(`[Highlight] "${d.txt.slice(0, 250)}${d.txt.length > 250 ? '…' : ''}"`);
    for (const m of vis) {
      const who = m.role === 'user' ? 'Researcher' : 'Assistant';
      blocks.push(`${who}: ${m.content}`);
    }
    blocks.push('');
  }
  return blocks.join('\n').trim();
}

function scheduleSummaryUpdate() {
  const count = conversationMessageCount();
  if (!count) return;
  summaryDirty = count > summaryMessageCount;
  if (!summaryDirty) return;
  clearTimeout(_summaryTimer);
  _summaryTimer = setTimeout(() => { maybeUpdateSummary(false); }, 45000);
}

async function maybeUpdateSummary(force = false) {
  if (_summaryInFlight || !currentDocId) return false;
  const count = conversationMessageCount();
  if (!count) return false;
  if (!force && count <= summaryMessageCount) return false;

  const source = buildSummarySource();
  if (!source) return false;

  _summaryInFlight = true;
  try {
    const summary = await callSummarize(source);
    conversationSummary = summary;
    summaryMessageCount = count;
    summaryDirty = false;
    await persistCurrentDoc();
    renderLibrary();
    return true;
  } catch (e) {
    console.warn('Conversation summary failed:', e.message);
    return false;
  } finally {
    _summaryInFlight = false;
  }
}

// ═══════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════
let pdfDoc = null, discussions = [], activeId = null, pendingSel = null;
let currentDocId = null, currentMode = null;
let docMeta = { name:'', mode:'', badge:'', url:null };
let conversationSummary = null, summaryMessageCount = 0, summaryDirty = false;
let _summaryTimer = null, _summaryInFlight = false;
let pendingCitation = null, returnToDocId = null, returnToDocName = null;
let citePreviewAbort = null;
let citePreviewTimer = null;
let classifyTimer = null;
let classifyToken = 0;
let bibByNumber = {};
let paperReferences = [];
let citationFormat = null;
let citationFormatPromise = null;

// Full extracted text of the current paper (for context + caching).
// Capped so we never blow past the long-context surcharge threshold.
let paperText = '';
let paperRefText = '';
const MAX_PAPER_CHARS = 600000;   // ~150k tokens, safely under the 200k cap

const COLORS = [
  { bg:'rgba(255,215,0,.45)',   dot:'#c9a000' },
  { bg:'rgba(80,210,130,.45)',  dot:'#1a9950' },
  { bg:'rgba(100,165,255,.45)', dot:'#2e72e0' },
  { bg:'rgba(255,110,150,.45)', dot:'#d02060' },
  { bg:'rgba(195,115,255,.45)', dot:'#8830d8' },
  { bg:'rgba(255,145,60,.45)',  dot:'#d05010' },
];
function nextColor() { return COLORS[discussions.length % COLORS.length]; }

// ═══════════════════════════════════════════════════════
//  LIBRARY  (upload screen)
// ═══════════════════════════════════════════════════════
function renderLibrary() {
  const store = loadStore();
  const docs = Object.values(store).sort((a,b) => b.updated - a.updated);
  const lib = document.getElementById('library');
  const cards = document.getElementById('lib-cards');

  // Featured example is an invitation for logged-out visitors only. Once they
  // open it, it's saved as a doc — so dedupe by URL and just sparkle that card
  // instead of showing a separate invitation.
  const loggedIn = !!(PaperStore.getEmail && PaperStore.getEmail());
  const featured = loggedIn ? null : getFeaturedPaper();
  const normUrl = (u) => (u || '').trim().replace(/\/+$/, '').toLowerCase();
  const featUrl = featured ? normUrl(featured.url) : '';
  const featuredSaved = !!(featUrl && docs.some(d => normUrl(d.url) === featUrl));

  if (!docs.length && !featured) { lib.classList.remove('show'); return; }
  lib.classList.add('show');
  cards.innerHTML = '';

  if (featured && !featuredSaved) {
    const card = document.createElement('div');
    card.className = 'lib-card lib-featured';
    card.innerHTML = `
      <div class="lib-icon">🌐</div>
      <div class="lib-info">
        <div class="lib-name">${esc(featured.title)}<span class="lib-spark" title="Annotated example">✨</span></div>
        ${featured.hook ? `<div class="lib-summary">${esc(featured.hook)}</div>` : ''}
        <div class="lib-meta">Annotated example · citations, math, to-code &amp; discussion</div>
      </div>`;
    card.addEventListener('click', () => openFeaturedExample());
    cards.appendChild(card);
  }

  for (const doc of docs) {
    const n = doc.discussions.length;
    const isFeatured = !!(featUrl && normUrl(doc.url) === featUrl);
    const card = document.createElement('div');
    card.className = 'lib-card' + (isFeatured ? ' lib-featured' : '');
    card.innerHTML = `
      <div class="lib-icon">${doc.mode === 'pdf' ? '📄' : '🌐'}</div>
      <div class="lib-info">
        <div class="lib-name">${esc(doc.name)}${isFeatured ? '<span class="lib-spark" title="Annotated example">✨</span>' : ''}</div>
        ${doc.conversationSummary ? `<div class="lib-summary">${esc(doc.conversationSummary)}</div>` : ''}
        <div class="lib-meta">${n} discussion${n!==1?'s':''} · ${timeAgo(doc.updated)}</div>
      </div>
      <button class="lib-del" title="Delete">×</button>`;
    card.addEventListener('click', e => {
      if (e.target.classList.contains('lib-del')) return;
      reopenDoc(doc.id);
    });
    card.querySelector('.lib-del').addEventListener('click', async e => {
      e.stopPropagation();
      await PaperStore.deleteDoc(doc.id);
      renderLibrary();
    });
    cards.appendChild(card);
  }
}
document.getElementById('clear-lib').addEventListener('click', async () => {
  if (confirm('Delete all saved documents and discussions?')) {
    await PaperStore.clearLibrary();
    renderLibrary();
  }
});

// ═══════════════════════════════════════════════════════
//  READ LATER
// ═══════════════════════════════════════════════════════
async function addToReadLater(item) {
  const id = item.id || (item.url ? 'rl::' + simpleHash(item.url) : 'rl::' + simpleHash(item.citationText || item.title));
  const added = await PaperStore.addReadLater({ ...item, id });
  if (added) renderReadLater();
  return added;
}
function renderReadLater() {
  const items = PaperStore.getReadLater();
  const section = document.getElementById('read-later');
  const cards = document.getElementById('read-later-cards');
  if (!items.length) { section.classList.remove('show'); return; }
  section.classList.add('show');
  cards.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'lib-card rl-card';
    const canOpen = !!(item.url || item.docId);
    card.innerHTML = `
      <div class="lib-icon">${item.url ? '🔗' : (item.docId ? '📄' : '📌')}</div>
      <div class="lib-info">
        <div class="lib-name">${esc(item.title)}</div>
        ${item.sourceDoc ? `<div class="rl-source">from ${esc(item.sourceDoc)}</div>` : ''}
        ${item.citationText ? `<div class="lib-summary">${esc(item.citationText.slice(0, 120))}${item.citationText.length > 120 ? '…' : ''}</div>` : ''}
        ${!canOpen ? '<div class="rl-unresolved">No URL — open source paper to resolve</div>' : ''}
        <div class="lib-meta">${timeAgo(item.addedAt)}</div>
      </div>
      <button class="lib-del" title="Remove">×</button>`;
    card.addEventListener('click', e => {
      if (e.target.classList.contains('lib-del')) return;
      openReadLaterItem(item);
    });
    card.querySelector('.lib-del').addEventListener('click', async e => {
      e.stopPropagation();
      await PaperStore.removeReadLater(item.id);
      renderReadLater();
    });
    cards.appendChild(card);
  }
}
async function openReadLaterItem(item) {
  if (item.url) {
    document.getElementById('url-input').value = item.url;
    await loadWebPage(item.url);
    return;
  }
  if (item.docId) {
    await reopenDoc(item.docId);
    return;
  }
  alert('This citation could not be resolved to a URL. Try selecting it again in the source paper.');
}
document.getElementById('clear-read-later').addEventListener('click', async () => {
  if (confirm('Clear your Read later list?')) {
    await PaperStore.clearReadLater();
    renderReadLater();
  }
});

// Reopen a saved doc. For web docs we can re-fetch + reposition highlights.
// For PDFs we can't re-render without the file, so we show discussions in a
// restored (list-only) state and invite re-opening the file.
async function reopenDoc(docId) {
  const store = loadStore();
  const doc = store[docId];
  if (!doc) return;

  if (doc.mode === 'web' && doc.url) {
    document.getElementById('url-input').value = doc.url;
    await loadWebPage(doc.url, docId);
    return;
  }

  // PDF: try stored bytes, or re-fetch arXiv PDF from saved abs URL
  startApp(doc.name, doc.badge || 'PDF');
  currentMode = doc.mode;
  currentDocId = docId;
  docMeta = { name:doc.name, mode:doc.mode, badge:doc.badge, url:doc.url };
  discussions = restoreDiscussions(doc.discussions);
  loadDocSummary(doc);
  citationFormat = doc.citationFormat || null;

  if (doc.mode === 'pdf') {
    setStatus('Loading saved PDF…');
    const blob = await PaperStore.getPdf(docId);
    if (blob) {
      try {
        const buf = await blob.arrayBuffer();
        await renderFromBuffer(buf);
        restoreHighlightsForLoadedPages();
        renderList();
        return;
      } catch(e) { console.warn('Stored PDF failed to render:', e); }
    }
    if (doc.url && parseArxivId(doc.url)) {
      document.getElementById('url-input').value = doc.url;
      await loadArxivPdf(doc.url, docId);
      return;
    }
    // Fallback: bytes missing (e.g. cleared) → list-only + reopen prompt
    document.getElementById('content-loading').style.display = 'none';
    document.getElementById('reload-note').style.display = 'block';
    document.getElementById('reload-note').innerHTML =
      `Saved file unavailable. Discussions for “${esc(doc.name)}” restored — ` +
      `<button id="reopen-file">open the PDF again</button> to see highlights on the page.`;
    const rf = document.getElementById('reopen-file');
    if (rf) rf.addEventListener('click', () => document.getElementById('pdf-input').click());
    showList();
    return;
  }

  // web without url (rare) → list only
  document.getElementById('content-loading').style.display = 'none';
  document.getElementById('reload-note').style.display = 'block';
  document.getElementById('reload-note').innerHTML = `Discussions restored.`;
  showList();
}

// ═══════════════════════════════════════════════════════
//  PDF
// ═══════════════════════════════════════════════════════
const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('pdf-input');

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => { if (e.target.files[0]) loadPDF(e.target.files[0]); });
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f && f.type === 'application/pdf') loadPDF(f);
});

async function loadPDF(file) {
  const name = file.name.replace(/\.pdf$/i,'');
  const id = docIdFor('pdf', name + ':' + file.size);
  startApp(name, 'PDF');
  currentMode = 'pdf'; currentDocId = id;
  docMeta = { name, mode:'pdf', badge:'PDF', url:null };

  // restore prior discussions for this doc, if any
  const store = loadStore();
  const saved = store[id];
  discussions = saved ? restoreDiscussions(saved.discussions) : [];
  loadDocSummary(saved);
  citationFormat = saved?.citationFormat || null;

  setStatus('Rendering PDF…');
  const buf = await file.arrayBuffer();

  // Persist the bytes so this PDF reopens automatically from the library.
  // (Copy the buffer before pdf.js detaches it.)
  PaperStore.putPdf(id, new Blob([buf.slice(0)], { type:'application/pdf' }))
    .catch(e => { console.warn('PDF cloud upload failed:', e); updateAuthBar(PaperStore.getSyncStatus()); });

  await renderFromBuffer(buf);
  restoreHighlightsForLoadedPages();
  renderList();
  await persistCurrentDoc();
  renderLibrary();
}

// Render a PDF from an ArrayBuffer (shared by fresh open and library reopen)
async function renderFromBuffer(buf) {
  pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
  await renderPDFPages();
}

function sanitizePdfString(s) {
  return String(s || '').replace(/\u0000/g, '');
}

function pdfFontSize(item) {
  if (!item?.transform) return 10;
  return Math.hypot(item.transform[0], item.transform[1]) || 10;
}

function combinePdfTextItems(items) {
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

function pdfTextItemsToString(items) {
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

function normalizePdfSelectionText(text) {
  const t = sanitizePdfString(text).replace(/\s+/g, ' ').trim();
  if (!t) return t;
  const parts = t.split(' ').filter(Boolean);
  if (parts.length >= 3 && parts.every((p) => p.length === 1)) return parts.join('');
  const singles = parts.filter((p) => p.length === 1).length;
  if (parts.length >= 4 && singles / parts.length >= 0.55) return parts.join('');
  return t;
}

async function renderPDFPages() {
  const container = document.getElementById('pdf-pages');
  container.innerHTML = '';
  paperText = '';
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
    if (i === 1) showViewer('pdf');
  }
  paperText = textChunks.join('').slice(0, MAX_PAPER_CHARS);
  paperRefText = extractReferencesSection(paperText);
  buildPaperReferences();
  void ensureCitationFormat();
}

function restoreHighlightsForLoadedPages() {
  for (const d of discussions) {
    if (d.mode !== 'pdf') continue;
    const wrap = document.querySelector(`.pdf-page-wrapper[data-page="${d.pageNum}"]`);
    if (wrap) { d.wrapper = wrap; paintHighlight(d); }
  }
}

// ═══════════════════════════════════════════════════════
//  URL / WEB
// ═══════════════════════════════════════════════════════
document.getElementById('url-load-btn').addEventListener('click', () => {
  const v = document.getElementById('url-input').value.trim();
  if (v) loadWebPage(v);
});
document.getElementById('url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const v = e.target.value.trim(); if(v) loadWebPage(v); }
});

async function loadWebPage(rawUrl, knownDocId, citationContext = null) {
  let url = rawUrl;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  if (parseArxivId(url)) {
    return loadArxivPdf(url, knownDocId, citationContext);
  }

  url = smartRewrite(url);

  const errEl = document.getElementById('url-error');
  errEl.style.display = 'none';

  let hostname;
  try { hostname = new URL(url).hostname; } catch(e) { hostname = url; }

  const id = knownDocId || docIdFor('web', url);
  startApp(hostname, 'Web');
  currentMode = 'web'; currentDocId = id;
  docMeta = { name:hostname, mode:'web', badge:'Web', url };

  const store = loadStore();
  const saved = store[id];
  discussions = saved ? restoreDiscussions(saved.discussions) : [];
  loadDocSummary(saved);
  citationFormat = saved?.citationFormat || null;

  try {
    setStatus('Fetching…');
    const html = await fetchViaProxy(url);
    setStatus('Extracting article…');

    const doc = new DOMParser().parseFromString(html, 'text/html');
    let base = doc.querySelector('base');
    if (!base) { base = doc.createElement('base'); doc.head.prepend(base); }
    base.href = url;

    bibByNumber = {};
    indexBibliographyFromDoc(doc);
    paperRefText = extractReferencesSectionFromDoc(doc);

    let title = '', content = '';
    if (typeof Readability !== 'undefined') {
      try {
        const art = new Readability(doc).parse();
        if (art && art.content) { title = art.title; content = art.content; }
      } catch(e) { console.warn('Readability failed', e); }
    }
    if (!content) {
      ['script','style','nav','footer','header','aside'].forEach(t =>
        doc.querySelectorAll(t).forEach(el => el.remove()));
      title   = doc.querySelector('title')?.textContent?.trim() || url;
      content = doc.querySelector('main,article,[role="main"]')?.innerHTML
             || doc.body?.innerHTML || '<p>Could not extract content.</p>';
    }

    docMeta.name = title || hostname;
    renderWebArticle(title, content, url);
    showViewer('web');
    restoreWebHighlights();
    renderList();
    await persistCurrentDoc();
    maybeApplyOnboardingCuration();
    if (citationContext) await finishCitationNavigation(citationContext);

  } catch(err) {
    console.error(err);
    if (citationContext) throw err;
    backToUpload();
    errEl.innerHTML = `Couldn't fetch: <strong>${esc(err.message)}</strong><br>
      Try the paper's PDF, or check the URL.`;
    errEl.style.display = 'block';
  }
}

function smartRewrite(url) {
  return url;
}

function parseArxivId(input) {
  const s = String(input || '').trim();
  const patterns = [
    /arxiv\.org\/(?:abs|pdf|e-print)\/([\d.]+(?:v\d+)?)/i,
    /ar5iv\.labs\.arxiv\.org\/html\/([\d.]+(?:v\d+)?)/i,
    /^arxiv:\s*([\d.]+(?:v\d+)?)/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1].replace(/\.pdf$/i, '');
  }
  return null;
}

function arxivAbsUrl(id) {
  return `https://arxiv.org/abs/${id}`;
}

function arxivPdfUrl(id) {
  return `https://arxiv.org/pdf/${id}.pdf`;
}

async function fetchArxivTitle(id, signal) {
  try {
    const r = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, { signal });
    const xml = await r.text();
    return decodeXmlText(xml.match(/<entry>[\s\S]*?<title>([^<]+)/)?.[1]) || `arXiv:${id}`;
  } catch {
    return `arXiv:${id}`;
  }
}

async function fetchPdfViaProxy(url) {
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(90000) : undefined;
  const r = await fetch(`/api/fetch-pdf?url=${encodeURIComponent(url)}`, { signal: timeout });
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try {
      const d = await r.json();
      if (d.error) msg = d.error;
    } catch (_) {}
    throw new Error(msg);
  }
  return await r.arrayBuffer();
}

async function loadArxivPdf(rawUrl, knownDocId, citationContext = null) {
  let url = rawUrl;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const arxivId = parseArxivId(url);
  if (!arxivId) throw new Error('Not a valid arXiv URL');

  const absUrl = arxivAbsUrl(arxivId);
  const pdfUrl = arxivPdfUrl(arxivId);
  const errEl = document.getElementById('url-error');
  errEl.style.display = 'none';

  const id = knownDocId || docIdFor('pdf', `arxiv:${arxivId}`);
  startApp(`arXiv:${arxivId}`, 'PDF');
  currentMode = 'pdf';
  currentDocId = id;

  const store = loadStore();
  const saved = store[id];
  discussions = saved ? restoreDiscussions(saved.discussions) : [];
  loadDocSummary(saved);
  citationFormat = saved?.citationFormat || null;

  const titleSignal = AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;

  try {
    setStatus('Fetching arXiv PDF…');
    const [buf, title] = await Promise.all([
      fetchPdfViaProxy(pdfUrl),
      fetchArxivTitle(arxivId, titleSignal),
    ]);

    docMeta = { name: title, mode: 'pdf', badge: 'PDF', url: absUrl };
    document.getElementById('paper-name').textContent = title;

    setStatus('Rendering PDF…');
    const pdfBlob = new Blob([buf.slice(0)], { type: 'application/pdf' });
    PaperStore.putPdf(id, pdfBlob)
      .catch((e) => { console.warn('PDF store failed:', e); updateAuthBar(PaperStore.getSyncStatus()); });

    await renderFromBuffer(buf);
    restoreHighlightsForLoadedPages();
    renderList();
    await persistCurrentDoc();
    renderLibrary();
    if (citationContext) await finishCitationNavigation(citationContext);
  } catch (err) {
    console.error(err);
    if (citationContext) throw err;
    backToUpload();
    errEl.innerHTML = `Couldn't fetch arXiv PDF: <strong>${esc(err.message)}</strong>`;
    errEl.style.display = 'block';
  }
}

async function fetchViaProxy(url) {
  const timeout = AbortSignal.timeout ? AbortSignal.timeout(25000) : undefined;
  const proxies = [
    async () => {
      const r = await fetch(`/api/fetch?url=${encodeURIComponent(url)}`, { signal: timeout });
      const d = await r.json();
      if (!r.ok || !d.html) throw new Error(d.error || `HTTP ${r.status}`);
      return d.html;
    },
    async () => {
      const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, { signal: timeout });
      const d = await r.json();
      if (!d.contents || d.contents.length < 200) throw new Error('empty');
      return d.contents;
    },
    async () => {
      const r = await fetch(`https://corsproxy.io/?url=${encodeURIComponent(url)}`, { signal: timeout });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    },
  ];
  let lastErr = null;
  for (const proxy of proxies) {
    try { return await proxy(); } catch (e) { lastErr = e; console.warn('Fetch proxy failed:', e); }
  }
  throw new Error(lastErr?.message || 'All proxies failed. The site may block external fetching.');
}

function renderWebArticle(title, html, url) {
  document.getElementById('article-heading').textContent = title || 'Untitled';
  document.getElementById('article-source-url').innerHTML =
    `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
  // Drop any highlight rects left over from a previously-opened paper — the
  // layer is shared across web docs, so stale rects would otherwise bleed in.
  const hlLayer = document.querySelector('#article-wrapper > .highlights-layer');
  if (hlLayer) hlLayer.innerHTML = '';
  document.getElementById('article-body').innerHTML = html;
  document.getElementById('paper-name').textContent = title || url;
  document.querySelectorAll('#article-body script').forEach(s => s.remove());
  // capture full text for context + caching
  const bodyText = document.getElementById('article-body').innerText || '';
  paperText = (`${title || ''}\n\n${bodyText}`).slice(0, MAX_PAPER_CHARS);
  indexWebBibliography();
  buildPaperReferences();
  void ensureCitationFormat();
}

function buildPaperReferences() {
  paperReferences = [];

  for (const [id, entry] of Object.entries(bibByNumber).sort((a, b) => +a[0] - +b[0])) {
    paperReferences.push({
      id: +id,
      text: entry.refText || entry.label || '',
      url: entry.url || null,
    });
  }
  if (paperReferences.length) {
    logCitation('success', 'extract-refs', { count: paperReferences.length, source: 'dom' });
    dumpBibliography('dom');
    return;
  }

  const section = paperRefText || extractReferencesSection(paperText);
  if (!section || section.length < 20) {
    logCitation('fail', 'extract-refs', { reason: 'no references section found', hasPaperText: !!paperText });
    return;
  }

  parseReferencesFromSection(section);

  logCitation(
    paperReferences.length ? 'success' : 'fail',
    'extract-refs',
    { count: paperReferences.length, source: 'text', sectionLen: section.length },
  );
  if (paperReferences.length) dumpBibliography('text');
}

function dumpBibliography(source) {
  console.groupCollapsed(`[CitationLookup] bibliography · ${source} · ${paperReferences.length} entries`);
  console.table(paperReferences.map((r) => ({
    id: r.id,
    url: r.url || '',
    text: String(r.text || '').slice(0, 160),
  })));
  console.log('[CitationLookup] full bibliography storage:', paperReferences);
  console.groupEnd();
}

function parseReferencesFromSection(section) {
  let m;
  const bracketRe = /\[(\d{1,3})\]\s*([\s\S]*?)(?=\[\d{1,3}\]|$)/g;
  while ((m = bracketRe.exec(section)) !== null) {
    const text = m[2].replace(/\s+/g, ' ').trim();
    if (text.length < 8) continue;
    const resolved = resolveReferenceEntry(`[${m[1]}] ${text}`);
    paperReferences.push({ id: +m[1], text, url: resolved.url });
  }

  if (!paperReferences.length) {
    const numberedRe = /^\s*(\d{1,3})\.\s+(.+)$/gm;
    while ((m = numberedRe.exec(section)) !== null) {
      const text = m[2].replace(/\s+/g, ' ').trim();
      if (text.length < 8) continue;
      const resolved = resolveReferenceEntry(text);
      paperReferences.push({ id: +m[1], text, url: resolved.url });
    }
  }

  if (!paperReferences.length) {
    parseAuthorYearReferenceLines(section);
  }
}

function parseAuthorYearReferenceLines(section) {
  const lines = section.split(/\n+/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let id = 1;
  for (const line of lines) {
    if (line.length < 25) continue;
    if (/^(references|bibliography|works cited|acknowledgments?)/i.test(line)) continue;
    const hasYear = /\(\s*(19|20)\d{2}[a-z]?\s*\)|,\s*(19|20)\d{2}[a-z]?/.test(line);
    const looksLikeRef = hasYear || /^[A-Z\[\d]/.test(line);
    if (!looksLikeRef) continue;
    const resolved = resolveReferenceEntry(line);
    paperReferences.push({ id, text: line, url: resolved.url });
    id++;
  }
}

function indexBibliographyFromDoc(doc) {
  if (!doc) return;

  const itemSelectors = [
    '.ltx_bibitem',
    'li.ltx_bibitem',
    'li[id^="bib."]',
    'li[id*="bibitem"]',
    '.csl-entry',
    'section.ltx_bibliography li',
    'section.bibliography li',
    '#bibliography li',
    '#refs li',
    'ol.references li',
  ].join(', ');

  doc.querySelectorAll(itemSelectors).forEach((item) => addBibliographyItem(item));

  if (Object.keys(bibByNumber).length) return;

  const bibSection = doc.querySelector(
    'section.ltx_bibliography, section.bibliography, #bibliography, #refs, [class*="ltx_bibliography"]',
  );
  if (bibSection) {
    bibSection.querySelectorAll('li, dt, .ltx_bibitem').forEach((item) => addBibliographyItem(item));
  }
}

function addBibliographyItem(item) {
  const tag = item.querySelector?.('.ltx_tag_bibitem, .ltx_tag, .label, .citation-number');
  const tagText = tag?.textContent || '';
  const idText = item.id || item.getAttribute?.('data-num') || '';
  const numMatch = tagText.match(/\[?(\d{1,3})\]?/)
    || idText.match(/(?:bib\.?|ref\.?)(\d{1,3})/i)
    || idText.match(/(\d{1,3})$/);
  if (!numMatch) return;
  const num = +numMatch[1];
  const text = item.textContent.replace(/\s+/g, ' ').trim();
  if (text.length < 8) return;
  const entry = resolveReferenceEntry(text);
  const link = item.querySelector?.('a[href^="http"]');
  if (link?.href && !entry.url) entry.url = link.href;
  bibByNumber[num] = entry;
}

function extractReferencesSectionFromDoc(doc) {
  if (!doc) return '';
  const sectionEl = doc.querySelector(
    'section.ltx_bibliography, section.bibliography, #bibliography, #refs, [class*="ltx_bibliography"]',
  );
  if (sectionEl) {
    const t = sectionEl.innerText || sectionEl.textContent || '';
    if (t.trim().length > 20) return t.trim();
  }
  const fullText = doc.body?.innerText || doc.body?.textContent || '';
  return extractReferencesSection(fullText);
}

function expandSelectionText(selText, range) {
  let expanded = (selText || '').trim();
  if (range) {
    try {
      const r = range.cloneRange();
      while (r.startOffset > 0 && /[^\s\n]/.test(r.startContainer.textContent[r.startOffset - 1])) {
        r.setStart(r.startContainer, r.startOffset - 1);
      }
      const endText = r.endContainer.textContent || '';
      while (r.endOffset < endText.length && /[^\s\n]/.test(endText[r.endOffset])) {
        r.setEnd(r.endContainer, r.endOffset + 1);
      }
      expanded = r.toString().replace(/\s+/g, ' ').trim();
    } catch (_) {}
  }

  if (paperText && expanded.length <= 160) {
    const needle = expanded.slice(0, Math.min(24, expanded.length));
    let idx = paperText.indexOf(expanded);
    if (idx < 0 && needle.length >= 6) idx = paperText.indexOf(needle);
    if (idx >= 0) {
      let start = idx;
      let end = idx + expanded.length;
      while (start > 0 && /[^\s\n,;.]/.test(paperText[start - 1])) start--;
      while (end < paperText.length && /[^\s\n,;.]/.test(paperText[end])) end++;
      expanded = paperText.slice(start, end).replace(/\s+/g, ' ').trim();
    }
  }

  return expanded || selText;
}

function indexWebBibliography() {
  const body = document.getElementById('article-body');
  if (!body) return;

  body.querySelectorAll(
    '.ltx_bibitem, li[id^="bib."], li[id*="bibitem"], .csl-entry, section.ltx_bibliography li',
  ).forEach((item) => addBibliographyItem(item));
}

function restoreWebHighlights() {
  const aw = document.getElementById('article-wrapper');
  for (const d of discussions) {
    if (d.mode !== 'web') continue;
    d.wrapper = aw;
    paintHighlight(d);
  }
}

// ═══════════════════════════════════════════════════════
//  APP LIFECYCLE
// ═══════════════════════════════════════════════════════
function startApp(name, badge) {
  cancelOnboardingPlacement();
  document.getElementById('upload-screen').style.display = 'none';
  document.getElementById('main-app').style.display = 'flex';
  document.getElementById('content-loading').style.display = 'flex';
  document.getElementById('pdf-pages').style.display = 'none';
  document.getElementById('web-reader').style.display = 'none';
  document.getElementById('reload-note').style.display = 'none';
  document.getElementById('paper-name').textContent = name;
  document.getElementById('source-badge').textContent = badge;
  activeId = null; pendingSel = null; paperText = '';
  paperRefText = '';
  bibByNumber = {};
  paperReferences = [];
  citationFormat = null;
  citationFormatPromise = null;
}
function setStatus(msg) { document.getElementById('load-status').textContent = msg; }
function showViewer(mode) {
  document.getElementById('content-loading').style.display = 'none';
  if (mode === 'pdf') document.getElementById('pdf-pages').style.display = 'flex';
  else                document.getElementById('web-reader').style.display = 'block';
}

// ═══════════════════════════════════════════════════════
//  CITATION RESOLUTION
// ═══════════════════════════════════════════════════════
const CITE_LOG_KEY = 'paperReader.citationLog.v2';
const CITE_LOG_MAX = 150;
const CITE_FAIL_TTL_MS = 60 * 60 * 1000;
let citationLog = null;

function loadCitationLogStore() {
  if (citationLog) return citationLog;
  try { citationLog = JSON.parse(localStorage.getItem(CITE_LOG_KEY)) || {}; }
  catch { citationLog = {}; }
  return citationLog;
}

function persistCitationLog() {
  try {
    const entries = Object.values(citationLog);
    entries.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (entries.length > CITE_LOG_MAX) {
      const keep = new Set(entries.slice(0, CITE_LOG_MAX).map((e) => e.key));
      for (const k of Object.keys(citationLog)) {
        if (!keep.has(k)) delete citationLog[k];
      }
    }
    localStorage.setItem(CITE_LOG_KEY, JSON.stringify(citationLog));
  } catch (e) {
    console.warn('[CitationLookup] persist failed:', e);
  }
}

function normalizeCitationText(t) {
  return (t || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function citeLogKey(citationText) {
  const doc = currentDocId || 'unknown';
  return `${doc}::${simpleHash(normalizeCitationText(citationText))}`;
}

function isCitationLogExpired(entry) {
  if (!entry?.ts) return true;
  if (entry.status === 'ok') return false;
  return Date.now() - entry.ts > CITE_FAIL_TTL_MS;
}

function getCitationLogEntry(key) {
  const store = loadCitationLogStore();
  const entry = store[key];
  if (!entry) return null;
  if (isCitationLogExpired(entry)) {
    delete store[key];
    persistCitationLog();
    logCitation('expired', 'cache', { key, stage: entry.stage });
    return null;
  }
  entry.hits = (entry.hits || 0) + 1;
  entry.lastHit = Date.now();
  return entry;
}

function writeCitationLogEntry(key, patch) {
  const store = loadCitationLogStore();
  store[key] = {
    key,
    hits: 0,
    ts: Date.now(),
    parentDocId: currentDocId || null,
    parentTitle: docMeta?.name || null,
    ...store[key],
    ...patch,
  };
  persistCitationLog();
  return store[key];
}

function logCitation(outcome, stage, data) {
  const msg = `[CitationLookup] ${outcome} · ${stage}`;
  if (outcome === 'fail' || outcome === 'expired') console.warn(msg, data);
  else if (outcome === 'debug') console.log(msg, data);
  else console.info(msg, data);
}

function looksLikeCitation(text) {
  const t = (text || '').trim();
  if (!t || t.length > 220) return false;
  if (/https?:\/\//i.test(t)) return true;
  if (/\[\s*\d{1,3}(?:\s*[,;]\s*\d{1,3})*\s*\]/.test(t)) return true;
  if (/(?:^|\s)\(\s*\d{1,3}(?:\s*[,;]\s*\d{1,3})*\s*\)(?:\s|$)/.test(t)) return true;
  if (/\barxiv\b/i.test(t)) return true;
  if (/10\.\d{4,9}\/\S+/i.test(t)) return true;
  if (/\(\s*[^()]{3,90},\s*(19|20)\d{2}[a-z]?\s*\)/i.test(t)) return true;
  if (/\b[A-Z][A-Za-z\-]{2,}(?:\s+(?:et\s+al\.?|&\s+[A-Z][A-Za-z\-]+))*,?\s+(19|20)\d{2}[a-z]?\b/.test(t)) return true;
  return false;
}

function extractRefNumber(text) {
  const t = (text || '').trim();
  const patterns = [
    /\[(\d{1,3})\]/,
    /^\[(\d{1,3})\]$/,
    /\((\d{1,3})\)/,
    /^(\d{1,3})$/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return +m[1];
  }
  const multi = t.match(/\[(\d{1,3})\s*[,;]/);
  if (multi) return +multi[1];
  return null;
}

function extractReferencesSection(text) {
  if (!text) return '';
  const markers = [
    /\n\s*References\s*\n/i,
    /\n\s*Bibliography\s*\n/i,
    /\n\s*REFERENCES\s*\n/,
    /\n\s*Works\s+Cited\s*\n/i,
    /\bReferences\b/i,
    /\bBibliography\b/i,
  ];
  let bestIdx = -1;
  let bestLen = 0;
  for (const re of markers) {
    for (const m of text.matchAll(asGlobalRegex(re))) {
      if (m.index >= bestIdx) { bestIdx = m.index; bestLen = m[0].length; }
    }
  }
  if (bestIdx >= 0) return text.slice(bestIdx + bestLen);
  return text.slice(Math.floor(text.length * 0.82));
}

function resolveReferenceEntry(entryText) {
  const entry = entryText.replace(/\s+/g, ' ').trim();
  const url = entry.match(/https?:\/\/[^\s\]\),]+/i);
  if (url) return { url: url[0].replace(/[.,;]+$/, ''), label: entry.slice(0, 140), refText: entry };

  const arxiv = entry.match(/arxiv[:\s]*(?:\/abs\/)?([\d.]+(?:v\d+)?)/i);
  if (arxiv) return { url: `https://arxiv.org/abs/${arxiv[1]}`, label: entry.slice(0, 140), refText: entry };

  const doi = entry.match(/(?:doi[:\s]*)?(10\.\d{4,9}\/[^\s\]\),]+)/i);
  if (doi) return { url: `https://doi.org/${doi[1].replace(/[.,;]+$/, '')}`, label: entry.slice(0, 140), refText: entry };

  return { url: null, label: entry.slice(0, 140), refText: entry, unresolved: true };
}

function findReferenceInPaper(num) {
  if (bibByNumber[num]) return { ...bibByNumber[num] };

  const refSection = extractReferencesSection(paperText);
  const haystacks = [refSection, paperText];

  const patterns = [
    new RegExp(`\\[${num}\\]\\s*[^\\[]*`, 'i'),
    new RegExp(`^\\s*${num}\\.\\s+(.+)$`, 'm'),
    new RegExp(`^\\s*${num}\\)\\s+(.+)$`, 'm'),
    new RegExp(`^\\s*${num}\\s+([A-Za-z].+)$`, 'm'),
    new RegExp(`\\[${num}\\]\\s*([^\n\\[]{15,400})`, 'i'),
  ];
  for (const hay of haystacks) {
    if (!hay) continue;
    for (const p of patterns) {
      const m = hay.match(p);
      if (m) return resolveReferenceEntry(m[0] || m[1]);
    }
  }
  return null;
}

function isPlausibleAuthorPart(authorPart) {
  const t = String(authorPart || '').trim();
  if (!t || t.length > 100) return false;
  if (/^(see|cf|cited in|according to|e\.g\.|eg\.|in)\b/i.test(t)) return false;
  if (/\b(the|for|from|with|this|that|these|those|however|also)\b/i.test(t)) return false;
  return /[A-Z][A-Za-z\-']/.test(t);
}

function parseAuthorYearFromSelection(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const patterns = [
    /\(([^()]+?),\s*((?:19|20)\d{2}[a-z]?)\)/,
    /\b([A-Z][A-Za-z\-']+(?:\s+(?:et\s+al\.?|&\s+[A-Z][A-Za-z\-']+))*)\s*\(((?:19|20)\d{2}[a-z]?)\)/,
    /\b([A-Z][A-Za-z\-']+(?:\s+(?:et\s+al\.?|&\s+[A-Z][A-Za-z\-']+))*)\s*,\s*((?:19|20)\d{2}[a-z]?)\b/,
    /^([A-Z][A-Za-z\-']+(?:\s+(?:et\s+al\.?|&\s+[A-Z][A-Za-z\-']+))*)\s*,\s*((?:19|20)\d{2}[a-z]?)(?:\s|$|[.;])/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && isPlausibleAuthorPart(m[1])) {
      return { authorPart: m[1].trim(), yearStr: m[2] };
    }
  }
  return null;
}

function authorMatchRequirements(authorPart) {
  const hasEtAl = /\bet\s+al\.?/i.test(authorPart);
  const names = authorLastNames(authorPart);
  if (!names.length) return { required: [], optional: [] };
  if (hasEtAl) return { required: [names[0]], optional: names.slice(1) };
  if (/\s(?:&|and)\s/i.test(authorPart) || names.length > 1) {
    return { required: names, optional: [] };
  }
  return { required: [names[0]], optional: names.slice(1) };
}

function yearMatchesRef(refText, yearStr) {
  if (!yearStr) return true;
  const y = String(yearStr).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${y}\\b`).test(String(refText || ''));
}

function authorTokenInRef(refText, token) {
  const tok = String(token || '').toLowerCase();
  if (tok.length < 2) return false;
  const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (tok.length >= 3) return new RegExp(`\\b${escaped}\\b`, 'i').test(refText);
  return String(refText || '').toLowerCase().includes(tok);
}

function scoreRefForAuthorYear(refText, authorPart, yearStr) {
  if (!yearMatchesRef(refText, yearStr)) return 0;
  const { required, optional } = authorMatchRequirements(authorPart);
  if (!required.length) return 0;
  let score = 10;
  for (const token of required) {
    if (!authorTokenInRef(refText, token)) return 0;
    score += 20;
  }
  for (const token of optional) {
    if (authorTokenInRef(refText, token)) score += 5;
  }
  return score;
}

function findBestAuthorYearMatch(references, authorPart, yearStr) {
  const scored = [];
  for (const ref of references) {
    const score = scoreRefForAuthorYear(ref.text, authorPart, yearStr);
    if (score > 0) scored.push({ ref, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (second && best.score - second.score < 10) return null;
  return {
    isCitation: true,
    matchId: best.ref.id,
    confidence: !second || best.score - second.score >= 20 ? 0.94 : 0.88,
    reason: 'author-year match',
  };
}

function refMatchesAuthorYear(refText, authorPart, yearStr) {
  return scoreRefForAuthorYear(refText, authorPart, yearStr) > 0;
}

function authorLastNames(authorPart) {
  const cleaned = (authorPart || '')
    .replace(/\s+et\s+al\.?/gi, '')
    .replace(/\([^)]*\)/g, '')
    .trim();
  const chunks = cleaned.split(/\s+(?:&|and)\s+|\s*,\s*|\s*;\s*/i).filter(Boolean);
  const names = [];
  for (const chunk of chunks) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);
    if (parts.length) names.push(parts[parts.length - 1].replace(/[.,;]+$/, ''));
  }
  return [...new Set(names.filter((n) => n.length > 1))];
}

function findReferenceByAuthorYear(author, year) {
  if (paperReferences?.length) {
    const best = findBestAuthorYearMatch(paperReferences, author, year);
    if (best) {
      const ref = paperReferences.find((r) => r.id == best.matchId);
      if (ref) return resolveReferenceEntry(ref.text);
    }
  }

  const refSection = paperRefText || extractReferencesSection(paperText);
  const haystacks = [refSection].filter((h) => h && h.length > 20);
  const names = authorLastNames(author);
  if (!names.length) {
    const last = author.replace(/\s+et\s+al\.?/i, '').split(/\s+/).pop();
    if (last) names.push(last.replace(/[.,;]+$/, ''));
  }
  let bestLine = null;
  let bestScore = 0;
  for (const last of names) {
    const safeLast = last.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = asGlobalRegex(new RegExp(`[^\\n]{15,500}\\b${safeLast}\\b[^\\n]*\\b${year}\\b[^\\n]*`, 'i'));
    for (const hay of haystacks) {
      for (const m of hay.matchAll(re)) {
        const line = m[0].trim();
        const score = scoreRefForAuthorYear(line, author, year);
        if (score > bestScore) { bestScore = score; bestLine = line; }
      }
    }
  }
  if (bestLine && bestScore >= 30) return resolveReferenceEntry(bestLine);
  return null;
}

function parseParentheticalAuthorYear(text) {
  const parsed = parseAuthorYearFromSelection(text);
  if (!parsed) return null;

  const ref = findReferenceByAuthorYear(parsed.authorPart, parsed.yearStr);
  const base = {
    label: (text || '').trim(),
    refText: (text || '').trim(),
    authors: parsed.authorPart,
    year: parsed.yearStr,
  };
  if (ref) return { ...ref, ...base };
  return { ...base, url: null, unresolved: true };
}

function parseAuthorYearCitation(text) {
  const paren = parseParentheticalAuthorYear(text);
  if (paren) return paren;

  const patterns = [
    /([A-Z][A-Za-z\-]+(?:\s+(?:et\s+al\.?|&\s+[A-Z][A-Za-z\-]+))*)\s*[\(,]\s*((19|20)\d{2}[a-z]?)/,
    /\(([^()]{4,100})\)/,
  ];
  const direct = text.match(patterns[0]);
  if (direct) {
    const ref = findReferenceByAuthorYear(direct[1], direct[2]);
    if (ref) return ref;
  }
  const inParens = text.match(patterns[1]);
  if (inParens) {
    const inner = inParens[1];
    const ay = inner.match(/(.+),\s*((19|20)\d{2}[a-z]?)$/i);
    if (ay) {
      const ref = findReferenceByAuthorYear(ay[1].trim(), ay[2]);
      if (ref) return ref;
    }
  }
  return null;
}

function parseCitation(text) {
  const t = text.trim();
  if (!t) return null;

  const urlMatch = t.match(/https?:\/\/[^\s\]\),]+/i);
  if (urlMatch) {
    const url = urlMatch[0].replace(/[.,;]+$/, '');
    return { url, label: t.slice(0, 140), refText: t };
  }

  const arxivAbs = t.match(/arxiv\.org\/abs\/([\d.]+(?:v\d+)?)/i);
  if (arxivAbs) return { url: `https://arxiv.org/abs/${arxivAbs[1]}`, label: t, refText: t };

  const arxivId = t.match(/arXiv:\s*([\d.]+(?:v\d+)?)/i);
  if (arxivId) return { url: `https://arxiv.org/abs/${arxivId[1]}`, label: t, refText: t };

  const doiMatch = t.match(/(?:doi[:\s]*)?(10\.\d{4,9}\/[^\s\]\),]+)/i);
  if (doiMatch) {
    const doi = doiMatch[1].replace(/[.,;]+$/, '');
    return { url: `https://doi.org/${doi}`, label: t, refText: t };
  }

  const bracketMatch = t.match(/\[(\d{1,3})\]/);
  if (bracketMatch) {
    const ref = findReferenceInPaper(+bracketMatch[1]);
    if (ref) return { ...ref, label: t };
  }

  const parenNum = t.match(/\((\d{1,3})\)/);
  if (parenNum) {
    const ref = findReferenceInPaper(+parenNum[1]);
    if (ref) return { ...ref, label: t };
  }

  const refNum = extractRefNumber(t);
  if (refNum) {
    const ref = findReferenceInPaper(refNum);
    if (ref) return { ...ref, label: t };
  }

  const authorYearRef = parseAuthorYearCitation(t);
  if (authorYearRef) return { ...authorYearRef, label: t };

  const parenAuthor = parseParentheticalAuthorYear(t);
  if (parenAuthor) return parenAuthor;

  const authorYear = t.match(/([A-Z][A-Za-z\-]+(?:\s+(?:et\s+al\.?|&\s+[A-Z][A-Za-z\-]+))*)\s*[\(,]\s*(\d{4})/);
  if (authorYear) {
    const ref = findReferenceByAuthorYear(authorYear[1], authorYear[2]);
    if (ref) return { ...ref, label: t };
  }

  if (/^\[\d{1,3}\]$/.test(t)) {
    const ref = findReferenceInPaper(+t.slice(1, -1));
    if (ref) return { ...ref, label: t };
  }

  if (looksLikeCitation(t)) {
    return { url: null, label: t.slice(0, 140), refText: t, unresolved: true };
  }

  return null;
}

const BIB_TITLE_STOP = new Set([
  'about', 'after', 'their', 'with', 'from', 'this', 'that', 'these', 'those',
  'using', 'based', 'through', 'between', 'within', 'paper', 'study', 'analysis',
  'review', 'approach', 'learning', 'neural', 'network', 'networks', 'toward', 'towards',
]);

function significantTitleWords(text) {
  return [...new Set(String(text || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4 && !BIB_TITLE_STOP.has(w)))].slice(0, 10);
}

function parseBibliographyMetadata(refText) {
  const entry = String(refText || '').replace(/\s+/g, ' ').trim();
  if (!entry) return { entry: '', year: null, title: '', authors: '' };

  const yearM = entry.match(/\((19|20)(\d{2})[a-z]?\)|,\s*(19|20)(\d{2})[a-z]?\b|\b(19|20)(\d{2})[a-z]?\b/);
  let year = null;
  if (yearM) year = (yearM[1] || yearM[3] || yearM[5] || '') + (yearM[2] || yearM[4] || yearM[6] || '');

  let title = '';
  const apa = entry.match(/\((?:19|20)\d{2}[a-z]?\)\.\s*([^.]+(?:\.[^.]+)?)/);
  if (apa) title = apa[1].trim();
  if (!title) {
    const bracket = entry.replace(/^\[\d+\]\s*/, '').match(/^[^(]+?\(\d{4}[a-z]?\)\.\s*(.+?)(?:\.\s|$)/);
    if (bracket) title = bracket[1].trim();
  }
  if (!title) {
    const venue = entry.match(/(?:et al\.?|[A-Z]\.)\s+(.+?)\.\s+(?:In |Proceedings|Journal|Nature|Science|arXiv|NeurIPS|ICML|ICLR|ACL|AAAI)/i);
    if (venue) title = venue[1].trim();
  }
  if (!title) {
    const numbered = entry.replace(/^\[\d+\]\s*/, '').match(/^[A-Z][^.]+\.\s+(.+?)\./);
    if (numbered) title = numbered[1].trim();
  }

  let authors = entry.replace(/^\[\d+\]\s*/, '').split(/\(\d{4}/)[0].replace(/\d{4}[a-z]?\./, '').trim();
  if (!authors) authors = entry.slice(0, Math.min(100, entry.length));

  return { entry, year, title, authors };
}

function scoreCrossrefItem(item, meta) {
  let score = 0;
  const itemTitle = (item.title?.[0] || '').toLowerCase();
  const pubYear = item.issued?.['date-parts']?.[0]?.[0]
    || item.published?.['date-parts']?.[0]?.[0]
    || item.created?.['date-parts']?.[0]?.[0];

  if (meta.year) {
    if (pubYear && String(pubYear) === String(meta.year)) score += 30;
    else if (pubYear && Math.abs(Number(pubYear) - Number(meta.year)) === 1) score += 10;
    else if (pubYear) return 0;
  }

  const surnames = authorLastNames(meta.authors || meta.entry.slice(0, 100));
  const crFamilies = (item.author || []).map((a) => (a.family || '').toLowerCase()).filter(Boolean);
  let authorHits = 0;
  for (const sn of surnames.slice(0, 4)) {
    if (crFamilies.includes(sn.toLowerCase())) authorHits++;
  }
  if (surnames.length && authorHits === 0) return 0;
  score += authorHits * 22;

  const titleWords = significantTitleWords(meta.title || meta.entry.slice(0, 160));
  if (titleWords.length >= 2) {
    let titleHits = 0;
    for (const w of titleWords) if (itemTitle.includes(w)) titleHits++;
    if (titleHits === 0) return 0;
    score += titleHits * 12;
  }

  return score;
}

async function lookupCrossrefBibliography(meta, signal) {
  const attempts = [];
  if (meta.title && meta.title.length > 8) {
    attempts.push(() => {
      const p = new URLSearchParams({ rows: '5', 'query.title': meta.title.slice(0, 120) });
      if (meta.year) p.set('filter', `from-pub-date:${meta.year},until-pub-date:${meta.year}`);
      const surnames = authorLastNames(meta.authors);
      if (surnames[0]) p.set('query.author', surnames[0]);
      return p;
    });
  }
  attempts.push(() => {
    const p = new URLSearchParams({ rows: '5', 'query.bibliographic': meta.entry.slice(0, 220) });
    if (meta.year) p.set('filter', `from-pub-date:${meta.year},until-pub-date:${meta.year}`);
    return p;
  });

  let best = null;
  let bestScore = 0;
  for (const buildParams of attempts) {
    const params = buildParams();
    try {
      const r = await fetch(`https://api.crossref.org/works?${params}`, { signal });
      if (!r.ok) continue;
      const data = await r.json();
      for (const item of data.message?.items || []) {
        const score = scoreCrossrefItem(item, meta);
        if (score > bestScore) { bestScore = score; best = item; }
      }
    } catch (_) {}
  }

  if (best && bestScore >= 45 && best.DOI) {
    return { doi: best.DOI, score: bestScore, title: best.title?.[0] || '' };
  }
  return null;
}

function verifyFetchedPaperAgainstBib(cited, meta) {
  const metaWords = significantTitleWords(meta.title || meta.entry);
  if (metaWords.length < 2) return { ok: true, ratio: 1, hits: 0, metaWords: [] };
  const citedTitle = (cited.title || cited.text || '').toLowerCase();
  let hits = 0;
  for (const w of metaWords) if (citedTitle.includes(w)) hits++;
  const ratio = hits / metaWords.length;
  return { ok: hits >= 2 || ratio >= 0.3, ratio, hits, metaWords: metaWords.slice(0, 6) };
}

async function resolveCitationUrl(cite, signal) {
  const citationText = cite?.refText || cite?.label || '';
  const logKey = citeLogKey(citationText || pendingSel?.txt || '');

  if (cite?.url) {
    logCitation('success', 'url', { logKey, citationText, method: 'direct', url: cite.url });
    writeCitationLogEntry(logKey, {
      status: 'ok',
      stage: 'url',
      citationText,
      url: cite.url,
      urlMethod: 'direct',
      error: null,
    });
    return { url: cite.url, method: 'direct' };
  }

  if (!citationText) return null;

  const bibText = cite?.refText || citationText;

  const cached = getCitationLogEntry(logKey);
  if (cached?.url && cached.status === 'ok') {
    logCitation('cache-hit', 'url', { logKey, citationText, url: cached.url, method: cached.urlMethod || 'cache' });
    return { url: cached.url, method: cached.urlMethod || 'cache' };
  }
  if (cached?.status === 'fail' && cached.stage === 'url') {
    logCitation('cache-hit', 'url-fail', { logKey, citationText, error: cached.error });
    return null;
  }

  const fail = (stage, error, extra = {}) => {
    logCitation('fail', stage, { logKey, citationText, error, ...extra });
    writeCitationLogEntry(logKey, {
      status: 'fail',
      stage,
      citationText,
      url: null,
      error,
      ...extra,
    });
    return null;
  };

  const succeed = (url, method) => {
    logCitation('success', 'url', { logKey, citationText, method, url });
    writeCitationLogEntry(logKey, {
      status: 'ok',
      stage: 'url',
      citationText,
      url,
      urlMethod: method,
      error: null,
    });
    return { url, method };
  };

  const fromEntry = resolveReferenceEntry(bibText);
  if (fromEntry.url) return succeed(fromEntry.url, 'ref-text');

  const num = extractRefNumber(bibText);
  if (num) {
    const ref = findReferenceInPaper(num);
    if (ref?.url) return succeed(ref.url, 'bib');
  }

  const authorYearRef = parseAuthorYearCitation(bibText);
  if (authorYearRef?.url) return succeed(authorYearRef.url, 'author-year');

  const meta = parseBibliographyMetadata(bibText);
  if (cite.authors) meta.authors = cite.authors;
  if (cite.year) meta.year = cite.year;

  if (meta.entry.length >= 12) {
    try {
      const hit = await lookupCrossrefBibliography(meta, signal);
      if (hit?.doi) {
        return succeed(`https://doi.org/${hit.doi}`, 'crossref');
      }
      fail('url', 'Crossref match failed verification', {
        method: 'crossref',
        bibTitle: meta.title?.slice(0, 80),
        year: meta.year,
      });
    } catch (e) {
      fail('url', e.message || 'Crossref lookup failed', { method: 'crossref', bibTitle: meta.title?.slice(0, 80) });
    }
  } else {
    fail('url', 'Could not resolve citation to a URL', { method: 'none' });
  }
  return null;
}

function arxivIdFromUrl(url) {
  const patterns = [
    /arxiv\.org\/abs\/([\d.]+(?:v\d+)?)/i,
    /ar5iv\.labs\.arxiv\.org\/html\/([\d.]+(?:v\d+)?)/i,
    /arxiv\.org\/pdf\/([\d.]+(?:v\d+)?)/i,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

async function fetchArxivAbstract(arxivId, signal) {
  const r = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, { signal });
  const xml = await r.text();
  const title = decodeXmlText(xml.match(/<entry>[\s\S]*?<title>([^<]+)/)?.[1]);
  const summary = decodeXmlText(xml.match(/<summary>([^<]+)/)?.[1]);
  if (!summary) throw new Error('No abstract found');
  return { title, text: summary };
}

async function fetchDoiAbstract(url, signal) {
  const m = url.match(/doi\.org\/(10\.\d{4,9}\/[^\s#?]+)/i);
  if (!m) return null;
  const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(m[1])}`, { signal });
  if (!r.ok) throw new Error('DOI lookup failed');
  const data = await r.json();
  const item = data.message || {};
  const title = item.title?.[0] || '';
  const abstract = (item.abstract || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const text = abstract || item.subtitle?.[0] || '';
  if (!text) throw new Error('No abstract in DOI record');
  return { title, text };
}

async function fetchPageExcerpt(url, signal) {
  const html = await fetchViaProxy(url);
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const metaAbs = doc.querySelector('meta[name="citation_abstract"], meta[property="og:description"]');
  if (metaAbs?.content?.trim()) {
    const title = doc.querySelector('meta[name="citation_title"]')?.content
      || doc.querySelector('title')?.textContent?.trim()
      || url;
    return { title, text: metaAbs.content.trim() };
  }

  const absEl = doc.querySelector('.ltx_abstract, blockquote.abstract, #abs, .abstract, [class*="abstract"]');
  if (absEl?.textContent?.trim()) {
    const title = doc.querySelector('meta[name="citation_title"]')?.content
      || doc.querySelector('h1')?.textContent?.trim()
      || doc.querySelector('title')?.textContent?.trim()
      || url;
    return { title, text: absEl.textContent.replace(/\s+/g, ' ').trim().slice(0, 4000) };
  }

  if (typeof Readability !== 'undefined') {
    try {
      const art = new Readability(doc).parse();
      if (art?.textContent) {
        return {
          title: art.title || url,
          text: art.textContent.replace(/\s+/g, ' ').trim().slice(0, 2500),
        };
      }
    } catch (_) {}
  }

  throw new Error('Could not extract cited paper text');
}

async function fetchCitedPaperInfo(url, signal) {
  const arxivId = arxivIdFromUrl(url);
  if (arxivId) {
    try { return await fetchArxivAbstract(arxivId, signal); }
    catch (e) { console.warn('arXiv API failed:', e); }
  }

  try {
    const doiInfo = await fetchDoiAbstract(url, signal);
    if (doiInfo) return doiInfo;
  } catch (e) { console.warn('DOI lookup failed:', e); }

  return fetchPageExcerpt(url, signal);
}

function sampleCitationContext() {
  const refSection = extractReferencesSection(paperText) || '';
  let bodySample = paperText;
  if (refSection) {
    const idx = paperText.indexOf(refSection.slice(0, Math.min(40, refSection.length)));
    if (idx > 0) bodySample = paperText.slice(0, idx);
  }
  bodySample = bodySample.slice(0, 4500);
  const refSample = refSection.slice(0, 2500);
  const inTextExamples = [];
  const citeRes = [
    /\[[\d,\s\-–—]+\]/g,
    /\([^()]{3,100}(?:19|20)\d{2}[a-z]?[^()]{0,30}\)/g,
    /\b[A-Z][A-Za-z\-]+(?:\s+(?:&|and)\s+[A-Z][A-Za-z\-]+)+\s*,?\s*(?:19|20)\d{2}[a-z]?/g,
  ];
  for (const re of citeRes) {
    for (const m of bodySample.matchAll(asGlobalRegex(re))) {
      if (inTextExamples.length >= 10) break;
      if (!inTextExamples.includes(m[0])) inTextExamples.push(m[0]);
    }
  }
  const bibSample = paperReferences.slice(0, 10).map((r) => `[${r.id}] ${r.text.slice(0, 140)}`).join('\n');
  return { bodySample, refSample, inTextExamples, bibSample };
}

function sanitizeCitationFormat(format, examples) {
  if (!format?.patterns?.length) return null;
  const testTexts = [...(examples || []), ...(format.examples || [])].filter(Boolean);
  const valid = format.patterns.filter((p) => {
    try { new RegExp(p.regex, p.flags || ''); return true; } catch { return false; }
  });
  if (!valid.length) return null;
  const matched = valid.filter((p) => {
    if (!testTexts.length) return true;
    try {
      const re = new RegExp(p.regex, p.flags || '');
      return testTexts.some((ex) => re.test(String(ex)));
    } catch { return false; }
  });
  const patterns = matched.length ? matched : valid;
  return { ...format, patterns };
}

function buildFallbackCitationFormat(ctx) {
  const examples = ctx?.inTextExamples || [];
  const patterns = [];
  const hasBracket = examples.some((e) => /\[\d{1,3}\]/.test(String(e)));
  const hasAuthorYear = examples.some((e) => /\([^()]{2,80},\s*(19|20)\d{2}/.test(String(e)));
  if (hasBracket || !examples.length) {
    patterns.push({
      name: 'numeric-bracket',
      regex: '\\[(\\d{1,3})\\]',
      flags: '',
      matchType: 'numeric-id',
      idGroup: 1,
      authorGroup: 1,
      yearGroup: 2,
    });
  }
  if (hasAuthorYear || !examples.length) {
    patterns.push({
      name: 'author-year-paren',
      regex: '\\(([^()]{2,100},\\s*((19|20)\\d{2}[a-z]?)\\)',
      flags: '',
      matchType: 'author-year',
      idGroup: 1,
      authorGroup: 1,
      yearGroup: 2,
    });
  }
  if (!patterns.length) return null;
  return {
    style: 'default',
    description: 'Built-in citation patterns',
    patterns,
    examples: examples.slice(0, 8),
    source: 'fallback',
  };
}

async function ensureCitationFormat(force = false) {
  if (!currentDocId || !paperText || !paperReferences.length) return citationFormat;
  if (citationFormat && !force && citationFormat.refCount === paperReferences.length) {
    return citationFormat;
  }
  if (citationFormatPromise) return citationFormatPromise;

  citationFormatPromise = (async () => {
    const ctx = sampleCitationContext();
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: 'citation-format-detect',
          bodySample: ctx.bodySample,
          refSample: ctx.refSample,
          inTextExamples: ctx.inTextExamples,
          bibSample: ctx.bibSample,
          refCount: paperReferences.length,
        }),
      });
      const data = await r.json();
      let format = data.error ? null : data;
      if (format) {
        const sanitized = sanitizeCitationFormat(format, ctx.inTextExamples);
        format = sanitized;
      }
      if (!format) {
        format = buildFallbackCitationFormat(ctx);
        if (format) {
          logCitation('success', 'format-detect', { style: 'default', patterns: format.patterns.length, source: 'fallback' });
        } else {
          logCitation('fail', 'format-detect', { reason: data.error || 'patterns did not match paper examples' });
          return citationFormat;
        }
      } else {
        logCitation('success', 'format-detect', {
          style: format.style,
          patterns: format.patterns?.length,
          source: format.source || 'haiku',
        });
      }
      citationFormat = { ...format, refCount: paperReferences.length };
      await persistCurrentDoc();
      return citationFormat;
    } catch (e) {
      logCitation('fail', 'format-detect', { error: e.message });
      return citationFormat;
    } finally {
      citationFormatPromise = null;
    }
  })();
  return citationFormatPromise;
}

function matchWithStoredFormat(selection, references, format) {
  if (!format?.patterns?.length) return null;
  const t = (selection || '').trim();
  if (!t) return null;

  for (const p of format.patterns) {
    try {
      const re = new RegExp(p.regex, p.flags || '');
      const m = t.match(re);
      if (!m) continue;

      if (p.matchType === 'numeric-id') {
        const id = +(m[p.idGroup || 1]);
        if (!Number.isNaN(id) && references.some((r) => r.id == id)) {
          return {
            isCitation: true,
            matchId: id,
            confidence: 0.98,
            reason: `paper format: ${p.name}`,
          };
        }
      }

      if (p.matchType === 'author-year') {
        const authorPart = String(m[p.authorGroup || 1] || '').trim();
        const yearStr = m[p.yearGroup || 2];
        if (authorPart && yearStr && isPlausibleAuthorPart(authorPart)) {
          const best = findBestAuthorYearMatch(references, authorPart, yearStr);
          if (best) {
            return { ...best, confidence: 0.95, reason: `paper format: ${p.name}` };
          }
        }
      }
    } catch (e) {
      console.warn('Citation format pattern failed:', p.name, e);
    }
  }
  return null;
}

function authorTokens(authorPart) {
  return (authorPart || '')
    .replace(/^\(|\)$/g, '')
    .replace(/\s+et\s+al\.?/gi, '')
    .split(/\s*(?:&|and)\s*|\s*,\s*|\s*;\s*/i)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const parts = chunk.split(/\s+/).filter(Boolean);
      return (parts[parts.length - 1] || chunk).replace(/[.,;]+$/, '');
    })
    .filter((t) => t.length > 1);
}

function refMatchesAuthorTokens(refText, tokens, yearStr) {
  if (!yearMatchesRef(refText, yearStr)) return false;
  if (!tokens.length) return false;
  return tokens.every((token) => authorTokenInRef(refText, token));
}

function matchCitationToReferences(selection, references, format = citationFormat) {
  const t = (selection || '').trim();
  if (!t || !references?.length) return null;

  const stored = matchWithStoredFormat(t, references, format);
  if (stored) return stored;

  const bracket = t.match(/^\[(\d{1,3})\]$/);
  if (bracket) {
    const id = +bracket[1];
    if (references.some((r) => r.id == id)) {
      return { isCitation: true, matchId: id, confidence: 1, reason: 'numeric bracket citation' };
    }
  }

  const parenNum = t.match(/^\((\d{1,3})\)$/);
  if (parenNum) {
    const id = +parenNum[1];
    if (references.some((r) => r.id == id)) {
      return { isCitation: true, matchId: id, confidence: 1, reason: 'numeric parenthetical citation' };
    }
  }

  const embedded = t.match(/\[(\d{1,3})\]/);
  if (embedded) {
    const id = +embedded[1];
    if (references.some((r) => r.id == id)) {
      return { isCitation: true, matchId: id, confidence: 0.95, reason: 'bracket in selection' };
    }
  }

  const parsed = parseAuthorYearFromSelection(t);
  if (parsed) {
    const best = findBestAuthorYearMatch(references, parsed.authorPart, parsed.yearStr);
    if (best) return best;
  }

  const partialAuthor = (parsed?.authorPart || t.replace(/^\(|\)$/g, '').replace(/,?\s*(19|20)\d{2}[a-z]?\s*$/i, '').trim());
  const yearStr = parsed?.yearStr || null;
  if (partialAuthor && isPlausibleAuthorPart(partialAuthor)) {
    const tokens = authorTokens(partialAuthor);
    if (tokens.length && yearStr) {
      const scored = [];
      for (const ref of references) {
        if (refMatchesAuthorTokens(ref.text, tokens, yearStr)) {
          scored.push({ ref, score: scoreRefForAuthorYear(ref.text, partialAuthor, yearStr) });
        }
      }
      if (scored.length) {
        scored.sort((a, b) => b.score - a.score);
        const best = scored[0];
        const second = scored[1];
        if (!second || best.score - second.score >= 10) {
          return {
            isCitation: true,
            matchId: best.ref.id,
            confidence: 0.85,
            reason: 'partial author match',
          };
        }
      }
    }
  }

  return null;
}

async function callCitationMatch(payload, signal) {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'citation-match', ...payload }),
    signal,
  });
  let data;
  try { data = await r.json(); } catch { throw new Error(`Citation match failed (HTTP ${r.status}).`); }
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.message);
  return data;
}

async function callCitationPreviewHaiku(payload, signal) {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'citation-preview', ...payload }),
    signal,
  });
  const data = await r.json();
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.message);
  return data;
}

async function callCitationPreviewClaude(payload, signal) {
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: 'citation-preview-claude', ...payload }),
    signal,
  });
  const data = await r.json();
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.message);
  return data;
}

async function loadCitationPreview() {
  const el = document.getElementById('cite-preview');
  const citeBtn = document.getElementById('cite-open-btn');
  if (!pendingSel) {
    el.style.display = 'none';
    citeBtn.style.display = 'none';
    citePreviewAbort?.abort();
    return;
  }

  buildPaperReferences();
  if (!paperReferences.length) {
    el.style.display = 'none';
    citeBtn.style.display = 'none';
    return;
  }

  citePreviewAbort?.abort();
  citePreviewAbort = new AbortController();
  const { signal } = citePreviewAbort;

  // Learn format in background — never block matching on this round-trip.
  void ensureCitationFormat();

  const rawSelection = pendingSel.txt;
  const expandedSelection = expandSelectionText(rawSelection, pendingSel.range);
  pendingSel.expandedTxt = expandedSelection;
  const passage = findNearbyContext(expandedSelection, 1200);
  const logKey = citeLogKey(expandedSelection);

  el.style.display = 'block';
  el.classList.add('loading');
  el.textContent = 'Matching citation…';

  const cachedPreview = getCitationLogEntry(logKey);
  if (cachedPreview?.status === 'ok' && cachedPreview.preview) {
    logCitation('cache-hit', 'preview', { logKey, citationText: expandedSelection, url: cachedPreview.url });
    pendingCitation = {
      url: cachedPreview.url,
      refText: cachedPreview.refText || expandedSelection,
      label: expandedSelection,
      matchId: cachedPreview.matchId,
    };
    citeBtn.style.display = cachedPreview.url ? 'flex' : 'none';
    citeBtn.textContent = '📖 Open citation';
    el.classList.remove('loading');
    el.innerHTML =
      `<div class="cite-preview-title">${esc(cachedPreview.citedTitle || 'Cited paper')}</div>` +
      renderPreviewHtml(cachedPreview.preview);
    return;
  }

  try {
    let match = cachedPreview?.match;
    if (match && !match.isCitation) match = null;
    if (!match) {
      match = matchCitationToReferences(expandedSelection, paperReferences);
      const localOk = match?.isCitation && match.matchId != null
        && paperReferences.some((r) => r.id == match.matchId);
      if (localOk) {
        writeCitationLogEntry(logKey, { match, citationText: expandedSelection });
        logCitation('success', 'match-local', {
          logKey,
          selection: expandedSelection,
          matchId: match.matchId,
          confidence: match.confidence,
          reason: match.reason,
        });
      } else {
        match = await callCitationMatch({
          references: paperReferences,
          selection: expandedSelection,
        }, signal);
        if (signal.aborted) return;
        if (match?._debug) {
          logCitation('debug', 'match-haiku-prompt', match._debug);
          delete match._debug;
        }
        if (match?.isCitation && match.matchId == null) {
          const localRetry = matchCitationToReferences(expandedSelection, paperReferences);
          if (localRetry?.matchId != null) match = localRetry;
        }
        if (match?.isCitation && match.matchId != null) {
          writeCitationLogEntry(logKey, { match, citationText: expandedSelection });
        }
        logCitation(match.isCitation ? 'success' : 'success', 'match', {
          logKey,
          selection: expandedSelection,
          matchId: match.matchId,
          confidence: match.confidence,
          reason: match.reason,
        });
      }
    } else {
      logCitation('cache-hit', 'match', { logKey, selection: expandedSelection, matchId: match.matchId });
    }

    if (!match.isCitation || match.matchId == null) {
      logCitation('fail', 'match', { logKey, selection: expandedSelection, reason: match.reason || 'not a citation' });
      el.style.display = 'none';
      citeBtn.style.display = 'none';
      pendingCitation = null;
      return;
    }

    const ref = paperReferences.find((r) => r.id == match.matchId);
    if (!ref) {
      logCitation('fail', 'match', { logKey, matchId: match.matchId, reason: 'id not in bibliography' });
      el.classList.remove('loading');
      el.innerHTML = `<div class="cite-preview-title">Citation</div><span style="color:#888">Matched reference not found in bibliography.</span>`;
      return;
    }

    const ayMeta = parseAuthorYearFromSelection(expandedSelection);
    const bibMeta = parseBibliographyMetadata(ref.text);
    let cite = {
      url: ref.url,
      refText: ref.text,
      label: expandedSelection,
      matchId: ref.id,
      authors: ayMeta?.authorPart || bibMeta.authors || null,
      year: ayMeta?.yearStr || bibMeta.year || null,
    };
    pendingCitation = cite;

    // ── STEP 2: title was found in the bibliography. Explain relevance. ──
    // URL resolution + abstract fetch are best-effort ENRICHMENT only — they
    // must never block the relevance summary now that we have a matched title.
    citeBtn.style.display = 'none';

    let urlMethod = cite.url ? 'bib' : null;
    if (!cite.url) {
      el.textContent = 'Resolving paper link…';
      try {
        const resolved = await resolveCitationUrl(cite, signal);
        if (signal.aborted) return;
        if (resolved?.url) {
          cite.url = resolved.url;
          urlMethod = resolved.method;
          pendingCitation = cite;
        }
      } catch (e) {
        if (signal.aborted || e.name === 'AbortError') return;
      }
    }

    // Best-effort abstract fetch to enrich the relevance summary.
    let cited = { title: bibMeta.title || '', text: '' };
    let abstractOk = false;
    if (cite.url) {
      el.textContent = 'Fetching abstract…';
      try {
        const fetched = await fetchCitedPaperInfo(cite.url, signal);
        if (signal.aborted) return;
        const verify = verifyFetchedPaperAgainstBib(fetched, bibMeta);
        if (verify.ok) {
          cited = fetched;
          abstractOk = true;
          logCitation('success', 'abstract', { logKey, url: cite.url, title: cited.title, verify });
        } else {
          logCitation('fail', 'abstract-verify', {
            logKey,
            url: cite.url,
            bibTitle: bibMeta.title?.slice(0, 100),
            fetchedTitle: fetched.title?.slice(0, 100),
            verify,
          });
        }
      } catch (e) {
        if (signal.aborted || e.name === 'AbortError') return;
        logCitation('fail', 'abstract', { logKey, url: cite.url, error: e.message });
      }
    }

    // If the resolved abstract didn't match the bibliography entry, don't trust
    // the link — fall back to summarizing relevance from the bib entry itself.
    if (!abstractOk) {
      cite.url = null;
      urlMethod = null;
      pendingCitation = cite;
    }
    citeBtn.style.display = cite.url ? 'flex' : 'none';
    citeBtn.textContent = '📖 Open citation';

    const citedTitle = (abstractOk && cited.title) ? cited.title : (bibMeta.title || ref.text.slice(0, 80));
    const citedText = abstractOk ? cited.text : ref.text;

    el.textContent = 'Summarizing relevance…';
    const previewPayload = {
      parentTitle: docMeta.name,
      parentExcerpt: passage,
      citationText: expandedSelection,
      citedTitle,
      citedText,
      citedTextKind: abstractOk ? 'abstract' : 'bibliography-entry',
    };

    let previewResult = await callCitationPreviewHaiku(previewPayload, signal);
    if (signal.aborted) return;
    if (previewResult?._debug) {
      logCitation('debug', 'preview-haiku-prompt', previewResult._debug);
      delete previewResult._debug;
    }

    let preview = previewResult.preview || '';
    let previewSource = previewResult.source || 'haiku';

    if (!previewResult.sufficient) {
      logCitation('fail', 'preview-haiku', {
        logKey,
        reason: previewResult.reason || 'insufficient',
      });
      el.textContent = 'Asking Sonnet…';
      previewResult = await callCitationPreviewClaude(previewPayload, signal);
      if (signal.aborted) return;
      if (previewResult?._debug) {
        logCitation('debug', 'preview-sonnet-prompt', previewResult._debug);
        delete previewResult._debug;
      }
      preview = previewResult.preview || preview;
      previewSource = previewResult.source || 'sonnet';
      logCitation('success', 'preview-sonnet', { logKey, url: cite.url });
    } else {
      logCitation('success', 'preview-haiku', { logKey, url: cite.url });
    }

    writeCitationLogEntry(logKey, {
      status: 'ok',
      stage: 'preview',
      citationText: expandedSelection,
      refText: ref.text,
      matchId: ref.id,
      url: cite.url,
      urlMethod,
      citedTitle,
      preview,
      previewSource,
      match,
      error: null,
    });

    el.classList.remove('loading');
    el.innerHTML = `<div class="cite-preview-title">${esc(citedTitle)}</div>${renderPreviewHtml(preview)}`;
  } catch (e) {
    if (signal.aborted || e.name === 'AbortError') return;
    const errMsg = e.message || 'Preview unavailable';
    writeCitationLogEntry(logKey, {
      status: 'fail',
      stage: 'preview',
      citationText: expandedSelection,
      error: errMsg,
    });
    logCitation('fail', 'preview', { logKey, selection: expandedSelection, error: errMsg });
    el.classList.remove('loading');
    el.innerHTML = `<div class="cite-preview-title">Citation</div><span style="color:#888">${esc(errMsg)}</span>`;
    citeBtn.style.display = 'none';
    pendingCitation = null;
  }
}

function shouldTryCitationPreview(text) {
  const t = (text || '').trim();
  if (!t || t.length > 200) return false;
  if (looksLikeCitation(t)) return true;
  return t.length <= 100 && paperReferences.length > 0;
}

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
  citePreviewAbort?.abort();
  if (citePreviewTimer) { clearTimeout(citePreviewTimer); citePreviewTimer = null; }
  if (classifyTimer) { clearTimeout(classifyTimer); classifyTimer = null; }
  pendingCitation = null;

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
  returnToDocId = ctx.parentDocId;
  returnToDocName = ctx.parentName;
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
  discussions.push(d);
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

  pendingSel = null;
  pendingCitation = null;
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

  pendingSel = null;
  pendingCitation = null;
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

    pendingCitation = parseCitation(txt);
    if (!pendingCitation) pendingCitation = parseParentheticalAuthorYear(txt);
    if (txt.length < 2 && !pendingCitation) { hidePopover(); return; }

    const pageWrap = selEl.closest('.pdf-page-wrapper');
    if (pageWrap) {
      const pr = pageWrap.getBoundingClientRect();
      const cleanTxt = normalizePdfSelectionText(txt);
      pendingSel = {
        txt: cleanTxt, range: range.cloneRange(), mode:'pdf', pageNum:+pageWrap.dataset.page, wrapper: pageWrap,
        relRects: rawRects.map(r => ({ left:r.left-pr.left, top:r.top-pr.top, width:r.width, height:r.height })),
        mathTex: captureSelectionTex(range, selEl), math: null
      };
      positionPopover(rawRects[rawRects.length-1]);
      updatePopoverButtons();
      return;
    }

    const aw = document.getElementById('article-wrapper');
    if (aw && selEl.closest('#article-body, #article-heading')) {
      const ar = aw.getBoundingClientRect();
      pendingSel = {
        txt, range: range.cloneRange(), mode:'web', pageNum:null, wrapper:aw,
        relRects: rawRects.map(r => ({ left:r.left-ar.left, top:r.top-ar.top, width:r.width, height:r.height })),
        mathTex: captureSelectionTex(range, selEl), math: null
      };
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
  citePreviewAbort?.abort();
  pendingCitation = null;
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
  discussions.push(d);
  pendingSel = null;
  pendingCitation = null;

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
  discussions.push(d);
  pendingSel = null;
  pendingCitation = null;

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

  discussions.push(d);
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
  pendingSel = {
    txt, range: d.cite ? null : range.cloneRange(), mode: 'web', pageNum: null, wrapper: aw,
    relRects: rects.map(r => ({ left: r.left - ar.left, top: r.top - ar.top, width: r.width, height: r.height })),
    mathTex: null, math: null,
  };
  pendingCitation = parseCitation(txt) || parseParentheticalAuthorYear(txt);
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
  returnToDocId = null;
  returnToDocName = null;
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
  discussions = discussions.filter(x => x.id !== id);
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
  activeId = id;
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
  activeId = null;
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

async function callSummarize(text) {
  const r = await fetch('/api/chat', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ task:'summarize', text }),
  });
  const data = await r.json();
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.message);
  return data.summary || '';
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
  clearTimeout(_summaryTimer);
  pdfDoc=null; discussions=[]; activeId=null; pendingSel=null;
  currentDocId=null; currentMode=null;
  conversationSummary=null; summaryMessageCount=0; summaryDirty=false;
  returnToDocId=null; returnToDocName=null;
  updateReturnButton();
  document.getElementById('pdf-pages').innerHTML='';
  document.getElementById('pdf-pages').style.display='none';
  document.getElementById('web-reader').style.display='none';
  document.getElementById('article-body').innerHTML='';
  document.getElementById('article-heading').textContent='';
  document.getElementById('article-source-url').innerHTML='';
  document.getElementById('main-app').style.display='none';
  document.getElementById('url-input').value='';
  fileInput.value='';
  document.getElementById('upload-screen').style.display='flex';
  showList();
  renderLibrary();
}

// Boot
function updateAuthBar(info) {
  const btn = document.getElementById('login-btn');
  const label = btn && btn.querySelector('.lw-label');
  const statusEl = document.getElementById('login-status');
  const form = document.getElementById('login-form');
  const emailInput = document.getElementById('auth-email-input');
  const logoutBtn = document.getElementById('auth-logout-btn');
  if (!btn) return;

  let loggedIn = false;
  let status = '<strong>Log in</strong> with your email to sync your library across devices.';
  let dotColor = '';

  if (info) {
    if (info.email) {
      loggedIn = true;
      emailInput.value = info.email;
      if (info.lastSyncError) {
        dotColor = '#d6453f';
        status = `<strong>${esc(info.email)}</strong> — sync issue.<span class="sync-err">${esc(info.lastSyncError)}</span>`;
      } else if (info.syncing) {
        dotColor = '#e0a000';
        status = `<strong>${esc(info.email)}</strong> — syncing ${info.docCount || 0} paper${info.docCount === 1 ? '' : 's'} from cloud…`;
      } else if (info.useCloud) {
        dotColor = '#36b37e';
        status = `<strong>${esc(info.email)}</strong> — ${info.docCount || 0} paper${info.docCount === 1 ? '' : 's'} synced. Same email on any device loads your library.`;
      } else {
        dotColor = '#9aa0a6';
        status = `<strong>${esc(info.email)}</strong> — saved locally only.`;
      }
    } else if (info.mode === 'local') {
      status = info.error
        ? `<strong>Local only</strong><span class="sync-err">${esc(info.error)}</span>`
        : '<strong>Local only</strong> — cloud not configured.';
    }
  }

  if (label) label.textContent = loggedIn ? info.email : 'Log in';

  let dot = btn.querySelector('.lw-dot');
  if (loggedIn) {
    if (!dot) { dot = document.createElement('span'); dot.className = 'lw-dot'; btn.insertBefore(dot, label); }
    dot.style.background = dotColor;
  } else if (dot) {
    dot.remove();
  }

  statusEl.innerHTML = status;
  form.style.display = loggedIn ? 'none' : 'flex';
  logoutBtn.style.display = loggedIn ? 'block' : 'none';
}

window.onPaperStoreSyncChange = (info) => {
  updateAuthBar(info);
  renderLibrary();
  renderReadLater();
};

async function loadLibraryForEmail() {
  const email = document.getElementById('auth-email-input').value.trim();
  if (!email) return;
  try {
    const info = await PaperStore.setEmail(email);
    updateAuthBar(info);
    renderLibrary();
    renderReadLater();
    document.getElementById('login-widget').classList.remove('open');
  } catch (e) {
    alert(e.message);
  }
}

// Kept for existing callers — the login widget reflects auth state directly.
function updateLogoutFab() {
  updateAuthBar(PaperStore.getSyncStatus());
}

const loginWidget = document.getElementById('login-widget');
document.getElementById('login-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = loginWidget.classList.toggle('open');
  if (open && document.getElementById('login-form').style.display !== 'none') {
    setTimeout(() => document.getElementById('auth-email-input').focus(), 0);
  }
});
loginWidget.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => loginWidget.classList.remove('open'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') loginWidget.classList.remove('open');
});

document.getElementById('auth-load-btn').addEventListener('click', loadLibraryForEmail);
document.getElementById('auth-email-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadLibraryForEmail();
});
document.getElementById('auth-logout-btn').addEventListener('click', () => {
  PaperStore.clearEmail();
  updateAuthBar(PaperStore.getSyncStatus());
  renderLibrary();
  renderReadLater();
  loginWidget.classList.remove('open');
  backToUpload();
});

window.onPaperStoreAuthChange = () => {
  renderLibrary();
  renderReadLater();
  updateAuthBar(PaperStore.getSyncStatus());
};

window.addEventListener('beforeunload', () => { void persistCurrentDoc(); });
window.addEventListener('pagehide', () => { void persistCurrentDoc(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void persistCurrentDoc();
    if (summaryDirty) maybeUpdateSummary(true);
  }
});

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
    discussions = [];
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
        discussions.push(d);
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


(async function boot() {
  initStorage();
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
