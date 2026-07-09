// Web page + arXiv loading, article rendering, and reference/bibliography
// extraction. Depends on the pure citation core for reference resolution.

import { esc, decodeXmlText, resolveMediaUrl, normalizeForMatch } from './util.js';
import { sanitizeHtml } from './sanitize.js';
import { findEquationAfter, rectsForElement, equationDisplayText, equationHighlightId, elementById } from './equation-highlight.js';
import {
  docMeta, paperText, paperRefText, paperReferences, bibByNumber, discussions, currentMode,
  extractedReferences, MAX_PAPER_CHARS,
  setCurrentMode, setCurrentDocId, setDocMeta, replaceDiscussions, setCitationFormat,
  setBibByNumber, setPaperRefText, setPaperText, setPaperReferences,
  setActiveId, setPendingSel, setCitationFormatPromise, setExtractedReferences,
} from './state.js';
import { docIdFor, loadStore, restoreDiscussions, loadDocSummary, persistCurrentDoc } from './persistence.js';
import { renderLibrary, updateAuthBar, updateLogoutFab } from './library.js';
import { renderFromBuffer, restoreHighlightsForLoadedPages } from './pdf.js';
import { extractReferencesSection, resolveReferenceEntry } from './citation-parse.js';

// Cross-module deps still owned by main.js (chat / onboarding / citation
// resolve+log) until those modules are extracted. Wired via setWebLoaderHooks().
// Prefixed `_wl` so the shared-scope test bundle doesn't collide with other
// modules' hook holders.
let _wlRenderList = () => {};
let _wlPaintHighlight = () => {};
let _wlEnsureCitationFormat = () => {};
let _wlLogCitation = () => {};
let _wlMaybeApplyOnboardingCuration = () => {};
let _wlFinishCitationNavigation = async () => {};
let _wlCancelOnboardingPlacement = () => {};
let _wlBackToUpload = () => {};

export function setWebLoaderHooks({
  renderList, paintHighlight, ensureCitationFormat, logCitation,
  maybeApplyOnboardingCuration, finishCitationNavigation, cancelOnboardingPlacement, backToUpload,
} = {}) {
  if (renderList) _wlRenderList = renderList;
  if (paintHighlight) _wlPaintHighlight = paintHighlight;
  if (ensureCitationFormat) _wlEnsureCitationFormat = ensureCitationFormat;
  if (logCitation) _wlLogCitation = logCitation;
  if (maybeApplyOnboardingCuration) _wlMaybeApplyOnboardingCuration = maybeApplyOnboardingCuration;
  if (finishCitationNavigation) _wlFinishCitationNavigation = finishCitationNavigation;
  if (cancelOnboardingPlacement) _wlCancelOnboardingPlacement = cancelOnboardingPlacement;
  if (backToUpload) _wlBackToUpload = backToUpload;
}

export function initWebLoader() {
  document.getElementById('url-load-btn').addEventListener('click', () => {
    const v = document.getElementById('url-input').value.trim();
    if (v) loadWebPage(v);
  });
  document.getElementById('url-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { const v = e.target.value.trim(); if(v) loadWebPage(v); }
  });

  // Web highlights are positioned from layout-derived rects — reflow them when
  // the article column changes width (window resize, sidebar collapse, etc.).
  let repaintTimer = null;
  const scheduleRepaintWebHighlights = () => {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => repaintWebHighlights(), 120);
  };
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(scheduleRepaintWebHighlights);
    for (const id of ['main-app', 'viewer-panel', 'article-wrapper']) {
      const el = document.getElementById(id);
      if (el) ro.observe(el);
    }
  }
  window.addEventListener('resize', scheduleRepaintWebHighlights);
}

export async function loadWebPage(rawUrl, knownDocId, citationContext = null) {
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
  setCurrentMode('web'); setCurrentDocId(id);
  setDocMeta({ name:hostname, mode:'web', badge:'Web', url });

  const store = loadStore();
  const saved = store[id];
  replaceDiscussions(saved ? restoreDiscussions(saved.discussions) : []);
  loadDocSummary(saved);
  setCitationFormat(saved?.citationFormat || null);
  setExtractedReferences(saved?.references || null);

  try {
    setStatus('Fetching…');
    const html = await fetchViaProxy(url);
    setStatus('Extracting article…');

    const doc = new DOMParser().parseFromString(html, 'text/html');
    let base = doc.querySelector('base');
    if (!base) { base = doc.createElement('base'); doc.head.prepend(base); }
    base.href = url;

    setBibByNumber({});
    indexBibliographyFromDoc(doc);
    setPaperRefText(extractReferencesSectionFromDoc(doc));

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
    _wlRenderList();
    await persistCurrentDoc();
    _wlMaybeApplyOnboardingCuration();
    if (citationContext) await _wlFinishCitationNavigation(citationContext);

  } catch(err) {
    console.error(err);
    if (citationContext) throw err;
    _wlBackToUpload();
    errEl.innerHTML = `Couldn't fetch: <strong>${esc(err.message)}</strong><br>
      Try the paper's PDF, or check the URL.`;
    errEl.style.display = 'block';
  }
}

export function smartRewrite(url) {
  return url;
}

export function parseArxivId(input) {
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

export function arxivAbsUrl(id) {
  return `https://arxiv.org/abs/${id}`;
}

export function arxivPdfUrl(id) {
  return `https://arxiv.org/pdf/${id}.pdf`;
}

export async function fetchArxivTitle(id, signal) {
  try {
    const r = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, { signal });
    const xml = await r.text();
    return decodeXmlText(xml.match(/<entry>[\s\S]*?<title>([^<]+)/)?.[1]) || `arXiv:${id}`;
  } catch {
    return `arXiv:${id}`;
  }
}

export async function fetchPdfViaProxy(url) {
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

export async function loadArxivPdf(rawUrl, knownDocId, citationContext = null) {
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
  setCurrentMode('pdf');
  setCurrentDocId(id);

  const store = loadStore();
  const saved = store[id];
  replaceDiscussions(saved ? restoreDiscussions(saved.discussions) : []);
  loadDocSummary(saved);
  setCitationFormat(saved?.citationFormat || null);
  setExtractedReferences(saved?.references || null);

  const titleSignal = AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;

  try {
    setStatus('Fetching arXiv PDF…');
    const [buf, title] = await Promise.all([
      fetchPdfViaProxy(pdfUrl),
      fetchArxivTitle(arxivId, titleSignal),
    ]);

    setDocMeta({ name: title, mode: 'pdf', badge: 'PDF', url: absUrl });
    document.getElementById('paper-name').textContent = title;

    setStatus('Rendering PDF…');
    const pdfBlob = new Blob([buf.slice(0)], { type: 'application/pdf' });
    PaperStore.putPdf(id, pdfBlob)
      .catch((e) => { console.warn('PDF store failed:', e); updateAuthBar(PaperStore.getSyncStatus()); });

    await renderFromBuffer(buf);
    restoreHighlightsForLoadedPages();
    _wlRenderList();
    await persistCurrentDoc();
    renderLibrary();
    if (citationContext) await _wlFinishCitationNavigation(citationContext);
  } catch (err) {
    console.error(err);
    if (citationContext) throw err;
    _wlBackToUpload();
    errEl.innerHTML = `Couldn't fetch arXiv PDF: <strong>${esc(err.message)}</strong>`;
    errEl.style.display = 'block';
  }
}

export async function fetchViaProxy(url) {
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

export function renderWebArticle(title, html, url) {
  document.getElementById('article-heading').textContent = title || 'Untitled';
  document.getElementById('article-source-url').innerHTML =
    `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
  // Drop any highlight rects left over from a previously-opened paper — the
  // layer is shared across web docs, so stale rects would otherwise bleed in.
  const hlLayer = document.querySelector('#article-wrapper > .highlights-layer');
  if (hlLayer) hlLayer.innerHTML = '';
  // `html` is remote, attacker-controllable content (fetched from an arbitrary
  // URL). Sanitize before it touches the DOM — setting innerHTML fires inline
  // event handlers like <img onerror>, so stripping <script> after the fact is
  // not enough. See js/sanitize.js.
  document.getElementById('article-body').innerHTML = sanitizeHtml(html);
  document.getElementById('paper-name').textContent = title || url;
  // Resolve relative figure/media URLs against the source page so images load
  // and figure capture can fetch them (root-relative /html/... paths otherwise
  // resolve to localhost and break cross-origin rasterization).
  document.querySelectorAll('#article-body img[src]').forEach((img) => {
    const raw = img.getAttribute('src');
    const abs = resolveMediaUrl(raw, url);
    if (abs) img.src = abs;
  });
  // capture full text for context + caching
  const bodyText = document.getElementById('article-body').innerText || '';
  setPaperText((`${title || ''}\n\n${bodyText}`).slice(0, MAX_PAPER_CHARS));
  indexWebBibliography();
  buildPaperReferences();
  void _wlEnsureCitationFormat();
}

export function buildPaperReferences() {
  setPaperReferences([]);

  // A Haiku-extracted bibliography (cached on the doc) exists only when the
  // local splitters already failed on this paper — trust it first.
  if (extractedReferences?.length) {
    paperReferences.push(...extractedReferences);
    _wlLogCitation('success', 'extract-refs', { count: paperReferences.length, source: 'haiku' });
    dumpBibliography('haiku');
    return;
  }

  // Keys are usually numeric but can be alpha labels ([Vas17]); numerics sort
  // first in order, labels after, lexicographically.
  const entries = Object.entries(bibByNumber).sort((a, b) => {
    const na = +a[0];
    const nb = +b[0];
    const aNum = !Number.isNaN(na);
    const bNum = !Number.isNaN(nb);
    if (aNum && bNum) return na - nb;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return a[0].localeCompare(b[0]);
  });
  for (const [id, entry] of entries) {
    const n = +id;
    paperReferences.push({
      id: Number.isNaN(n) ? id : n,
      text: entry.refText || entry.label || '',
      url: entry.url || null,
    });
  }
  if (paperReferences.length) {
    _wlLogCitation('success', 'extract-refs', { count: paperReferences.length, source: 'dom' });
    dumpBibliography('dom');
    return;
  }

  const section = paperRefText || extractReferencesSection(paperText);
  if (!section || section.length < 20) {
    _wlLogCitation('fail', 'extract-refs', { reason: 'no references section found', hasPaperText: !!paperText });
    return;
  }

  parseReferencesFromSection(section);

  _wlLogCitation(
    paperReferences.length ? 'success' : 'fail',
    'extract-refs',
    { count: paperReferences.length, source: 'text', sectionLen: section.length },
  );
  if (paperReferences.length) dumpBibliography('text');
}

export function dumpBibliography(source) {
  console.groupCollapsed(`[CitationLookup] bibliography · ${source} · ${paperReferences.length} entries`);
  console.table(paperReferences.map((r) => ({
    id: r.id,
    url: r.url || '',
    text: String(r.text || '').slice(0, 160),
  })));
  console.log('[CitationLookup] full bibliography storage:', paperReferences);
  console.groupEnd();
}

export function parseReferencesFromSection(section) {
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
    const alphaRe = /\[([A-Za-z][A-Za-z0-9+\-]{0,15})\]\s*([\s\S]*?)(?=\[[A-Za-z][A-Za-z0-9+\-]{0,15}\]|$)/g;
    const found = [];
    while ((m = alphaRe.exec(section)) !== null) {
      const text = m[2].replace(/\s+/g, ' ').trim();
      if (text.length < 8) continue;
      const resolved = resolveReferenceEntry(`[${m[1]}] ${text}`);
      found.push({ id: m[1], text, url: resolved.url });
    }
    // Require a few hits so stray bracketed words don't masquerade as a bibliography.
    if (found.length >= 3) paperReferences.push(...found);
  }

  if (!paperReferences.length) {
    parseAuthorYearReferenceLines(section);
  }
}

// PDF text extraction yields one physical line per visual line, so a wrapped
// bibliography entry arrives as several short fragments. Reassemble them:
// join a line into the previous one when the previous line ends mid-word
// (hyphen), mid-sentence (no terminal punctuation), or before the entry has a
// year — real entries virtually always carry one.
export function mergeWrappedRefLines(lines) {
  const merged = [];
  for (const line of lines) {
    const prev = merged.length ? merged[merged.length - 1] : null;
    if (prev === null || prev.length > 1200) { merged.push(line); continue; }
    if (/[A-Za-z]-$/.test(prev)) {
      merged[merged.length - 1] = prev.slice(0, -1) + line;
      continue;
    }
    const prevComplete = /[.!?]$/.test(prev) && /\b(19|20)\d{2}\b/.test(prev);
    if (!prevComplete || /^[a-z]/.test(line)) {
      merged[merged.length - 1] = prev + ' ' + line;
    } else {
      merged.push(line);
    }
  }
  return merged;
}

export function parseAuthorYearReferenceLines(section) {
  const rawLines = section.split(/\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l && !/^\[Page \d+\]$/.test(l)
      && !/^(references|bibliography|works cited|acknowledgments?)$/i.test(l));
  const lines = mergeWrappedRefLines(rawLines);
  let id = 1;
  for (const line of lines) {
    if (line.length < 25) continue;
    if (/^(references|bibliography|works cited|acknowledgments?)/i.test(line)) continue;
    const hasYear = /\(\s*(19|20)\d{2}[a-z]?\s*\)|,\s*(19|20)\d{2}[a-z]?/.test(line);
    const looksLikeRef = hasYear || /^[A-Z\[\d]/.test(line);
    if (!looksLikeRef) continue;
    const resolved = resolveReferenceEntry(line);
    const labelM = line.match(/^\[([A-Za-z][A-Za-z0-9+\-]{0,15})\]\s*/);
    paperReferences.push({ id: labelM ? labelM[1] : id, text: line, url: resolved.url });
    if (!labelM) id++;
  }
}

export function indexBibliographyFromDoc(doc) {
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

export function addBibliographyItem(item) {
  const tag = item.querySelector?.('.ltx_tag_bibitem, .ltx_tag, .label, .citation-number');
  const tagText = tag?.textContent || '';
  const idText = item.id || item.getAttribute?.('data-num') || '';
  // Alpha labels like [Vas17] must be checked before the numeric patterns,
  // which would otherwise pull the "17" out of the label.
  const alphaMatch = tagText.trim().match(/^\[?([A-Za-z][A-Za-z0-9+\-]{1,15})\]?$/);
  const numMatch = alphaMatch ? null
    : (tagText.match(/\[?(\d{1,3})\]?/)
      || idText.match(/(?:bib\.?|ref\.?)(\d{1,3})/i)
      || idText.match(/(\d{1,3})$/));
  if (!alphaMatch && !numMatch) return;
  const num = alphaMatch ? alphaMatch[1] : +numMatch[1];
  const text = item.textContent.replace(/\s+/g, ' ').trim();
  if (text.length < 8) return;
  const entry = resolveReferenceEntry(text);
  const link = item.querySelector?.('a[href^="http"]');
  if (link?.href && !entry.url) entry.url = link.href;
  bibByNumber[num] = entry;
}

export function extractReferencesSectionFromDoc(doc) {
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

function findCitationAnchor(source, selText) {
  const expanded = (selText || '').trim();
  if (!expanded) return -1;

  let idx = source.indexOf(expanded);
  if (idx >= 0) return idx;

  const needle = expanded.slice(0, Math.min(24, expanded.length));
  if (needle.length >= 6) {
    idx = source.indexOf(needle);
    if (idx >= 0) return idx;
  }

  const authorM = expanded.match(/([A-Z][A-Za-z\-']{2,})/);
  if (!authorM) return -1;
  const surname = authorM[1];
  let pos = 0;
  while (pos < source.length) {
    const hit = source.indexOf(surname, pos);
    if (hit < 0) break;
    for (let i = hit; i >= Math.max(0, hit - 100); i--) {
      if (source[i] === '(') return i;
      if (/[.!?]/.test(source[i]) && i < hit - 8) break;
    }
    pos = hit + surname.length;
  }
  return -1;
}

function expandCitationInPaperText(selText, source) {
  const expanded = (selText || '').trim();
  if (!expanded || !source) return null;

  const idx = findCitationAnchor(source, expanded);
  if (idx < 0) return null;

  let start = idx;
  if (source[start] !== '(') {
    for (let i = start - 1; i >= Math.max(0, start - 120); i--) {
      if (source[i] === '(') { start = i; break; }
      if (/[.!?]/.test(source[i]) && i < start - 8) break;
    }
  }

  if (source[start] === '(') {
    let depth = 0;
    let end = start;
    for (let i = start; i < source.length && i < start + 220; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end > start + 1) {
      return source.slice(start, end).replace(/\s+/g, ' ').trim();
    }
  }

  let end = idx + expanded.length;
  if (/,\s*(?:19|20)\d{0,3}[a-z]?\s*\)?$/.test(expanded)) {
    while (end < source.length && /[\dA-Za-z]/.test(source[end])) end++;
    if (source[end] === ')') end++;
  } else {
    while (start > 0 && /[^\s\n]/.test(source[start - 1])) start--;
    while (end < source.length && /[^\s\n]/.test(source[end])) end++;
  }
  return source.slice(start, end).replace(/\s+/g, ' ').trim();
}

export function expandSelectionText(selText, range) {
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
    const fromPaper = expandCitationInPaperText(expanded, paperText);
    if (fromPaper) expanded = fromPaper;
  }

  return expanded || selText;
}

export function indexWebBibliography() {
  const body = document.getElementById('article-body');
  if (!body) return;

  body.querySelectorAll(
    '.ltx_bibitem, li[id^="bib."], li[id*="bibitem"], .csl-entry, section.ltx_bibliography li',
  ).forEach((item) => addBibliographyItem(item));
}

// Locate a verbatim snippet in a rendered container and return a DOM Range.
export function locateTextRange(root, snippet) {
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

export function rectsForRange(range, wrapperEl) {
  const wrap = wrapperEl.getBoundingClientRect();
  return Array.from(range.getClientRects())
    .filter((r) => r.width > 1)
    .map((r) => ({ left: r.left - wrap.left, top: r.top - wrap.top, width: r.width, height: r.height }));
}

function rangeIsConnected(range) {
  try { return !!range?.commonAncestorContainer?.isConnected; } catch (_) { return false; }
}

function locateTextRangeFuzzy(root, snippet) {
  const norm = normalizeForMatch(snippet);
  if (!norm || norm.length < 4) return null;
  let range = locateTextRange(root, norm);
  if (range) return range;
  for (const len of [120, 80, 48, 32]) {
    if (norm.length <= len) continue;
    range = locateTextRange(root, norm.slice(0, len));
    if (range) return range;
  }
  return null;
}

function relocateWebDiscussionRects(d, aw, body) {
  if (!d || d.mode !== 'web' || !aw || !body) return;
  if (d.figure) return;

  // Onboarding math/code highlights target the display equation, not the prose
  // anchor snippet — re-measure by stable id when the page reflows.
  if (d.equationId) {
    const eq = elementById(body, d.equationId);
    if (eq) {
      const rects = rectsForElement(eq, aw);
      if (rects.length) { d.relRects = rects; return; }
    }
  }

  // Onboarding math/code anchors on prose — upgrade to the display equation when
  // placement ran before the equation was in the DOM (or before equation targeting).
  if (d.onboarding && (d.feature === 'math' || d.feature === 'code') && d._range && rangeIsConnected(d._range)) {
    const eq = findEquationAfter(d._range);
    if (eq) {
      const rects = rectsForElement(eq, aw);
      if (rects.length) {
        d.relRects = rects;
        d.equationId = equationHighlightId(eq);
        d.txt = equationDisplayText(eq, d.mathTex || d.tex);
        return;
      }
    }
  }

  // Live DOM Range survives reflow — re-measure its client rects.
  if (d._range && rangeIsConnected(d._range)) {
    const rects = rectsForRange(d._range, aw);
    if (rects.length) { d.relRects = rects; return; }
  }

  if (!d.txt || d.txt.length < 4) return;
  const range = locateTextRangeFuzzy(body, d.txt);
  if (!range) return;
  const rects = rectsForRange(range, aw);
  if (rects.length) {
    d.relRects = rects;
    d._range = range;
  }
}

export function repaintWebHighlights() {
  if (currentMode !== 'web') return;
  const aw = document.getElementById('article-wrapper');
  const body = document.getElementById('article-body');
  if (!aw || !body) return;
  const layer = aw.querySelector('.highlights-layer');
  if (layer) layer.innerHTML = '';
  for (const d of discussions) {
    if (d.mode !== 'web') continue;
    d.wrapper = aw;
    relocateWebDiscussionRects(d, aw, body);
    // Figure captures are pixel-fixed drag boxes — they cannot follow reflow and
    // paint misleading strips over unrelated text at new widths. The captured
    // image still appears in the discussion thread.
    if (d.figure) continue;
    _wlPaintHighlight(d);
  }
}

export function restoreWebHighlights() {
  repaintWebHighlights();
}

export function startApp(name, badge) {
  _wlCancelOnboardingPlacement();
  document.getElementById('upload-screen').style.display = 'none';
  document.getElementById('main-app').style.display = 'flex';
  document.getElementById('content-loading').style.display = 'flex';
  document.getElementById('pdf-pages').style.display = 'none';
  document.getElementById('web-reader').style.display = 'none';
  document.getElementById('reload-note').style.display = 'none';
  document.getElementById('paper-name').textContent = name;
  document.getElementById('source-badge').textContent = badge;
  setActiveId(null); setPendingSel(null); setPaperText('');
  setPaperRefText('');
  setBibByNumber({});
  setPaperReferences([]);
  setCitationFormat(null);
  setCitationFormatPromise(null);
  updateLogoutFab();
}

export function setStatus(msg) { document.getElementById('load-status').textContent = msg; }

export function showViewer(mode) {
  document.getElementById('content-loading').style.display = 'none';
  if (mode === 'pdf') document.getElementById('pdf-pages').style.display = 'flex';
  else                document.getElementById('web-reader').style.display = 'block';
}

export function arxivIdFromUrl(url) {
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
