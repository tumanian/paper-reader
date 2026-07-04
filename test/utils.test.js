'use strict';

// Characterization tests for the small pure utilities in index.html: HTML
// escaping, the tiny markdown renderer, the citation-preview list renderer,
// arXiv id parsing, relative timestamps, the nearby-context locator, the
// full-paper block policy, the cross-highlight context builder, and the
// onboarding-curation sanitizer.

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');
const { plain } = app;

before(async () => { await app.ready; });
beforeEach(() => { app.reset(); });

// ── esc ──────────────────────────────────────────────────────────────────────
test('esc escapes &, <, > and double-quote', () => {
  assert.equal(app.esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

// ── md ─────────────────────────────────────────────────────────────────────--
test('md renders bold, italic, inline code and line breaks', () => {
  assert.match(app.md('**b**'), /<strong>b<\/strong>/);
  assert.match(app.md('*i*'), /<em>i<\/em>/);
  assert.match(app.md('`code`'), /<code[^>]*>code<\/code>/);
  assert.match(app.md('a\nb'), /a<br>b/);
});

// ── renderPreviewHtml ─────────────────────────────────────────────────────────
test('renderPreviewHtml turns a bullet list into <li> items', () => {
  const html = app.renderPreviewHtml('• one\n• two\n• three');
  assert.match(html, /<ul class="cite-takeaways">/);
  assert.equal((html.match(/<li>/g) || []).length, 3);
});

test('renderPreviewHtml escapes a single line and does not wrap it', () => {
  const html = app.renderPreviewHtml('just <b>one</b> line');
  assert.ok(!/<ul/.test(html));
  assert.match(html, /&lt;b&gt;/);
});

// ── parseArxivId / arxiv URL helpers ──────────────────────────────────────────
test('parseArxivId handles abs, pdf, and arxiv: forms', () => {
  assert.equal(app.parseArxivId('https://arxiv.org/abs/1706.03762'), '1706.03762');
  assert.equal(app.parseArxivId('https://arxiv.org/pdf/2005.14165v2.pdf'), '2005.14165v2');
  assert.equal(app.parseArxivId('arxiv:1234.5678'), '1234.5678');
  assert.equal(app.parseArxivId('https://example.com/paper'), null);
});

test('arxivAbsUrl / arxivPdfUrl build canonical URLs', () => {
  assert.equal(app.arxivAbsUrl('1706.03762'), 'https://arxiv.org/abs/1706.03762');
  assert.equal(app.arxivPdfUrl('1706.03762'), 'https://arxiv.org/pdf/1706.03762.pdf');
});

test('arxivIdFromUrl extracts id from abs/pdf/ar5iv URLs', () => {
  assert.equal(app.arxivIdFromUrl('https://ar5iv.labs.arxiv.org/html/1706.03762'), '1706.03762');
  assert.equal(app.arxivIdFromUrl('https://arxiv.org/abs/2005.14165'), '2005.14165');
});

// ── timeAgo ───────────────────────────────────────────────────────────────────
test('timeAgo describes recent intervals', () => {
  const now = Date.now();
  assert.equal(app.timeAgo(now), 'just now');
  assert.equal(app.timeAgo(now - 5 * 60 * 1000), '5m ago');
  assert.equal(app.timeAgo(now - 3 * 3600 * 1000), '3h ago');
  assert.equal(app.timeAgo(now - 2 * 86400 * 1000), '2d ago');
});

// ── findNearbyContext ─────────────────────────────────────────────────────────
test('findNearbyContext returns a window around the located needle with ellipses', () => {
  app.state.paperText = 'AAAA '.repeat(50) + 'UNIQUE_NEEDLE' + ' BBBB'.repeat(50);
  const ctx = app.findNearbyContext('UNIQUE_NEEDLE', 20);
  assert.match(ctx, /UNIQUE_NEEDLE/);
  assert.ok(ctx.startsWith('…'));
  assert.ok(ctx.endsWith('…'));
});

test('findNearbyContext returns empty string when paper text is empty', () => {
  app.state.paperText = '';
  assert.equal(app.findNearbyContext('anything'), '');
});

test('findNearbyContext returns empty string when the needle is absent', () => {
  app.state.paperText = 'some unrelated text here';
  assert.equal(app.findNearbyContext('zzz not present zzz'), '');
});

// ── buildPaperBlock (the "full if it fits" policy) ───────────────────────────
test('buildPaperBlock returns the full paper when under the size cap', () => {
  app.state.paperText = 'short paper text';
  assert.deepEqual(plain(app.buildPaperBlock()), { text: 'short paper text', kind: 'full' });
});

test('buildPaperBlock returns kind:none when paper text is empty', () => {
  app.state.paperText = '';
  assert.deepEqual(plain(app.buildPaperBlock()), { text: '', kind: 'none' });
});

// ── buildDocContext (cross-highlight memory) ─────────────────────────────────
test('buildDocContext summarizes OTHER discussions, excluding the current one', () => {
  app.state.discussions = [
    { id: 1, txt: 'first highlight', messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }] },
    { id: 2, txt: 'second highlight', messages: [] },
    { id: 3, txt: 'current', messages: [{ role: 'user', content: 'current q' }] },
  ];
  const ctx = app.buildDocContext(3);
  assert.match(ctx, /first highlight/);
  assert.match(ctx, /Researcher: q1/);
  assert.match(ctx, /You: a1/);
  // discussion 2 has no visible messages → excluded; current (3) excluded
  assert.ok(!/second highlight/.test(ctx));
  assert.ok(!/current q/.test(ctx));
});

test('buildDocContext returns empty string when there are no other discussions with messages', () => {
  app.state.discussions = [{ id: 1, txt: 'only', messages: [] }];
  assert.equal(app.buildDocContext(1), '');
});

// ── sanitizeOnboarding ────────────────────────────────────────────────────────
test('sanitizeOnboarding keeps valid papers/items and drops malformed ones', () => {
  const out = app.sanitizeOnboarding({
    featured: 'p1',
    papers: {
      p1: { title: 'Paper 1', url: 'http://p1', items: [
        { snippet: 'hello', feature: 'math', tex: 'x^2' },
        { snippet: 42 },              // invalid snippet → dropped
        { feature: 'citation' },      // no snippet → dropped
      ] },
      bad: null,                       // invalid paper → skipped
    },
    tracks: [{ id: 't1', label: 'Track', paperIds: ['p1', 'missing'] }],
  });
  assert.equal(out.featured, 'p1');
  assert.equal(out.papers.p1.items.length, 1);
  assert.equal(out.papers.p1.items[0].feature, 'math');
  assert.equal(out.papers.bad, undefined);
  // unknown paperIds are filtered out of tracks
  assert.deepEqual(plain(out.tracks[0].paperIds), ['p1']);
});

test('sanitizeOnboarding coerces an unknown feature to discuss', () => {
  const out = app.sanitizeOnboarding({ papers: { p: { items: [{ snippet: 'x', feature: 'bogus' }] } } });
  assert.equal(out.papers.p.items[0].feature, 'discuss');
});

test('sanitizeOnboarding returns an empty shape for junk input', () => {
  assert.deepEqual(plain(app.sanitizeOnboarding(null)), { tracks: [], papers: {}, featured: '' });
});

test('sanitizeOnboardingActionCache keeps valid chat and citation entries', () => {
  const out = app.sanitizeOnboardingActionCache({
    papers: {
      p1: {
        citations: {
          '[13]': { preview: 'LSTM paper', matchId: 13 },
          bad: { matchId: 1 },
        },
        chat: {
          math: { user: 'Explain this math.', assistant: 'Here is the answer.' },
          code: { user: 'x', assistant: 42 },
        },
      },
      empty: {},
    },
  });
  assert.ok(out.papers.p1);
  assert.equal(out.papers.p1.citations['[13]'].preview, 'LSTM paper');
  assert.equal(out.papers.p1.chat.math.assistant, 'Here is the answer.');
  assert.equal(out.papers.p1.chat.code, undefined);
  assert.equal(out.papers.empty, undefined);
});

test('sanitizeOnboardingActionCache returns empty papers for junk input', () => {
  assert.deepEqual(plain(app.sanitizeOnboardingActionCache(null)), { papers: {} });
});

// ── isTodoValue / normalizeForMatch ──────────────────────────────────────────
test('isTodoValue flags empty and TODO-prefixed strings', () => {
  assert.equal(app.isTodoValue(''), true);
  assert.equal(app.isTodoValue('TODO: add url'), true);
  assert.equal(app.isTodoValue('https://real.url'), false);
});

test('normalizeForMatch collapses whitespace and trims', () => {
  assert.equal(app.normalizeForMatch('  a\n b   c '), 'a b c');
});

// ── resolveMediaUrl (figure capture + web article rendering) ─────────────────
test('resolveMediaUrl absolutizes root-relative paths against the page URL', () => {
  const base = 'https://ar5iv.org/abs/1706.03762';
  assert.equal(
    app.resolveMediaUrl('/html/1706.03762/assets/Figures/ModalNet-21.png', base),
    'https://ar5iv.org/html/1706.03762/assets/Figures/ModalNet-21.png',
  );
});

test('resolveMediaUrl leaves absolute and data URLs untouched', () => {
  const abs = 'https://cdn.example.com/fig.png';
  const data = 'data:image/png;base64,AAA';
  assert.equal(app.resolveMediaUrl(abs, 'https://ar5iv.org/abs/1'), abs);
  assert.equal(app.resolveMediaUrl(data, 'https://ar5iv.org/abs/1'), data);
});

test('resolveMediaUrl returns the original src when base is missing or invalid', () => {
  assert.equal(app.resolveMediaUrl('/fig.png', ''), '/fig.png');
  assert.equal(app.resolveMediaUrl('/fig.png', 'not a url'), '/fig.png');
});

test('resolveMediaUrl remaps localhost ar5iv asset paths to ar5iv.org', () => {
  assert.equal(
    app.resolveMediaUrl('http://localhost:3000/html/1706.03762/assets/Figures/ModalNet-21.png', ''),
    'https://ar5iv.org/html/1706.03762/assets/Figures/ModalNet-21.png',
  );
  assert.equal(
    app.resolveMediaUrl('/html/1706.03762/assets/Figures/ModalNet-21.png', 'http://localhost:3000/'),
    'https://ar5iv.org/html/1706.03762/assets/Figures/ModalNet-21.png',
  );
});
