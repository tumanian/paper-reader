'use strict';

// Characterization tests for the localStorage schema migration + discussion
// normalization helpers in index.html. These guarantee a saved library from an
// older shape loads without data loss and with stable defaults.

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');
const { plain } = app;

before(async () => { await app.ready; });
beforeEach(() => { app.reset(); });

// ── docIdFor / simpleHash ────────────────────────────────────────────────────
test('docIdFor builds a stable mode-prefixed id', () => {
  assert.equal(app.docIdFor('web', 'https://x.com'), 'web::https://x.com');
  assert.equal(app.docIdFor('pdf', 'name:12345'), 'pdf::name:12345');
});

test('simpleHash is deterministic and stable for the same input', () => {
  assert.equal(app.simpleHash('hello'), app.simpleHash('hello'));
  assert.notEqual(app.simpleHash('hello'), app.simpleHash('world'));
  assert.equal(typeof app.simpleHash('x'), 'string');
});

// ── migrateDoc ───────────────────────────────────────────────────────────────
test('migrateDoc fills in defaults for a minimal doc', () => {
  const { doc, changed } = app.migrateDoc({ discussions: [] }, 'web::http://e.com');
  assert.equal(changed, true);
  assert.equal(doc.id, 'web::http://e.com');
  assert.equal(doc.mode, 'web');         // inferred from web:: prefix
  assert.equal(doc.badge, 'Web');
  assert.equal(doc.url, null);
  assert.equal(doc.conversationSummary, null);
  assert.equal(doc.summaryMessageCount, 0);
  assert.ok(Array.isArray(doc.discussions));
});

test('migrateDoc infers pdf mode for a non-web id', () => {
  const { doc } = app.migrateDoc({}, 'pdf::paper:999');
  assert.equal(doc.mode, 'pdf');
  assert.equal(doc.badge, 'PDF');
});

test('migrateDoc normalizes message roles and coerces content to strings', () => {
  const { doc } = app.migrateDoc({
    discussions: [{ txt: 'hi', messages: [{ role: 'bot', content: 42 }, { role: 'assistant', content: 'ok' }] }],
  }, 'web::x');
  const msgs = doc.discussions[0].messages;
  assert.deepEqual(plain(msgs), [
    { role: 'user', content: '42' },   // unknown role → 'user', number → string
    { role: 'assistant', content: 'ok' },
  ]);
});

test('migrateDoc gives a discussion default color and empty arrays', () => {
  const { doc } = app.migrateDoc({ discussions: [{ txt: 'x' }] }, 'web::x');
  const d = doc.discussions[0];
  assert.deepEqual(plain(d.color), { bg: 'rgba(255,215,0,.45)', dot: '#c9a000' });
  assert.deepEqual(plain(d.relRects), []);
  assert.deepEqual(plain(d.messages), []);
});

test('migrateDoc returns null for a non-object input', () => {
  assert.equal(app.migrateDoc(null, 'x'), null);
});

test('migrateDoc reports changed=false for an already-complete doc', () => {
  const complete = {
    id: 'web::x', name: 'X', mode: 'web', badge: 'Web', url: 'http://x', updated: 123,
    conversationSummary: null, summaryMessageCount: 0, discussions: [],
  };
  const { changed } = app.migrateDoc(complete, 'web::x');
  assert.equal(changed, false);
});

// ── migrateStore ─────────────────────────────────────────────────────────────
test('migrateStore migrates every doc and flags changed', () => {
  const { store, changed } = app.migrateStore({
    'web::a': { discussions: [] },
    'pdf::b': { name: 'B', discussions: [{ txt: 'q', messages: [] }] },
  });
  assert.equal(changed, true);
  assert.deepEqual(Object.keys(store).sort(), ['pdf::b', 'web::a']);
  assert.equal(store['pdf::b'].mode, 'pdf');
});

test('migrateStore returns an empty store for a non-object', () => {
  const { store } = app.migrateStore('garbage');
  assert.deepEqual(plain(store), {});
});

// ── migrateReadLaterList ─────────────────────────────────────────────────────
test('migrateReadLaterList synthesizes ids and defaults', () => {
  const { items, changed } = app.migrateReadLaterList([{ url: 'http://a.com' }]);
  assert.equal(changed, true);
  assert.equal(items.length, 1);
  assert.ok(items[0].id.startsWith('rl::'));
  assert.equal(items[0].title, 'Untitled');
  assert.equal(items[0].mode, 'web');     // inferred because url present
  assert.ok(typeof items[0].addedAt === 'number');
});

test('migrateReadLaterList tolerates a null input and a non-array', () => {
  assert.deepEqual(plain(app.migrateReadLaterList(null)), { items: [], changed: false });
  assert.deepEqual(plain(app.migrateReadLaterList('x')), { items: [], changed: true });
});

// ── restoreDiscussions (the runtime normalizer) ──────────────────────────────
test('restoreDiscussions hardens missing arrays and color', () => {
  const restored = app.restoreDiscussions([
    { id: 1, txt: 'a', messages: null, relRects: null },
    { id: 2, txt: 'b', messages: [{ role: 'user', content: 'hi' }], color: { bg: 'x', dot: 'y' } },
  ]);
  assert.deepEqual(plain(restored[0].messages), []);
  assert.deepEqual(plain(restored[0].relRects), []);
  assert.deepEqual(plain(restored[0].color), { bg: 'rgba(255,215,0,.45)', dot: '#c9a000' });
  assert.equal(restored[0].wrapper, null);
  assert.deepEqual(plain(restored[1].messages), [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(plain(restored[1].color), { bg: 'x', dot: 'y' });
});

test('restoreDiscussions returns an empty array for null', () => {
  assert.deepEqual(plain(app.restoreDiscussions(null)), []);
});

// ── initStorage round-trips a migration into localStorage ────────────────────
test('initStorage migrates a legacy store in localStorage in place', () => {
  const STORE_KEY = 'paperReader.docs.v1';
  app.localStorage.setItem(STORE_KEY, JSON.stringify({
    'web::legacy': { discussions: [{ txt: 'old', messages: [{ role: 'weird', content: 7 }] }] },
  }));
  app.initStorage();
  const after = JSON.parse(app.localStorage.getItem(STORE_KEY));
  const doc = after['web::legacy'];
  assert.equal(doc.mode, 'web');
  assert.equal(doc.discussions[0].messages[0].role, 'user');
  assert.equal(doc.discussions[0].messages[0].content, '7');
});
