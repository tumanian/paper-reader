'use strict';

// Cross-device message-sync tests. Locks in the fix for the silent history-loss
// bug: messages used to have no stable identity, so cloud sync did a blob-level
// delete-then-reinsert (last-write-wins) that let a stale device wipe a peer's
// messages. The fix: content-addressed message ids (standard SHA-256, via Web
// Crypto — necessarily async, no sync digest exists in browsers) +
// crypto.randomUUID discussion ids + a pure (synchronous) merge-by-id (a
// CRDT-style union) instead of blob replacement.
//
// These exercise the PURE seam (no I/O): PaperStore.messageClientId / newId /
// mergeConversation. Storage-level (upsert-not-delete, tombstone writes) and the
// forced-interleaving lost-update scenario live in message-sync.interleave.test.js;
// randomized convergence in message-sync.property.test.js.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');
const { PaperStore, plain } = app;

before(async () => { await app.ready; });

// ── builders ────────────────────────────────────────────────────────────────
// messageClientId is async (Web Crypto's subtle.digest has no sync form), so
// these builders are async too — every call site below awaits them.
const mid = (d, r, c) => PaperStore.messageClientId(d, r, c);
const M = async (d, r, c, t = 0) => ({ id: await mid(d, r, c), role: r, content: c, createdMs: t });
const D = (id, msgs = [], o = {}) => ({ id, deleted: !!o.deleted, updated: o.updated || 0, txt: o.txt || ('hl-' + id), messages: msgs });
const C = (...discs) => ({ discussions: discs });
const merge = (a, b) => plain(PaperStore.mergeConversation(a, b));

// all message ids in a merged conversation, flattened
const allMsgIds = (conv) => conv.discussions.flatMap((d) => d.messages.map((m) => m.id));

// ── 1. Identity ───────────────────────────────────────────────────────────────
test('messageClientId is deterministic and content-addressed', async () => {
  assert.equal(await mid('d1', 'user', 'hello'), await mid('d1', 'user', 'hello'), 'same inputs → same id');
  assert.notEqual(await mid('d1', 'user', 'hello'), await mid('d1', 'user', 'HELLO'), 'content changes the id');
  assert.notEqual(await mid('d1', 'user', 'hi'), await mid('d1', 'assistant', 'hi'), 'role changes the id');
  assert.notEqual(await mid('d1', 'user', 'hi'), await mid('d2', 'user', 'hi'), 'discussion changes the id');
  assert.ok((await mid('d1', 'user', 'hi')).startsWith('d1:user:'), 'id is scoped to discussion+role');
});

test('newId produces collision-free ids at scale, across simulated devices', () => {
  const ids = new Set();
  for (let device = 0; device < 5; device++) {
    for (let i = 0; i < 2000; i++) {
      const id = PaperStore.newId();
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'UUID shape');
      ids.add(id);
    }
  }
  assert.equal(ids.size, 10000, 'zero collisions across 10k ids');
});

// ── 2. Merge algebra (CRDT laws) ──────────────────────────────────────────────
// Two devices touched the same doc: device A added a user turn, device B a reply,
// plus a second discussion only B knows about.
async function fixtures() {
  const a = C(
    D('d1', [await M('d1', 'user', 'Q1', 10)]),
    D('d2', [await M('d2', 'user', 'only-A', 5)]),
  );
  const b = C(
    D('d1', [await M('d1', 'assistant', 'A1', 20)]),
    D('d3', [await M('d3', 'user', 'only-B', 7)]),
  );
  const c = C(
    D('d1', [await M('d1', 'user', 'Q2', 30)]),
  );
  return { a, b, c };
}

test('merge is idempotent: replaying a sync changes nothing', async () => {
  const { a, b } = await fixtures();
  const once = merge(a, b);
  assert.deepStrictEqual(merge(a, once), once, 'merge(a, merge(a,b)) === merge(a,b)');
  assert.deepStrictEqual(merge(once, once), once, 'merge(x,x) === x');
});

test('merge is commutative: device order does not matter', async () => {
  const { a, b } = await fixtures();
  assert.deepStrictEqual(merge(a, b), merge(b, a));
});

test('merge is associative: three devices converge regardless of grouping', async () => {
  const { a, b, c } = await fixtures();
  const left = plain(PaperStore.mergeConversation(PaperStore.mergeConversation(a, b), c));
  const right = plain(PaperStore.mergeConversation(a, PaperStore.mergeConversation(b, c)));
  assert.deepStrictEqual(left, right);
});

test('merge loses nothing and duplicates nothing', async () => {
  const { a, b } = await fixtures();
  const m = merge(a, b);
  const ids = allMsgIds(m);
  const expected = new Set([...allMsgIds(a), ...allMsgIds(b)]);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate message ids');
  assert.deepEqual(new Set(ids), expected, 'every unique message survives exactly once');
});

test('concurrent adds to the SAME discussion both survive', async () => {
  const a = C(D('d1', [await M('d1', 'user', 'from-A', 1)]));
  const b = C(D('d1', [await M('d1', 'user', 'from-B', 2)]));
  const m = merge(a, b);
  const contents = m.discussions[0].messages.map((x) => x.content).sort();
  assert.deepEqual(contents, ['from-A', 'from-B'], 'neither concurrent message is clobbered');
});

test('identical content+role in one discussion collapses to a single message (accepted edge)', async () => {
  const a = C(D('d1', [await M('d1', 'user', 'ok', 1)]));
  const b = C(D('d1', [await M('d1', 'user', 'ok', 9)]));
  const m = merge(a, b);
  assert.equal(m.discussions[0].messages.length, 1, 'same content+role → one id → one row');
});

// ── 3. Tombstones (monotonic delete) ──────────────────────────────────────────
test('a delete tombstone wins over a live copy, and stays deleted (monotonic)', async () => {
  const deleted = C(D('d1', [await M('d1', 'user', 'x', 1)], { deleted: true, updated: 100 }));
  const live = C(D('d1', [await M('d1', 'user', 'x', 1)], { deleted: false, updated: 200 }));
  const m1 = merge(deleted, live);
  assert.equal(m1.discussions[0].deleted, true, 'deleted wins even when the live copy is newer');
  const m2 = merge(m1, live);
  assert.equal(m2.discussions[0].deleted, true, 'cannot be resurrected on a later merge');
});

test('deleting one discussion does not affect a concurrent add to another', async () => {
  const a = C(D('d1', [await M('d1', 'user', 'keep', 1)], { deleted: true }));
  const b = C(D('d2', [await M('d2', 'user', 'new', 2)]));
  const m = merge(a, b);
  const byId = Object.fromEntries(m.discussions.map((d) => [d.id, d]));
  assert.equal(byId.d1.deleted, true);
  assert.equal(byId.d2.deleted, false);
  assert.equal(byId.d2.messages[0].content, 'new');
});

// ── 4. Ordering by createdMs, independent of identity (clock-skew safety) ──────
test('messages sort by createdMs; a skewed (earlier) clock cannot drop a message', async () => {
  // Device B's clock is 5 min behind, so its message has a smaller createdMs.
  const a = C(D('d1', [await M('d1', 'user', 'first-real', 1000)]));
  const b = C(D('d1', [await M('d1', 'assistant', 'skewed-earlier', 1000 - 300000)]));
  const m = merge(a, b);
  assert.equal(m.discussions[0].messages.length, 2, 'no loss under clock skew');
  const order = m.discussions[0].messages.map((x) => x.content);
  assert.deepEqual(order, ['skewed-earlier', 'first-real'], 'stable order by createdMs');
});
