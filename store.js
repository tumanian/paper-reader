// Cloud + local persistence. Supabase stores data by owner_email — no magic links.
// Enter your email once; it's saved in localStorage and reused on every visit.
window.PaperStore = (function () {
  const STORE_KEY = 'paperReader.docs.v1';
  const READ_LATER_KEY = 'paperReader.readLater.v1';
  const EMAIL_KEY = 'paperReader.email.v1';

  let supabase = null;
  let ownerEmail = null;
  let useCloud = false;
  let ready = false;
  let lastSyncError = null;
  let docs = {};
  let readLater = [];

  function friendlyError(e) {
    const msg = e?.message || String(e);
    const code = e?.code || '';
    if (code === 'PGRST205' || (msg.includes('relation') && msg.includes('does not exist'))) {
      return 'Database tables missing — run supabase/schema.sql (or migrate-to-email.sql).';
    }
    if (code === '42703' && msg.includes('owner_email')) {
      return 'Database needs migration — run supabase/migrate-to-email.sql in Supabase SQL Editor.';
    }
    if (code === '42501' || msg.toLowerCase().includes('row-level security')) {
      return 'Database permission error — run supabase/migrate-to-email.sql for open RLS policies.';
    }
    return msg;
  }

  function setSyncError(e) {
    lastSyncError = e ? friendlyError(e) : null;
    if (e) console.error('Paper Reader sync error:', e);
    if (typeof window.onPaperStoreSyncChange === 'function') {
      window.onPaperStoreSyncChange(getSyncStatus());
    }
  }

  function emailPathKey(email) {
    return btoa(email.toLowerCase()).replace(/[^a-zA-Z0-9]/g, '').slice(0, 48);
  }

  function getEmail() {
    return ownerEmail || localStorage.getItem(EMAIL_KEY) || null;
  }

  function normalizeEmail(raw) {
    const email = String(raw || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error('Enter a valid email address.');
    }
    return email;
  }

  // ── Local helpers ───────────────────────────────────────────────────────

  function loadLocalDocs() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch { return {}; }
  }

  function saveLocalDocs(store) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); }
    catch (e) { console.warn('Local backup failed:', e); }
  }

  function loadLocalReadLater() {
    try { return JSON.parse(localStorage.getItem(READ_LATER_KEY)) || []; }
    catch { return []; }
  }

  function saveLocalReadLater(items) {
    try { localStorage.setItem(READ_LATER_KEY, JSON.stringify(items)); }
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
      const req = indexedDB.open('paperReader.files', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('pdfs')) db.createObjectStore('pdfs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  async function idbGetLocal(key) {
    const db = await openLocalIDB();
    if (!db) return null;
    return new Promise((res) => {
      const tx = db.transaction('pdfs', 'readonly');
      const r = tx.objectStore('pdfs').get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });
  }

  function docToRow(doc) {
    return {
      id: doc.id,
      owner_email: ownerEmail,
      name: doc.name,
      mode: doc.mode,
      badge: doc.badge || null,
      url: doc.url || null,
      conversation_summary: doc.conversationSummary || null,
      summary_message_count: doc.summaryMessageCount || 0,
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
      discussions: discussions || [],
    };
  }

  // ── Supabase load / save ──────────────────────────────────────────────

  async function loadFromCloud() {
    if (!ownerEmail) return;

    const { data: docRows, error: docErr } = await supabase
      .from('documents')
      .select('*')
      .eq('owner_email', ownerEmail)
      .order('updated_at', { ascending: false });
    if (docErr) throw docErr;

    const { data: discRows, error: discErr } = await supabase
      .from('discussions')
      .select('*')
      .eq('owner_email', ownerEmail);
    if (discErr) throw discErr;

    const { data: msgRows, error: msgErr } = await supabase
      .from('messages')
      .select('*')
      .eq('owner_email', ownerEmail)
      .order('sort_order', { ascending: true });
    if (msgErr) throw msgErr;

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
        messages: msgsByDisc[d.id] || [],
      });
    }

    const store = {};
    for (const row of docRows || []) {
      store[row.id] = rowToDoc(row, discsByDoc[row.id] || []);
    }
    docs = store;

    const { data: rlRows, error: rlErr } = await supabase
      .from('read_later')
      .select('*')
      .eq('owner_email', ownerEmail)
      .order('added_at', { ascending: false });
    if (rlErr) throw rlErr;

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

  async function saveDocToCloud(doc) {
    const { error: docErr } = await supabase.from('documents').upsert(docToRow(doc));
    if (docErr) throw docErr;

    // Delete all discussions for this doc (including legacy rows with null owner_email).
    const { error: delErr } = await supabase
      .from('discussions')
      .delete()
      .eq('document_id', doc.id);
    if (delErr) throw delErr;

    for (const d of doc.discussions || []) {
      const { error: discErr } = await supabase.from('discussions').insert({
        id: d.id,
        document_id: doc.id,
        owner_email: ownerEmail,
        txt: d.txt || '',
        mode: d.mode || doc.mode,
        page_num: d.pageNum ?? null,
        color: d.color || null,
        rel_rects: d.relRects || [],
        citation_meta: d.citationMeta || null,
      });
      if (discErr) throw discErr;

      const messages = (d.messages || []).map((m, i) => ({
        discussion_id: d.id,
        owner_email: ownerEmail,
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

  async function saveReadLaterToCloud(item) {
    const { error } = await supabase.from('read_later').upsert({
      id: item.id,
      owner_email: ownerEmail,
      title: item.title,
      url: item.url || null,
      mode: item.mode || null,
      doc_id: item.docId || null,
      citation_text: item.citationText || null,
      source_doc: item.sourceDoc || null,
      ref_text: item.refText || null,
      added_at: new Date(item.addedAt || Date.now()).toISOString(),
    });
    if (error) throw error;
  }

  async function syncAllToCloud() {
    if (!useCloud || !ownerEmail) return true;
    let ok = true;
    for (const doc of Object.values(docs)) {
      try {
        await saveDocToCloud(doc);
        const blob = await idbGetLocal(doc.id);
        if (blob && doc.mode === 'pdf') {
          try { await putPdfToCloud(doc.id, blob); }
          catch (e) { ok = false; setSyncError(e); }
        }
      } catch (e) {
        ok = false;
        setSyncError(e);
      }
    }
    for (const item of readLater) {
      try { await saveReadLaterToCloud(item); }
      catch (e) { ok = false; setSyncError(e); }
    }
    if (ok) setSyncError(null);
    return ok;
  }

  async function deleteDocFromCloud(docId) {
    const { error } = await supabase.from('documents').delete().eq('id', docId);
    if (error) throw error;
    try {
      await supabase.storage.from('pdfs').remove([`${emailPathKey(ownerEmail)}/${docId}`]);
    } catch (e) { console.warn('PDF delete:', e); }
  }

  async function putPdfToCloud(docId, blob) {
    const path = `${emailPathKey(ownerEmail)}/${docId}`;
    const { error } = await supabase.storage.from('pdfs').upload(path, blob, {
      upsert: true,
      contentType: 'application/pdf',
    });
    if (error) throw error;
  }

  async function reloadForEmail() {
    let loadFailed = false;
    try {
      await loadFromCloud();
    } catch (e) {
      loadFailed = true;
      setSyncError(e);
      docs = {};
      readLater = [];
    }
    mergeLocalDocs();
    mergeLocalReadLater();
    saveLocalDocs(docs);
    saveLocalReadLater(readLater);
    const syncOk = await syncAllToCloud();
    if (!loadFailed && syncOk) setSyncError(null);
  }

  // ── Public API ────────────────────────────────────────────────────────

  async function init() {
    try {
      const r = await fetch('/api/config');
      const cfg = await r.json();
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
        ownerEmail = getEmail();
        docs = loadLocalDocs();
        readLater = loadLocalReadLater();
        ready = true;
        return { mode: 'local', email: ownerEmail };
      }

      supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      ownerEmail = getEmail();

      if (!ownerEmail) {
        docs = loadLocalDocs();
        readLater = loadLocalReadLater();
        ready = true;
        return { mode: 'cloud', needsEmail: true };
      }

      useCloud = true;
      await reloadForEmail();
      ready = true;
      return getSyncStatus();
    } catch (e) {
      console.warn('Paper Reader: cloud init failed, falling back to local:', e);
      setSyncError(e);
      ownerEmail = getEmail();
      docs = loadLocalDocs();
      readLater = loadLocalReadLater();
      useCloud = false;
      ready = true;
      return { mode: 'local', error: friendlyError(e), email: ownerEmail };
    }
  }

  async function setEmail(raw) {
    const email = normalizeEmail(raw);
    localStorage.setItem(EMAIL_KEY, email);
    ownerEmail = email;
    useCloud = !!supabase;

    if (!useCloud) {
      return getSyncStatus();
    }

    await reloadForEmail();
    if (typeof window.onPaperStoreAuthChange === 'function') {
      window.onPaperStoreAuthChange();
    }
    return getSyncStatus();
  }

  function clearEmail() {
    localStorage.removeItem(EMAIL_KEY);
    ownerEmail = null;
    if (supabase) {
      docs = loadLocalDocs();
      readLater = loadLocalReadLater();
      return { mode: 'cloud', needsEmail: true };
    }
    return getSyncStatus();
  }

  function getSyncStatus() {
    return {
      mode: useCloud ? 'cloud' : (supabase ? 'cloud' : 'local'),
      useCloud: useCloud && !!ownerEmail,
      email: ownerEmail,
      needsEmail: supabase && !ownerEmail,
      lastSyncError,
      docCount: Object.keys(docs).length,
    };
  }

  function getStore() { return docs; }

  function getReadLater() { return readLater; }

  function isCloud() { return useCloud && !!ownerEmail; }

  async function saveDoc(doc) {
    docs[doc.id] = doc;
    saveLocalDocs(docs);
    if (!useCloud || !ownerEmail) return;
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
    if (useCloud && ownerEmail) await deleteDocFromCloud(docId);
    const db = await openLocalIDB();
    if (db) {
      const tx = db.transaction('pdfs', 'readwrite');
      tx.objectStore('pdfs').delete(docId);
    }
  }

  async function clearLibrary() {
    const ids = Object.keys(docs);
    docs = {};
    saveLocalDocs(docs);
    if (useCloud && ownerEmail) {
      for (const id of ids) await deleteDocFromCloud(id);
    }
    const db = await openLocalIDB();
    if (db) {
      const tx = db.transaction('pdfs', 'readwrite');
      tx.objectStore('pdfs').clear();
    }
  }

  async function addReadLater(item) {
    const id = item.id || ('rl::' + (item.url || item.citationText || item.title || Date.now()));
    const entry = { ...item, id, addedAt: item.addedAt || Date.now() };
    if (readLater.some((i) => i.id === id)) return false;
    readLater.unshift(entry);
    saveLocalReadLater(readLater);
    if (useCloud && ownerEmail) {
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
    if (useCloud && ownerEmail) {
      await supabase.from('read_later').delete().eq('id', id).eq('owner_email', ownerEmail);
    }
  }

  async function clearReadLater() {
    readLater = [];
    saveLocalReadLater(readLater);
    if (useCloud && ownerEmail) {
      await supabase.from('read_later').delete().eq('owner_email', ownerEmail);
    }
  }

  async function putPdf(docId, blob) {
    const db = await openLocalIDB();
    if (db) {
      await new Promise((res) => {
        const tx = db.transaction('pdfs', 'readwrite');
        tx.objectStore('pdfs').put(blob, docId);
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      });
    }
    if (useCloud && ownerEmail) {
      try {
        await putPdfToCloud(docId, blob);
      } catch (e) {
        setSyncError(e);
        throw e;
      }
    }
  }

  async function getPdf(docId) {
    if (useCloud && ownerEmail) {
      const path = `${emailPathKey(ownerEmail)}/${docId}`;
      const { data, error } = await supabase.storage.from('pdfs').download(path);
      if (!error && data) return data;
    }
    return idbGetLocal(docId);
  }

  return {
    init,
    ready,
    isCloud,
    getEmail,
    setEmail,
    clearEmail,
    getStore,
    getReadLater,
    getSyncStatus,
    saveDoc,
    deleteDoc,
    clearLibrary,
    addReadLater,
    removeReadLater,
    clearReadLater,
    putPdf,
    getPdf,
    syncAllToCloud,
    getClient: () => supabase,
  };
})();
