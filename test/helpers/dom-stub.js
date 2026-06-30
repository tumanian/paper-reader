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

  return { open };
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
    location: { href: 'http://localhost/', hostname: 'localhost' },
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
      fetchCalls,
      jsonResponse,
      setFetchHandler(fn) { fetchHandler = fn; },
      clearFetchCalls() { fetchCalls.length = 0; },
    },
  };
}

module.exports = { buildSandbox, makeEl, makeDocument, makeLocalStorage, makeIndexedDB, jsonResponse };
