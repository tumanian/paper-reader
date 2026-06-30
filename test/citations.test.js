'use strict';

// Characterization tests for the front-end citation logic that lives in
// index.html: author/year parsing, reference scoring, and the local matcher
// that resolves a selected in-text citation to a bibliography entry before any
// model round-trip. All pure (args in → result out).

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');
const { plain } = app;

before(async () => { await app.ready; });
beforeEach(() => { app.reset(); });

const REFS = [
  { id: 1, text: 'Vaswani, A., Shazeer, N. et al. Attention is all you need. NeurIPS 2017.' },
  { id: 2, text: 'Devlin, J. et al. BERT: pre-training of deep bidirectional transformers. 2019.' },
  { id: 3, text: 'Smith, J. & Lee, K. A study of widgets. 2020.' },
  { id: 12, text: 'Brown, T. et al. Language models are few-shot learners. 2020.' },
];

// ── parseAuthorYearFromSelection ─────────────────────────────────────────────
test('parses (Author et al., year) parenthetical', () => {
  assert.deepEqual(plain(app.parseAuthorYearFromSelection('(Vaswani et al., 2017)')),
    { authorPart: 'Vaswani et al.', yearStr: '2017' });
});

test('parses Author (year) form', () => {
  assert.deepEqual(plain(app.parseAuthorYearFromSelection('Devlin et al. (2019)')),
    { authorPart: 'Devlin et al.', yearStr: '2019' });
});

test('returns null for non-citation prose', () => {
  assert.equal(app.parseAuthorYearFromSelection('the cat sat on the mat'), null);
});

test('rejects an implausible author part (leading stopword)', () => {
  // "see X" should not be accepted as an author name
  assert.equal(app.isPlausibleAuthorPart('see also'), false);
  assert.equal(app.isPlausibleAuthorPart('Vaswani'), true);
});

// ── authorLastNames ──────────────────────────────────────────────────────────
test('extracts deduped surnames, dropping et al.', () => {
  assert.deepEqual(plain(app.authorLastNames('Vaswani et al.')), ['Vaswani']);
  assert.deepEqual(plain(app.authorLastNames('Smith & Lee')), ['Smith', 'Lee']);
  assert.deepEqual(plain(app.authorLastNames('Brown, T. and Mann, B.')), ['Brown', 'Mann']);
});

// ── scoreRefForAuthorYear ────────────────────────────────────────────────────
test('scores a matching author+year above zero and a mismatch at zero', () => {
  assert.ok(app.scoreRefForAuthorYear(REFS[0].text, 'Vaswani et al.', '2017') > 0);
  assert.equal(app.scoreRefForAuthorYear(REFS[0].text, 'Vaswani et al.', '1999'), 0); // wrong year
  assert.equal(app.scoreRefForAuthorYear(REFS[0].text, 'Hinton', '2017'), 0);          // wrong author
});

test('yearMatchesRef treats a missing year as a wildcard', () => {
  assert.equal(app.yearMatchesRef('anything', null), true);
  assert.equal(app.yearMatchesRef('published 2017 somewhere', '2017'), true);
  assert.equal(app.yearMatchesRef('published 2017 somewhere', '2018'), false);
});

// ── matchCitationToReferences (the local, pre-model matcher) ──────────────────
test('matches a bare numeric bracket [12] with confidence 1', () => {
  const m = app.matchCitationToReferences('[12]', REFS);
  assert.deepEqual(plain(m), { isCitation: true, matchId: 12, confidence: 1, reason: 'numeric bracket citation' });
});

test('matches a numeric parenthetical (3)', () => {
  const m = app.matchCitationToReferences('(3)', REFS);
  assert.equal(m.matchId, 3);
  assert.equal(m.isCitation, true);
});

test('matches an author-year selection to the right entry', () => {
  const m = app.matchCitationToReferences('Vaswani et al., 2017', REFS);
  assert.equal(m.isCitation, true);
  assert.equal(m.matchId, 1);
});

test('returns null when the selection is not a citation', () => {
  assert.equal(app.matchCitationToReferences('a plain English sentence', REFS), null);
});

test('returns null for an empty selection or empty references', () => {
  assert.equal(app.matchCitationToReferences('', REFS), null);
  assert.equal(app.matchCitationToReferences('[1]', []), null);
});

test('does not match a numeric id that is absent from the bibliography', () => {
  assert.equal(app.matchCitationToReferences('[99]', REFS), null);
});

// ── matchWithStoredFormat (learned per-paper patterns) ───────────────────────
test('matchWithStoredFormat resolves a numeric-id pattern', () => {
  const format = {
    patterns: [{ name: 'num', regex: '^\\[(\\d{1,3})\\]$', flags: '', matchType: 'numeric-id', idGroup: 1 }],
  };
  const m = app.matchWithStoredFormat('[2]', REFS, format);
  assert.equal(m.isCitation, true);
  assert.equal(m.matchId, 2);
  assert.equal(m.confidence, 0.98);
});

test('matchWithStoredFormat returns null when no pattern applies', () => {
  assert.equal(app.matchWithStoredFormat('[2]', REFS, { patterns: [] }), null);
  assert.equal(app.matchWithStoredFormat('[2]', REFS, null), null);
});

// ── parseCitation (full resolver, uses indexed bibliography) ─────────────────
test('parseCitation extracts a direct URL', () => {
  const c = app.parseCitation('see https://arxiv.org/abs/1234.5678 for details');
  assert.equal(c.url, 'https://arxiv.org/abs/1234.5678');
});

test('parseCitation maps arXiv id and DOI forms to canonical URLs', () => {
  assert.equal(app.parseCitation('arXiv:2005.14165').url, 'https://arxiv.org/abs/2005.14165');
  assert.equal(app.parseCitation('doi:10.1000/xyz123').url, 'https://doi.org/10.1000/xyz123');
});

test('parseCitation resolves a [n] marker against the indexed bibliography', () => {
  app.state.bibByNumber = { 7: { url: 'http://example.com/ref7', refText: 'Ref seven', label: 'Ref seven' } };
  const c = app.parseCitation('[7]');
  assert.equal(c.url, 'http://example.com/ref7');
  assert.equal(c.label, '[7]');
});

test('parseCitation returns null for ordinary prose', () => {
  assert.equal(app.parseCitation('this is just a normal sentence about cats'), null);
});

// ── extractRefNumber / looksLikeCitation / extractReferencesSection ──────────
test('extractRefNumber pulls the leading reference id', () => {
  assert.equal(app.extractRefNumber('[42]'), 42);
  assert.equal(app.extractRefNumber('(7)'), 7);
  assert.equal(app.extractRefNumber('[3, 4]'), 3);
  assert.equal(app.extractRefNumber('no number here'), null);
});

test('looksLikeCitation recognizes citation-shaped text and rejects prose', () => {
  assert.equal(app.looksLikeCitation('[12]'), true);
  assert.equal(app.looksLikeCitation('(Smith & Lee, 2020)'), true);
  assert.equal(app.looksLikeCitation('https://example.com'), true);
  assert.equal(app.looksLikeCitation('the quick brown fox'), false);
});

test('extractReferencesSection slices from the References heading', () => {
  const text = 'Intro body text.\n\nReferences\n[1] First ref.\n[2] Second ref.';
  const section = app.extractReferencesSection(text);
  assert.match(section, /\[1\] First ref\./);
  assert.ok(!/Intro body text/.test(section));
});

// ── parseBibliographyMetadata ────────────────────────────────────────────────
test('parseBibliographyMetadata extracts year, title and authors', () => {
  const meta = app.parseBibliographyMetadata('[1] Vaswani, A. (2017). Attention is all you need. NeurIPS.');
  assert.equal(meta.year, '2017');
  assert.match(meta.title, /Attention is all you need/);
  assert.match(meta.authors, /Vaswani/);
});

// ── significantTitleWords / verifyFetchedPaperAgainstBib ─────────────────────
test('significantTitleWords drops stopwords and short tokens', () => {
  const words = app.significantTitleWords('Attention is all you need for translation');
  assert.ok(words.includes('attention'));
  assert.ok(words.includes('translation'));
  assert.ok(!words.includes('is'));
  assert.ok(!words.includes('you'));
});

test('verifyFetchedPaperAgainstBib accepts a strong title overlap', () => {
  const v = app.verifyFetchedPaperAgainstBib({ title: 'attention translation networks' }, { title: 'Attention translation' });
  assert.equal(v.ok, true);
});

// ── scoreCrossrefItem ────────────────────────────────────────────────────────
test('scoreCrossrefItem rewards matching year, author and title; zero on year mismatch', () => {
  const meta = { year: '2017', authors: 'Vaswani', title: 'Attention is all you need', entry: 'x' };
  const good = {
    title: ['Attention is all you need'],
    issued: { 'date-parts': [[2017]] },
    author: [{ family: 'Vaswani' }],
    DOI: '10.1/x',
  };
  assert.ok(app.scoreCrossrefItem(good, meta) > 0);
  const wrongYear = { ...good, issued: { 'date-parts': [[1990]] } };
  assert.equal(app.scoreCrossrefItem(wrongYear, meta), 0);
});

// ── citation format sanitization / fallback ──────────────────────────────────
test('buildFallbackCitationFormat produces a numeric-bracket pattern from [n] examples', () => {
  const fmt = app.buildFallbackCitationFormat({ inTextExamples: ['[3]', '[17]'] });
  assert.ok(fmt.patterns.some((p) => p.name === 'numeric-bracket'));
  assert.equal(fmt.source, 'fallback');
});

test('sanitizeCitationFormat drops invalid regexes and keeps valid ones', () => {
  const sane = app.sanitizeCitationFormat(
    { patterns: [{ regex: '\\[\\d+\\]', flags: '' }, { regex: '(', flags: '' }] },
    ['[3]'],
  );
  assert.equal(sane.patterns.length, 1);
});

test('sanitizeCitationFormat returns null when there are no usable patterns', () => {
  assert.equal(app.sanitizeCitationFormat({ patterns: [] }, []), null);
  assert.equal(app.sanitizeCitationFormat(null, []), null);
});

// ── shouldTryCitationPreview ─────────────────────────────────────────────────
test('shouldTryCitationPreview is true for citation-shaped text and false for long prose', () => {
  app.state.paperReferences = REFS;
  assert.equal(app.shouldTryCitationPreview('[9]'), true);
  assert.equal(app.shouldTryCitationPreview('x'.repeat(250)), false);
});
