'use strict';

// arXiv paper titles: parsing the arXiv API (Atom) response, the proxy-first
// fetch, the API → PDF metadata → page-1 heading fallback chain, and the lazy
// retry that replaces a persisted "arXiv:<id>" placeholder on reopen.

const { test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');
const { jsonResponse } = app;

const ID = '1706.03762';

before(async () => { await app.ready; });
// PaperStore keeps its doc table in memory across tests; drop the arXiv doc so
// a title resolved in one test can't leak into the next as "already known".
beforeEach(async () => {
  app.reset();
  app.setFetchHandler(null);
  for (const id of Object.keys(app.PaperStore.getStore())) await app.PaperStore.deleteDoc(id);
});
afterEach(() => { app.setFetchHandler(null); });

const API_URL = `https://export.arxiv.org/api/query?id_list=${ID}`;

function atomFeed(entryTitle, { entryExtra = '' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/query?search_query%3D%26id_list%3D${ID}" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: search_query=&amp;id_list=${ID}&amp;start=0&amp;max_results=10</title>
  <id>http://arxiv.org/api/abc123</id>
  <updated>2026-09-14T00:00:00-04:00</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/${ID}v7</id>
    <updated>2023-08-02T00:41:18Z</updated>
    <published>2017-06-12T17:57:34Z</published>
    ${entryTitle}
    <summary>  The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks.
</summary>
    <author><name>Ashish Vaswani</name></author>${entryExtra}
  </entry>
</feed>`;
}

const ERROR_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query: search_query=&amp;id_list=2606.25234</title>
  <entry>
    <id>http://arxiv.org/api/errors#incorrect_id_format_for_2606.25234</id>
    <title>Error</title>
    <summary>incorrect id format for 2606.25234</summary>
  </entry>
</feed>`;

// A big-enough "html" body so it would pass the proxy's own length check.
function proxyResponse(xml, status = 200) {
  return jsonResponse(status === 200 ? { html: xml } : { error: `Upstream HTTP ${status}` }, status);
}

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get() { return null; } }, url: '',
    async text() { return text; },
    async json() { return JSON.parse(text); },
    async arrayBuffer() { return new ArrayBuffer(0); },
  };
}

function pdfResponse() {
  return {
    ok: true, status: 200, headers: { get() { return 'application/pdf'; } }, url: '',
    async arrayBuffer() { return new ArrayBuffer(16); },
    async json() { return {}; },
    async text() { return ''; },
  };
}

// ── decodeXmlEntities / decodeXmlText ───────────────────────────────────────
test('decodeXmlEntities resolves the XML predefined and numeric references', () => {
  assert.equal(app.decodeXmlEntities('A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos;'), 'A & B <C> "D" \'E\'');
  assert.equal(app.decodeXmlEntities('it&#39;s &#x27;quoted&#x27; &#8211; dash &#x3B1;'), "it's 'quoted' – dash α");
});

test('decodeXmlEntities leaves unknown names and out-of-range codepoints verbatim', () => {
  assert.equal(app.decodeXmlEntities('&eacute;&bogus; &#x110000; &#0;'), '&eacute;&bogus; &#x110000; &#0;');
  assert.equal(app.decodeXmlEntities(''), '');
  assert.equal(app.decodeXmlEntities(null), '');
});

test('decodeXmlEntities does not double-decode', () => {
  assert.equal(app.decodeXmlEntities('&amp;lt;b&amp;gt;'), '&lt;b&gt;');
});

test('decodeXmlText collapses wrapped whitespace after decoding', () => {
  assert.equal(app.decodeXmlText('  Scaling\n   Laws &amp;\n  Data  '), 'Scaling Laws & Data');
  assert.equal(app.decodeXmlText(''), '');
});

// ── parseArxivTitle ─────────────────────────────────────────────────────────
test('parseArxivTitle reads the entry title, not the feed-level query title', () => {
  assert.equal(app.parseArxivTitle(atomFeed('<title>Attention Is All You Need</title>')), 'Attention Is All You Need');
});

test('parseArxivTitle joins a multi-line, indented title into one line', () => {
  const xml = atomFeed(`<title>Scaling Laws for Neural Language Models: A Study of
  Compute-Optimal Training
        and Data</title>`);
  assert.equal(app.parseArxivTitle(xml), 'Scaling Laws for Neural Language Models: A Study of Compute-Optimal Training and Data');
});

test('parseArxivTitle trims surrounding whitespace', () => {
  assert.equal(app.parseArxivTitle(atomFeed('<title>\n    Padded Title   \n  </title>')), 'Padded Title');
});

test('parseArxivTitle decodes entities', () => {
  const xml = atomFeed('<title>P &amp; NP: Don&#39;t &lt;Panic&gt; &#x2014; &quot;Really&quot;</title>');
  assert.equal(app.parseArxivTitle(xml), 'P & NP: Don\'t <Panic> — "Really"');
});

test('parseArxivTitle accepts attributes on <title> and CDATA content', () => {
  assert.equal(app.parseArxivTitle(atomFeed('<title type="text">Typed Title</title>')), 'Typed Title');
  assert.equal(app.parseArxivTitle(atomFeed('<title><![CDATA[A & B <C>]]></title>')), 'A & B <C>');
});

test('parseArxivTitle returns null for an arXiv error entry', () => {
  assert.equal(app.parseArxivTitle(ERROR_FEED), null);
});

test('parseArxivTitle returns null when there is no entry, no title, or an empty title', () => {
  assert.equal(app.parseArxivTitle('<feed><title>ArXiv Query: id_list=1</title></feed>'), null);
  assert.equal(app.parseArxivTitle(atomFeed('')), null);
  assert.equal(app.parseArxivTitle(atomFeed('<title>   </title>')), null);
  assert.equal(app.parseArxivTitle(''), null);
  assert.equal(app.parseArxivTitle(null), null);
  assert.equal(app.parseArxivTitle('<html><body>Rate limited</body></html>'), null);
});

test('parseArxivTitle still reads a response truncated before </entry>', () => {
  const full = atomFeed('<title>Attention Is All You Need</title>');
  const truncated = full.slice(0, full.indexOf('<summary>'));
  assert.equal(app.parseArxivTitle(truncated), 'Attention Is All You Need');
});

// ── placeholder helpers ─────────────────────────────────────────────────────
test('arxivTitlePlaceholder / isArxivTitlePlaceholder round-trip and reject real titles', () => {
  assert.equal(app.arxivTitlePlaceholder('2604.28119'), 'arXiv:2604.28119');
  assert.equal(app.isArxivTitlePlaceholder('arXiv:2604.28119'), true);
  assert.equal(app.isArxivTitlePlaceholder('arXiv:2604.28119v2'), true);
  assert.equal(app.isArxivTitlePlaceholder('arxiv: 2604.28119'), true);
  assert.equal(app.isArxivTitlePlaceholder('Attention Is All You Need'), false);
  assert.equal(app.isArxivTitlePlaceholder('arXiv:2604.28119 and beyond'), false);
  assert.equal(app.isArxivTitlePlaceholder(''), false);
  assert.equal(app.isArxivTitlePlaceholder(null), false);
});

// ── fetchArxivTitle (proxy first, then direct) ──────────────────────────────
test('fetchArxivTitle goes through /api/fetch and does not hit export.arxiv.org when the proxy works', async () => {
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch?')) return proxyResponse(atomFeed('<title>Attention Is All You Need</title>'));
    return undefined;
  });
  const title = await app.fetchArxivTitle(ID);
  assert.equal(title, 'Attention Is All You Need');
  assert.deepEqual(app.fetchCalls.map((c) => c.url), [`/api/fetch?url=${encodeURIComponent(API_URL)}`]);
});

test('fetchArxivTitle falls back to a direct export.arxiv.org request when the proxy fails', async () => {
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch?')) return proxyResponse(null, 502);
    if (url === API_URL) return textResponse(atomFeed('<title>Direct Title</title>'));
    return undefined;
  });
  assert.equal(await app.fetchArxivTitle(ID), 'Direct Title');
  assert.deepEqual(app.fetchCalls.map((c) => c.url), [`/api/fetch?url=${encodeURIComponent(API_URL)}`, API_URL]);
});

test('fetchArxivTitle falls through when the proxy returns a body with no usable entry', async () => {
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch?')) return proxyResponse(ERROR_FEED);
    if (url === API_URL) return textResponse(atomFeed('<title>Recovered</title>'));
    return undefined;
  });
  assert.equal(await app.fetchArxivTitle(ID), 'Recovered');
});

test('fetchArxivTitle resolves null (never throws, never a placeholder) when every source fails', async () => {
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch?')) throw new Error('network down');
    if (url === API_URL) throw new Error('CORS');
    return undefined;
  });
  assert.equal(await app.fetchArxivTitle(ID), null);
  assert.equal(app.fetchCalls.length, 2);
});

test('fetchArxivTitle retries the proxy once after a 429 from arXiv', async () => {
  let proxyHits = 0;
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch?')) {
      proxyHits++;
      return proxyHits === 1 ? proxyResponse(null, 429) : proxyResponse(atomFeed('<title>After Backoff</title>'));
    }
    return undefined;
  });
  assert.equal(await app.fetchArxivTitle(ID, undefined, { retryDelayMs: 0 }), 'After Backoff');
  assert.equal(proxyHits, 2);
  assert.ok(!app.fetchCalls.some((c) => c.url === API_URL), 'direct request not needed');
});

test('fetchArxivTitle does not retry non-rate-limit failures and gives up after the second 429', async () => {
  let proxyHits = 0;
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch?')) { proxyHits++; return proxyResponse(null, 502); }
    if (url === API_URL) return textResponse('', 500);
    return undefined;
  });
  assert.equal(await app.fetchArxivTitle(ID, undefined, { retryDelayMs: 0 }), null);
  assert.equal(proxyHits, 1);

  app.clearFetchCalls();
  proxyHits = 0;
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch?')) { proxyHits++; return proxyResponse(null, 429); }
    if (url === API_URL) return textResponse('', 429);
    return undefined;
  });
  assert.equal(await app.fetchArxivTitle(ID, undefined, { retryDelayMs: 0 }), null);
  assert.equal(proxyHits, 2);
  assert.equal(app.fetchCalls.filter((c) => c.url === API_URL).length, 2);
});

test('fetchArxivTitle skips the 429 backoff when the signal is already aborted', async () => {
  const ac = new AbortController();
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch?')) { ac.abort(); return proxyResponse(null, 429); }
    return undefined;
  });
  assert.equal(await app.fetchArxivTitle(ID, ac.signal, { retryDelayMs: 60000 }), null);
  assert.equal(app.fetchCalls.length, 1);
});

test('fetchArxivTitle threads the abort signal into every request', async () => {
  const signal = new AbortController().signal;
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch?')) return proxyResponse(null, 502);
    if (url === API_URL) return textResponse('', 503);
    return undefined;
  });
  assert.equal(await app.fetchArxivTitle(ID, signal), null);
  assert.equal(app.fetchCalls.length, 2);
  for (const c of app.fetchCalls) assert.equal(c.opts.signal, signal);
});

// ── PDF fallbacks ───────────────────────────────────────────────────────────
test('titleFromPdfMetadata accepts a real Title and rejects toolchain leftovers', () => {
  assert.equal(app.titleFromPdfMetadata({ Title: '  Attention   Is All\nYou Need ' }), 'Attention Is All You Need');
  assert.equal(app.titleFromPdfMetadata({ Title: 'main.dvi' }), null);
  assert.equal(app.titleFromPdfMetadata({ Title: 'paper.tex' }), null);
  assert.equal(app.titleFromPdfMetadata({ Title: 'Untitled' }), null);
  assert.equal(app.titleFromPdfMetadata({ Title: 'Microsoft Word - draft' }), null);
  assert.equal(app.titleFromPdfMetadata({ Title: 'arXiv:1706.03762v7 [cs.CL] 2 Aug 2023' }), null);
  assert.equal(app.titleFromPdfMetadata({ Title: '' }), null);
  assert.equal(app.titleFromPdfMetadata({ Title: 'x'.repeat(400) }), null);
  assert.equal(app.titleFromPdfMetadata(null), null);
  assert.equal(app.titleFromPdfMetadata(undefined, undefined), null);
});

test('titleFromPdfMetadata falls back to the XMP dc:title', () => {
  const metadata = { get: (k) => (k === 'dc:title' ? 'Deep Residual Learning for Image Recognition' : null) };
  assert.equal(app.titleFromPdfMetadata({ Title: 'main.dvi' }, metadata), 'Deep Residual Learning for Image Recognition');
  const arr = { get: (k) => (k === 'dc:title' ? ['From an Array'] : null) };
  assert.equal(app.titleFromPdfMetadata({}, arr), 'From an Array');
});

// Synthetic pdf.js text items: transform = [a, b, c, d, x, y]; y grows upward.
function item(str, x, y, size, extra = {}) {
  return {
    str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5, height: size,
    fontName: 'F1', hasEOL: true, ...extra,
  };
}
function rotated(str, x, y, size) {
  return { str, transform: [0, size, -size, 0, x, y], width: str.length * size * 0.5, height: size, fontName: 'F2', hasEOL: true };
}

function firstPage() {
  return [
    rotated('arXiv:1706.03762v7 [cs.CL] 2 Aug 2023', 20, 300, 14),
    item('Published as a conference paper at NeurIPS 2017', 100, 760, 9),
    item('Attention Is All', 180, 700, 20),
    item('You Need', 230, 675, 20),
    item('Ashish Vaswani', 120, 630, 11),
    item('Google Brain', 120, 618, 9),
    item('Abstract', 250, 560, 12),
    ...Array.from({ length: 30 }, (_, i) => item(`Body text line number ${i} of the abstract and intro.`, 80, 540 - i * 12, 10)),
    item('1 Introduction', 80, 150, 14),
  ];
}

test('titleFromPdfTextItems picks the largest-font block near the top and skips the arXiv stamp', () => {
  assert.equal(app.titleFromPdfTextItems(firstPage()), 'Attention Is All You Need');
});

test('titleFromPdfTextItems joins hyphenated wraps and strips footnote markers', () => {
  const items = [
    item('Compute-Optimal Pre-', 150, 700, 20),
    item('training at Scale∗', 180, 675, 20),
    ...Array.from({ length: 20 }, (_, i) => item(`Body text line ${i} is small.`, 80, 600 - i * 12, 10)),
  ];
  assert.equal(app.titleFromPdfTextItems(items), 'Compute-Optimal Pretraining at Scale');
});

test('titleFromPdfTextItems returns null when no heading stands out or the page is empty', () => {
  const uniform = Array.from({ length: 20 }, (_, i) => item(`Line ${i} of a scanned page with one size.`, 80, 700 - i * 12, 10));
  assert.equal(app.titleFromPdfTextItems(uniform), null);
  assert.equal(app.titleFromPdfTextItems([]), null);
  assert.equal(app.titleFromPdfTextItems(null), null);
  // Only the stamp is big → nothing usable.
  const stampOnly = [rotated('arXiv:1706.03762v7 [cs.CL] 2 Aug 2023', 20, 300, 20),
    ...Array.from({ length: 10 }, (_, i) => item(`Body ${i} text here.`, 80, 700 - i * 12, 10))];
  assert.equal(app.titleFromPdfTextItems(stampOnly), null);
});

test('titleFromPdfTextItems ignores a large-font heading in the lower half of the page', () => {
  const items = [
    ...Array.from({ length: 30 }, (_, i) => item(`Body text line number ${i} fills the page.`, 80, 760 - i * 12, 10)),
    item('References And Notes', 80, 100, 20),
  ];
  assert.equal(app.titleFromPdfTextItems(items), null);
});

// numPages 0 keeps renderPDFPages (canvas/viewport) out of the picture; the
// title fallback asks for page 1 directly.
function fakePdfDoc({ info = {}, metadata = null, items = [] } = {}) {
  const calls = { getMetadata: 0, getPage: 0 };
  return {
    calls,
    numPages: 0,
    async getMetadata() { calls.getMetadata++; return { info, metadata }; },
    async getPage() { calls.getPage++; return { async getTextContent() { return { items }; } }; },
  };
}

test('titleFromPdfDoc prefers metadata and falls back to the page-1 heading', async () => {
  const withMeta = fakePdfDoc({ info: { Title: 'Metadata Wins Here' }, items: firstPage() });
  assert.equal(await app.titleFromPdfDoc(withMeta), 'Metadata Wins Here');
  assert.equal(withMeta.calls.getPage, 0);

  const noMeta = fakePdfDoc({ info: { Title: 'main.dvi' }, items: firstPage() });
  assert.equal(await app.titleFromPdfDoc(noMeta), 'Attention Is All You Need');

  const nothing = fakePdfDoc({ info: {}, items: [] });
  assert.equal(await app.titleFromPdfDoc(nothing), null);
  assert.equal(await app.titleFromPdfDoc(null), null);
});

test('titleFromPdfDoc survives a document whose metadata/page calls throw', async () => {
  const broken = { async getMetadata() { throw new Error('no xref'); }, async getPage() { throw new Error('no page'); } };
  assert.equal(await app.titleFromPdfDoc(broken), null);
});

// ── resolveArxivTitle fallback chain ────────────────────────────────────────
test('resolveArxivTitle uses the API title first and never touches the PDF', async () => {
  const pdf = fakePdfDoc({ info: { Title: 'Should Not Be Used' } });
  const title = await app.resolveArxivTitle(ID, { apiTitle: Promise.resolve('  API   Title '), pdf });
  assert.equal(title, 'API Title');
  assert.equal(pdf.calls.getMetadata, 0);
  assert.equal(app.fetchCalls.length, 0);
});

test('resolveArxivTitle falls back to PDF metadata, then the page heading, then null', async () => {
  assert.equal(
    await app.resolveArxivTitle(ID, { apiTitle: Promise.resolve(null), pdf: fakePdfDoc({ info: { Title: 'From Metadata Title' } }) }),
    'From Metadata Title',
  );
  assert.equal(
    await app.resolveArxivTitle(ID, { apiTitle: Promise.resolve(null), pdf: fakePdfDoc({ info: { Title: 'main.dvi' }, items: firstPage() }) }),
    'Attention Is All You Need',
  );
  assert.equal(await app.resolveArxivTitle(ID, { apiTitle: Promise.resolve(null), pdf: fakePdfDoc() }), null);
  assert.equal(await app.resolveArxivTitle(ID, { apiTitle: Promise.resolve(null), pdf: null }), null);
});

test('resolveArxivTitle treats a rejected API lookup or a placeholder answer as a miss', async () => {
  const pdf = fakePdfDoc({ info: { Title: 'Recovered From PDF' } });
  assert.equal(await app.resolveArxivTitle(ID, { apiTitle: Promise.reject(new Error('boom')), pdf }), 'Recovered From PDF');
  assert.equal(await app.resolveArxivTitle(ID, { apiTitle: Promise.resolve(`arXiv:${ID}`), pdf }), 'Recovered From PDF');
});

test('resolveArxivTitle performs the API fetch itself when no lookup is handed in', async () => {
  app.setFetchHandler(async (url) => (url.startsWith('/api/fetch?') ? proxyResponse(atomFeed('<title>Fetched Fresh</title>')) : undefined));
  assert.equal(await app.resolveArxivTitle(ID, { pdf: null }), 'Fetched Fresh');
  assert.equal(app.fetchCalls.length, 1);
});

// ── adoptArxivTitle / maybeRefreshArxivTitle ────────────────────────────────
function openPlaceholderDoc(docId, name = `arXiv:${ID}`) {
  app.state.currentMode = 'pdf';
  app.state.currentDocId = docId;
  app.state.docMeta = { name, mode: 'pdf', badge: 'PDF', url: `https://arxiv.org/abs/${ID}` };
  app.state.discussions = [];
  app.document.getElementById('paper-name').textContent = name;
}

test('adoptArxivTitle updates docMeta, the header, and the saved doc', async () => {
  const docId = `pdf::arxiv:${ID}`;
  openPlaceholderDoc(docId);
  await app.persistCurrentDoc();
  assert.equal(app.loadStore()[docId].name, `arXiv:${ID}`);

  const adopted = await app.adoptArxivTitle(docId, ID, { apiTitle: Promise.resolve('Attention Is All You Need'), pdf: null });
  assert.equal(adopted, 'Attention Is All You Need');
  assert.equal(app.state.docMeta.name, 'Attention Is All You Need');
  assert.equal(app.document.getElementById('paper-name').textContent, 'Attention Is All You Need');
  assert.equal(app.loadStore()[docId].name, 'Attention Is All You Need');
});

test('adoptArxivTitle leaves the placeholder alone when nothing resolves', async () => {
  const docId = `pdf::arxiv:${ID}`;
  openPlaceholderDoc(docId);
  assert.equal(await app.adoptArxivTitle(docId, ID, { apiTitle: Promise.resolve(null), pdf: null }), null);
  assert.equal(app.state.docMeta.name, `arXiv:${ID}`);
});

test('adoptArxivTitle does not touch a different doc the user navigated to meanwhile', async () => {
  openPlaceholderDoc('pdf::arxiv:9999.00001', 'Some Other Paper');
  assert.equal(await app.adoptArxivTitle(`pdf::arxiv:${ID}`, ID, { apiTitle: Promise.resolve('Late Title'), pdf: null }), null);
  assert.equal(app.state.docMeta.name, 'Some Other Paper');
  assert.equal(app.document.getElementById('paper-name').textContent, 'Some Other Paper');
});

test('maybeRefreshArxivTitle retries only for a placeholder-named arXiv PDF doc', async () => {
  app.setFetchHandler(async (url) => (url.startsWith('/api/fetch?') ? proxyResponse(atomFeed('<title>Refreshed Title</title>')) : undefined));
  const docId = `pdf::arxiv:${ID}`;

  openPlaceholderDoc(docId, 'Already A Real Title');
  assert.equal(await app.maybeRefreshArxivTitle(docId), null);
  assert.equal(app.fetchCalls.length, 0);

  openPlaceholderDoc(docId);
  app.state.pdfDoc = null;
  assert.equal(await app.maybeRefreshArxivTitle(docId), 'Refreshed Title');
  assert.equal(app.state.docMeta.name, 'Refreshed Title');
  assert.equal(app.fetchCalls.length, 1);

  // Not the current doc → no-op.
  openPlaceholderDoc('pdf::other');
  assert.equal(await app.maybeRefreshArxivTitle(docId), null);
});

// ── loadArxivPdf end-to-end ─────────────────────────────────────────────────
function withFakePdfjs(doc, fn) {
  const lib = app.sandbox.pdfjsLib;
  const orig = lib.getDocument;
  lib.getDocument = () => ({ promise: Promise.resolve(doc) });
  return Promise.resolve().then(fn).finally(() => { lib.getDocument = orig; });
}

test('loadArxivPdf stores the real title from the arXiv API (via the proxy) on the doc and card', async () => {
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch-pdf?')) return pdfResponse();
    if (url.startsWith('/api/fetch?')) return proxyResponse(atomFeed('<title>Attention Is All\n  You Need</title>'));
    return undefined;
  });
  await withFakePdfjs(fakePdfDoc(), () => app.loadArxivPdf(`https://arxiv.org/abs/${ID}`));

  const docId = `pdf::arxiv:${ID}`;
  assert.equal(app.state.currentDocId, docId);
  assert.equal(app.state.docMeta.name, 'Attention Is All You Need');
  assert.equal(app.document.getElementById('paper-name').textContent, 'Attention Is All You Need');
  assert.equal(app.loadStore()[docId].name, 'Attention Is All You Need');
  assert.equal(app.loadStore()[docId].url, `https://arxiv.org/abs/${ID}`);
  // The PDF still went through its own proxy route.
  assert.ok(app.fetchCalls.some((c) => c.url.startsWith('/api/fetch-pdf?')));
});

test('loadArxivPdf falls back to the PDF itself when the arXiv API is unreachable', async () => {
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch-pdf?')) return pdfResponse();
    if (url.startsWith('/api/fetch?')) throw new Error('proxy down');
    if (url.startsWith('https://export.arxiv.org/')) throw new Error('CORS');
    return undefined;
  });
  const doc = fakePdfDoc({ info: { Title: 'main.dvi' }, items: firstPage() });
  await withFakePdfjs(doc, () => app.loadArxivPdf(`https://arxiv.org/abs/${ID}`));

  const docId = `pdf::arxiv:${ID}`;
  assert.equal(app.state.docMeta.name, 'Attention Is All You Need');
  assert.equal(app.loadStore()[docId].name, 'Attention Is All You Need');
});

test('loadArxivPdf keeps the paper open under the placeholder when every title source fails', async () => {
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch-pdf?')) return pdfResponse();
    if (url.startsWith('/api/fetch?')) return proxyResponse(null, 502);
    if (url.startsWith('https://export.arxiv.org/')) return textResponse('', 503);
    return undefined;
  });
  await withFakePdfjs(fakePdfDoc(), () => app.loadArxivPdf(`https://arxiv.org/abs/${ID}`));

  const docId = `pdf::arxiv:${ID}`;
  assert.equal(app.state.currentDocId, docId);
  assert.equal(app.state.docMeta.name, `arXiv:${ID}`);
  assert.equal(app.loadStore()[docId].name, `arXiv:${ID}`);
  assert.equal(app.document.getElementById('upload-screen').style.display, 'none');
});

test('loadArxivPdf keeps a previously resolved title while a later lookup fails', async () => {
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch-pdf?')) return pdfResponse();
    if (url.startsWith('/api/fetch?')) return proxyResponse(atomFeed('<title>Attention Is All You Need</title>'));
    return undefined;
  });
  await withFakePdfjs(fakePdfDoc(), () => app.loadArxivPdf(`https://arxiv.org/abs/${ID}`));
  const docId = `pdf::arxiv:${ID}`;
  assert.equal(app.loadStore()[docId].name, 'Attention Is All You Need');

  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch-pdf?')) return pdfResponse();
    if (url.startsWith('/api/fetch?')) throw new Error('down');
    if (url.startsWith('https://export.arxiv.org/')) throw new Error('down');
    return undefined;
  });
  await withFakePdfjs(fakePdfDoc(), () => app.loadArxivPdf(`https://arxiv.org/abs/${ID}`, docId));
  assert.equal(app.state.docMeta.name, 'Attention Is All You Need');
  assert.equal(app.loadStore()[docId].name, 'Attention Is All You Need');
});

test('reopening a placeholder-named arXiv doc from the library retries the title lookup', async () => {
  // First open: PDF loads, every title source fails → placeholder persisted.
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch-pdf?')) return pdfResponse();
    if (url.startsWith('/api/fetch?')) throw new Error('down');
    if (url.startsWith('https://export.arxiv.org/')) throw new Error('down');
    return undefined;
  });
  await withFakePdfjs(fakePdfDoc(), () => app.loadArxivPdf(`https://arxiv.org/abs/${ID}`));
  const docId = `pdf::arxiv:${ID}`;
  assert.equal(app.loadStore()[docId].name, `arXiv:${ID}`);

  // Later reopen from the library (stored bytes, no PDF re-download): the
  // arXiv API is reachable now → the card and header pick up the real title.
  app.clearFetchCalls();
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch?')) return proxyResponse(atomFeed('<title>Attention Is All You Need</title>'));
    return undefined;
  });
  await withFakePdfjs(fakePdfDoc(), () => app.reopenDoc(docId));

  assert.equal(app.state.currentDocId, docId);
  assert.equal(app.state.docMeta.name, 'Attention Is All You Need');
  assert.equal(app.document.getElementById('paper-name').textContent, 'Attention Is All You Need');
  assert.equal(app.loadStore()[docId].name, 'Attention Is All You Need');
  assert.ok(!app.fetchCalls.some((c) => c.url.startsWith('/api/fetch-pdf?')), 'reopen should use stored bytes');
});
