'use strict';

// Forced-interleaving tests — the exact lost-update ordering that caused the bug.
// A shared in-memory store models the cloud AFTER the fix: a write MERGES the
// client's conversation by id (upsert-not-replace) instead of overwriting the
// blob. Orderings are forced explicitly (no timers, no racing) by controlling
// when each client reads and writes.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');
const { PaperStore, plain } = app;

before(async () => { await app.ready; });

// messageClientId is async (Web Crypto's subtle.digest has no sync form).
const mid = (d, r, c) => PaperStore.messageClientId(d, r, c);
const M = async (d, r, c, t = 0) => ({ id: await mid(d, r, c), role: r, content: c, createdMs: t });
const D = (id, msgs = [], o = {}) => ({ id, deleted: !!o.deleted, updated: o.updated || 0, txt: 'hl-' + id, messages: msgs });
const C = (...discs) => ({ discussions: discs });

// Shared store that mimics the real post-fix cloud: a write is a merge-by-id
// union, so a stale writer can add but never delete a peer's rows.
function sharedStore(initial) {
  let state = plain(initial);
  return {
    read: () => plain(state),
    write: (clientDoc) => { state = plain(PaperStore.mergeConversation(state, clientDoc)); },
    dump: () => plain(state),
  };
}
const contents = (conv, discId) => {
  const d = conv.discussions.find((x) => x.id === discId);
  return (d ? d.messages.map((m) => m.content) : []).sort();
};

// ── The classic lost update: read(A), read(B), write(A), write(B) ─────────────
test('read(A), read(B), write(A), write(B): BOTH clients survive (no clobber)', async () => {
  const store = sharedStore(C(D('d1', [await M('d1', 'user', 'base', 1)])));

  const a = store.read();                                  // read A (before anyone wrote)
  const b = store.read();                                  // read B (also stale of the other's edit)
  a.discussions[0].messages.push(await M('d1', 'assistant', 'from-A', 10)); // A edits locally
  b.discussions[0].messages.push(await M('d1', 'user', 'from-B', 20));      // B edits locally
  store.write(a);                                          // write A
  store.write(b);                                          // write B lands AFTER A's — the danger window

  assert.deepEqual(contents(store.dump(), 'd1'), ['base', 'from-A', 'from-B'],
    'the write that lands second must not wipe the first');
});

// ── Both clients append to the SAME discussion concurrently ───────────────────
test('two clients append to the same discussion concurrently — both kept', async () => {
  const store = sharedStore(C(D('d1', [])));
  const a = store.read();
  const b = store.read();
  a.discussions[0].messages.push(await M('d1', 'user', 'A-msg', 5));
  b.discussions[0].messages.push(await M('d1', 'assistant', 'B-msg', 6));
  store.write(b);  // reverse order this time
  store.write(a);
  assert.deepEqual(contents(store.dump(), 'd1'), ['A-msg', 'B-msg']);
});

// ── One client adds while another deletes a DIFFERENT discussion ──────────────
test('add on one discussion + delete of another do not interfere', async () => {
  const store = sharedStore(C(D('d1', [await M('d1', 'user', 'keep', 1)]), D('d2', [await M('d2', 'user', 'doomed', 1)])));
  const adder = store.read();
  const deleter = store.read();
  adder.discussions[0].messages.push(await M('d1', 'assistant', 'added', 9));
  deleter.discussions[1].deleted = true;                  // tombstone d2
  store.write(adder);
  store.write(deleter);
  const final = store.dump();
  const byId = Object.fromEntries(final.discussions.map((d) => [d.id, d]));
  assert.deepEqual(contents(final, 'd1'), ['added', 'keep'], 'the add survives');
  assert.equal(byId.d2.deleted, true, 'the delete propagates');
});

// ── Replaying a sync (double write) is harmless ───────────────────────────────
test('a client syncing twice in a row does not duplicate or lose anything', async () => {
  const store = sharedStore(C(D('d1', [await M('d1', 'user', 'base', 1)])));
  const a = store.read();
  a.discussions[0].messages.push(await M('d1', 'assistant', 'reply', 2));
  store.write(a);
  const afterFirst = store.dump();
  store.write(a);                                          // replay the exact same write
  assert.deepStrictEqual(store.dump(), afterFirst, 'replay is a no-op');
});

// ── Three replicas, staggered, converge ───────────────────────────────────────
test('three staggered replicas converge to the same state after a final sync', async () => {
  const store = sharedStore(C(D('d1', [await M('d1', 'user', 'seed', 0)])));
  const r1 = store.read(), r2 = store.read(), r3 = store.read();
  r1.discussions[0].messages.push(await M('d1', 'assistant', 'r1', 1));
  r2.discussions.push(D('d2', [await M('d2', 'user', 'r2', 2)]));
  r3.discussions[0].messages.push(await M('d1', 'user', 'r3', 3));
  // interleave writes in a non-sorted order
  store.write(r2); store.write(r1); store.write(r3);
  // each replica does a final read (pull) → should equal the store
  const final = store.dump();
  for (const stale of [r1, r2, r3]) {
    const pulled = plain(PaperStore.mergeConversation(stale, final));
    assert.deepStrictEqual(pulled, final, 'every replica converges to the merged state');
  }
  assert.deepEqual(contents(final, 'd1'), ['r1', 'r3', 'seed']);
  assert.deepEqual(contents(final, 'd2'), ['r2']);
});
