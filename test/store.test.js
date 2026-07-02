'use strict';

// Functional tests for the storage layer (store.js / window.PaperStore) running
// in LOCAL mode (no Supabase configured — /api/config returns nulls). Exercises
// the real localStorage + IndexedDB code paths via the in-memory stubs, pinning
// the storage model: doc save/load, PDF bytes round-trip, read-later, figures.

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');
const { PaperStore, plain } = app;

// Signed-out sessions persist under the fixed 'local' namespace (v2 keys are
// namespaced per Supabase user id when signed in).
const STORE_KEY = 'paperReader.docs.v2.local';

before(async () => { await app.ready; });

beforeEach(async () => {
  app.localStorage.clear();
  await PaperStore.init();          // re-read (now empty) local state, stay local-only
});

function sampleDoc(id = 'web::a') {
  return {
    id, name: 'Sample', mode: 'web', badge: 'Web', url: 'http://a',
    updated: 1000, conversationSummary: null, summaryMessageCount: 0,
    discussions: [
      { id: 1, txt: 'highlight one', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] },
    ],
  };
}

test('local mode: not using cloud', () => {
  assert.equal(PaperStore.isCloud(), false);
});

test('saveDoc → getStore round-trips the document', async () => {
  await PaperStore.saveDoc(sampleDoc());
  const store = PaperStore.getStore();
  assert.deepEqual(Object.keys(store), ['web::a']);
  assert.equal(store['web::a'].name, 'Sample');
  assert.deepEqual(plain(store['web::a'].discussions[0].messages), [
    { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' },
  ]);
});

test('saveDoc mirrors to localStorage under the namespaced v2 key', async () => {
  await PaperStore.saveDoc(sampleDoc());
  const raw = JSON.parse(app.localStorage.getItem(STORE_KEY));
  assert.ok(raw['web::a']);
  assert.equal(raw['web::a'].discussions[0].txt, 'highlight one');
});

test('a fresh init() reloads saved docs from localStorage', async () => {
  await PaperStore.saveDoc(sampleDoc());
  await PaperStore.init();                 // simulate a reload
  assert.ok(PaperStore.getStore()['web::a']);
});

test('deleteDoc removes the document', async () => {
  await PaperStore.saveDoc(sampleDoc());
  await PaperStore.deleteDoc('web::a');
  assert.equal(PaperStore.getStore()['web::a'], undefined);
});

test('clearLibrary empties the store', async () => {
  await PaperStore.saveDoc(sampleDoc('web::a'));
  await PaperStore.saveDoc(sampleDoc('web::b'));
  await PaperStore.clearLibrary();
  assert.deepEqual(plain(PaperStore.getStore()), {});
});

// ── PDF bytes round-trip through IndexedDB (the reopen-from-IDB path) ─────────
test('putPdf → getPdf restores the stored blob from IndexedDB', async () => {
  const blob = { size: 1234, type: 'application/pdf' };
  await PaperStore.putPdf('web::a', blob);
  const got = await PaperStore.getPdf('web::a');
  assert.ok(got);
  assert.equal(got.size, 1234);
});

test('getPdf returns null when nothing was stored', async () => {
  const got = await PaperStore.getPdf('web::missing');
  assert.equal(got, null);
});

// ── Read later ───────────────────────────────────────────────────────────────
test('addReadLater / getReadLater / removeReadLater', async () => {
  const added = await PaperStore.addReadLater({ id: 'rl::1', title: 'Later', url: 'http://later' });
  assert.equal(added, true);
  assert.equal(PaperStore.getReadLater().length, 1);

  // duplicate id is rejected
  const again = await PaperStore.addReadLater({ id: 'rl::1', title: 'dup' });
  assert.equal(again, false);
  assert.equal(PaperStore.getReadLater().length, 1);

  await PaperStore.removeReadLater('rl::1');
  assert.equal(PaperStore.getReadLater().length, 0);
});

test('read later mirrors to localStorage', async () => {
  await PaperStore.addReadLater({ id: 'rl::x', title: 'X', url: 'http://x' });
  const raw = JSON.parse(app.localStorage.getItem('paperReader.readLater.v2.local'));
  assert.equal(raw[0].id, 'rl::x');
});

// ── Figures (IndexedDB, never localStorage) ──────────────────────────────────
test('putFigure → getFigure round-trips a captured figure record', async () => {
  const rec = { dataUrl: 'data:image/png;base64,AAA', mediaType: 'image/png', w: 10, h: 10 };
  await PaperStore.putFigure('fig::web::a::1', rec);
  const got = await PaperStore.getFigure('fig::web::a::1');
  assert.equal(got.dataUrl, 'data:image/png;base64,AAA');
  assert.equal(got.mediaType, 'image/png');
});
