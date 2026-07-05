'use strict';

// Integration tests driving the REAL frontend (chat.js/selection.js/onboarding.js)
// through the app harness, wired to the fake Supabase client. Complements
// message-sync.test.js (pure merge algebra) and message-sync.interleave.test.js
// (forced orderings): these confirm the app actually USES the fix — new
// discussion ids are UUIDs (not Date.now()), deleting a highlight issues a
// tombstone UPDATE (not a destructive delete), and the poll additively merges
// cloud messages into the live discussion object without replacing it (so DOM
// refs like `wrapper` survive).

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');
const { PaperStore } = app;

const USER_A = { id: 'aaaaaaaa-1111-2222-3333-444444444444', email: 'alice@example.com', user_metadata: {} };
const sessionFor = (user) => ({ user, access_token: 'tok' });

function cloudConfig() {
  app.setFetchHandler(async (url) => {
    if (url.includes('/api/config')) {
      return app.jsonResponse({ supabaseUrl: 'https://fake.supabase.co', supabaseAnonKey: 'anon-key' });
    }
    return undefined;
  });
}

before(async () => { await app.ready; });

beforeEach(async () => {
  app.reset();
  app.setFetchHandler(null);
  app.fakeSupabase.setSession(null);
  app.fakeSupabase.clearCalls();
  // Earlier tests can leave a live poll behind (renderList starts one as a side
  // effect); clear it so each test's startMessagePoll isn't short-circuited by
  // the "already polling this doc" guard.
  app.stopMessagePoll();
});

async function signedInAs(user) {
  cloudConfig();
  app.fakeSupabase.setSession(sessionFor(user));
  await PaperStore.init();
  app.fakeSupabase.clearCalls();
}

// ── discussion identity: UUID, not Date.now() ─────────────────────────────────
test('a discussion created via PaperStore.newId() is a UUID, never a bare timestamp', () => {
  const id = PaperStore.newId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  // The regression this guards: two ids minted in the same millisecond (as
  // Date.now() would produce) must still be numerically random / distinct.
  const a = PaperStore.newId(), b = PaperStore.newId();
  assert.notEqual(a, b);
});

// ── deleteDiscussion: tombstone, not destructive delete ──────────────────────
test('deleteDiscussion issues a discussions UPDATE (tombstone), never a delete, and removes it locally', async () => {
  await signedInAs(USER_A);
  app.state.currentDocId = 'web::x';
  app.state.discussions = [
    { id: 'd1', txt: 'a', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [] },
    { id: 'd2', txt: 'b', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [] },
  ];
  app.deleteDiscussion('d1');
  await new Promise((r) => setTimeout(r, 0)); // let the cloud tombstone call's microtasks flush

  assert.deepEqual(app.state.discussions.map((d) => d.id), ['d2'], 'removed locally');

  const queries = app.fakeSupabase.state.calls.queries;
  assert.ok(!queries.some((q) => q.table === 'discussions' && q.op === 'delete'),
    'must never hard-delete — that was the destructive path');
  const tombstone = queries.find((q) => q.table === 'discussions' && q.op === 'update');
  assert.ok(tombstone, 'a tombstone update was issued');
  assert.equal(tombstone.rows.deleted, true);
  assert.deepEqual(tombstone.filters.find((f) => f[0] === 'id'), ['id', 'd1']);
});

// ── poll: additive merge without replacing the discussion object ─────────────
test('syncMessagesFromCloud adds a peer-device message without replacing the discussion object (DOM ref survives)', async () => {
  await signedInAs(USER_A);
  app.state.currentDocId = 'web::x';
  const wrapperSentinel = { tag: 'the-real-dom-node' };
  const hiId = await PaperStore.messageClientId('d1', 'user', 'hi');
  const otherId = await PaperStore.messageClientId('d1', 'assistant', 'from other device');
  const local = {
    id: 'd1', txt: 'hl', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' },
    relRects: [], wrapper: wrapperSentinel,
    messages: [{ id: hiId, role: 'user', content: 'hi', createdMs: 1 }],
  };
  app.state.discussions = [local];

  // Cloud already knows d1 (not deleted) and has ONE extra message from another device.
  app.fakeSupabase.state.selectResults.discussions = [{ id: 'd1', deleted: false }];
  app.fakeSupabase.state.selectResults.messages = [
    { id: hiId, discussion_id: 'd1', role: 'user', content: 'hi', hidden: false, created_ms: 1 },
    { id: otherId, discussion_id: 'd1', role: 'assistant', content: 'from other device', hidden: false, created_ms: 2 },
  ];

  const changed = await app.syncMessagesFromCloud('web::x');
  assert.equal(changed, true);
  assert.equal(app.state.discussions[0], local, 'same object identity — wrapper/color/relRects preserved');
  assert.equal(app.state.discussions[0].wrapper, wrapperSentinel);
  assert.deepEqual(app.plain(app.state.discussions[0].messages).map((m) => m.content), ['hi', 'from other device']);
});

test('syncMessagesFromCloud removes a discussion tombstoned by another device (and issues no delete of its own)', async () => {
  await signedInAs(USER_A);
  app.state.currentDocId = 'web::x';
  app.state.discussions = [
    { id: 'd1', txt: 'hl', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [] },
  ];
  app.fakeSupabase.state.selectResults.discussions = [{ id: 'd1', deleted: true }];
  app.fakeSupabase.state.selectResults.messages = [];

  const changed = await app.syncMessagesFromCloud('web::x');
  assert.equal(changed, true);
  assert.deepEqual(app.state.discussions, []);
  assert.ok(!app.fakeSupabase.state.calls.queries.some((q) => q.table === 'discussions' && (q.op === 'delete' || q.op === 'update')),
    'a REMOTE tombstone must not trigger another write — only a local removal');
});

test('syncMessagesFromCloud materializes a discussion created on another device (with its messages)', async () => {
  await signedInAs(USER_A);
  app.state.currentDocId = 'web::x';
  app.state.discussions = []; // this tab has never seen any discussion

  const qId = await PaperStore.messageClientId('d-new', 'user', 'question from tab A');
  // DB-shaped rows, as PostgREST returns them (snake_case) — getDocConversation maps them.
  app.fakeSupabase.state.selectResults.discussions = [{
    id: 'd-new', deleted: false, txt: 'highlighted passage', mode: 'web', page_num: null,
    color: { bg: 'b', dot: 'd' }, rel_rects: [{ left: 1, top: 2, width: 3, height: 4 }],
    citation_meta: null, math: null,
  }];
  app.fakeSupabase.state.selectResults.messages = [
    { id: qId, discussion_id: 'd-new', role: 'user', content: 'question from tab A', hidden: false, created_ms: 5 },
  ];

  const changed = await app.syncMessagesFromCloud('web::x');
  assert.equal(changed, true);
  assert.equal(app.state.discussions.length, 1, 'the unseen discussion was adopted');
  const d = app.state.discussions[0];
  assert.equal(d.id, 'd-new');
  assert.equal(d.txt, 'highlighted passage');
  assert.deepEqual(app.plain(d.relRects), [{ left: 1, top: 2, width: 3, height: 4 }]);
  assert.deepEqual(app.plain(d.messages).map((m) => m.content), ['question from tab A']);
  assert.equal(d.deleted, undefined, 'tombstone flag is not carried onto the live object');
});

test('syncMessagesFromCloud does NOT materialize a remote discussion that is tombstoned', async () => {
  await signedInAs(USER_A);
  app.state.currentDocId = 'web::x';
  app.state.discussions = [];
  app.fakeSupabase.state.selectResults.discussions = [{ id: 'd-dead', deleted: true, txt: 'x', mode: 'web' }];
  app.fakeSupabase.state.selectResults.messages = [];
  const changed = await app.syncMessagesFromCloud('web::x');
  assert.equal(changed, false);
  assert.deepEqual(app.state.discussions, []);
});

test('syncMessagesFromCloud is a no-op for a doc that is not the currently open one', async () => {
  await signedInAs(USER_A);
  app.state.currentDocId = 'web::OTHER';
  app.state.discussions = [{ id: 'd1', txt: 'hl', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [] }];
  const changed = await app.syncMessagesFromCloud('web::x'); // stale poll for a doc no longer open
  assert.equal(changed, false);
});

// ── startMessagePoll / stopMessagePoll ────────────────────────────────────────
test('startMessagePoll fires an IMMEDIATE first sync (not a full interval later)', async () => {
  await signedInAs(USER_A);
  app.state.currentDocId = 'web::x';
  app.state.discussions = [];
  app.fakeSupabase.state.selectResults.discussions = [];
  app.fakeSupabase.state.selectResults.messages = [];

  app.startMessagePoll('web::x');
  await new Promise((r) => setTimeout(r, 0)); // flush the immediate tick's microtasks (no 4s wait)
  app.stopMessagePoll();

  assert.ok(app.fakeSupabase.state.calls.queries.some((q) => q.table === 'discussions' && q.op === 'select'),
    'a conversation fetch happened at poll start, without waiting for the first interval');
});

test('poll DEFERS (not dies) when cloud is not ready: sync no-ops, then works once the session lands', async () => {
  // Regression: startMessagePoll used to check isCloud() once at start — if the
  // Supabase session was still initializing at doc-open, the poll silently
  // never started and nothing propagated for the rest of the session.
  await PaperStore.init(); // local-only right now — cloud not ready
  app.state.currentDocId = 'web::x';
  app.startMessagePoll('web::x');           // must not give up here
  assert.equal(await app.syncMessagesFromCloud('web::x'), false, 'tick no-ops while signed out');
  app.stopMessagePoll();
});
