// Pure citation parsing / matching / scoring core. No DOM, no network — only
// text, regex, and reads of shared state (bibliography + paper text). Heavily
// covered by test/citations.test.js; kept ISOLATED per the refactor plan.

import { asGlobalRegex } from './util.js';
import { bibByNumber, paperText, paperReferences, paperRefText, citationFormat } from './state.js';

function matchesLearnedPattern(t) {
  for (const p of citationFormat?.patterns || []) {
    try {
      if (new RegExp(p.regex, p.flags || '').test(t)) return true;
    } catch (_) {}
  }
  return false;
}

export function looksLikeCitation(text) {
  const t = (text || '').trim();
  if (!t || t.length > 220) return false;
  if (matchesLearnedPattern(t)) return true;
  if (/https?:\/\//i.test(t)) return true;
  if (/\[\s*\d{1,3}(?:\s*[,;]\s*\d{1,3})*\s*\]/.test(t)) return true;
  if (/(?:^|\s)\(\s*\d{1,3}(?:\s*[,;]\s*\d{1,3})*\s*\)(?:\s|$)/.test(t)) return true;
  if (/\barxiv\b/i.test(t)) return true;
  if (/10\.\d{4,9}\/\S+/i.test(t)) return true;
  if (/\(\s*[^()]{3,90},\s*(?:19|20)\d{0,2}[a-z]?\s*\)?/i.test(t)) return true;
  if (/\b[A-Z][A-Za-z\-]{2,}(?:\s+(?:et\s+al\.?|&\s+[A-Z][A-Za-z\-]+))*,?\s+(19|20)\d{2}[a-z]?\b/.test(t)) return true;
  return false;
}

export function extractRefNumber(text) {
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

export function extractReferencesSection(text) {
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

export function resolveReferenceEntry(entryText) {
  const entry = entryText.replace(/\s+/g, ' ').trim();
  const url = entry.match(/https?:\/\/[^\s\]\),]+/i);
  if (url) return { url: url[0].replace(/[.,;]+$/, ''), label: entry.slice(0, 140), refText: entry };

  // arXiv IDs appear a few ways: "arXiv:1412.3555", "arXiv:1412.3555v2",
  // old-style "arXiv:cs/0123456", and the CoRR form "CoRR, abs/1412.3555"
  // (no "arXiv" token at all). An arXiv id is either NNNN.NNNNN or category/NNNNNNN.
  const ARXIV_ID = '(?:\\d{4}\\.\\d{4,5}|[a-z-]+\\/\\d{7})(?:v\\d+)?';
  const arxiv = entry.match(new RegExp(`arxiv[:\\s]*(?:\\/?abs\\/)?(${ARXIV_ID})`, 'i'))
             || entry.match(new RegExp(`\\babs\\/(${ARXIV_ID})`, 'i'));
  if (arxiv) return { url: `https://arxiv.org/abs/${arxiv[1]}`, label: entry.slice(0, 140), refText: entry };

  const doi = entry.match(/(?:doi[:\s]*)?(10\.\d{4,9}\/[^\s\]\),]+)/i);
  if (doi) return { url: `https://doi.org/${doi[1].replace(/[.,;]+$/, '')}`, label: entry.slice(0, 140), refText: entry };

  return { url: null, label: entry.slice(0, 140), refText: entry, unresolved: true };
}

export function findReferenceInPaper(num) {
  if (bibByNumber[num]) return { ...bibByNumber[num] };

  const refSection = extractReferencesSection(paperText);
  const haystacks = [refSection, paperText];

  // Ids can be alphanumeric labels like "BLM+20" — escape before interpolating.
  const safe = String(num).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\[${safe}\\]\\s*[^\\[]*`, 'i'),
    new RegExp(`^\\s*${safe}\\.\\s+(.+)$`, 'm'),
    new RegExp(`^\\s*${safe}\\)\\s+(.+)$`, 'm'),
    new RegExp(`^\\s*${safe}\\s+([A-Za-z].+)$`, 'm'),
    new RegExp(`\\[${safe}\\]\\s*([^\n\\[]{15,400})`, 'i'),
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

export function isPlausibleAuthorPart(authorPart) {
  const t = String(authorPart || '').trim();
  if (!t || t.length > 100) return false;
  if (/^(see|cf|cited in|according to|e\.g\.|eg\.|in)\b/i.test(t)) return false;
  if (/\b(the|for|from|with|this|that|these|those|however|also)\b/i.test(t)) return false;
  return /[A-Z][A-Za-z\-']/.test(t);
}

export function parseAuthorYearFromSelection(text) {
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

export function authorMatchRequirements(authorPart) {
  const hasEtAl = /\bet\s+al\.?/i.test(authorPart);
  const names = authorLastNames(authorPart);
  if (!names.length) return { required: [], optional: [] };
  if (hasEtAl) return { required: [names[0]], optional: names.slice(1) };
  if (/\s(?:&|and)\s/i.test(authorPart) || names.length > 1) {
    return { required: names, optional: [] };
  }
  return { required: [names[0]], optional: names.slice(1) };
}

export function yearMatchesRef(refText, yearStr) {
  if (!yearStr) return true;
  const y = String(yearStr).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${y}\\b`).test(String(refText || ''));
}

export function authorTokenInRef(refText, token) {
  const tok = String(token || '').toLowerCase();
  if (tok.length < 2) return false;
  const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (tok.length >= 3) return new RegExp(`\\b${escaped}\\b`, 'i').test(refText);
  return String(refText || '').toLowerCase().includes(tok);
}

export function scoreRefForAuthorYear(refText, authorPart, yearStr) {
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

export function findBestAuthorYearMatch(references, authorPart, yearStr) {
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

export function parsePartialAuthorYearFromSelection(text) {
  const t = String(text || '').trim();
  const patterns = [
    /\(([^()]+?),\s*((?:19|20)\d{0,2})\)?$/,
    /\b([A-Z][A-Za-z\-']+(?:\s+(?:et\s+al\.?|&\s+[A-Z][A-Za-z\-']+))*)\s*,\s*((?:19|20)\d{0,2})\s*\)?$/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m || !isPlausibleAuthorPart(m[1])) continue;
    const yearToken = m[2];
    if (/^(?:19|20)\d{2}[a-z]?$/.test(yearToken)) {
      return { authorPart: m[1].trim(), yearStr: yearToken, yearPrefix: null };
    }
    if (yearToken.length >= 2 && yearToken.length <= 3 && /^(?:19|20)\d*$/.test(yearToken)) {
      return { authorPart: m[1].trim(), yearStr: null, yearPrefix: yearToken };
    }
  }
  return null;
}

export function findBestAuthorYearMatchByPrefix(references, authorPart, yearPrefix) {
  const prefix = String(yearPrefix || '').trim();
  if (!prefix || prefix.length < 2 || prefix.length > 3 || !/^(?:19|20)\d*$/.test(prefix)) return null;
  const scored = [];
  for (const ref of references) {
    const yearM = String(ref.text || '').match(/\b((?:19|20)\d{2}[a-z]?)\b/);
    if (!yearM || !yearM[1].startsWith(prefix)) continue;
    const score = scoreRefForAuthorYear(ref.text, authorPart, yearM[1]);
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
    confidence: !second || best.score - second.score >= 20 ? 0.9 : 0.84,
    reason: 'author-year prefix match',
  };
}

export function refMatchesAuthorYear(refText, authorPart, yearStr) {
  return scoreRefForAuthorYear(refText, authorPart, yearStr) > 0;
}

export function authorLastNames(authorPart) {
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

export function findReferenceByAuthorYear(author, year) {
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

export function parseParentheticalAuthorYear(text) {
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

export function parseAuthorYearCitation(text) {
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

export function parseCitation(text) {
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

  const stored = matchWithStoredFormat(t, paperReferences, citationFormat);
  if (stored?.matchId != null) {
    const ref = paperReferences.find((r) => r.id == stored.matchId);
    if (ref) return { ...resolveReferenceEntry(ref.text), label: t };
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

export function significantTitleWords(text) {
  return [...new Set(String(text || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4 && !BIB_TITLE_STOP.has(w)))].slice(0, 10);
}

export function parseBibliographyMetadata(refText) {
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

export function scoreCrossrefItem(item, meta) {
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

export function verifyFetchedPaperAgainstBib(cited, meta) {
  const metaWords = significantTitleWords(meta.title || meta.entry);
  if (metaWords.length < 2) return { ok: true, ratio: 1, hits: 0, metaWords: [] };
  const citedTitle = (cited.title || cited.text || '').toLowerCase();
  let hits = 0;
  for (const w of metaWords) if (citedTitle.includes(w)) hits++;
  const ratio = hits / metaWords.length;
  return { ok: hits >= 2 || ratio >= 0.3, ratio, hits, metaWords: metaWords.slice(0, 6) };
}

export function sanitizeCitationFormat(format, examples) {
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

export function buildFallbackCitationFormat(ctx) {
  const examples = ctx?.inTextExamples || [];
  const patterns = [];
  const hasBracket = examples.some((e) => /\[\d{1,3}\]/.test(String(e)));
  const hasAuthorYear = examples.some((e) => /\([^()]{2,80},\s*(19|20)\d{2}/.test(String(e)));
  const hasAlphaLabel = examples.some((e) => /\[[A-Za-z][A-Za-z0-9+\-]{1,15}\]/.test(String(e)));
  if (hasAlphaLabel) {
    patterns.push({
      name: 'alpha-bracket',
      regex: '\\[([A-Za-z][A-Za-z0-9+\\-]{1,15})\\]',
      flags: '',
      matchType: 'label-id',
      idGroup: 1,
      authorGroup: 1,
      yearGroup: 2,
    });
  }
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
      regex: '\\(([^()]{2,100}),\\s*((19|20)\\d{2}[a-z]?)\\)',
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

export function matchWithStoredFormat(selection, references, format) {
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

      if (p.matchType === 'label-id') {
        const label = String(m[p.idGroup || 1] || '').trim();
        if (label) {
          const ref = references.find((r) => String(r.id) === label
            || String(r.id).toLowerCase() === label.toLowerCase());
          if (ref) {
            return {
              isCitation: true,
              matchId: ref.id,
              confidence: 0.98,
              reason: `paper format: ${p.name}`,
            };
          }
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

export function authorTokens(authorPart) {
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

export function refMatchesAuthorTokens(refText, tokens, yearStr) {
  if (!yearMatchesRef(refText, yearStr)) return false;
  if (!tokens.length) return false;
  return tokens.every((token) => authorTokenInRef(refText, token));
}

export function matchCitationToReferences(selection, references, format = citationFormat) {
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

  const partialAy = parsePartialAuthorYearFromSelection(t);
  if (partialAy) {
    if (partialAy.yearStr) {
      const best = findBestAuthorYearMatch(references, partialAy.authorPart, partialAy.yearStr);
      if (best) return best;
    } else if (partialAy.yearPrefix) {
      const best = findBestAuthorYearMatchByPrefix(references, partialAy.authorPart, partialAy.yearPrefix);
      if (best) return best;
    }
  }

  const partialAuthor = (parsed?.authorPart || partialAy?.authorPart || t.replace(/^\(|\)$/g, '').replace(/,?\s*(19|20)\d{2}[a-z]?\s*$/i, '').trim());
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

export function shouldTryCitationPreview(text) {
  const t = (text || '').trim();
  if (!t || t.length > 200) return false;
  if (looksLikeCitation(t)) return true;
  if (t.length > 100) return false;
  if (parseAuthorYearFromSelection(t)) return true;
  if (parsePartialAuthorYearFromSelection(t)?.yearStr) return true;
  return paperReferences.length > 0;
}
