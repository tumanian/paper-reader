'use strict';

// Functional tests for the persistence guard and the save → close → reopen
// cycle. These wire the REAL front-end persistCurrentDoc() to the REAL
// PaperStore (store.js), both running in the same context, and assert the
// behaviours the .cursorrules explicitly call out as invariants:
//   * the empty-overwrite guard must never blank a saved doc's discussions
//   * a save → reopen round-trip preserves discussions and messages

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');
const { PaperStore, plain } = app;

before(async () => { await app.ready; });

beforeEach(async () => {
  app.reset();
  await PaperStore.init();
});

function discussionWithMessages() {
  return {
    id: 1, txt: 'a highlighted passage', mode: 'web', pageNum: null,
    color: { bg: 'rgba(1,2,3,.4)', dot: '#123' }, relRects: [{ left: 1, top: 2, width: 3, height: 4 }],
    messages: [
      { role: 'user', content: 'what does this mean?' },
      { role: 'assistant', content: 'it means X' },
    ],
  };
}

// ── empty-overwrite guard ────────────────────────────────────────────────────
test('persistCurrentDoc refuses to overwrite saved discussions with an empty set', async () => {
  // Seed a saved doc that already has discussions.
  await PaperStore.saveDoc({
    id: 'web::guard', name: 'Guarded', mode: 'web', badge: 'Web', url: 'http://g', updated: 1,
    discussions: [{ id: 1, txt: 'saved highlight', messages: [{ role: 'user', content: 'q' }] }],
  });

  // Now a stray persist fires while the in-memory discussions are empty.
  app.state.currentDocId = 'web::guard';
  app.state.docMeta = { name: 'Guarded', mode: 'web', badge: 'Web', url: 'http://g' };
  app.state.discussions = [];

  await app.persistCurrentDoc();

  // The saved doc must still have its discussion — not blanked.
  const saved = PaperStore.getStore()['web::guard'];
  assert.equal(saved.discussions.length, 1);
  assert.equal(saved.discussions[0].txt, 'saved highlight');
});

test('persistCurrentDoc DOES save when there are in-memory discussions', async () => {
  await PaperStore.saveDoc({
    id: 'web::guard', name: 'Guarded', mode: 'web', badge: 'Web', url: 'http://g', updated: 1,
    discussions: [{ id: 1, txt: 'old', messages: [] }],
  });

  app.state.currentDocId = 'web::guard';
  app.state.docMeta = { name: 'Guarded', mode: 'web', badge: 'Web', url: 'http://g' };
  app.state.discussions = [{ id: 2, txt: 'new highlight', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [] }];

  await app.persistCurrentDoc();

  const saved = PaperStore.getStore()['web::guard'];
  assert.equal(saved.discussions.length, 1);
  assert.equal(saved.discussions[0].txt, 'new highlight');
});

test('persistCurrentDoc is a no-op with no current document', async () => {
  app.state.currentDocId = null;
  await app.persistCurrentDoc(); // must not throw
  assert.deepEqual(plain(PaperStore.getStore()), {});
});

// ── save → close → reopen cycle ──────────────────────────────────────────────
test('save → reopen preserves discussions and their messages', async () => {
  app.state.currentDocId = 'web::cycle';
  app.state.currentMode = 'web';
  app.state.docMeta = { name: 'Cycle Paper', mode: 'web', badge: 'Web', url: 'http://cycle' };
  app.state.conversationSummary = 'a short summary';
  app.state.summaryMessageCount = 2;
  app.state.discussions = [discussionWithMessages()];

  await app.persistCurrentDoc();

  // "Close": simulate a reload by re-initializing the store from localStorage.
  await PaperStore.init();

  // "Reopen": read the saved doc and restore through the runtime normalizer.
  const saved = PaperStore.getStore()['web::cycle'];
  assert.ok(saved, 'doc should be present after reopen');
  assert.equal(saved.name, 'Cycle Paper');
  assert.equal(saved.conversationSummary, 'a short summary');
  assert.equal(saved.summaryMessageCount, 2);

  const restored = app.restoreDiscussions(saved.discussions);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].txt, 'a highlighted passage');
  assert.deepEqual(plain(restored[0].messages), [
    { role: 'user', content: 'what does this mean?' },
    { role: 'assistant', content: 'it means X' },
  ]);
  assert.deepEqual(plain(restored[0].relRects), [{ left: 1, top: 2, width: 3, height: 4 }]);
  assert.deepEqual(plain(restored[0].color), { bg: 'rgba(1,2,3,.4)', dot: '#123' });
});

test('save → reopen preserves math metadata on a discussion', async () => {
  app.state.currentDocId = 'web::math';
  app.state.docMeta = { name: 'Math Paper', mode: 'web', badge: 'Web', url: 'http://m' };
  app.state.discussions = [{
    id: 7, txt: 'E = mc^2', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [],
    messages: [{ role: 'user', content: 'explain' }],
    mathKind: 'explain', mathTex: 'E = mc^2',
  }];

  await app.persistCurrentDoc();
  await PaperStore.init();

  const saved = PaperStore.getStore()['web::math'];
  assert.equal(saved.discussions[0].mathKind, 'explain');
  assert.equal(saved.discussions[0].mathTex, 'E = mc^2');
});
