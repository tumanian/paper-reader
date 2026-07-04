// Citation resolution: the citation log/cache, URL resolution (Crossref/DOI/
// arXiv), cited-paper abstract fetching, citation-format detection, and the
// selection → match → preview pipeline. Networked + UI side; the pure matching
// lives in citation-parse.js.

import { esc, renderPreviewHtml, simpleHash, decodeXmlText, asGlobalRegex } from './util.js';
import {
  currentDocId, docMeta, pendingSel, paperText, paperRefText, paperReferences, citationFormat, citationFormatPromise,
  extractedReferences,
  setPendingCitation, setCitationFormat, setCitationFormatPromise, setExtractedReferences,
} from './state.js';
import { persistCurrentDoc } from './persistence.js';
import {
  authorLastNames, scoreCrossrefItem, resolveReferenceEntry, extractRefNumber, findReferenceInPaper,
  parseAuthorYearCitation, parseBibliographyMetadata, parseAuthorYearFromSelection,
  parsePartialAuthorYearFromSelection, parseCitation,
  verifyFetchedPaperAgainstBib, sanitizeCitationFormat, buildFallbackCitationFormat, matchCitationToReferences,
  extractReferencesSection,
} from './citation-parse.js';
import { fetchViaProxy, arxivIdFromUrl, buildPaperReferences, expandSelectionText } from './web-loader.js';

// Cross-module dep still owned by main.js (chat) until extracted. `_cr`-prefixed
// so the shared-scope test bundle doesn't collide with other modules.
let _crFindNearbyContext = () => '';
let _crRepositionPopover = () => {};
export function setCitationResolveHooks({ findNearbyContext, repositionPopover } = {}) {
  if (findNearbyContext) _crFindNearbyContext = findNearbyContext;
  if (repositionPopover) _crRepositionPopover = repositionPopover;
}

const CITE_LOG_KEY = 'paperReader.citationLog.v2';
const CITE_LOG_MAX = 150;
const CITE_FAIL_TTL_MS = 60 * 60 * 1000;
let citationLog = null;

// In-flight preview controllers (shared with selection code via cancelCitationPreview).
let citePreviewAbort = null;
let citePreviewTimer = null;

export function cancelCitationPreview() {
  citePreviewAbort?.abort();
  if (citePreviewTimer) { clearTimeout(citePreviewTimer); citePreviewTimer = null; }
}

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

export function citeLogKey(citationText) {
  const doc = currentDocId || 'unknown';
  return `${doc}::${simpleHash(normalizeCitationText(citationText))}`;
}

function isCitationLogExpired(entry) {
  if (!entry?.ts) return true;
  if (entry.status === 'ok') return false;
  return Date.now() - entry.ts > CITE_FAIL_TTL_MS;
}

export function getCitationLogEntry(key) {
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

export function writeCitationLogEntry(key, patch) {
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

// Pre-seed citation log entries for onboarding demos (static cache → instant preview).
export function seedOnboardingCitationCache(entries) {
  if (!entries || typeof entries !== 'object') return;
  for (const [citationText, patch] of Object.entries(entries)) {
    if (!patch || typeof patch !== 'object') continue;
    writeCitationLogEntry(citeLogKey(citationText), patch);
  }
}

export function logCitation(outcome, stage, data) {
  const msg = `[CitationLookup] ${outcome} · ${stage}`;
  if (outcome === 'fail' || outcome === 'expired') console.warn(msg, data);
  else if (outcome === 'debug') console.log(msg, data);
  else console.info(msg, data);
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

async function lookupCrossrefAuthorYear(authorPart, yearStr, signal) {
  const surname = authorLastNames(authorPart)[0];
  if (!surname || !yearStr) return null;

  const meta = {
    entry: `${authorPart}, ${yearStr}`,
    year: yearStr,
    title: '',
    authors: authorPart,
  };

  try {
    const params = new URLSearchParams({
      rows: '10',
      'query.author': surname,
      filter: `from-pub-date:${yearStr},until-pub-date:${yearStr}`,
    });
    const r = await fetch(`https://api.crossref.org/works?${params}`, { signal });
    if (!r.ok) return null;
    const data = await r.json();
    let best = null;
    let bestScore = 0;
    for (const item of data.message?.items || []) {
      const score = scoreCrossrefItem(item, meta);
      if (score > bestScore) { bestScore = score; best = item; }
    }
    if (best && bestScore >= 30 && best.DOI) {
      return { doi: best.DOI, score: bestScore, title: best.title?.[0] || '' };
    }
  } catch (_) {}
  return null;
}

export function buildCiteFromExpandedSelection(text) {
  const t = (text || '').trim();
  if (!t) return null;

  const linked = parseCitation(t);
  if (linked?.url) {
    return {
      url: linked.url,
      label: t,
      refText: linked.refText || t,
      citedTitle: linked.label || null,
      authors: linked.authors || null,
      year: linked.year || null,
    };
  }

  let ay = parseAuthorYearFromSelection(t);
  if (!ay) {
    const partial = parsePartialAuthorYearFromSelection(t);
    if (partial?.yearStr) ay = { authorPart: partial.authorPart, yearStr: partial.yearStr };
  }
  if (!ay?.yearStr) return null;

  return {
    url: null,
    label: t,
    refText: t,
    citedTitle: null,
    authors: ay.authorPart,
    year: ay.yearStr,
  };
}

async function summarizeAndShowCitationPreview({
  el, citeBtn, readLaterBtn, logKey, expandedSelection, passage, signal,
  cite, citedTitle, citedText, citedTextKind, urlMethod, match, refText, matchId,
}) {
  cite.citedTitle = citedTitle;
  setPendingCitation(cite);
  readLaterBtn.style.display = citedTitle ? 'flex' : 'none';
  citeBtn.style.display = cite.url ? 'flex' : 'none';
  citeBtn.textContent = '📖 Open citation';
  _crRepositionPopover();

  el.textContent = 'Summarizing relevance…';
  const previewPayload = {
    parentTitle: docMeta.name,
    parentExcerpt: passage,
    citationText: expandedSelection,
    citedTitle,
    citedText,
    citedTextKind,
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
    refText,
    matchId,
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
  _crRepositionPopover();
}

async function loadCitationPreviewWithoutBibliography({
  el, citeBtn, readLaterBtn, expandedSelection, passage, logKey, signal,
}) {
  const cachedPreview = getCitationLogEntry(logKey);
  if (cachedPreview?.status === 'ok' && cachedPreview.preview) {
    logCitation('cache-hit', 'preview', { logKey, citationText: expandedSelection, url: cachedPreview.url });
    el.style.display = 'block';
    setPendingCitation({
      url: cachedPreview.url,
      refText: cachedPreview.refText || expandedSelection,
      label: expandedSelection,
      citedTitle: cachedPreview.citedTitle || null,
    });
    citeBtn.style.display = cachedPreview.url ? 'flex' : 'none';
    citeBtn.textContent = '📖 Open citation';
    readLaterBtn.style.display = cachedPreview.citedTitle ? 'flex' : 'none';
    el.classList.remove('loading');
    el.innerHTML =
      `<div class="cite-preview-title">${esc(cachedPreview.citedTitle || 'Cited paper')}</div>` +
      renderPreviewHtml(cachedPreview.preview);
    _crRepositionPopover();
    return;
  }

  const cite = buildCiteFromExpandedSelection(expandedSelection);
  if (!cite) {
    logCitation('fail', 'match', { logKey, selection: expandedSelection, reason: 'no bibliography' });
    el.style.display = 'none';
    citeBtn.style.display = 'none';
    readLaterBtn.style.display = 'none';
    setPendingCitation(null);
    return;
  }

  el.style.display = 'block';
  el.classList.add('loading');
  el.textContent = 'Looking up citation…';
  _crRepositionPopover();
  setPendingCitation(cite);

  let urlMethod = cite.url ? 'direct' : null;
  let crossrefTitle = cite.citedTitle;

  if (!cite.url) {
    try {
      const resolved = await resolveCitationUrl(cite, signal);
      if (signal.aborted) return;
      if (resolved?.url) {
        cite.url = resolved.url;
        urlMethod = resolved.method;
        setPendingCitation(cite);
      }
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') return;
    }

    if (!crossrefTitle && cite.authors && cite.year) {
      try {
        const hit = await lookupCrossrefAuthorYear(cite.authors, cite.year, signal);
        if (signal.aborted) return;
        if (hit?.title) crossrefTitle = hit.title;
      } catch (e) {
        if (signal.aborted || e.name === 'AbortError') return;
      }
    }
  }

  const bibMeta = parseBibliographyMetadata(cite.refText);
  let cited = { title: crossrefTitle || bibMeta.title || '', text: '' };
  let abstractOk = false;

  if (cite.url) {
    el.textContent = 'Fetching abstract…';
    try {
      const fetched = await fetchCitedPaperInfo(cite.url, signal);
      if (signal.aborted) return;
      const verify = verifyFetchedPaperAgainstBib(fetched, {
        ...bibMeta,
        title: crossrefTitle || bibMeta.title,
        authors: cite.authors || bibMeta.authors,
        year: cite.year || bibMeta.year,
      });
      if (verify.ok) {
        cited = fetched;
        abstractOk = true;
        logCitation('success', 'abstract', { logKey, url: cite.url, title: cited.title, verify });
      }
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') return;
      logCitation('fail', 'abstract', { logKey, url: cite.url, error: e.message });
    }
  }

  const citedTitle = (abstractOk && cited.title)
    ? cited.title
    : (crossrefTitle || (cite.authors && cite.year ? `${cite.authors} (${cite.year})` : cite.label));
  const citedText = abstractOk ? cited.text : cite.refText;

  logCitation('success', 'match', {
    logKey,
    selection: expandedSelection,
    reason: 'author-year without bibliography',
    citedTitle: citedTitle?.slice(0, 80),
  });

  await summarizeAndShowCitationPreview({
    el, citeBtn, readLaterBtn, logKey, expandedSelection, passage, signal,
    cite, citedTitle, citedText,
    citedTextKind: abstractOk ? 'abstract' : 'citation-text',
    urlMethod, match: { isCitation: true, matchId: null, reason: 'no bibliography' },
    refText: cite.refText, matchId: null,
  });
}

export async function resolveCitationUrl(cite, signal) {
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

  if (cite.authors && cite.year) {
    try {
      const hit = await lookupCrossrefAuthorYear(cite.authors, cite.year, signal);
      if (hit?.doi) {
        return succeed(`https://doi.org/${hit.doi}`, 'crossref-author-year');
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
  }

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

export async function fetchCitedPaperInfo(url, signal) {
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
    /\[[A-Za-z][A-Za-z0-9+\-]{1,15}\]/g,
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


// A parsed bibliography is suspect when it's empty despite a real references
// section, or when most "entries" carry no year — the signature of a wrapped
// PDF bibliography shredded into line fragments.
function bibliographyLooksSuspect() {
  const section = paperRefText || extractReferencesSection(paperText);
  if (!section || section.length < 300) return false;
  if (!paperReferences.length) return true;
  if (paperReferences.length < 5) return false;
  const withYear = paperReferences.filter((r) => /\b(19|20)\d{2}\b/.test(r.text)).length;
  return withYear / paperReferences.length < 0.7;
}

let bibliographyExtractPromise = null;

// When local splitting failed (or produced shreds), ask Haiku for the actual
// entry list once, cache it on the doc, and rebuild the bibliography from it.
export async function ensureBibliography() {
  if (!currentDocId || !paperText) return;
  if (extractedReferences?.length) return;
  if (!bibliographyLooksSuspect()) return;
  if (bibliographyExtractPromise) return bibliographyExtractPromise;

  const docId = currentDocId;
  bibliographyExtractPromise = (async () => {
    const section = paperRefText || extractReferencesSection(paperText);
    try {
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'bibliography-extract', refText: section.slice(0, 16000) }),
      });
      const data = await r.json();
      if (data.error || !Array.isArray(data.references) || data.references.length < 3) {
        logCitation('fail', 'extract-refs-haiku', { reason: data.error || 'too few entries' });
        return;
      }
      const seen = new Set();
      const refs = [];
      for (const item of data.references) {
        const text = String(item?.text || '').trim();
        if (text.length < 20) continue;
        let id = item?.label ? String(item.label).trim() : refs.length + 1;
        if (seen.has(String(id))) id = refs.length + 1;
        seen.add(String(id));
        refs.push({ id, text, url: resolveReferenceEntry(text).url });
      }
      if (refs.length < 3) return;
      // The doc may have changed while Haiku was working — don't cross-wire.
      if (currentDocId !== docId) return;
      setExtractedReferences(refs);
      buildPaperReferences();
      logCitation('success', 'extract-refs-haiku', { count: refs.length });
      await persistCurrentDoc();
    } catch (e) {
      logCitation('fail', 'extract-refs-haiku', { error: e.message });
    } finally {
      bibliographyExtractPromise = null;
    }
  })();
  return bibliographyExtractPromise;
}

export async function ensureCitationFormat(force = false) {
  if (!currentDocId || !paperText) return citationFormat;
  // Rescue a failed/shredded bibliography first, so format detection (and its
  // refCount cache guard below) sees the real entries.
  await ensureBibliography();
  if (citationFormat && !force && citationFormat.refCount === paperReferences.length) {
    return citationFormat;
  }
  if (citationFormatPromise) return citationFormatPromise;

  const ctx = sampleCitationContext();
  // Zero parsed refs is fine as long as a references section exists — Haiku
  // can return a refEntryPattern that lets us split it after the fact.
  if (!paperReferences.length && ctx.refSample.length < 200) return citationFormat;

  setCitationFormatPromise((async () => {
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
      setCitationFormat({ ...format, refCount: paperReferences.length });
      await persistCurrentDoc();
      return citationFormat;
    } catch (e) {
      logCitation('fail', 'format-detect', { error: e.message });
      return citationFormat;
    } finally {
      setCitationFormatPromise(null);
    }
  })());
  return citationFormatPromise;
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

export async function loadCitationPreview() {
  const el = document.getElementById('cite-preview');
  const citeBtn = document.getElementById('cite-open-btn');
  const readLaterBtn = document.getElementById('read-later-sel-btn');
  if (!pendingSel) {
    el.style.display = 'none';
    citeBtn.style.display = 'none';
    readLaterBtn.style.display = 'none';
    citePreviewAbort?.abort();
    return;
  }

  buildPaperReferences();

  citePreviewAbort?.abort();
  citePreviewAbort = new AbortController();
  const { signal } = citePreviewAbort;

  const rawSelection = pendingSel.txt;
  const expandedSelection = expandSelectionText(rawSelection, pendingSel.range);
  pendingSel.expandedTxt = expandedSelection;
  const passage = _crFindNearbyContext(expandedSelection, 1200);
  const logKey = citeLogKey(expandedSelection);

  if (!paperReferences.length) {
    // Still learn the paper's format in the background: a refEntryPattern can
    // recover the bibliography for the next selection.
    void ensureCitationFormat();
    try {
      await loadCitationPreviewWithoutBibliography({
        el, citeBtn, readLaterBtn, expandedSelection, passage, logKey, signal,
      });
    } catch (e) {
      if (signal.aborted || e.name === 'AbortError') return;
      const errMsg = e.message || 'Preview unavailable';
      logCitation('fail', 'preview', { logKey, selection: expandedSelection, error: errMsg });
      el.classList.remove('loading');
      el.innerHTML = `<div class="cite-preview-title">Citation</div><span style="color:#888">${esc(errMsg)}</span>`;
      citeBtn.style.display = 'none';
      readLaterBtn.style.display = 'none';
      setPendingCitation(null);
      _crRepositionPopover();
    }
    return;
  }

  // Learn format in background — never block matching on this round-trip.
  void ensureCitationFormat();

  el.style.display = 'block';
  el.classList.add('loading');
  el.textContent = 'Matching citation…';
  _crRepositionPopover();

  const cachedPreview = getCitationLogEntry(logKey);
  if (cachedPreview?.status === 'ok' && cachedPreview.preview) {
    logCitation('cache-hit', 'preview', { logKey, citationText: expandedSelection, url: cachedPreview.url });
    setPendingCitation({
      url: cachedPreview.url,
      refText: cachedPreview.refText || expandedSelection,
      label: expandedSelection,
      citedTitle: cachedPreview.citedTitle || null,
      matchId: cachedPreview.matchId,
    });
    citeBtn.style.display = cachedPreview.url ? 'flex' : 'none';
    citeBtn.textContent = '📖 Open citation';
    readLaterBtn.style.display = cachedPreview.citedTitle ? 'flex' : 'none';
    el.classList.remove('loading');
    el.innerHTML =
      `<div class="cite-preview-title">${esc(cachedPreview.citedTitle || 'Cited paper')}</div>` +
      renderPreviewHtml(cachedPreview.preview);
    _crRepositionPopover();
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
      setPendingCitation(null);
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
      citedTitle: bibMeta.title || null,
      matchId: ref.id,
      authors: ayMeta?.authorPart || bibMeta.authors || null,
      year: ayMeta?.yearStr || bibMeta.year || null,
    };
    setPendingCitation(cite);

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
          setPendingCitation(cite);
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
      setPendingCitation(cite);
    }
    citeBtn.style.display = cite.url ? 'flex' : 'none';
    citeBtn.textContent = '📖 Open citation';

    const citedTitle = (abstractOk && cited.title) ? cited.title : (bibMeta.title || ref.text.slice(0, 80));
    const citedText = abstractOk ? cited.text : ref.text;

    await summarizeAndShowCitationPreview({
      el, citeBtn, readLaterBtn, logKey, expandedSelection, passage, signal,
      cite, citedTitle, citedText,
      citedTextKind: abstractOk ? 'abstract' : 'bibliography-entry',
      urlMethod, match, refText: ref.text, matchId: ref.id,
    });
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
    readLaterBtn.style.display = 'none';
    setPendingCitation(null);
    _crRepositionPopover();
  }
}
