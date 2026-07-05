'use strict';

// Minimal, dependency-free browser-environment stubs used to load the app's
// front-end code (store.js + the inline <script> from index.html) inside a Node
// `vm` context. The goal is NOT to emulate a real browser — only to provide
// enough surface that (a) the script's top-level wiring runs without throwing
// and (b) the pure / logic functions under test behave exactly as they do in
// the page. Anything visual (layout, painting, popover positioning) is a no-op.

// ── Fake element ──────────────────────────────────────────────────────────
// One permissive node type. getElementById caches by id so a test can set
// `.value` / `.textContent` and read it back through the same handle the app
// code sees.
function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    style: {},
    dataset: {},
    _attrs: {},
    children: [],
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, force) {
        const has = this._set.has(c);
        const on = force === undefined ? !has : !!force;
        if (on) this._set.add(c); else this._set.delete(c);
        return on;
      },
      contains(c) { return this._set.has(c); },
    },
    textContent: '',
    innerHTML: '',
    innerText: '',
    value: '',
    title: '',
    href: '',
    src: '',
    disabled: false,
    width: 0,
    height: 0,
    addEventListener() {},
    removeEventListener() {},
    appendChild(n) { this.children.push(n); return n; },
    removeChild(n) { this.children = this.children.filter((c) => c !== n); return n; },
    remove() {},
    insertBefore(n) { this.children.unshift(n); return n; },
    prepend(n) { this.children.unshift(n); return n; },
    insertAdjacentHTML() {},
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    hasAttribute(k) { return k in this._attrs; },
    removeAttribute(k) { delete this._attrs[k]; },
    // Returns a cached stub node (never null) so render helpers can attach
    // listeners to sub-nodes without throwing. Identity is stable per selector.
    querySelector(sel) {
      this._qs = this._qs || {};
      if (!(sel in this._qs)) this._qs[sel] = makeEl();
      return this._qs[sel];
    },
    querySelectorAll() { return []; },
    closest() { return null; },
    cloneNode() { return makeEl(this.tagName); },
    scrollIntoView() {},
    focus() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    getClientRects() { return []; },
    getContext() { return makeCanvasContext(); },
    toDataURL() { return 'data:image/png;base64,'; },
  };
  return el;
}

function makeCanvasContext() {
  return {
    fillStyle: '#fff',
    fillRect() {},
    drawImage() {},
    getImageData() { return { data: [] }; },
  };
}

// ── Fake document ───────────────────────────────────────────────────────────
function makeDocument() {
  const byId = new Map();
  const doc = {
    _byId: byId,
    visibilityState: 'visible',
    head: makeEl('head'),
    body: makeEl('body'),
    documentElement: makeEl('html'),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeEl());
      return byId.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tag) { return makeEl(tag); },
    createTextNode(t) { return { nodeType: 3, nodeValue: t, textContent: t }; },
    createRange() {
      return {
        setStart() {}, setEnd() {},
        cloneRange() { return this; },
        getClientRects() { return []; },
        toString() { return ''; },
        startContainer: { textContent: '' },
        endContainer: { textContent: '' },
        commonAncestorContainer: { textContent: '' },
      };
    },
    createTreeWalker() { return { nextNode() { return null; } }; },
    addEventListener() {},
    removeEventListener() {},
  };
  return doc;
}

// ── Fake localStorage ─────────────────────────────────────────────────────
function makeLocalStorage() {
  const m = new Map();
  return {
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    clear() { m.clear(); },
    key(i) { return [...m.keys()][i] ?? null; },
    get length() { return m.size; },
    _dump() { return Object.fromEntries(m); },
  };
}

// ── Fake IndexedDB (in-memory, async via microtasks) ────────────────────────
// Implements just the slice store.js uses: open w/ upgrade, object stores,
// get/put/delete/clear/getAll/getAllKeys, and transaction.oncomplete timing.
function makeIndexedDB() {
  const databases = new Map(); // name -> { version, stores: Map<name, Map<key,val>> }

  function open(name, version = 1) {
    const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null };
    queueMicrotask(() => {
      let db = databases.get(name);
      const isNew = !db;
      if (isNew) { db = { version: 0, stores: new Map() }; databases.set(name, db); }
      const dbObj = makeDBObject(db);
      req.result = dbObj;
      if (isNew || version > db.version) {
        db.version = version;
        if (typeof req.onupgradeneeded === 'function') req.onupgradeneeded({ target: req });
      }
      if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
    });
    return req;
  }

  function makeDBObject(db) {
    return {
      objectStoreNames: { contains: (n) => db.stores.has(n) },
      createObjectStore(n, opts) {
        db.stores.set(n, new Map());
        const s = makeStore(db, n, null);
        s._keyPath = opts && opts.keyPath ? opts.keyPath : null;
        db._keyPaths = db._keyPaths || {};
        db._keyPaths[n] = s._keyPath;
        return s;
      },
      transaction(n) { return makeTx(db, Array.isArray(n) ? n : [n]); },
      close() {},
    };
  }

  function makeTx(db, names) {
    const tx = { oncomplete: null, onerror: null, _pending: 0, _done: false };
    function maybeComplete() {
      if (tx._pending === 0 && !tx._done) {
        tx._done = true;
        queueMicrotask(() => { if (typeof tx.oncomplete === 'function') tx.oncomplete(); });
      }
    }
    tx._track = (fire) => {
      tx._pending++;
      queueMicrotask(() => { fire(); tx._pending--; maybeComplete(); });
    };
    queueMicrotask(maybeComplete);
    tx.objectStore = (n) => makeStore(db, n, tx);
    return tx;
  }

  function makeStore(db, name, tx) {
    if (!db.stores.has(name)) db.stores.set(name, new Map());
    const map = db.stores.get(name);
    const keyPath = (db._keyPaths || {})[name] || null;
    function request(resultFn) {
      const r = { onsuccess: null, onerror: null, result: undefined };
      const fire = () => {
        r.result = resultFn();
        if (typeof r.onsuccess === 'function') r.onsuccess({ target: r });
      };
      if (tx && tx._track) tx._track(fire); else queueMicrotask(fire);
      return r;
    }
    return {
      _keyPath: keyPath,
      get: (k) => request(() => map.get(k)),
      put: (v, k) => request(() => {
        const key = k !== undefined ? k : (keyPath && v ? v[keyPath] : undefined);
        map.set(key, v);
        return key;
      }),
      delete: (k) => request(() => { map.delete(k); return undefined; }),
      clear: () => request(() => { map.clear(); return undefined; }),
      getAllKeys: () => request(() => [...map.keys()]),
      getAll: () => request(() => [...map.values()]),
    };
  }

  return {
    open,
    deleteDatabase(name) {
      const req = { onsuccess: null, onerror: null };
      queueMicrotask(() => {
        databases.delete(name);
        if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
      });
      return req;
    },
    _databases: databases,
  };
}

// ── Fake Supabase client ─────────────────────────────────────────────────────
// Just enough of supabase-js v2 for store.js: auth (getSession /
// onAuthStateChange / signInWithOAuth / signOut), chainable-thenable table
// queries that record what was asked and resolve { data, error }, and a
// storage stub. Tests drive sessions via setSession()/emitAuthChange() and
// assert against state.calls.
function makeFakeSupabase() {
  const state = {
    session: null,
    createClientArgs: null,
    authChangeCallbacks: [],
    calls: { signInWithOAuth: [], signOut: 0, queries: [] },
    // Optional per-table select results: { [table]: rows }
    selectResults: {},
  };

  function chain(table) {
    const q = { table, op: 'select', filters: [], rows: null, options: null };
    const result = () => {
      state.calls.queries.push(q);
      const data = q.op === 'select' ? (state.selectResults[table] || []) : null;
      return { data, error: null };
    };
    const c = {
      select() { q.op = 'select'; return c; },
      insert(rows) { q.op = 'insert'; q.rows = rows; return c; },
      upsert(rows, options) { q.op = 'upsert'; q.rows = rows; q.options = options || null; return c; },
      update(rows) { q.op = 'update'; q.rows = rows; return c; },
      delete() { q.op = 'delete'; return c; },
      eq(col, val) { q.filters.push([col, val]); return c; },
      in(col, vals) { q.filters.push([col, vals]); return c; },
      order() { return c; },
      then(res, rej) { return Promise.resolve(result()).then(res, rej); },
    };
    return c;
  }

  const client = {
    auth: {
      async getSession() { return { data: { session: state.session }, error: null }; },
      onAuthStateChange(cb) {
        state.authChangeCallbacks.push(cb);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signInWithOAuth(opts) {
        state.calls.signInWithOAuth.push(opts);
        return { data: { url: 'https://accounts.google.com/o/oauth2/auth' }, error: null };
      },
      async signOut() {
        state.calls.signOut++;
        state.session = null;
        for (const cb of state.authChangeCallbacks) cb('SIGNED_OUT', null);
        return { error: null };
      },
    },
    from: (table) => chain(table),
    storage: {
      from: () => ({
        async upload() { return { error: null }; },
        async download() { return { data: null, error: { message: 'not found' } }; },
        async remove() { return { error: null }; },
      }),
    },
  };

  return {
    client,
    state,
    setSession(session) { state.session = session; },
    emitAuthChange(event, session) {
      state.session = session;
      for (const cb of state.authChangeCallbacks) cb(event, session);
    },
    clearCalls() {
      state.calls.signInWithOAuth.length = 0;
      state.calls.signOut = 0;
      state.calls.queries.length = 0;
    },
  };
}

// ── Response / fetch helpers ────────────────────────────────────────────────
function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get() { return null; } },
    url: '',
    async json() { return obj; },
    async text() { return JSON.stringify(obj); },
    async arrayBuffer() { return new ArrayBuffer(0); },
    async blob() { return { size: 0, type: 'application/json' }; },
  };
}

// Build a contextified sandbox. `onboardingJson` is returned for the
// onboarding-curation.json fetch during boot. Tests can override the chat
// fetch behaviour via the returned `setFetchHandler`.
function buildSandbox({ onboardingJson } = {}) {
  const localStorage = makeLocalStorage();
  const indexedDB = makeIndexedDB();
  const document = makeDocument();
  const fakeSupabase = makeFakeSupabase();
  const fetchCalls = [];
  let fetchHandler = null;

  async function fetchImpl(url, opts) {
    const call = { url: String(url), opts: opts || {} };
    fetchCalls.push(call);
    if (fetchHandler) {
      const r = await fetchHandler(call.url, call.opts);
      if (r !== undefined) return r;
    }
    if (call.url.includes('/api/config')) {
      return jsonResponse({ supabaseUrl: null, supabaseAnonKey: null });
    }
    if (call.url.includes('onboarding-curation.json')) {
      return jsonResponse(onboardingJson || { tracks: [], papers: {}, featured: '' });
    }
    if (call.url.includes('onboarding-action-cache.json')) {
      return jsonResponse({ papers: {} });
    }
    return jsonResponse({});
  }

  // App timers (e.g. the 45s summary debounce) must never keep the Node test
  // process alive, so every timer the app schedules is unref'd. clearTimeout
  // still works on the returned handle.
  const unrefTimeout = (fn, ms, ...a) => { const t = setTimeout(fn, ms, ...a); if (t && t.unref) t.unref(); return t; };
  const unrefInterval = (fn, ms, ...a) => { const t = setInterval(fn, ms, ...a); if (t && t.unref) t.unref(); return t; };

  // Silence the app's own logging (console.info/log/warn/group/table/...) so it
  // doesn't drown out the test runner output. Tests assert behaviour, not logs.
  const noop = () => {};
  const silentConsole = new Proxy({}, { get: () => noop });

  const sandbox = {
    console: silentConsole,
    setTimeout: unrefTimeout, clearTimeout, setInterval: unrefInterval, clearInterval, queueMicrotask,
    Promise, Math, Date, JSON, RegExp, Array, Object, Number, String, Boolean,
    Map, Set, WeakMap, WeakSet, Symbol, Error, parseInt, parseFloat, isNaN, isFinite,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    crypto: globalThis.crypto,
    fetch: fetchImpl,
    localStorage,
    indexedDB,
    document,
    navigator: { platform: '', userAgent: 'node-test' },
    location: { href: 'http://localhost/', hostname: 'localhost', origin: 'http://localhost', pathname: '/', hash: '', search: '' },
    history: { replaceState() {} },
    // CDN supabase-js global; store.js only touches it when /api/config
    // returns a url+key (tests opt in via setFetchHandler).
    supabase: { createClient(url, key, opts) { fakeSupabase.state.createClientArgs = { url, key, opts }; return fakeSupabase.client; } },
    requestAnimationFrame: (fn) => unrefTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: () => {},
    MutationObserver: class { observe() {} disconnect() {} },
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    DOMParser: class { parseFromString() { return makeDocument(); } },
    XMLSerializer: class { serializeToString() { return ''; } },
    Image: class { set src(_v) { if (this.onload) unrefTimeout(() => this.onload(), 0); } },
    Blob: class { constructor(parts) { this.size = (parts || []).length; this.type = 'application/pdf'; }
      async arrayBuffer() { return new ArrayBuffer(0); } },
    alert: () => {},
    confirm: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    pdfjsLib: { GlobalWorkerOptions: {}, getDocument() { return { promise: Promise.resolve({}) }; }, renderTextLayer() { return { promise: Promise.resolve() }; } },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  return {
    sandbox,
    helpers: {
      localStorage,
      indexedDB,
      document,
      fakeSupabase,
      fetchCalls,
      jsonResponse,
      setFetchHandler(fn) { fetchHandler = fn; },
      clearFetchCalls() { fetchCalls.length = 0; },
    },
  };
}

module.exports = { buildSandbox, makeEl, makeDocument, makeLocalStorage, makeIndexedDB, makeFakeSupabase, jsonResponse };
