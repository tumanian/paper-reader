'use strict';

// Library card text: the paper-level description (arXiv summary / abstract /
// page excerpt) is the card's primary line; the conversation summary appears
// only behind a real exchange and only when it describes the discussion
// rather than replying to it. Also covers where the description comes from:
// the arXiv API entry, the PDF page text, the web page, and the reopen-time
// refresh for docs saved before descriptions existed.

const { test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');
const { jsonResponse } = app;

const ID = '1706.03762';
const API_URL = `https://export.arxiv.org/api/query?id_list=${ID}`;
const ABSTRACT = 'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose a new simple network architecture, the Transformer.';

before(async () => { await app.ready; });
beforeEach(async () => {
  app.reset();
  app.setFetchHandler(null);
  for (const id of Object.keys(app.PaperStore.getStore())) await app.PaperStore.deleteDoc(id);
});
afterEach(() => { app.setFetchHandler(null); });

function atomFeed({ title = 'Attention Is All You Need', summary = ABSTRACT } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query: search_query=&amp;id_list=${ID}</title>
  <entry>
    <id>http://arxiv.org/abs/${ID}v7</id>
    ${title == null ? '' : `<title>${title}</title>`}
    ${summary == null ? '' : `<summary>  ${summary.replace(/\. /g, '.\n  ')}\n</summary>`}
    <author><name>Ashish Vaswani</name></author>
  </entry>
</feed>`;
}

function proxyResponse(xml, status = 200) {
  return jsonResponse(status === 200 ? { html: xml } : { error: `Upstream HTTP ${status}` }, status);
}

function pdfResponse() {
  return {
    ok: true, status: 200, headers: { get() { return 'application/pdf'; } }, url: '',
    async arrayBuffer() { return new ArrayBuffer(16); },
    async json() { return {}; },
    async text() { return ''; },
  };
}

// A pdf.js document stub. `pages` is a list of page texts; each becomes one
// text item so renderPDFPages produces real paperText. Empty → numPages 0.
function fakePdfDoc(pages = []) {
  return {
    numPages: pages.length,
    async getMetadata() { return { info: {}, metadata: null }; },
    async getPage(i) {
      const text = pages[i - 1] || '';
      return {
        getViewport() { return { width: 600, height: 800, scale: 1.5 }; },
        render() { return { promise: Promise.resolve() }; },
        async getTextContent() {
          const items = text.split('\n').map((str, k) => ({
            str, transform: [10, 0, 0, 10, 50, 780 - k * 12], width: str.length * 5, height: 10, fontName: 'F1', hasEOL: true,
          }));
          return { items };
        },
      };
    },
  };
}

function withFakePdfjs(doc, fn) {
  const lib = app.sandbox.pdfjsLib;
  const orig = lib.getDocument;
  lib.getDocument = () => ({ promise: Promise.resolve(doc) });
  return Promise.resolve().then(fn).finally(() => { lib.getDocument = orig; });
}

const exchange = (q = 'Why scale by sqrt(d_k)?', a = 'Because large dot products push softmax into saturated regions.') =>
  [{ role: 'user', content: q }, { role: 'assistant', content: a }];

function doc(over = {}) {
  return {
    id: 'pdf::arxiv:1706.03762', name: 'Attention Is All You Need', mode: 'pdf', badge: 'PDF',
    url: 'https://arxiv.org/abs/1706.03762', updated: Date.now(),
    description: null, conversationSummary: null, summaryMessageCount: 0,
    discussions: [],
    ...over,
  };
}

// ── cleanDescription ────────────────────────────────────────────────────────
test('cleanDescription collapses whitespace, joins hyphenated line wraps, and drops empties', () => {
  assert.equal(app.cleanDescription('  We   study\n  trans-\nformer\tmodels. '), 'We study transformer models.');
  assert.equal(app.cleanDescription('soft\u00adhyphen'), 'softhyphen');
  assert.equal(app.cleanDescription('state-of-the-art'), 'state-of-the-art');
  assert.equal(app.cleanDescription(''), null);
  assert.equal(app.cleanDescription('   '), null);
  assert.equal(app.cleanDescription(null), null);
  assert.equal(app.cleanDescription(undefined), null);
});

test('cleanDescription caps long text on a sentence boundary, else on a word with an ellipsis', () => {
  const sentences = 'First sentence is here. Second sentence follows. Third sentence ends it.';
  assert.equal(app.cleanDescription(sentences, 50), 'First sentence is here. Second sentence follows.');
  const noBreaks = 'word '.repeat(40).trim();
  const capped = app.cleanDescription(noBreaks, 50);
  assert.ok(capped.endsWith('…'));
  assert.ok(capped.length <= 51);
  assert.equal(app.cleanDescription('short one.', 50), 'short one.');
});

// ── abstractFromText ────────────────────────────────────────────────────────
test('abstractFromText lifts the abstract between the heading and the introduction', () => {
  const text = `[Page 1]
Attention Is All You Need
Ashish Vaswani
Abstract
The dominant sequence transduction models are based on complex recurrent or
convolutional neural networks. We propose a new simple network architecture, the
Transformer.
1 Introduction
Recurrent neural networks, long short-term memory...`;
  assert.equal(app.abstractFromText(text), ABSTRACT);
});

test('abstractFromText handles "Abstract." / "Abstract—" prefix styles and stops at keyword lists', () => {
  const ieee = `Title\nAbstract—We introduce a method for X that beats the prior state of the art by a wide margin.\nIndex Terms—graphs, learning\nI. INTRODUCTION\nBody`;
  assert.equal(app.abstractFromText(ieee), 'We introduce a method for X that beats the prior state of the art by a wide margin.');
  const dotted = `ABSTRACT. Neural nets are trained on lots of data and this abstract is long enough to count.\nKeywords: nets\n`;
  assert.equal(app.abstractFromText(dotted), 'Neural nets are trained on lots of data and this abstract is long enough to count.');
  const paged = `Abstract\nWe study something interesting and the abstract keeps going for a while here.\n\n[Page 2]\nMore body text.`;
  assert.equal(app.abstractFromText(paged), 'We study something interesting and the abstract keeps going for a while here.');
});

test('abstractFromText stops at a numbered section heading other than the introduction', () => {
  const text = `Abstract\nWe propose a compact model for retrieval that is fast to train and easy to deploy.\n2 Background and Related Work\nPrior work...`;
  assert.equal(app.abstractFromText(text), 'We propose a compact model for retrieval that is fast to train and easy to deploy.');
});

test('abstractFromText returns null without a real abstract heading', () => {
  assert.equal(app.abstractFromText('Abstract PDF Cite\nSome navigation strip text that is long enough to be a paragraph.'), null);
  assert.equal(app.abstractFromText('An abstract representation of the problem is given in the body of the paper here.'), null);
  assert.equal(app.abstractFromText('Abstraction\nof layers is discussed at length in this section of the text.'), null);
  assert.equal(app.abstractFromText('Abstract\nToo short.\n1 Introduction'), null);
  assert.equal(app.abstractFromText(''), null);
  assert.equal(app.abstractFromText(null), null);
});

test('abstractFromText caps a run-on abstract that has no closing heading', () => {
  const text = 'Abstract\n' + 'This sentence is part of a very long abstract. '.repeat(60);
  const a = app.abstractFromText(text);
  assert.ok(a.length <= 500, `${a.length} chars`);
  assert.ok(a.endsWith('.'), a);
});

// ── looksLikeChatReply ──────────────────────────────────────────────────────
test('looksLikeChatReply flags summaries that reply to the transcript instead of describing it', () => {
  for (const s of [
    'I don\'t have additional context beyond "s on DIN" to work with.',
    'It looks like your message got cut off. Could you share the rest?',
    'I\'m sorry, but I need more context to help with that.',
    'Unfortunately the selection is too short to say anything meaningful.',
    'Could you clarify what you mean by "attention"?',
    'Sure! Here\'s an explanation of scaled dot-product attention.',
    'Your message seems incomplete — please paste the full passage.',
    'There is no additional context in the passage you highlighted.',
    'What would you like to know about this section?',
  ]) assert.equal(app.looksLikeChatReply(s), true, s);
});

test('looksLikeChatReply passes real discussion descriptions, including titles containing "you"', () => {
  for (const s of [
    'Explored how multi-head attention scales with sequence length and why the authors use scaled dot-product attention.',
    'The researcher asked why "Attention Is All You Need" drops recurrence and what positional encodings replace it with.',
    'Discussion of the beam search settings and label smoothing used in the main results table.',
    'Clarified the notation in Eq. 3 and how the residual stream is normalised.',
  ]) assert.equal(app.looksLikeChatReply(s), false, s);
  assert.equal(app.looksLikeChatReply(''), false);
  assert.equal(app.looksLikeChatReply(null), false);
});

// ── hasSubstantiveDiscussion / libraryCardText ──────────────────────────────
test('hasSubstantiveDiscussion needs a visible user + assistant pair in one discussion', () => {
  assert.equal(app.hasSubstantiveDiscussion(doc()), false);
  assert.equal(app.hasSubstantiveDiscussion(doc({ discussions: [{ id: 1, txt: 'hl', messages: [] }] })), false);
  assert.equal(app.hasSubstantiveDiscussion(doc({ discussions: [{ id: 1, txt: 'hl', messages: [{ role: 'user', content: 'why?' }] }] })), false);
  assert.equal(app.hasSubstantiveDiscussion(doc({ discussions: [{ id: 1, txt: 'hl', messages: [
    { role: 'user', content: 'ctx', hidden: true }, { role: 'assistant', content: 'a' },
  ] }] })), false);
  assert.equal(app.hasSubstantiveDiscussion(doc({ discussions: [{ id: 1, txt: 'hl', messages: [
    { role: 'user', content: '   ' }, { role: 'assistant', content: 'a' },
  ] }] })), false);
  assert.equal(app.hasSubstantiveDiscussion(doc({ discussions: [
    { id: 1, txt: 'hl', messages: [{ role: 'user', content: 'q' }] },
    { id: 2, txt: 'hl2', messages: [{ role: 'assistant', content: 'a' }] },
  ] })), false, 'pair must be in the same discussion');
  assert.equal(app.hasSubstantiveDiscussion(doc({ discussions: [{ id: 1, txt: 'hl', messages: exchange() }] })), true);
  assert.equal(app.hasSubstantiveDiscussion(null), false);
  assert.equal(app.hasSubstantiveDiscussion({ discussions: [{ messages: null }, null] }), false);
});

test('libraryCardText prefers the paper description and adds the discussion only behind a real exchange', () => {
  const summary = 'Explored why attention scores are scaled by the key dimension.';
  assert.deepEqual(app.plain(app.libraryCardText(doc({ description: ABSTRACT }))), { description: ABSTRACT, discussion: null });
  // A summary with no exchange behind it (stale, or seeded) is not shown.
  assert.deepEqual(app.plain(app.libraryCardText(doc({ description: ABSTRACT, conversationSummary: summary }))),
    { description: ABSTRACT, discussion: null });
  assert.deepEqual(
    app.plain(app.libraryCardText(doc({ description: ABSTRACT, conversationSummary: summary, discussions: [{ id: 1, txt: 'hl', messages: exchange() }] }))),
    { description: ABSTRACT, discussion: summary });
  // No description yet: the discussion line stands alone.
  assert.deepEqual(
    app.plain(app.libraryCardText(doc({ conversationSummary: summary, discussions: [{ id: 1, txt: 'hl', messages: exchange() }] }))),
    { description: null, discussion: summary });
  assert.deepEqual(app.plain(app.libraryCardText(doc())), { description: null, discussion: null });
  assert.deepEqual(app.plain(app.libraryCardText({ id: 'x', name: 'legacy doc without the new fields' })), { description: null, discussion: null });
});

test('libraryCardText suppresses a summary that is really the tail of a chat reply', () => {
  const bad = 'I don\'t have additional context beyond "s on DIN" to work with.';
  const withChat = doc({ description: ABSTRACT, conversationSummary: bad, discussions: [{ id: 1, txt: 'hl', messages: exchange() }] });
  assert.deepEqual(app.plain(app.libraryCardText(withChat)), { description: ABSTRACT, discussion: null });
  const cutOff = doc({ conversationSummary: 'It looks like your message got cut off…', discussions: [{ id: 1, txt: 'hl', messages: exchange() }] });
  assert.deepEqual(app.plain(app.libraryCardText(cutOff)), { description: null, discussion: null });
});

test('libraryCardText normalises whitespace and length of both lines', () => {
  const d = doc({
    description: '  Line one\n   line two  ',
    conversationSummary: 'x'.repeat(2000),
    discussions: [{ id: 1, txt: 'hl', messages: exchange() }],
  });
  const t = app.libraryCardText(d);
  assert.equal(t.description, 'Line one line two');
  assert.ok(t.discussion.length < 600);
});

// ── renderLibrary ───────────────────────────────────────────────────────────
// Saved-doc cards only (they carry a delete button); the logged-out "featured
// example" invitation card names the same Transformer paper. The DOM stub's
// `innerHTML = ''` doesn't drop children, so clear them before each render.
function cardFor(name) {
  const cards = app.document.getElementById('lib-cards').children;
  return cards.find((c) => c.innerHTML.includes('lib-del') && c.innerHTML.includes(name));
}
function renderCards() {
  app.document.getElementById('lib-cards').children.length = 0;
  app.renderLibrary();
}

test('renderLibrary shows the paper description, not a chat-reply summary', async () => {
  await app.PaperStore.saveDoc(doc({
    description: ABSTRACT,
    conversationSummary: 'It looks like your message got cut off. Could you share the rest?',
    discussions: [{ id: 1, txt: 'hl', mode: 'pdf', pageNum: 1, color: { bg: 'b', dot: 'd' }, relRects: [], messages: exchange() }],
  }));
  renderCards();
  const card = cardFor('Attention Is All You Need');
  assert.ok(card, 'card rendered');
  assert.ok(card.innerHTML.includes(ABSTRACT));
  assert.ok(!card.innerHTML.includes('cut off'));
  assert.ok(!card.innerHTML.includes('lib-discussed'));
});

test('renderLibrary adds the discussion line under the description when the summary is real', async () => {
  const summary = 'Explored why attention scores are scaled by the key dimension.';
  await app.PaperStore.saveDoc(doc({
    description: ABSTRACT, conversationSummary: summary,
    discussions: [{ id: 1, txt: 'hl', mode: 'pdf', pageNum: 1, color: { bg: 'b', dot: 'd' }, relRects: [], messages: exchange() }],
  }));
  renderCards();
  const html = cardFor('Attention Is All You Need').innerHTML;
  assert.ok(html.indexOf(ABSTRACT) < html.indexOf(summary), 'description first');
  assert.ok(html.includes('lib-discussed'));
});

test('renderLibrary omits both lines for a doc with neither, and escapes what it shows', async () => {
  await app.PaperStore.saveDoc(doc({ id: 'pdf::x', name: 'Plain Doc' }));
  await app.PaperStore.saveDoc(doc({ id: 'pdf::y', name: 'Angle Doc', description: 'Uses <b>bold</b> & "quotes" in the abstract text here.' }));
  renderCards();
  assert.ok(!cardFor('Plain Doc').innerHTML.includes('lib-summary'));
  const html = cardFor('Angle Doc').innerHTML;
  assert.ok(html.includes('&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quotes&quot;'));
  assert.ok(!html.includes('<b>bold</b>'));
});

// ── parseArxivEntry / fetchArxivEntry ───────────────────────────────────────
test('parseArxivEntry returns the title and the single-line summary', () => {
  assert.deepEqual(app.plain(app.parseArxivEntry(atomFeed())), { title: 'Attention Is All You Need', summary: ABSTRACT });
});

test('parseArxivEntry decodes entities in the summary and tolerates a missing field', () => {
  const xml = atomFeed({ summary: 'We study P &amp; NP with &#8220;quotes&#8221; and show that this summary is long.' });
  assert.equal(app.parseArxivEntry(xml).summary, 'We study P & NP with “quotes” and show that this summary is long.');
  assert.deepEqual(app.plain(app.parseArxivEntry(atomFeed({ summary: null }))), { title: 'Attention Is All You Need', summary: null });
  assert.deepEqual(app.plain(app.parseArxivEntry(atomFeed({ title: null }))), { title: null, summary: ABSTRACT });
  assert.equal(app.parseArxivEntry('<feed><title>ArXiv Query</title></feed>'), null);
  assert.equal(app.parseArxivEntry(null), null);
});

test('parseArxivEntry returns null for an arXiv error entry', () => {
  const err = `<feed><entry><id>http://arxiv.org/api/errors#incorrect_id</id><title>Error</title><summary>incorrect id format</summary></entry></feed>`;
  assert.equal(app.parseArxivEntry(err), null);
});

test('parseArxivTitle still agrees with parseArxivEntry', () => {
  assert.equal(app.parseArxivTitle(atomFeed()), 'Attention Is All You Need');
  assert.equal(app.parseArxivTitle(atomFeed({ title: null })), null);
});

test('fetchArxivEntry resolves the entry through the proxy and null when every source fails', async () => {
  app.setFetchHandler(async (url) => (url.startsWith('/api/fetch?') ? proxyResponse(atomFeed()) : undefined));
  assert.deepEqual(app.plain(await app.fetchArxivEntry(ID)), { title: 'Attention Is All You Need', summary: ABSTRACT });
  assert.deepEqual(app.fetchCalls.map((c) => c.url), [`/api/fetch?url=${encodeURIComponent(API_URL)}`]);

  app.clearFetchCalls();
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch?')) throw new Error('down');
    if (url === API_URL) throw new Error('CORS');
    return undefined;
  });
  assert.equal(await app.fetchArxivEntry(ID), null);
  assert.equal(await app.fetchArxivTitle(ID), null);
});

// ── adoptPaperDescription / adoptArxivMeta ──────────────────────────────────
function openDoc(docId, { name = 'Attention Is All You Need', description = null, mode = 'pdf', url = `https://arxiv.org/abs/${ID}` } = {}) {
  app.state.currentMode = mode;
  app.state.currentDocId = docId;
  app.state.docMeta = { name, mode, badge: mode === 'pdf' ? 'PDF' : 'Web', url, description };
  app.state.discussions = [];
  app.document.getElementById('paper-name').textContent = name;
}

test('adoptPaperDescription sets the open doc\'s description once and ignores other docs', () => {
  const docId = `pdf::arxiv:${ID}`;
  openDoc(docId);
  assert.equal(app.adoptPaperDescription(docId, `  ${ABSTRACT}  `), true);
  assert.equal(app.state.docMeta.description, ABSTRACT);
  assert.equal(app.adoptPaperDescription(docId, ABSTRACT), false, 'no change → false');
  assert.equal(app.adoptPaperDescription(docId, ''), false);
  assert.equal(app.adoptPaperDescription(docId, null), false);
  assert.equal(app.adoptPaperDescription('pdf::other', 'Another blurb long enough to count as a description.'), false);
  assert.equal(app.state.docMeta.description, ABSTRACT);
});

test('adoptArxivMeta stores the API summary as the description alongside the title', async () => {
  const docId = `pdf::arxiv:${ID}`;
  openDoc(docId, { name: `arXiv:${ID}` });
  const title = await app.adoptArxivMeta(docId, ID, { apiEntry: Promise.resolve({ title: 'Attention Is All You Need', summary: ABSTRACT }), pdf: null });
  assert.equal(title, 'Attention Is All You Need');
  assert.equal(app.state.docMeta.name, 'Attention Is All You Need');
  assert.equal(app.state.docMeta.description, ABSTRACT);
  assert.equal(app.loadStore()[docId].description, ABSTRACT);
  assert.equal(app.loadStore()[docId].name, 'Attention Is All You Need');
});

test('adoptArxivMeta persists a new description even when the title is unchanged', async () => {
  const docId = `pdf::arxiv:${ID}`;
  openDoc(docId);
  await app.persistCurrentDoc();
  assert.equal(app.loadStore()[docId].description, null);
  const title = await app.adoptArxivMeta(docId, ID, { apiEntry: Promise.resolve({ title: 'Attention Is All You Need', summary: ABSTRACT }), pdf: null });
  assert.equal(title, null, 'name did not change');
  assert.equal(app.loadStore()[docId].description, ABSTRACT);
});

test('adoptArxivMeta falls back to the abstract in the page text when the API has no summary', async () => {
  const docId = `pdf::arxiv:${ID}`;
  openDoc(docId, { name: `arXiv:${ID}` });
  app.state.paperText = `[Page 1]\nAttention Is All You Need\nAbstract\n${ABSTRACT}\n1 Introduction\nBody`;
  await app.adoptArxivMeta(docId, ID, { apiEntry: Promise.reject(new Error('down')), pdf: null });
  assert.equal(app.state.docMeta.name, `arXiv:${ID}`, 'no title source → placeholder kept');
  assert.equal(app.state.docMeta.description, ABSTRACT);
  assert.equal(app.loadStore()[docId].description, ABSTRACT);
});

test('adoptArxivMeta leaves a doc the user navigated away from untouched', async () => {
  openDoc('pdf::arxiv:9999.00001', { name: 'Some Other Paper', url: 'https://arxiv.org/abs/9999.00001' });
  const r = await app.adoptArxivMeta(`pdf::arxiv:${ID}`, ID, { apiEntry: Promise.resolve({ title: 'Late', summary: ABSTRACT }), pdf: null });
  assert.equal(r, null);
  assert.equal(app.state.docMeta.name, 'Some Other Paper');
  assert.equal(app.state.docMeta.description, null);
});

// ── maybeRefreshArxivMeta (reopen) ──────────────────────────────────────────
test('maybeRefreshArxivMeta fetches only the description for a doc with a real title but no blurb', async () => {
  app.setFetchHandler(async (url) => (url.startsWith('/api/fetch?') ? proxyResponse(atomFeed({ title: 'A Different API Title' })) : undefined));
  const docId = `pdf::arxiv:${ID}`;
  openDoc(docId);
  assert.equal(await app.maybeRefreshArxivMeta(docId), null);
  assert.equal(app.fetchCalls.length, 1);
  assert.equal(app.state.docMeta.name, 'Attention Is All You Need', 'a real title is never replaced');
  assert.equal(app.state.docMeta.description, ABSTRACT);
  assert.equal(app.loadStore()[docId].description, ABSTRACT);
});

test('maybeRefreshArxivMeta is a no-op when the card already has everything', async () => {
  app.setFetchHandler(async (url) => (url.startsWith('/api/fetch?') ? proxyResponse(atomFeed()) : undefined));
  const docId = `pdf::arxiv:${ID}`;
  openDoc(docId, { description: ABSTRACT });
  assert.equal(await app.maybeRefreshArxivMeta(docId), null);
  assert.equal(app.fetchCalls.length, 0);
  // Not the current doc / not an arXiv doc → nothing.
  openDoc('pdf::other', { url: null });
  assert.equal(await app.maybeRefreshArxivMeta(docId), null);
  assert.equal(await app.maybeRefreshArxivMeta('pdf::other'), null);
  assert.equal(app.fetchCalls.length, 0);
});

test('maybeRefreshArxivMeta still resolves a placeholder title (and the blurb) in one round-trip', async () => {
  app.setFetchHandler(async (url) => (url.startsWith('/api/fetch?') ? proxyResponse(atomFeed()) : undefined));
  const docId = `pdf::arxiv:${ID}`;
  openDoc(docId, { name: `arXiv:${ID}` });
  app.state.pdfDoc = null;
  assert.equal(await app.maybeRefreshArxivMeta(docId), 'Attention Is All You Need');
  assert.equal(app.fetchCalls.length, 1);
  assert.equal(app.state.docMeta.description, ABSTRACT);
  assert.equal(app.loadStore()[docId].description, ABSTRACT);
});

test('maybeRefreshArxivMeta uses the page text when the API is down, and retries next time otherwise', async () => {
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch?')) throw new Error('down');
    if (url === API_URL) throw new Error('CORS');
    return undefined;
  });
  const docId = `pdf::arxiv:${ID}`;
  openDoc(docId);
  assert.equal(await app.maybeRefreshArxivMeta(docId), null);
  assert.equal(app.state.docMeta.description, null, 'nothing to derive from yet');

  app.state.paperText = `Abstract\n${ABSTRACT}\n1 Introduction\nBody`;
  assert.equal(await app.maybeRefreshArxivMeta(docId), null);
  assert.equal(app.state.docMeta.description, ABSTRACT);
});

// ── loaders end-to-end ──────────────────────────────────────────────────────
test('loadArxivPdf saves the arXiv summary as the doc description', async () => {
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch-pdf?')) return pdfResponse();
    if (url.startsWith('/api/fetch?')) return proxyResponse(atomFeed());
    return undefined;
  });
  await withFakePdfjs(fakePdfDoc(), () => app.loadArxivPdf(`https://arxiv.org/abs/${ID}`));
  const docId = `pdf::arxiv:${ID}`;
  const saved = app.loadStore()[docId];
  assert.equal(saved.name, 'Attention Is All You Need');
  assert.equal(saved.description, ABSTRACT);
  assert.equal(app.state.docMeta.description, ABSTRACT);
  renderCards();
  assert.ok(cardFor('Attention Is All You Need').innerHTML.includes(ABSTRACT));
});

test('loadArxivPdf falls back to the abstract on page 1 when the arXiv API is unreachable', async () => {
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch-pdf?')) return pdfResponse();
    if (url.startsWith('/api/fetch?')) throw new Error('proxy down');
    if (url.startsWith('https://export.arxiv.org/')) throw new Error('CORS');
    return undefined;
  });
  const pdf = fakePdfDoc([`Attention Is All You Need\nAbstract\n${ABSTRACT}\n1 Introduction\nRecurrent neural networks...`]);
  await withFakePdfjs(pdf, () => app.loadArxivPdf(`https://arxiv.org/abs/${ID}`));
  assert.equal(app.loadStore()[`pdf::arxiv:${ID}`].description, ABSTRACT);
});

test('loadArxivPdf keeps a saved description when a later lookup fails', async () => {
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch-pdf?')) return pdfResponse();
    if (url.startsWith('/api/fetch?')) return proxyResponse(atomFeed());
    return undefined;
  });
  await withFakePdfjs(fakePdfDoc(), () => app.loadArxivPdf(`https://arxiv.org/abs/${ID}`));
  const docId = `pdf::arxiv:${ID}`;
  app.setFetchHandler(async (url) => {
    if (url.startsWith('/api/fetch-pdf?')) return pdfResponse();
    if (url.startsWith('/api/fetch?')) throw new Error('down');
    if (url.startsWith('https://export.arxiv.org/')) throw new Error('down');
    return undefined;
  });
  await withFakePdfjs(fakePdfDoc(), () => app.loadArxivPdf(`https://arxiv.org/abs/${ID}`, docId));
  assert.equal(app.state.docMeta.description, ABSTRACT);
  assert.equal(app.loadStore()[docId].description, ABSTRACT);
});

test('an uploaded PDF gets its description from the abstract on page 1', async () => {
  const file = { name: 'my-paper.pdf', size: 1234, async arrayBuffer() { return new ArrayBuffer(16); } };
  const pdf = fakePdfDoc([`My Paper Title\nAbstract\n${ABSTRACT}\n1 Introduction\nBody text`]);
  await withFakePdfjs(pdf, () => app.loadPDF(file));
  const saved = app.loadStore()['pdf::my-paper:1234'];
  assert.equal(saved.name, 'my-paper');
  assert.equal(saved.description, ABSTRACT);
});

test('reopenDoc restores the saved description into docMeta and refreshes a missing one', async () => {
  const docId = `pdf::arxiv:${ID}`;
  await app.PaperStore.saveDoc(doc({ id: docId, description: ABSTRACT }));
  await app.PaperStore.putPdf(docId, { size: 16, type: 'application/pdf', async arrayBuffer() { return new ArrayBuffer(16); } });
  app.setFetchHandler(async (url) => (url.startsWith('/api/fetch?') ? proxyResponse(atomFeed()) : undefined));
  await withFakePdfjs(fakePdfDoc(), () => app.reopenDoc(docId));
  assert.equal(app.state.docMeta.description, ABSTRACT);
  assert.equal(app.fetchCalls.filter((c) => c.url.startsWith('/api/fetch?')).length, 0, 'nothing to refresh');

  // Same doc saved before descriptions existed: reopen fills it in.
  await app.PaperStore.saveDoc(doc({ id: docId }));
  app.clearFetchCalls();
  await withFakePdfjs(fakePdfDoc(), () => app.reopenDoc(docId));
  assert.equal(app.fetchCalls.filter((c) => c.url.startsWith('/api/fetch?')).length, 1);
  assert.equal(app.state.docMeta.description, ABSTRACT);
  assert.equal(app.loadStore()[docId].description, ABSTRACT);
  assert.equal(app.loadStore()[docId].name, 'Attention Is All You Need');
});

test('persistCurrentDoc writes the description and tolerates docMeta without one', async () => {
  const docId = 'pdf::x';
  openDoc(docId, { name: 'X', url: null, description: ABSTRACT });
  await app.persistCurrentDoc();
  assert.equal(app.loadStore()[docId].description, ABSTRACT);
  app.state.docMeta = { name: 'X', mode: 'pdf', badge: 'PDF', url: null };
  await app.persistCurrentDoc();
  assert.equal(app.loadStore()[docId].description, null);
});

// ── descriptionFromWebDoc ───────────────────────────────────────────────────
function fakeWebDoc(metas = {}) {
  return {
    querySelector(sel) {
      for (const [k, v] of Object.entries(metas)) {
        if (sel.includes(k)) return { getAttribute: (a) => (a === 'content' ? v : null) };
      }
      return null;
    },
  };
}

test('descriptionFromWebDoc prefers an abstract meta tag, then the text abstract, then the excerpt', () => {
  const abstractMeta = 'We present a publisher-provided abstract that is long enough to be used as a description.';
  const text = `Title\n\nAbstract\n${ABSTRACT}\n\nIntroduction\nBody`;
  assert.equal(app.descriptionFromWebDoc(fakeWebDoc({ citation_abstract: abstractMeta }), { excerpt: 'An excerpt long enough to count as a description.', text }), abstractMeta);
  assert.equal(app.descriptionFromWebDoc(fakeWebDoc(), { excerpt: 'An excerpt long enough to count as a description.', text }), ABSTRACT);
  assert.equal(app.descriptionFromWebDoc(fakeWebDoc(), { excerpt: 'An excerpt long enough to count as a description.', text: 'no abstract here' }),
    'An excerpt long enough to count as a description.');
  assert.equal(app.descriptionFromWebDoc(fakeWebDoc({ 'og:description': 'Shared on social with a long enough description here.' }), { excerpt: 'short', text: '' }),
    'Shared on social with a long enough description here.');
});

test('descriptionFromWebDoc returns null when nothing usable exists and never throws on a bare doc', () => {
  assert.equal(app.descriptionFromWebDoc(fakeWebDoc(), { excerpt: '', text: '' }), null);
  assert.equal(app.descriptionFromWebDoc(fakeWebDoc({ description: 'Too short.' }), { excerpt: 'tiny', text: '' }), null);
  assert.equal(app.descriptionFromWebDoc(null, {}), null);
  assert.equal(app.descriptionFromWebDoc({}, {}), null);
});

// ── summary pipeline ────────────────────────────────────────────────────────
test('maybeUpdateSummary keeps the previous summary when the model replies to the transcript instead', async () => {
  const docId = `pdf::arxiv:${ID}`;
  openDoc(docId);
  app.state.discussions = [{ id: 1, txt: 'highlight', mode: 'pdf', pageNum: 1, color: { bg: 'b', dot: 'd' }, relRects: [], messages: exchange() }];
  app.state.conversationSummary = 'Explored the scaling factor in dot-product attention.';
  app.state.summaryMessageCount = 0;

  const bodies = [];
  app.setFetchHandler(async (url, opts) => {
    if (url === '/api/chat') {
      bodies.push(JSON.parse(opts.body));
      return jsonResponse({ summary: 'It looks like your message got cut off. Could you share the rest?' });
    }
    return undefined;
  });
  assert.equal(await app.maybeUpdateSummary(true), true);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].task, 'summarize');
  assert.equal(app.state.conversationSummary, 'Explored the scaling factor in dot-product attention.');
  assert.equal(app.state.summaryMessageCount, 2, 'messages counted as covered — no retry storm');
  assert.equal(app.loadStore()[docId].conversationSummary, 'Explored the scaling factor in dot-product attention.');

  // A real description of the discussion is adopted as before.
  app.state.discussions[0].messages.push(...exchange('And the residual?', 'It carries the input forward.'));
  app.setFetchHandler(async (url) => (url === '/api/chat' ? jsonResponse({ summary: 'Covered attention scaling and residual connections.' }) : undefined));
  assert.equal(await app.maybeUpdateSummary(true), true);
  assert.equal(app.state.conversationSummary, 'Covered attention scaling and residual connections.');
  assert.equal(app.state.summaryMessageCount, 4);
});
