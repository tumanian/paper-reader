import { simpleHash } from './util.js';
import {
  discussions, currentDocId, docMeta, conversationSummary, summaryMessageCount, summaryDirty, citationFormat,
  setConversationSummary, setSummaryMessageCount, setSummaryDirty,
} from './state.js';

// ═══════════════════════════════════════════════════════
//  PERSISTENCE LAYER  (localStorage + PaperStore)
// ═══════════════════════════════════════════════════════
export const STORE_KEY = 'paperReader.docs.v1';
export const READ_LATER_KEY = 'paperReader.readLater.v1';
export const SCHEMA_META_KEY = 'paperReader.schema.v1';
export const SCHEMA_VERSION = 2;

// Optional UI hooks so persistence stays decoupled from library/auth rendering.
let _onCloudSaveError = () => {};
let _onAfterSummaryPersist = () => {};
export function setPersistenceHooks({ onCloudSaveError, onAfterSummaryPersist } = {}) {
  if (onCloudSaveError) _onCloudSaveError = onCloudSaveError;
  if (onAfterSummaryPersist) _onAfterSummaryPersist = onAfterSummaryPersist;
}

// docs = { [docId]: { id, name, mode, badge, url, updated, discussions: [...] } }
export function migrateDoc(doc, docId) {
  if (!doc || typeof doc !== 'object') return null;
  const m = { ...doc };
  let changed = false;

  const setDefault = (key, value) => {
    if (m[key] === undefined) { m[key] = value; changed = true; }
  };

  setDefault('id', docId);
  setDefault('name', docId);
  setDefault('mode', docId.startsWith('web::') ? 'web' : 'pdf');
  setDefault('badge', m.mode === 'pdf' ? 'PDF' : 'Web');
  setDefault('url', null);
  setDefault('updated', Date.now());
  setDefault('conversationSummary', null);
  setDefault('summaryMessageCount', 0);

  if (!Array.isArray(m.discussions)) {
    m.discussions = [];
    changed = true;
  }

  m.discussions = m.discussions.map(d => {
    if (!d || typeof d !== 'object') { changed = true; return null; }
    const nd = { ...d };
    const setDefaultOn = (obj, key, val) => {
      if (obj[key] === undefined) { obj[key] = val; changed = true; }
    };
    setDefaultOn(nd, 'id', Date.now());
    setDefaultOn(nd, 'txt', '');
    setDefaultOn(nd, 'mode', m.mode);
    setDefaultOn(nd, 'pageNum', null);
    setDefaultOn(nd, 'citationMeta', null);
    setDefaultOn(nd, 'relRects', []);
    setDefaultOn(nd, 'color', { bg:'rgba(255,215,0,.45)', dot:'#c9a000' });

    if (!Array.isArray(nd.messages)) {
      nd.messages = [];
      changed = true;
    } else {
      nd.messages = nd.messages.map(msg => {
        if (!msg || typeof msg !== 'object') { changed = true; return null; }
        const nm = { ...msg };
        if (nm.role !== 'assistant' && nm.role !== 'user') {
          nm.role = 'user';
          changed = true;
        }
        if (typeof nm.content !== 'string') {
          nm.content = nm.content == null ? '' : String(nm.content);
          changed = true;
        }
        return nm;
      }).filter(Boolean);
    }
    return nd;
  }).filter(Boolean);

  return { doc: m, changed };
}

export function migrateStore(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { store: {}, changed: !!raw };
  }
  const store = {};
  let changed = false;
  for (const [docId, doc] of Object.entries(raw)) {
    const result = migrateDoc(doc, docId);
    if (!result) { changed = true; continue; }
    store[docId] = result.doc;
    if (result.changed) changed = true;
  }
  if (Object.keys(raw).length !== Object.keys(store).length) changed = true;
  return { store, changed };
}

export function migrateReadLaterList(raw) {
  if (raw == null) return { items: [], changed: false };
  if (!Array.isArray(raw)) return { items: [], changed: true };
  const items = [];
  let changed = false;
  for (const item of raw) {
    if (!item || typeof item !== 'object') { changed = true; continue; }
    const m = { ...item };
    if (!m.id) {
      m.id = 'rl::' + simpleHash(m.url || m.citationText || m.title || String(m.addedAt || Date.now()));
      changed = true;
    }
    if (!m.title) { m.title = 'Untitled'; changed = true; }
    if (m.url === undefined) { m.url = null; changed = true; }
    if (m.mode === undefined) { m.mode = m.url ? 'web' : null; changed = true; }
    if (m.docId === undefined) { m.docId = null; changed = true; }
    if (m.citationText === undefined) { m.citationText = null; changed = true; }
    if (m.sourceDoc === undefined) { m.sourceDoc = null; changed = true; }
    if (m.refText === undefined) { m.refText = null; changed = true; }
    if (!m.addedAt) { m.addedAt = Date.now(); changed = true; }
    items.push(m);
  }
  if (items.length !== raw.length) changed = true;
  return { items, changed };
}

export function initStorage() {
  let anyChanged = false;

  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const { store, changed } = migrateStore(parsed);
      if (changed) {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
        anyChanged = true;
        console.info('Paper Reader: migrated library store to schema v' + SCHEMA_VERSION);
      }
    }
  } catch (e) {
    console.warn('Paper Reader: library migration skipped — existing data left untouched:', e);
  }

  try {
    const raw = localStorage.getItem(READ_LATER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const { items, changed } = migrateReadLaterList(parsed);
      if (changed) {
        localStorage.setItem(READ_LATER_KEY, JSON.stringify(items));
        anyChanged = true;
        console.info('Paper Reader: migrated read-later list to schema v' + SCHEMA_VERSION);
      }
    }
  } catch (e) {
    console.warn('Paper Reader: read-later migration skipped — existing data left untouched:', e);
  }

  if (anyChanged) {
    try {
      localStorage.setItem(SCHEMA_META_KEY, JSON.stringify({
        version: SCHEMA_VERSION,
        migratedAt: Date.now(),
      }));
    } catch (e) { console.warn('Could not save schema metadata:', e); }
  }
}

export function loadStore() { return PaperStore.getStore(); }

export async function persistCurrentDoc() {
  if (!currentDocId) return;
  // Snapshot the owner now: if the session changes before the (async) save
  // lands (logout race, sign-out in another tab), saveDoc drops the stale
  // write instead of leaking this doc into the wrong namespace.
  const owner = PaperStore.getUserId();
  const store = loadStore();
  const prior = store[currentDocId];
  if (prior && prior.discussions && prior.discussions.length > 0 && discussions.length === 0) {
    console.warn('persistCurrentDoc: refusing to overwrite saved discussions with empty set');
    return;
  }
  const doc = {
    id: currentDocId,
    name: docMeta.name,
    mode: docMeta.mode,
    badge: docMeta.badge,
    url: docMeta.url || null,
    updated: Date.now(),
    conversationSummary,
    summaryMessageCount,
    citationFormat: citationFormat || null,
    discussions: discussions.map(d => ({
      id: d.id, txt: d.txt, mode: d.mode, pageNum: d.pageNum,
      color: d.color, relRects: d.relRects, messages: d.messages,
      citationMeta: d.citationMeta || null,
      mathKind: d.mathKind || null, mathTex: d.mathTex || null,
      note: d.note || null, onboarding: d.onboarding || false,
      feature: d.feature || null, tex: d.tex || null, cite: d.cite || null,
      // Figure metadata only — the captured pixels live in IndexedDB (keyed by
      // figure.imageKey), never in this localStorage/cloud doc state.
      figure: d.figure || null, figureCaption: d.figureCaption || null,
    })),
  };
  try {
    await PaperStore.saveDoc(doc, owner);
  } catch (e) {
    console.warn('Cloud save failed (local backup kept):', e);
    _onCloudSaveError();
  }
}

export function docIdFor(mode, key) {
  // stable id: web → url, pdf → name+size proxy (name only here)
  return mode + '::' + key;
}

// Restore discussions from a saved doc, hardening against any missing fields
// so a partial record can never blank out a thread or throw.
export function restoreDiscussions(saved) {
  return (saved || []).map(d => ({
    ...d,
    wrapper: null,
    messages: Array.isArray(d.messages) ? d.messages : [],
    relRects: Array.isArray(d.relRects) ? d.relRects : [],
    color: d.color || { bg:'rgba(255,215,0,.45)', dot:'#c9a000' },
    citationMeta: d.citationMeta || null,
  }));
}

export function loadDocSummary(saved) {
  setConversationSummary(saved?.conversationSummary || null);
  setSummaryMessageCount(saved?.summaryMessageCount || 0);
  setSummaryDirty(conversationMessageCount() > summaryMessageCount);
}

export function conversationMessageCount() {
  return discussions.reduce((n, d) => n + d.messages.filter(m => !m.hidden).length, 0);
}

export function buildSummarySource() {
  const blocks = [];
  for (const d of discussions) {
    const vis = d.messages.filter(m => !m.hidden);
    if (!vis.length) continue;
    blocks.push(`[Highlight] "${d.txt.slice(0, 250)}${d.txt.length > 250 ? '…' : ''}"`);
    for (const m of vis) {
      const who = m.role === 'user' ? 'Researcher' : 'Assistant';
      blocks.push(`${who}: ${m.content}`);
    }
    blocks.push('');
  }
  return blocks.join('\n').trim();
}

let _summaryTimer = null;
let _summaryInFlight = false;

export function clearScheduledSummaryUpdate() {
  clearTimeout(_summaryTimer);
  _summaryTimer = null;
}

export function scheduleSummaryUpdate() {
  const count = conversationMessageCount();
  if (!count) return;
  setSummaryDirty(count > summaryMessageCount);
  if (!summaryDirty) return;
  clearScheduledSummaryUpdate();
  _summaryTimer = setTimeout(() => { maybeUpdateSummary(false); }, 45000);
}

export async function maybeUpdateSummary(force = false) {
  if (_summaryInFlight || !currentDocId) return false;
  const count = conversationMessageCount();
  if (!count) return false;
  if (!force && count <= summaryMessageCount) return false;

  const source = buildSummarySource();
  if (!source) return false;

  _summaryInFlight = true;
  try {
    const summary = await callSummarize(source);
    setConversationSummary(summary);
    setSummaryMessageCount(count);
    setSummaryDirty(false);
    await persistCurrentDoc();
    _onAfterSummaryPersist();
    return true;
  } catch (e) {
    console.warn('Conversation summary failed:', e.message);
    return false;
  } finally {
    _summaryInFlight = false;
  }
}

export async function callSummarize(text) {
  const r = await fetch('/api/chat', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ task:'summarize', text }),
  });
  const data = await r.json();
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.message);
  return data.summary || '';
}
