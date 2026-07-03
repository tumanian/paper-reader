'use strict';

// Unit tests for the Supabase Auth (Google OAuth) identity layer:
//   * pure helpers: identityFromSession, storageKeyForUser, userPathKey
//   * legacy email-era data drop (drop-and-rebuild, no migration)
//   * signed-in vs signed-out gate + session-state transitions
//   * cloud scoping by Supabase user id (not email)
//
// The REAL OAuth redirect (Google consent + code exchange) cannot run here —
// the fake Supabase client in dom-stub.js stands in for supabase-js, and these
// tests verify OUR handling of sessions it reports. End-to-end OAuth is
// verified live in the browser (Phase C).

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');
const { PaperStore } = app;

const H = PaperStore._internals;

const USER_A = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  email: 'alice@example.com',
  user_metadata: { full_name: 'Alice A', avatar_url: 'https://lh3.example/a.png' },
};
const USER_B = {
  id: 'bbbbbbbb-5555-6666-7777-888888888888',
  email: 'bob@example.com',
  user_metadata: {},
};

function sessionFor(user) { return { user, access_token: 'tok' }; }

// Make /api/config report a configured Supabase project so init() goes down
// the cloud path against the fake client.
function cloudConfig() {
  app.setFetchHandler(async (url) => {
    if (url.includes('/api/config')) {
      return app.jsonResponse({ supabaseUrl: 'https://fake.supabase.co', supabaseAnonKey: 'anon-key' });
    }
    return undefined; // fall through to defaults for everything else
  });
}

before(async () => { await app.ready; });

beforeEach(() => {
  app.localStorage.clear();
  app.setFetchHandler(null);
  app.fakeSupabase.setSession(null);
  app.fakeSupabase.clearCalls();
});

// ── identityFromSession ──────────────────────────────────────────────────────
test('identityFromSession maps id/email/name/avatar from the session user', () => {
  const id = H.identityFromSession(sessionFor(USER_A));
  assert.deepEqual(app.plain(id), {
    id: USER_A.id,
    email: 'alice@example.com',
    name: 'Alice A',
    avatar: 'https://lh3.example/a.png',
  });
});

test('identityFromSession tolerates missing metadata and null sessions', () => {
  const id = H.identityFromSession(sessionFor(USER_B));
  assert.equal(id.id, USER_B.id);
  assert.equal(id.email, 'bob@example.com');
  assert.equal(id.name, null);
  assert.equal(id.avatar, null);

  assert.equal(H.identityFromSession(null), null);
  assert.equal(H.identityFromSession({}), null);
  assert.equal(H.identityFromSession({ user: {} }), null); // no id → no identity
});

test('identityFromSession falls back to metadata name/picture variants', () => {
  const id = H.identityFromSession(sessionFor({
    id: 'u1', user_metadata: { name: 'N', picture: 'p.png' },
  }));
  assert.equal(id.name, 'N');
  assert.equal(id.avatar, 'p.png');
});

// ── storage keying ───────────────────────────────────────────────────────────
test('storageKeyForUser derives distinct, stable, per-user keys', () => {
  const a = H.storageKeyForUser('paperReader.docs.v2', USER_A.id);
  const b = H.storageKeyForUser('paperReader.docs.v2', USER_B.id);
  assert.notEqual(a, b);
  assert.equal(a, H.storageKeyForUser('paperReader.docs.v2', USER_A.id)); // stable
  assert.ok(a.includes(USER_A.id));
});

test('storageKeyForUser uses the fixed local namespace when signed out', () => {
  assert.equal(H.storageKeyForUser('base', null), 'base.local');
  assert.equal(H.storageKeyForUser('base', undefined), 'base.local');
});

test('userPathKey is path-safe, deterministic, and distinct per user', () => {
  const a = H.userPathKey(USER_A.id);
  assert.match(a, /^[a-zA-Z0-9]+$/);
  assert.equal(a, H.userPathKey(USER_A.id));
  assert.notEqual(a, H.userPathKey(USER_B.id));
});

// ── legacy data drop ─────────────────────────────────────────────────────────
test('dropLegacyData clears all v1 email-era keys and is idempotent', () => {
  for (const k of H.legacyKeysToClear()) app.localStorage.setItem(k, 'legacy');
  assert.deepEqual(app.plain(H.legacyKeysToClear()), [
    'paperReader.docs.v1',
    'paperReader.readLater.v1',
    'paperReader.email.v1',
    'paperReader.schema.v1',
  ]);

  assert.equal(H.dropLegacyData(), true);
  for (const k of H.legacyKeysToClear()) {
    assert.equal(app.localStorage.getItem(k), null, k + ' should be cleared');
  }
  assert.ok(app.localStorage.getItem('paperReader.authMigrated.v2'));

  // Second run is a guarded no-op: re-seeded keys survive.
  app.localStorage.setItem('paperReader.docs.v1', 'reseeded');
  assert.equal(H.dropLegacyData(), false);
  assert.equal(app.localStorage.getItem('paperReader.docs.v1'), 'reseeded');
});

test('init() drops legacy keys exactly once', async () => {
  app.localStorage.setItem('paperReader.email.v1', 'old@example.com');
  await PaperStore.init();
  assert.equal(app.localStorage.getItem('paperReader.email.v1'), null);
  assert.ok(app.localStorage.getItem('paperReader.authMigrated.v2'));
});

// ── signed-in vs signed-out gate ─────────────────────────────────────────────
test('signed out (local mode): no identity, not cloud', async () => {
  await PaperStore.init();
  assert.equal(PaperStore.isSignedIn(), false);
  assert.equal(PaperStore.getUserId(), null);
  assert.equal(PaperStore.getIdentity(), null);
  assert.equal(PaperStore.isCloud(), false);
  const s = PaperStore.getSyncStatus();
  assert.equal(s.signedIn, false);
  assert.equal(s.mode, 'local');
});

test('cloud configured but signed out: needsAuth, not cloud', async () => {
  cloudConfig();
  await PaperStore.init();
  const s = PaperStore.getSyncStatus();
  assert.equal(s.mode, 'cloud');
  assert.equal(s.signedIn, false);
  assert.equal(s.needsAuth, true);
  assert.equal(PaperStore.isCloud(), false);
});

test('init() with an existing session establishes the identity and cloud mode', async () => {
  cloudConfig();
  app.fakeSupabase.setSession(sessionFor(USER_A));
  await PaperStore.init();

  assert.equal(PaperStore.isSignedIn(), true);
  assert.equal(PaperStore.getUserId(), USER_A.id);
  assert.equal(PaperStore.getIdentity().email, 'alice@example.com');
  assert.equal(PaperStore.getIdentity().name, 'Alice A');
  assert.equal(PaperStore.getEmail(), 'alice@example.com'); // display accessor
  assert.equal(PaperStore.isCloud(), true);
  const s = PaperStore.getSyncStatus();
  assert.equal(s.signedIn, true);
  assert.equal(s.needsAuth, false);
  assert.equal(s.userId, USER_A.id);
});

// ── session-state transitions ────────────────────────────────────────────────
test('SIGNED_OUT auth event clears identity and leaves cloud mode', async () => {
  cloudConfig();
  app.fakeSupabase.setSession(sessionFor(USER_A));
  await PaperStore.init();
  assert.equal(PaperStore.isSignedIn(), true);

  app.fakeSupabase.emitAuthChange('SIGNED_OUT', null);
  assert.equal(PaperStore.isSignedIn(), false);
  assert.equal(PaperStore.getUserId(), null);
  assert.equal(PaperStore.isCloud(), false);
});

test('SIGNED_IN auth event after boot establishes the identity', async () => {
  cloudConfig();
  await PaperStore.init(); // signed out at boot
  assert.equal(PaperStore.isSignedIn(), false);

  app.fakeSupabase.emitAuthChange('SIGNED_IN', sessionFor(USER_B));
  assert.equal(PaperStore.isSignedIn(), true);
  assert.equal(PaperStore.getUserId(), USER_B.id);
  assert.equal(PaperStore.isCloud(), true);
});

test('signOut() calls supabase.auth.signOut and clears the session state', async () => {
  cloudConfig();
  app.fakeSupabase.setSession(sessionFor(USER_A));
  await PaperStore.init();

  await PaperStore.signOut();
  assert.equal(app.fakeSupabase.state.calls.signOut, 1);
  assert.equal(PaperStore.isSignedIn(), false);
  assert.equal(PaperStore.getIdentity(), null);
  assert.equal(PaperStore.isCloud(), false);
});

// ── sign-in call shape ───────────────────────────────────────────────────────
test('signInWithGoogle calls Supabase OAuth with provider google and a redirect back to the app', async () => {
  cloudConfig();
  await PaperStore.init();
  await PaperStore.signInWithGoogle();

  const calls = app.fakeSupabase.state.calls.signInWithOAuth;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'google');
  assert.ok(calls[0].options.redirectTo.startsWith('http://localhost'));
});

test('signInWithGoogle throws when cloud is not configured', async () => {
  await PaperStore.init(); // local mode — no supabase client
  await assert.rejects(() => PaperStore.signInWithGoogle(), /not configured/i);
});

// ── identity keying of data ──────────────────────────────────────────────────
test('cloud rows and queries are scoped by the Supabase user id, not the email', async () => {
  cloudConfig();
  app.fakeSupabase.setSession(sessionFor(USER_A));
  await PaperStore.init();
  app.fakeSupabase.clearCalls();

  await PaperStore.saveDoc({
    id: 'web::x', name: 'X', mode: 'web', badge: 'Web', url: 'http://x', updated: 1,
    discussions: [],
  });

  const upserts = app.fakeSupabase.state.calls.queries.filter(
    (q) => q.table === 'documents' && q.op === 'upsert',
  );
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].rows.owner_email, USER_A.id, 'row is keyed by user id');
  assert.notEqual(upserts[0].rows.owner_email, 'alice@example.com');

  app.fakeSupabase.clearCalls();
  await PaperStore.getRatingsFromCloud();
  const sel = app.fakeSupabase.state.calls.queries.find((q) => q.table === 'ratings');
  assert.deepEqual(sel.filters, [['owner_email', USER_A.id]]);
});

// Design principle: the signed-out experience is equivalent to signed-in, just
// device-local. Signed-out sessions read and write the `.local` namespace.
test('signed out with cloud configured shows the .local library', async () => {
  cloudConfig();
  app.localStorage.setItem('paperReader.docs.v2.local', JSON.stringify({
    'web::mine': { id: 'web::mine', name: 'Mine', mode: 'web', discussions: [] },
  }));
  await PaperStore.init();
  assert.equal(PaperStore.isSignedIn(), false);
  assert.ok(PaperStore.getStore()['web::mine']);
});

test('saveDoc persists to .local when cloud is configured but signed out', async () => {
  cloudConfig();
  await PaperStore.init();
  await PaperStore.saveDoc({
    id: 'web::offline', name: 'Offline', mode: 'web', badge: 'Web', url: 'http://o', updated: 1,
    discussions: [],
  });
  assert.ok(PaperStore.getStore()['web::offline']);
  const raw = JSON.parse(app.localStorage.getItem('paperReader.docs.v2.local'));
  assert.ok(raw['web::offline']);
});

test('saveDoc drops a stale write when the session changed since the caller captured it', async () => {
  cloudConfig();
  app.fakeSupabase.setSession(sessionFor(USER_A));
  await PaperStore.init();

  // Caller captured USER_A, but by save time the session is signed out.
  app.fakeSupabase.emitAuthChange('SIGNED_OUT', null);
  await PaperStore.saveDoc({
    id: 'web::stale', name: 'Stale', mode: 'web', badge: 'Web', url: 'http://s', updated: 1,
    discussions: [],
  }, USER_A.id);
  assert.equal(PaperStore.getStore()['web::stale'], undefined);
  assert.equal(app.localStorage.getItem('paperReader.docs.v2.local'), null);
});

test('signOut clears the in-memory library (signed-in papers must not linger)', async () => {
  cloudConfig();
  app.fakeSupabase.setSession(sessionFor(USER_A));
  await PaperStore.init();
  await PaperStore.saveDoc({
    id: 'web::mine', name: 'Mine', mode: 'web', badge: 'Web', url: 'http://m', updated: 1,
    discussions: [{ id: 1, txt: 'hi', messages: [{ role: 'user', content: 'q' }] }],
  });
  assert.ok(PaperStore.getStore()['web::mine']);

  await PaperStore.signOut();
  assert.equal(PaperStore.isSignedIn(), false);
  assert.deepEqual(app.plain(PaperStore.getStore()), {});
});

// ── signed-out → signed-in migration ─────────────────────────────────────────
// Signing in exists for cross-device transfer, so everything created while
// signed out moves into the account (one-way), then `.local` is cleared.

function localDoc(id, extra = {}) {
  return {
    id, name: 'Local ' + id, mode: 'web', badge: 'Web', url: 'http://' + id, updated: 500,
    discussions: [{ id: 1, txt: 'hl', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [{ role: 'user', content: 'q' }] }],
    ...extra,
  };
}

test('signing in migrates .local docs and read-later into the account and clears .local', async () => {
  cloudConfig();
  app.localStorage.setItem('paperReader.docs.v2.local', JSON.stringify({
    'web::l1': localDoc('web::l1'),
  }));
  app.localStorage.setItem('paperReader.readLater.v2.local', JSON.stringify([
    { id: 'rl::l1', title: 'Later', url: 'http://later', addedAt: 100 },
  ]));

  await PaperStore.init(); // signed out at boot
  app.fakeSupabase.emitAuthChange('SIGNED_IN', sessionFor(USER_A));

  assert.ok(PaperStore.getStore()['web::l1'], 'doc adopted into the account');
  assert.equal(PaperStore.getReadLater()[0].id, 'rl::l1');

  const keyA = 'paperReader.docs.v2.' + USER_A.id;
  assert.ok(JSON.parse(app.localStorage.getItem(keyA))['web::l1'], 'account namespace has the doc');
  assert.equal(app.localStorage.getItem('paperReader.docs.v2.local'), null, '.local docs cleared');
  assert.equal(app.localStorage.getItem('paperReader.readLater.v2.local'), null, '.local read-later cleared');
});

test('untouched onboarding demo docs are seeded content and are NOT migrated', async () => {
  cloudConfig();
  const demoDoc = localDoc('web::demo', {
    discussions: [
      { id: 1, txt: 'demo', onboarding: true, messages: [] },
      { id: 2, txt: 'demo math', onboarding: true, messages: [
        { role: 'user', content: 'Explain this math.' },
        { role: 'assistant', content: 'canned answer' },
      ] },
    ],
  });
  app.localStorage.setItem('paperReader.docs.v2.local', JSON.stringify({
    'web::demo': demoDoc,
    'web::real': localDoc('web::real'),
  }));

  await PaperStore.init();
  app.fakeSupabase.emitAuthChange('SIGNED_IN', sessionFor(USER_A));

  assert.equal(PaperStore.getStore()['web::demo'], undefined, 'demo doc skipped');
  assert.ok(PaperStore.getStore()['web::real'], 'real doc migrated');
  assert.equal(app.localStorage.getItem('paperReader.docs.v2.local'), null);
});

test('a demo doc the visitor actually engaged with IS migrated', async () => {
  const H2 = PaperStore._internals;
  const engaged = localDoc('web::demo', {
    discussions: [{ id: 1, txt: 'demo', onboarding: true, messages: [
      { role: 'user', content: 'Explain this math.' },
      { role: 'assistant', content: 'canned answer' },
      { role: 'user', content: 'wait, why does the variance shrink?' },
    ] }],
  });
  assert.equal(H2.isUntouchedDemoDoc(engaged), false);
});

test('migrating a doc that also exists in the account merges the missing discussions', async () => {
  cloudConfig();
  // Account already has web::x with discussion 1.
  const keyA = 'paperReader.docs.v2.' + USER_A.id;
  app.localStorage.setItem(keyA, JSON.stringify({
    'web::x': localDoc('web::x', { updated: 900, discussions: [{ id: 1, txt: 'account hl', messages: [] }] }),
  }));
  // Signed-out session added discussion 2 on the same paper.
  app.localStorage.setItem('paperReader.docs.v2.local', JSON.stringify({
    'web::x': localDoc('web::x', { updated: 1200, discussions: [
      { id: 1, txt: 'account hl', messages: [] },
      { id: 2, txt: 'local hl', messages: [{ role: 'user', content: 'q2' }] },
    ] }),
  }));

  await PaperStore.init();
  app.fakeSupabase.emitAuthChange('SIGNED_IN', sessionFor(USER_A));

  const doc = app.plain(PaperStore.getStore()['web::x']);
  assert.deepEqual(doc.discussions.map((d) => d.id), [1, 2]);
  assert.equal(doc.discussions[0].txt, 'account hl', 'account copy wins for shared discussion');
  assert.equal(doc.updated, 1200, 'updated bumps to the newer of the two');
});

test('migrated docs are pushed to the cloud by the post-sign-in refresh', async () => {
  cloudConfig();
  app.localStorage.setItem('paperReader.docs.v2.local', JSON.stringify({
    'web::l1': localDoc('web::l1'),
  }));

  await PaperStore.init();
  // A refresh kicked off by an earlier test may still be in flight;
  // startCloudRefresh dedupes on it, so wait for quiescence first.
  for (let i = 0; i < 50 && PaperStore.getSyncStatus().syncing; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  app.fakeSupabase.clearCalls();
  app.fakeSupabase.emitAuthChange('SIGNED_IN', sessionFor(USER_A));

  // The cloud refresh runs async — poll a few microtask/timer ticks.
  let upsert = null;
  for (let i = 0; i < 20 && !upsert; i++) {
    await new Promise((r) => setTimeout(r, 0));
    upsert = app.fakeSupabase.state.calls.queries.find(
      (q) => q.table === 'documents' && q.op === 'upsert' && q.rows && q.rows.id === 'web::l1',
    );
  }
  assert.ok(upsert, 'migrated doc upserted to the documents table');
  assert.equal(upsert.rows.owner_email, USER_A.id);
});

test('local caches are namespaced per user id and separated between accounts', async () => {
  cloudConfig();
  app.fakeSupabase.setSession(sessionFor(USER_A));
  await PaperStore.init();

  await PaperStore.saveDoc({
    id: 'web::mine', name: 'Mine', mode: 'web', badge: 'Web', url: 'http://m', updated: 1,
    discussions: [],
  });
  const keyA = 'paperReader.docs.v2.' + USER_A.id;
  assert.ok(JSON.parse(app.localStorage.getItem(keyA))['web::mine']);

  // Switch to user B: their store is empty; A's data stays under A's key.
  app.fakeSupabase.emitAuthChange('SIGNED_IN', sessionFor(USER_B));
  assert.deepEqual(app.plain(PaperStore.getStore()), {});
  assert.ok(JSON.parse(app.localStorage.getItem(keyA))['web::mine']);
});
