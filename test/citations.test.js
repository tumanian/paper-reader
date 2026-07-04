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

test('matches a truncated parenthetical author-year selection', () => {
  const refs = [
    { id: 1, text: 'Dettmers, T. et al. LLM.int8(): 8-bit matrix multiplication for transformers. NeurIPS 2022.' },
    { id: 2, text: 'Smith, J. Widgets in the wild. 2020.' },
  ];
  const m = app.matchCitationToReferences('(Dettmers et al., 20', refs);
  assert.equal(m?.isCitation, true);
  assert.equal(m?.matchId, 1);
});

test('expandSelectionText completes a partial parenthetical from paper text', () => {
  app.state.paperText = 'Prior work (Dettmers et al., 2022) shows quantization helps.';
  const expanded = app.expandSelectionText('(Dettmers et al., 20', null);
  assert.equal(expanded, '(Dettmers et al., 2022)');
});

test('expandSelectionText completes through the author-year comma', () => {
  app.state.paperText = 'See (Dettmers et al., 2022) for details.';
  const expanded = app.expandSelectionText('(Dettmers et al.,', null);
  assert.equal(expanded, '(Dettmers et al., 2022)');
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
  assert.equal(app.looksLikeCitation('(Dettmers et al., 20'), true);
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

// ── label-id patterns (alpha bracket labels like [Vas17]) ────────────────────
const ALPHA_REFS = [
  { id: 'Vas17', text: 'Vassilevska Williams, V. Multiplying matrices faster. 2017.' },
  { id: 'BLM+20', text: 'Blum, A. et al. Foundations of data science. 2020.' },
];
const ALPHA_FORMAT = {
  style: 'alpha-bracket',
  patterns: [{ name: 'alpha-bracket', regex: '\\[([A-Za-z][A-Za-z0-9+\\-]{1,15})\\]', flags: '', matchType: 'label-id', idGroup: 1 }],
};

test('matchWithStoredFormat resolves a label-id pattern to the reference id', () => {
  const m = app.matchWithStoredFormat('[Vas17]', ALPHA_REFS, ALPHA_FORMAT);
  assert.equal(m.isCitation, true);
  assert.equal(m.matchId, 'Vas17');
  assert.equal(m.confidence, 0.98);
});

test('matchWithStoredFormat matches labels case-insensitively but returns the bib casing', () => {
  const m = app.matchWithStoredFormat('[vas17]', ALPHA_REFS, ALPHA_FORMAT);
  assert.equal(m.matchId, 'Vas17');
});

test('matchWithStoredFormat returns null for a label absent from the bibliography', () => {
  assert.equal(app.matchWithStoredFormat('[Zzz99]', ALPHA_REFS, ALPHA_FORMAT), null);
});

test('matchCitationToReferences resolves alpha labels only via the stored format', () => {
  const m = app.matchCitationToReferences('[Vas17]', ALPHA_REFS, ALPHA_FORMAT);
  assert.equal(m.isCitation, true);
  assert.equal(m.matchId, 'Vas17');
  // Without a learned format the hardcoded fallbacks don't know this style.
  assert.equal(app.matchCitationToReferences('[Vas17]', ALPHA_REFS), null);
});

test('looksLikeCitation consults the learned format before the hardcoded patterns', () => {
  assert.equal(app.looksLikeCitation('[Vas17]'), false);
  app.state.citationFormat = ALPHA_FORMAT;
  assert.equal(app.looksLikeCitation('[Vas17]'), true);
});

test('shouldTryCitationPreview accepts learned-format citations without a bibliography', () => {
  app.state.paperReferences = [];
  assert.equal(app.shouldTryCitationPreview('[Vas17]'), false);
  app.state.citationFormat = ALPHA_FORMAT;
  assert.equal(app.shouldTryCitationPreview('[Vas17]'), true);
});

test('parseCitation resolves an alpha label through the stored format', () => {
  app.state.paperReferences = ALPHA_REFS;
  app.state.citationFormat = ALPHA_FORMAT;
  const c = app.parseCitation('[Vas17]');
  assert.equal(c.label, '[Vas17]');
  assert.match(c.refText, /Vassilevska/);
});

test('findReferenceInPaper escapes regex metacharacters in alpha labels', () => {
  app.state.paperText = 'Body text.\n\nReferences\n[BLM+20] Blum, A. et al. Foundations of data science. Cambridge University Press, 2020.\n[Vas17] Vassilevska Williams, V. Multiplying matrices faster. 2017.';
  const ref = app.findReferenceInPaper('BLM+20');
  assert.ok(ref);
  assert.match(ref.refText, /Blum/);
});

// ── bibliography splitting (alpha labels + learned refEntryPattern) ──────────
test('parseReferencesFromSection splits alpha-bracket bibliographies with string ids', () => {
  const section =
    '[Vas17] Vassilevska Williams, V. Multiplying matrices in subcubic time. 2017.\n' +
    '[BLM+20] Blum, A., et al. Foundations of data science. 2020.\n' +
    '[Foo19] Foo, B. A third entry with enough text to count. 2019.';
  app.parseReferencesFromSection(section);
  assert.deepEqual(app.state.paperReferences.map((r) => r.id), ['Vas17', 'BLM+20', 'Foo19']);
});

test('parseReferencesWithPattern splits entries and captures labels', () => {
  const section =
    '[R1] First reference entry with plenty of characters. 2001.\n' +
    '[R2] Second reference entry with plenty of characters. 2002.\n' +
    '[R3] Third reference entry with plenty of characters. 2003.\n' +
    '[R4] Fourth reference entry with plenty of characters. 2004.';
  const refs = app.parseReferencesWithPattern(section, { regex: '^\\[(R\\d+)\\]', flags: 'gm', labelGroup: 1 });
  assert.equal(refs.length, 4);
  assert.deepEqual(plain(refs.map((r) => r.id)), ['R1', 'R2', 'R3', 'R4']);
  assert.match(refs[2].text, /Third reference entry/);
});

test('parseReferencesWithPattern rejects patterns matching fewer than 3 entries or invalid regexes', () => {
  const section = '[R1] First reference entry, long enough. 2001.\n[R2] Second reference entry, long enough. 2002.';
  assert.deepEqual(plain(app.parseReferencesWithPattern(section, { regex: '^\\[(R\\d+)\\]', flags: 'gm', labelGroup: 1 })), []);
  assert.deepEqual(plain(app.parseReferencesWithPattern(section, { regex: '(', flags: 'gm', labelGroup: 1 })), []);
});

test('parseAuthorYearReferenceLines preserves leading bracket labels as ids', () => {
  const section =
    '[Vas17] Vassilevska Williams, V. (2017). Matrix multiplication advances.\n' +
    '[BLM+20] Blum, A. et al. (2020). Foundations of data science.';
  app.parseAuthorYearReferenceLines(section);
  assert.deepEqual(app.state.paperReferences.map((r) => r.id), ['Vas17', 'BLM+20']);
});

// ── refEntryPattern sanitization ─────────────────────────────────────────────
test('sanitizeCitationFormat keeps a compiling refEntryPattern and forces the g flag', () => {
  const sane = app.sanitizeCitationFormat({
    patterns: [{ regex: '\\[\\d+\\]', flags: '' }],
    refEntryPattern: { regex: '^\\[(\\w+)\\]', flags: 'm', labelGroup: 1 },
  }, ['[3]']);
  assert.ok(sane.refEntryPattern);
  assert.ok(sane.refEntryPattern.flags.includes('g'));
});

test('sanitizeCitationFormat drops a non-compiling refEntryPattern but keeps the format', () => {
  const sane = app.sanitizeCitationFormat({
    patterns: [{ regex: '\\[\\d+\\]', flags: '' }],
    refEntryPattern: { regex: '(', flags: '' },
  }, ['[3]']);
  assert.equal(sane.refEntryPattern, null);
  assert.equal(sane.patterns.length, 1);
});

test('sanitizeCitationFormat keeps a format that only carries a refEntryPattern', () => {
  const sane = app.sanitizeCitationFormat({
    patterns: [],
    refEntryPattern: { regex: '^\\[(\\w+)\\]', flags: 'gm', labelGroup: 1 },
  }, []);
  assert.ok(sane);
  assert.equal(sane.patterns.length, 0);
  assert.ok(sane.refEntryPattern);
});

test('buildFallbackCitationFormat author-year pattern compiles and matches (regression)', () => {
  const fmt = app.buildFallbackCitationFormat({ inTextExamples: ['(Smith, 2020)'] });
  const ay = fmt.patterns.find((p) => p.matchType === 'author-year');
  assert.ok(ay);
  const re = new RegExp(ay.regex, ay.flags); // must not throw
  assert.ok(re.test('(Smith, 2020)'));
});

test('buildFallbackCitationFormat emits a label-id pattern for alpha bracket examples', () => {
  const fmt = app.buildFallbackCitationFormat({ inTextExamples: ['[Vas17]', '[BLM+20]'] });
  const alpha = fmt.patterns.find((p) => p.matchType === 'label-id');
  assert.ok(alpha);
  assert.ok(new RegExp(alpha.regex).test('[Vas17]'));
});

// ── shouldTryCitationPreview ─────────────────────────────────────────────────
test('shouldTryCitationPreview is true for citation-shaped text and false for long prose', () => {
  app.state.paperReferences = REFS;
  assert.equal(app.shouldTryCitationPreview('[9]'), true);
  assert.equal(app.shouldTryCitationPreview('x'.repeat(250)), false);
});

test('shouldTryCitationPreview works for author-year even without a bibliography', () => {
  app.state.paperReferences = [];
  assert.equal(app.shouldTryCitationPreview('(Dettmers et al., 2022)'), true);
});
