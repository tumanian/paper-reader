// Cloud + local persistence. Identity is a real Supabase Auth session (Google
// OAuth via supabase.auth.signInWithOAuth); all data — cloud rows, local
// caches, storage paths — is scoped by the authenticated Supabase user id.
// NOTE: the Postgres column is still named owner_email but carries the user id
// (disposable pre-auth data was dropped, no migration). See docs/AUTH_SETUP.md.
window.PaperStore = (function () {
  const STORE_BASE = 'paperReader.docs.v2';
  const READ_LATER_BASE = 'paperReader.readLater.v2';
  const MIGRATED_FLAG = 'paperReader.authMigrated.v2';
  const IDB_NAME = 'paperReader.files.v2';

  let supabase = null;
  let identity = null;   // { id, email, name, avatar } from the Supabase session
  let userId = null;     // identity.id — the scoping key everywhere
  let useCloud = false;
  let ready = false;
  let lastSyncError = null;
  let cloudRefreshPromise = null;
  let docs = {};
  let readLater = [];
  let authSubscribed = false;

  function friendlyError(e) {
    const msg = e?.message || String(e);
    const code = e?.code || '';
    if (/invalid api key/i.test(msg)) {
      return 'Supabase anon key is invalid — paste the real key from Supabase → Settings → API into .env.local (or remove Supabase vars for local-only mode).';
    }
    if (code === 'PGRST205' || (msg.includes('relation') && msg.includes('does not exist'))) {
      return 'Database tables missing — run supabase/schema.sql (or migrate-to-email.sql).';
    }
    if (code === '42703' && msg.includes('owner_email')) {
      return 'Database needs migration — run supabase/schema.sql in Supabase SQL Editor.';
    }
    if (code === '42501' || msg.toLowerCase().includes('row-level security')) {
      return 'Database permission error — sign in, and ensure supabase/harden-rls.sql and supabase/multi-tenant-keys.sql have been applied in the SQL Editor.';
    }
    return msg;
  }

  function notifyChange() {
    if (typeof window.onPaperStoreSyncChange === 'function') {
      window.onPaperStoreSyncChange(getSyncStatus());
    }
  }

  function setSyncError(e) {
    lastSyncError = e ? friendlyError(e) : null;
    if (e) console.error('Paper Reader sync error:', e);
    notifyChange();
  }

  // ── Identity helpers (pure) ─────────────────────────────────────────────
  // Identity comes from the Supabase Auth session (Google OAuth). All data is
  // scoped by the stable Supabase user id — see docs/AUTH_SETUP.md.

  function identityFromSession(session) {
    const u = session?.user;
    if (!u || !u.id) return null;
    const md = u.user_metadata || {};
    return {
      id: u.id,
      email: u.email || md.email || null,
      name: md.full_name || md.name || null,
      avatar: md.avatar_url || md.picture || null,
    };
  }

  // Per-user localStorage namespace. Signed-out (or cloud-less) sessions use a
  // fixed 'local' namespace so local-only mode keeps full persistence.
  function storageKeyForUser(base, uid) {
    return base + '.' + (uid || 'local');
  }

  // Storage-bucket path segment for a user id (UUID → path-safe, stable).
  function userPathKey(uid) {
    return String(uid).replace(/[^a-zA-Z0-9]/g, '').slice(0, 48);
  }

  // ── Legacy (email-era) data drop ────────────────────────────────────────
  // The old email-keyed model stored GLOBAL keys. That content is disposable
  // (per the auth migration decision: drop and rebuild, no migration). Runs
  // once, guarded by MIGRATED_FLAG, so no orphaned v1 keys linger to confuse
  // the new id-keyed reads.

  function legacyKeysToClear() {
    return [
      'paperReader.docs.v1',
      'paperReader.readLater.v1',
      'paperReader.email.v1',
      'paperReader.schema.v1',
    ];
  }

  function dropLegacyData() {
    try {
      if (localStorage.getItem(MIGRATED_FLAG)) return false;
      for (const k of legacyKeysToClear()) localStorage.removeItem(k);
      try {
        if ('indexedDB' in window && indexedDB.deleteDatabase) {
          indexedDB.deleteDatabase('paperReader.files');
        }
      } catch (e) { console.warn('Legacy IndexedDB drop failed:', e); }
      localStorage.setItem(MIGRATED_FLAG, JSON.stringify({ migratedAt: Date.now() }));
      return true;
    } catch { return false; }
  }

  // ── Local helpers (per-user namespaced) ─────────────────────────────────

  function docsKey() { return storageKeyForUser(STORE_BASE, userId); }
  function readLaterKey() { return storageKeyForUser(READ_LATER_BASE, userId); }

  function loadLocalDocs() {
    try { return JSON.parse(localStorage.getItem(docsKey())) || {}; }
    catch { return {}; }
  }

  function saveLocalDocs(store) {
    try { localStorage.setItem(docsKey(), JSON.stringify(store)); }
    catch (e) { console.warn('Local backup failed:', e); }
  }

  function loadLocalReadLater() {
    try { return JSON.parse(localStorage.getItem(readLaterKey())) || []; }
    catch { return []; }
  }

  function saveLocalReadLater(items) {
    try { localStorage.setItem(readLaterKey(), JSON.stringify(items)); }
    catch (e) { console.warn('Read later local backup failed:', e); }
  }

  function mergeLocalDocs() {
    const local = loadLocalDocs();
    for (const [id, doc] of Object.entries(local)) {
      if (!docs[id] || (doc.updated || 0) >= (docs[id].updated || 0)) {
        docs[id] = doc;
      }
    }
  }

  function mergeLocalReadLater() {
    const local = loadLocalReadLater();
    const byId = new Map(readLater.map((i) => [i.id, i]));
    for (const item of local) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
    readLater = [...byId.values()].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  function openLocalIDB() {
    return new Promise((resolve) => {
      if (!('indexedDB' in window)) { resolve(null); return; }
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('pdfs')) db.createObjectStore('pdfs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  // IndexedDB keys are namespaced per user (same rule as localStorage) so PDFs
  // and figures never leak across accounts on a shared device.
  function idbKey(key) {
    return (userId || 'local') + '::' + key;
  }

  async function idbGetLocal(key) {
    const db = await openLocalIDB();
    if (!db) return null;
    return new Promise((res) => {
      const tx = db.transaction('pdfs', 'readonly');
      const r = tx.objectStore('pdfs').get(idbKey(key));
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });
  }

  // Raw-key variants (no idbKey namespacing) — used by the signed-out →
  // signed-in migration, which moves blobs BETWEEN namespaces.
  async function idbGetRaw(rawKey) {
    const db = await openLocalIDB();
    if (!db) return null;
    return new Promise((res) => {
      const tx = db.transaction('pdfs', 'readonly');
      const r = tx.objectStore('pdfs').get(rawKey);
      r.onsuccess = () => res(r.result ?? null);
      r.onerror = () => res(null);
    });
  }

  async function idbPutRaw(rawKey, value) {
    const db = await openLocalIDB();
    if (!db) return;
    await new Promise((res) => {
      const tx = db.transaction('pdfs', 'readwrite');
      tx.objectStore('pdfs').put(value, rawKey);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  }

  async function idbDeleteRaw(rawKey) {
    const db = await openLocalIDB();
    if (!db) return;
    await new Promise((res) => {
      const tx = db.transaction('pdfs', 'readwrite');
      tx.objectStore('pdfs').delete(rawKey);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  }

  function docToRow(doc) {
    return {
      id: doc.id,
      // Column name is historical; the value is the Supabase user id.
      owner_email: userId,
      name: doc.name,
      mode: doc.mode,
      badge: doc.badge || null,
      url: doc.url || null,
      conversation_summary: doc.conversationSummary || null,
      summary_message_count: doc.summaryMessageCount || 0,
      citation_format: doc.citationFormat || null,
      updated_at: new Date(doc.updated || Date.now()).toISOString(),
    };
  }

  function rowToDoc(row, discussions) {
    return {
      id: row.id,
      name: row.name,
      mode: row.mode,
      badge: row.badge,
      url: row.url,
      updated: new Date(row.updated_at).getTime(),
      conversationSummary: row.conversation_summary,
      summaryMessageCount: row.summary_message_count || 0,
      citationFormat: row.citation_format || null,
      discussions: discussions || [],
    };
  }

  // ── Supabase load / save ──────────────────────────────────────────────

  async function loadFromCloud() {
    if (!userId) return;

    const [docRes, discRes, msgRes, rlRes] = await Promise.all([
      supabase.from('documents').select('*').eq('owner_email', userId).order('updated_at', { ascending: false }),
      supabase.from('discussions').select('*').eq('owner_email', userId),
      supabase.from('messages').select('*').eq('owner_email', userId).order('sort_order', { ascending: true }),
      supabase.from('read_later').select('*').eq('owner_email', userId).order('added_at', { ascending: false }),
    ]);
    if (docRes.error) throw docRes.error;
    if (discRes.error) throw discRes.error;
    if (msgRes.error) throw msgRes.error;
    if (rlRes.error) throw rlRes.error;

    const docRows = docRes.data;
    const discRows = discRes.data;
    const msgRows = msgRes.data;
    const rlRows = rlRes.data;

    const msgsByDisc = {};
    for (const m of msgRows || []) {
      if (!msgsByDisc[m.discussion_id]) msgsByDisc[m.discussion_id] = [];
      msgsByDisc[m.discussion_id].push({
        role: m.role,
        content: m.content,
        ...(m.hidden ? { hidden: true } : {}),
      });
    }

    const discsByDoc = {};
    for (const d of discRows || []) {
      if (!discsByDoc[d.document_id]) discsByDoc[d.document_id] = [];
      discsByDoc[d.document_id].push({
        id: d.id,
        txt: d.txt,
        mode: d.mode,
        pageNum: d.page_num,
        color: d.color,
        relRects: d.rel_rects || [],
        citationMeta: d.citation_meta || null,
        mathKind: d.math?.kind || null,
        mathTex: d.math?.tex || null,
        messages: msgsByDisc[d.id] || [],
      });
    }

    const store = {};
    for (const row of docRows || []) {
      store[row.id] = rowToDoc(row, discsByDoc[row.id] || []);
    }
    docs = store;

    readLater = (rlRows || []).map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      mode: r.mode,
      docId: r.doc_id,
      citationText: r.citation_text,
      sourceDoc: r.source_doc,
      refText: r.ref_text,
      addedAt: new Date(r.added_at).getTime(),
    }));
  }

  // Serialize cloud saves per document. saveDocToCloud does a delete-then-insert
  // of discussions, so two overlapping saves for the same doc (e.g. seeding a
  // discussion then immediately sending its first message) would both delete and
  // then both insert the same discussion id → duplicate-key (Postgres 23505).
  // Chaining keeps them strictly sequential, last write wins with full data.
  const cloudSaveChains = {};
  async function saveDocToCloud(doc) {
    const prev = cloudSaveChains[doc.id] || Promise.resolve();
    const run = prev.catch(() => {}).then(() => saveDocToCloudInner(doc));
    cloudSaveChains[doc.id] = run;
    try {
      return await run;
    } finally {
      if (cloudSaveChains[doc.id] === run) delete cloudSaveChains[doc.id];
    }
  }

  async function saveDocToCloudInner(doc) {
    // Composite primary key (owner_email, id): rows are unique per user, so two
    // accounts can hold the same content-addressed paper without colliding.
    // upsert must resolve conflicts on BOTH key columns.
    const { error: docErr } = await supabase
      .from('documents')
      .upsert(docToRow(doc), { onConflict: 'owner_email,id' });
    if (docErr) throw docErr;

    // Delete this user's discussions for the doc, then re-insert. Scoped by
    // owner_email as well as document_id so it can never touch another account's
    // rows for the same shared document id (RLS enforces this too).
    const { error: delErr } = await supabase
      .from('discussions')
      .delete()
      .eq('owner_email', userId)
      .eq('document_id', doc.id);
    if (delErr) throw delErr;

    for (const d of doc.discussions || []) {
      const { error: discErr } = await supabase.from('discussions').upsert({
        id: d.id,
        document_id: doc.id,
        owner_email: userId,
        txt: d.txt || '',
        mode: d.mode || doc.mode,
        page_num: d.pageNum ?? null,
        color: d.color || null,
        rel_rects: d.relRects || [],
        citation_meta: d.citationMeta || null,
        math: d.mathKind ? { kind: d.mathKind, tex: d.mathTex || null } : null,
      }, { onConflict: 'owner_email,id' });
      if (discErr) throw discErr;

      const messages = (d.messages || []).map((m, i) => ({
        discussion_id: d.id,
        owner_email: userId,
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content || '',
        hidden: !!m.hidden,
        sort_order: i,
      }));

      if (messages.length) {
        const { error: msgErr } = await supabase.from('messages').insert(messages);
        if (msgErr) throw msgErr;
      }
    }
  }

  function ratingToRow(rec) {
    return {
      id: rec.id,
      owner_email: userId,
      rating: rec.rating,
      reason: rec.reason || null,
      selected_text: rec.selectedText || '',
      selected_text_kind: rec.selectedTextKind || 'text',
      math_kind: rec.mathKind || null,
      question: rec.question || '',
      response: rec.response || '',
      model: rec.model || null,
      doc_id: rec.docId || null,
      paper_title: rec.paperTitle || null,
      paper_url: rec.paperUrl || null,
      discussion_id: rec.discussionId ?? null,
      message_index: rec.messageIndex ?? null,
      citation_meta: rec.citationMeta || null,
      session_id: rec.sessionId || null,
      user_id: rec.userId || null,
      schema_version: rec.schemaVersion || 1,
      created_at: new Date(rec.createdAt || Date.now()).toISOString(),
      updated_at: new Date(rec.updatedAt || Date.now()).toISOString(),
    };
  }

  function rowToRating(row) {
    return {
      id: row.id,
      schemaVersion: row.schema_version || 1,
      rating: row.rating,
      reason: row.reason || null,
      selectedText: row.selected_text || '',
      selectedTextKind: row.selected_text_kind || 'text',
      mathKind: row.math_kind || null,
      question: row.question || '',
      response: row.response || '',
      model: row.model || null,
      docId: row.doc_id || null,
      paperTitle: row.paper_title || null,
      paperUrl: row.paper_url || null,
      discussionId: row.discussion_id,
      messageIndex: row.message_index,
      citationMeta: row.citation_meta || null,
      sessionId: row.session_id || null,
      userId: row.user_id || null,
      createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
    };
  }

  // ── Ratings ("golden set") cloud mirror ──────────────────────────────────
  // Local-first: the frontend always writes to its own IndexedDB; when cloud is
  // configured we also upsert here so ratings aggregate across devices.
  async function saveRating(rec) {
    if (!useCloud || !userId) return;
    try {
      const { error } = await supabase.from('ratings').upsert(ratingToRow(rec), { onConflict: 'owner_email,id' });
      if (error) throw error;
      setSyncError(null);
    } catch (e) { setSyncError(e); throw e; }
  }

  async function deleteRating(id) {
    if (!useCloud || !userId) return;
    try {
      const { error } = await supabase.from('ratings').delete().eq('id', id).eq('owner_email', userId);
      if (error) throw error;
    } catch (e) { setSyncError(e); throw e; }
  }

  async function getRatingsFromCloud() {
    if (!useCloud || !userId) return [];
    const { data, error } = await supabase
      .from('ratings').select('*').eq('owner_email', userId)
      .order('updated_at', { ascending: false });
    if (error) throw error;
    return (data || []).map(rowToRating);
  }

  async function saveReadLaterToCloud(item) {
    const { error } = await supabase.from('read_later').upsert({
      id: item.id,
      owner_email: userId,
      title: item.title,
      url: item.url || null,
      mode: item.mode || null,
      doc_id: item.docId || null,
      citation_text: item.citationText || null,
      source_doc: item.sourceDoc || null,
      ref_text: item.refText || null,
      added_at: new Date(item.addedAt || Date.now()).toISOString(),
    }, { onConflict: 'owner_email,id' });
    if (error) throw error;
  }

  async function syncAllToCloud() {
    if (!useCloud || !userId) return true;
    let ok = true;
    for (const doc of Object.values(docs)) {
      try { await saveDocToCloud(doc); }
      catch (e) { ok = false; setSyncError(e); }
    }
    for (const item of readLater) {
      try { await saveReadLaterToCloud(item); }
      catch (e) { ok = false; setSyncError(e); }
    }
    if (ok) setSyncError(null);
    return ok;
  }

  async function refreshFromCloud() {
    if (!useCloud || !userId || !supabase) return;
    const refreshFor = userId;

    const localDocsSnapshot = loadLocalDocs();
    const localRlSnapshot = loadLocalReadLater();
    let cloudDocs = {};

    try {
      await loadFromCloud();
      if (userId !== refreshFor) return;
      cloudDocs = { ...docs };
    } catch (e) {
      if (userId !== refreshFor) return;
      setSyncError(e);
      mergeLocalDocs();
      mergeLocalReadLater();
      saveLocalDocs(docs);
      saveLocalReadLater(readLater);
      return;
    }

    const toPush = [];
    for (const [id, localDoc] of Object.entries(localDocsSnapshot)) {
      const cloudDoc = cloudDocs[id];
      if (!cloudDoc || (localDoc.updated || 0) > (cloudDoc.updated || 0)) {
        toPush.push(localDoc);
      }
    }

    mergeLocalDocs();
    mergeLocalReadLater();

    const cloudRlIds = new Set(readLater.map((i) => i.id));
    const rlToPush = localRlSnapshot.filter((i) => !cloudRlIds.has(i.id));

    if (userId !== refreshFor) return;
    saveLocalDocs(docs);
    saveLocalReadLater(readLater);

    let ok = true;
    for (const doc of toPush) {
      if (userId !== refreshFor) return;
      try { await saveDocToCloud(doc); }
      catch (e) { ok = false; setSyncError(e); }
    }
    for (const item of rlToPush) {
      if (userId !== refreshFor) return;
      try { await saveReadLaterToCloud(item); }
      catch (e) { ok = false; setSyncError(e); }
    }
    if (userId !== refreshFor) return;
    if (ok) setSyncError(null);
  }

  function startCloudRefresh() {
    if (!useCloud || !userId || !supabase) return Promise.resolve();
    if (cloudRefreshPromise) return cloudRefreshPromise;
    notifyChange();
    cloudRefreshPromise = refreshFromCloud()
      .finally(() => {
        cloudRefreshPromise = null;
        notifyChange();
      });
    return cloudRefreshPromise;
  }

  async function deleteDocFromCloud(docId) {
    // Scope by owner as well as id: the id is shared across users (composite PK),
    // so an id-only delete could target another account's row (RLS blocks it,
    // but being explicit avoids relying on that alone).
    const { error } = await supabase.from('documents').delete().eq('owner_email', userId).eq('id', docId);
    if (error) throw error;
    try {
      await supabase.storage.from('pdfs').remove([`${userPathKey(userId)}/${docId}`]);
    } catch (e) { console.warn('PDF delete:', e); }
  }

  async function putPdfToCloud(docId, blob) {
    const path = `${userPathKey(userId)}/${docId}`;
    const { error } = await supabase.storage.from('pdfs').upload(path, blob, {
      upsert: true,
      contentType: 'application/pdf',
    });
    if (error) throw error;
  }

  // ── Session / auth plumbing ─────────────────────────────────────────────

  function applySession(session) {
    identity = identityFromSession(session);
    userId = identity ? identity.id : null;
  }

  // ── Signed-out → signed-in migration ────────────────────────────────────
  // Design principle: signed-out is a full, device-local experience; signing
  // in exists for cross-device transfer. So on sign-in, everything created
  // while signed out (docs, discussions, read-later, PDF/figure blobs) moves
  // into the account namespace, then the `.local` copies are cleared. One-way:
  // local → account only. The cloud upload itself is handled by the normal
  // refreshFromCloud push (it uploads local docs the cloud doesn't have yet);
  // only PDF blobs need explicit handling here.

  // Mirrors isUntouchedOnboardingDemo in js/onboarding.js (store.js is a plain
  // script, it can't import from the module graph). A doc whose highlights are
  // all pristine onboarding demos is seeded content, not user work — skip it.
  const DEMO_PROMPTS = ['Explain this math.', 'Translate this formula to code.'];
  function isUntouchedDemoDiscussion(d) {
    if (!d || !d.onboarding) return false;
    const msgs = d.messages || [];
    if (msgs.length === 0) return true;
    return msgs.length === 2
      && msgs[0].role === 'user' && DEMO_PROMPTS.includes(msgs[0].content)
      && msgs[1].role === 'assistant';
  }
  function isUntouchedDemoDoc(doc) {
    const discs = doc && Array.isArray(doc.discussions) ? doc.discussions : [];
    return discs.length > 0 && discs.every(isUntouchedDemoDiscussion);
  }

  function readLocalNamespace(base) {
    try { return JSON.parse(localStorage.getItem(base + '.local')); }
    catch { return null; }
  }

  // Synchronous localStorage move (docs + read-later); kicks off the async
  // blob move. Runs on every transition to a signed-in session — a no-op when
  // `.local` is empty, so it is safely idempotent.
  function migrateLocalDataToAccount() {
    if (!userId) return;
    const localDocs = readLocalNamespace(STORE_BASE) || {};
    const localRl = readLocalNamespace(READ_LATER_BASE);
    const moved = [];

    const mine = loadLocalDocs(); // account namespace (cloud merge comes later)
    for (const [id, doc] of Object.entries(localDocs)) {
      if (!doc || isUntouchedDemoDoc(doc)) continue;
      const existing = mine[id];
      if (!existing) {
        mine[id] = doc;
      } else {
        // Same paper touched both signed out and in: keep the account copy,
        // adopt any local discussions it doesn't have.
        const have = new Set((existing.discussions || []).map((d) => d && d.id));
        for (const d of doc.discussions || []) {
          if (d && !have.has(d.id)) (existing.discussions = existing.discussions || []).push(d);
        }
        existing.updated = Math.max(existing.updated || 0, doc.updated || 0);
      }
      moved.push(doc);
    }
    if (moved.length) saveLocalDocs(mine);

    if (Array.isArray(localRl) && localRl.length) {
      const rl = loadLocalReadLater();
      const have = new Set(rl.map((i) => i.id));
      let changed = false;
      for (const item of localRl) {
        if (item && !have.has(item.id)) { rl.push(item); changed = true; }
      }
      if (changed) {
        rl.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        saveLocalReadLater(rl);
      }
    }

    try {
      localStorage.removeItem(STORE_BASE + '.local');
      localStorage.removeItem(READ_LATER_BASE + '.local');
    } catch { /* clearing is best-effort */ }

    if (moved.length) {
      void migrateLocalBlobsToAccount(moved).catch((e) =>
        console.warn('Local blob migration failed (docs migrated, PDFs may need re-upload):', e));
    }
  }

  // Move IndexedDB blobs (PDF bytes + captured figures) from the `local::`
  // namespace to the account's, and upload PDFs to cloud storage so the paper
  // opens on other devices too. Best-effort.
  async function migrateLocalBlobsToAccount(movedDocs) {
    const uid = userId;
    if (!uid) return;
    for (const doc of movedDocs) {
      const keys = [doc.id];
      for (const d of doc.discussions || []) {
        if (d && d.figure && d.figure.imageKey) keys.push(d.figure.imageKey);
      }
      for (const key of keys) {
        const val = await idbGetRaw('local::' + key);
        if (val == null) continue;
        await idbPutRaw(uid + '::' + key, val);
        await idbDeleteRaw('local::' + key);
        if (key === doc.id && doc.mode === 'pdf' && useCloud && userId === uid) {
          try { await putPdfToCloud(doc.id, val); }
          catch (e) { console.warn('Migrated PDF upload failed for', doc.id, e); }
        }
      }
    }
  }

  function loadLocalState() {
    // Signed out (with or without cloud configured) reads the `.local`
    // namespace: the signed-out experience is fully equivalent to signed-in,
    // just device-local. Signing in migrates it — see migrateLocalDataToAccount.
    docs = loadLocalDocs();
    readLater = loadLocalReadLater();
  }

  // After the OAuth redirect lands back on the app, supabase-js (PKCE +
  // detectSessionInUrl) exchanges the ?code= itself; we just tidy the URL so a
  // reload/bookmark is clean.
  function cleanAuthParamsFromUrl() {
    try {
      const url = new URL(window.location.href);
      let changed = false;
      for (const p of ['code', 'state', 'error', 'error_code', 'error_description']) {
        if (url.searchParams.has(p)) { url.searchParams.delete(p); changed = true; }
      }
      if (window.location.hash && /access_token|refresh_token|error/.test(window.location.hash)) {
        url.hash = '';
        changed = true;
      }
      if (changed && window.history && window.history.replaceState) {
        window.history.replaceState(null, '', url.toString());
      }
    } catch (_) { /* URL cleanup is cosmetic — never fail init over it */ }
  }

  function subscribeToAuthChanges() {
    if (authSubscribed || !supabase) return;
    authSubscribed = true;
    supabase.auth.onAuthStateChange((_event, session) => {
      const prevUserId = userId;
      applySession(session);
      if (userId === prevUserId) { notifyChange(); return; }
      useCloud = !!(supabase && userId);
      if (userId) migrateLocalDataToAccount();
      loadLocalState();
      notifyChange();
      if (useCloud) startCloudRefresh();
      if (typeof window.onPaperStoreAuthChange === 'function') {
        window.onPaperStoreAuthChange();
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────────────

  async function init() {
    dropLegacyData();
    ready = true;

    try {
      const r = await fetch('/api/config');
      const cfg = await r.json();
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
        supabase = null;
        applySession(null);
        useCloud = false;
        loadLocalState();
        return getSyncStatus();
      }

      supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: 'pkce',
        },
      });

      const { data } = await supabase.auth.getSession();
      applySession(data && data.session ? data.session : null);
      subscribeToAuthChanges();
      cleanAuthParamsFromUrl();

      useCloud = !!userId;
      // Landing signed-in (e.g. back from the OAuth redirect) adopts whatever
      // was created while signed out on this device.
      if (userId) migrateLocalDataToAccount();
      loadLocalState();
      if (useCloud) startCloudRefresh();
      return getSyncStatus();
    } catch (e) {
      console.warn('Paper Reader: cloud init failed, falling back to local:', e);
      setSyncError(e);
      useCloud = false;
      loadLocalState();
      return { mode: 'local', error: friendlyError(e), email: identity ? identity.email : null };
    }
  }

  // Kicks off the Google OAuth redirect. The browser navigates away; the
  // session is established by init() when we land back.
  async function signInWithGoogle() {
    if (!supabase) throw new Error('Cloud is not configured — sign-in unavailable.');
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (error) { setSyncError(error); throw error; }
    return data;
  }

  async function signOut() {
    if (supabase) {
      try { await supabase.auth.signOut(); }
      catch (e) { console.warn('Supabase signOut failed:', e); }
    }
    // The SIGNED_OUT auth event normally clears state; do it directly too so
    // signOut() is deterministic even if the event doesn't fire.
    applySession(null);
    useCloud = false;
    loadLocalState();
    notifyChange();
    return getSyncStatus();
  }

  function getIdentity() { return identity; }

  function getUserId() { return userId; }

  function isSignedIn() { return !!userId; }

  // Back-compat display accessor (identity email, not a scoping key).
  function getEmail() { return identity ? identity.email : null; }

  function getSyncStatus() {
    return {
      mode: supabase ? 'cloud' : 'local',
      useCloud: useCloud && !!userId,
      signedIn: !!userId,
      identity,
      userId,
      email: identity ? identity.email : null,
      needsAuth: !!supabase && !userId,
      syncing: !!cloudRefreshPromise,
      lastSyncError,
      docCount: Object.keys(docs).length,
    };
  }

  function getStore() { return docs; }

  function getReadLater() { return readLater; }

  function isCloud() { return useCloud && !!userId; }

  // `expectedUserId` (optional) is the user id the CALLER captured when it
  // decided to save. If the session changed in between (sign-out event from
  // another tab, logout race), the save is stale — drop it instead of leaking
  // one namespace's data into another.
  async function saveDoc(doc, expectedUserId) {
    if (expectedUserId !== undefined && expectedUserId !== userId) return;
    docs[doc.id] = doc;
    saveLocalDocs(docs);
    if (!useCloud || !userId) return;
    try {
      await saveDocToCloud(doc);
      setSyncError(null);
    } catch (e) {
      setSyncError(e);
      throw e;
    }
  }

  async function deleteDoc(docId) {
    delete docs[docId];
    saveLocalDocs(docs);
    if (useCloud && userId) await deleteDocFromCloud(docId);
    const db = await openLocalIDB();
    if (db) {
      const tx = db.transaction('pdfs', 'readwrite');
      tx.objectStore('pdfs').delete(idbKey(docId));
    }
    await deleteFiguresForDoc(docId);
  }

  async function clearLibrary() {
    const ids = Object.keys(docs);
    docs = {};
    saveLocalDocs(docs);
    if (useCloud && userId) {
      for (const id of ids) await deleteDocFromCloud(id);
    }
    // Only clear THIS user's namespace — other accounts' blobs stay intact.
    const db = await openLocalIDB();
    if (db) {
      const prefix = (userId || 'local') + '::';
      await new Promise((res) => {
        const tx = db.transaction('pdfs', 'readwrite');
        const store = tx.objectStore('pdfs');
        const req = store.getAllKeys ? store.getAllKeys() : null;
        if (!req) { res(); return; }
        req.onsuccess = () => {
          for (const k of req.result || []) {
            if (typeof k === 'string' && k.startsWith(prefix)) store.delete(k);
          }
        };
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      });
    }
  }

  async function addReadLater(item) {
    const id = item.id || ('rl::' + (item.url || item.citationText || item.title || Date.now()));
    const entry = { ...item, id, addedAt: item.addedAt || Date.now() };
    if (readLater.some((i) => i.id === id)) return false;
    readLater.unshift(entry);
    saveLocalReadLater(readLater);
    if (useCloud && userId) {
      try {
        await saveReadLaterToCloud(entry);
        setSyncError(null);
      } catch (e) {
        setSyncError(e);
        throw e;
      }
    }
    return true;
  }

  async function removeReadLater(id) {
    readLater = readLater.filter((i) => i.id !== id);
    saveLocalReadLater(readLater);
    if (useCloud && userId) {
      await supabase.from('read_later').delete().eq('id', id).eq('owner_email', userId);
    }
  }

  async function clearReadLater() {
    readLater = [];
    saveLocalReadLater(readLater);
    if (useCloud && userId) {
      await supabase.from('read_later').delete().eq('owner_email', userId);
    }
  }

  async function putPdf(docId, blob) {
    const db = await openLocalIDB();
    if (db) {
      await new Promise((res) => {
        const tx = db.transaction('pdfs', 'readwrite');
        tx.objectStore('pdfs').put(blob, idbKey(docId));
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      });
    }
    if (useCloud && userId) {
      try {
        await putPdfToCloud(docId, blob);
      } catch (e) {
        setSyncError(e);
        throw e;
      }
    }
  }

  async function getPdf(docId) {
    if (useCloud && userId) {
      const path = `${userPathKey(userId)}/${docId}`;
      const { data, error } = await supabase.storage.from('pdfs').download(path);
      if (!error && data) return data;
    }
    return idbGetLocal(docId);
  }

  // ── Captured figure images ───────────────────────────────────────────────
  // Figure screenshots can be hundreds of KB, so they live in IndexedDB (the
  // same local `pdfs` object store that holds PDF bytes) instead of the
  // localStorage doc state, which would blow the ~5MB quota. They are keyed by
  // `fig::<docId>::<discId>` so they sit alongside (and never collide with) the
  // PDF blob keyed by plain docId. Local-only: the value is a small JSON record
  // { dataUrl, mediaType, w, h }. Not mirrored to cloud storage — figure
  // discussions restore from the device that captured them.
  async function putFigure(key, record) {
    const db = await openLocalIDB();
    if (!db) return;
    await new Promise((res) => {
      const tx = db.transaction('pdfs', 'readwrite');
      tx.objectStore('pdfs').put(record, idbKey(key));
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  }

  async function getFigure(key) {
    return idbGetLocal(key);
  }

  // Remove every figure blob belonging to a document (called on doc delete so
  // captured images don't leak after the doc is gone).
  async function deleteFiguresForDoc(docId) {
    const db = await openLocalIDB();
    if (!db) return;
    const prefix = idbKey(`fig::${docId}::`);
    await new Promise((res) => {
      const tx = db.transaction('pdfs', 'readwrite');
      const store = tx.objectStore('pdfs');
      const req = store.getAllKeys ? store.getAllKeys() : null;
      if (!req) { res(); return; }
      req.onsuccess = () => {
        for (const k of req.result || []) {
          if (typeof k === 'string' && k.startsWith(prefix)) store.delete(k);
        }
      };
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  }

  return {
    init,
    ready,
    isCloud,
    signInWithGoogle,
    signOut,
    getIdentity,
    getUserId,
    isSignedIn,
    getEmail,
    getStore,
    getReadLater,
    getSyncStatus,
    saveDoc,
    deleteDoc,
    clearLibrary,
    addReadLater,
    removeReadLater,
    clearReadLater,
    saveRating,
    deleteRating,
    getRatingsFromCloud,
    putPdf,
    getPdf,
    putFigure,
    getFigure,
    deleteFiguresForDoc,
    syncAllToCloud,
    getClient: () => supabase,
    // Pure helpers exposed for unit tests (no app behaviour depends on these
    // being public).
    _internals: {
      identityFromSession, storageKeyForUser, userPathKey, legacyKeysToClear, dropLegacyData,
      isUntouchedDemoDoc, migrateLocalDataToAccount,
    },
  };
})();
