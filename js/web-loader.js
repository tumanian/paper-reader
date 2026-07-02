// Web page + arXiv loading, article rendering, and reference/bibliography
// extraction. Depends on the pure citation core for reference resolution.

import { esc, decodeXmlText } from './util.js';
import {
  docMeta, paperText, paperRefText, paperReferences, bibByNumber, discussions,
  MAX_PAPER_CHARS,
  setCurrentMode, setCurrentDocId, setDocMeta, replaceDiscussions, setCitationFormat,
  setBibByNumber, setPaperRefText, setPaperText, setPaperReferences,
  setActiveId, setPendingSel, setCitationFormatPromise,
} from './state.js';
import { docIdFor, loadStore, restoreDiscussions, loadDocSummary, persistCurrentDoc } from './persistence.js';
import { renderLibrary, updateAuthBar } from './library.js';
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
  document.getElementById('article-body').innerHTML = html;
  document.getElementById('paper-name').textContent = title || url;
  document.querySelectorAll('#article-body script').forEach(s => s.remove());
  // capture full text for context + caching
  const bodyText = document.getElementById('article-body').innerText || '';
  setPaperText((`${title || ''}\n\n${bodyText}`).slice(0, MAX_PAPER_CHARS));
  indexWebBibliography();
  buildPaperReferences();
  void _wlEnsureCitationFormat();
}

export function buildPaperReferences() {
  setPaperReferences([]);

  for (const [id, entry] of Object.entries(bibByNumber).sort((a, b) => +a[0] - +b[0])) {
    paperReferences.push({
      id: +id,
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
    parseAuthorYearReferenceLines(section);
  }
}

export function parseAuthorYearReferenceLines(section) {
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

export function indexWebBibliography() {
  const body = document.getElementById('article-body');
  if (!body) return;

  body.querySelectorAll(
    '.ltx_bibitem, li[id^="bib."], li[id*="bibitem"], .csl-entry, section.ltx_bibliography li',
  ).forEach((item) => addBibliographyItem(item));
}

export function restoreWebHighlights() {
  const aw = document.getElementById('article-wrapper');
  for (const d of discussions) {
    if (d.mode !== 'web') continue;
    d.wrapper = aw;
    _wlPaintHighlight(d);
  }
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
