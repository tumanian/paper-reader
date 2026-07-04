'use strict';

// Multi-tenant write-path tests for store.js.
//
// The database uses composite primary keys (owner_email, id) so two accounts can
// hold the same content-addressed paper without colliding (see
// supabase/multi-tenant-keys.sql). The DB enforces that; these tests pin the
// APP side of the contract that makes it work:
//   * every cloud write carries owner_email (per-user scoping)
//   * upserts resolve conflicts on the full composite key (owner_email,id)
//   * deletes are scoped by owner, never id-only
//   * the same content id written by two users stays owner-separated
//
// The fake Supabase client (dom-stub.js) does not enforce keys/RLS, so the
// end-to-end "no collision" guarantee is verified live against Postgres; here we
// assert the requests the app SENDS are the ones that key/RLS need.

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');
const { PaperStore } = app;

const USER_A = { id: 'aaaaaaaa-1111-2222-3333-444444444444', email: 'alice@example.com', user_metadata: {} };
const USER_B = { id: 'bbbbbbbb-5555-6666-7777-888888888888', email: 'bob@example.com', user_metadata: {} };
const sessionFor = (user) => ({ user, access_token: 'tok' });

function cloudConfig() {
  app.setFetchHandler(async (url) => {
    if (url.includes('/api/config')) {
      return app.jsonResponse({ supabaseUrl: 'https://fake.supabase.co', supabaseAnonKey: 'anon-key' });
    }
    return undefined;
  });
}

// A doc whose one discussion carries a message, so the save exercises the
// documents + discussions + messages write paths in one call.
function docWithThread(id = 'web::shared') {
  return {
    id, name: 'Shared Paper', mode: 'web', badge: 'Web', url: 'http://shared', updated: 1,
    discussions: [{
      id: 42, txt: 'highlight', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' },
      relRects: [], messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
    }],
  };
}

const q = () => app.fakeSupabase.state.calls.queries;
const upsertsFor = (table) => q().filter((x) => x.table === table && x.op === 'upsert');

before(async () => { await app.ready; });

beforeEach(async () => {
  app.localStorage.clear();
  app.setFetchHandler(null);
  app.fakeSupabase.setSession(null);
  app.fakeSupabase.clearCalls();
});

async function signedInAs(user) {
  cloudConfig();
  app.fakeSupabase.setSession(sessionFor(user));
  await PaperStore.init();
  app.fakeSupabase.clearCalls();
}

// ── upsert conflict targets ────────────────────────────────────────────────

test('documents upsert resolves conflicts on the composite key (owner_email,id)', async () => {
  await signedInAs(USER_A);
  await PaperStore.saveDoc(docWithThread());

  const [docUpsert] = upsertsFor('documents');
  assert.ok(docUpsert, 'a documents upsert was issued');
  assert.equal(docUpsert.rows.owner_email, USER_A.id);
  assert.equal(docUpsert.rows.id, 'web::shared');
  assert.equal(docUpsert.options?.onConflict, 'owner_email,id');
});

test('discussions upsert carries owner_email + document_id and the composite conflict target', async () => {
  await signedInAs(USER_A);
  await PaperStore.saveDoc(docWithThread());

  const [discUpsert] = upsertsFor('discussions');
  assert.ok(discUpsert, 'a discussions upsert was issued');
  assert.equal(discUpsert.rows.owner_email, USER_A.id);
  assert.equal(discUpsert.rows.document_id, 'web::shared');
  assert.equal(discUpsert.options?.onConflict, 'owner_email,id');
});

test('messages insert carries owner_email and the parent discussion id', async () => {
  await signedInAs(USER_A);
  await PaperStore.saveDoc(docWithThread());

  const msgInsert = q().find((x) => x.table === 'messages' && x.op === 'insert');
  assert.ok(msgInsert, 'a messages insert was issued');
  assert.ok(Array.isArray(msgInsert.rows) && msgInsert.rows.length === 2);
  for (const m of msgInsert.rows) {
    assert.equal(m.owner_email, USER_A.id);
    assert.equal(m.discussion_id, 42);
  }
});

test('read_later and ratings upserts use the composite conflict target', async () => {
  await signedInAs(USER_A);

  await PaperStore.addReadLater({ id: 'rl::1', title: 'Later', url: 'http://later', addedAt: 1 });
  const [rl] = upsertsFor('read_later');
  assert.equal(rl.rows.owner_email, USER_A.id);
  assert.equal(rl.options?.onConflict, 'owner_email,id');

  app.fakeSupabase.clearCalls();
  await PaperStore.saveRating({ id: 'rt::1', rating: 'up' });
  const [rating] = upsertsFor('ratings');
  assert.equal(rating.rows.owner_email, USER_A.id);
  assert.equal(rating.options?.onConflict, 'owner_email,id');
});

// ── owner-scoped deletes (never id-only) ───────────────────────────────────

test('saveDoc clears prior discussions scoped by BOTH owner_email and document_id', async () => {
  await signedInAs(USER_A);
  await PaperStore.saveDoc(docWithThread());

  const del = q().find((x) => x.table === 'discussions' && x.op === 'delete');
  assert.ok(del, 'a discussions delete was issued');
  const cols = del.filters.map((f) => f[0]);
  assert.ok(cols.includes('owner_email'), 'delete is scoped by owner_email');
  assert.ok(cols.includes('document_id'), 'delete is scoped by document_id');
  assert.deepEqual(
    del.filters.find((f) => f[0] === 'owner_email'), ['owner_email', USER_A.id],
  );
});

test('deleteDoc deletes the documents row scoped by owner_email + id, not id alone', async () => {
  await signedInAs(USER_A);
  await PaperStore.saveDoc(docWithThread());
  app.fakeSupabase.clearCalls();

  await PaperStore.deleteDoc('web::shared');
  const del = q().find((x) => x.table === 'documents' && x.op === 'delete');
  assert.ok(del, 'a documents delete was issued');
  const cols = del.filters.map((f) => f[0]);
  assert.ok(cols.includes('owner_email') && cols.includes('id'), 'scoped by owner_email + id');
});

// ── the core multi-tenant property, at the app layer ───────────────────────

test('two users saving the SAME content id each write rows under their own owner', async () => {
  // User A saves web::shared.
  await signedInAs(USER_A);
  await PaperStore.saveDoc(docWithThread('web::shared'));
  const aOwner = upsertsFor('documents')[0].rows.owner_email;

  // User B saves the same content id.
  await signedInAs(USER_B);
  await PaperStore.saveDoc(docWithThread('web::shared'));
  const bOwner = upsertsFor('documents')[0].rows.owner_email;

  assert.equal(aOwner, USER_A.id);
  assert.equal(bOwner, USER_B.id);
  assert.notEqual(aOwner, bOwner);
  // Same id, different owner → distinct rows under the composite PK. Without it
  // B's upsert would target A's row and RLS would reject the write (42501).
});
