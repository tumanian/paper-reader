import { esc, timeAgo, simpleHash } from './util.js';
import { summaryDirty, setCurrentMode, setCurrentDocId, setDocMeta, replaceDiscussions, setCitationFormat } from './state.js';
import { loadStore, restoreDiscussions, loadDocSummary, persistCurrentDoc, maybeUpdateSummary } from './persistence.js';

// Cross-module hooks for loaders/nav still owned by main.js until their modules
// are extracted (web-loader, pdf, chat, onboarding, nav).
let _loadWebPage = async () => {};
let _loadArxivPdf = async () => {};
let _startApp = () => {};
let _setStatus = () => {};
let _renderFromBuffer = async () => {};
let _restoreHighlightsForLoadedPages = () => {};
let _renderList = () => {};
let _showList = () => {};
let _parseArxivId = () => null;
let _getFeaturedPaper = () => null;
let _openFeaturedExample = () => {};
let _backToUpload = () => {};

export function setLibraryHooks({
  loadWebPage, loadArxivPdf, startApp, setStatus, renderFromBuffer,
  restoreHighlightsForLoadedPages, renderList, showList, parseArxivId,
  getFeaturedPaper, openFeaturedExample, backToUpload,
} = {}) {
  if (loadWebPage) _loadWebPage = loadWebPage;
  if (loadArxivPdf) _loadArxivPdf = loadArxivPdf;
  if (startApp) _startApp = startApp;
  if (setStatus) _setStatus = setStatus;
  if (renderFromBuffer) _renderFromBuffer = renderFromBuffer;
  if (restoreHighlightsForLoadedPages) _restoreHighlightsForLoadedPages = restoreHighlightsForLoadedPages;
  if (renderList) _renderList = renderList;
  if (showList) _showList = showList;
  if (parseArxivId) _parseArxivId = parseArxivId;
  if (getFeaturedPaper) _getFeaturedPaper = getFeaturedPaper;
  if (openFeaturedExample) _openFeaturedExample = openFeaturedExample;
  if (backToUpload) _backToUpload = backToUpload;
}

// ═══════════════════════════════════════════════════════
//  LIBRARY  (upload screen)
// ═══════════════════════════════════════════════════════
export function renderLibrary() {
  const store = loadStore();
  const docs = Object.values(store).sort((a,b) => b.updated - a.updated);
  const lib = document.getElementById('library');
  const cards = document.getElementById('lib-cards');

  // Featured example is an invitation for logged-out visitors only. Once they
  // open it, it's saved as a doc — so dedupe by URL and just sparkle that card
  // instead of showing a separate invitation. Signed-in = real Supabase session.
  const loggedIn = !!(PaperStore.getUserId && PaperStore.getUserId());
  const featured = loggedIn ? null : _getFeaturedPaper();
  const normUrl = (u) => (u || '').trim().replace(/\/+$/, '').toLowerCase();
  const featUrl = featured ? normUrl(featured.url) : '';
  const featuredSaved = !!(featUrl && docs.some(d => normUrl(d.url) === featUrl));

  if (!docs.length && !featured) { lib.classList.remove('show'); return; }
  lib.classList.add('show');
  cards.innerHTML = '';

  if (featured && !featuredSaved) {
    const card = document.createElement('div');
    card.className = 'lib-card lib-featured';
    card.innerHTML = `
      <div class="lib-icon">🌐</div>
      <div class="lib-info">
        <div class="lib-name">${esc(featured.title)}<span class="lib-spark" title="Annotated example">✨</span></div>
        ${featured.hook ? `<div class="lib-summary">${esc(featured.hook)}</div>` : ''}
        <div class="lib-meta">Annotated example · citations, math, to-code &amp; discussion</div>
      </div>`;
    card.addEventListener('click', () => _openFeaturedExample());
    cards.appendChild(card);
  }

  for (const doc of docs) {
    const n = doc.discussions.length;
    const isFeatured = !!(featUrl && normUrl(doc.url) === featUrl);
    const card = document.createElement('div');
    card.className = 'lib-card' + (isFeatured ? ' lib-featured' : '');
    card.innerHTML = `
      <div class="lib-icon">${doc.mode === 'pdf' ? '📄' : '🌐'}</div>
      <div class="lib-info">
        <div class="lib-name">${esc(doc.name)}${isFeatured ? '<span class="lib-spark" title="Annotated example">✨</span>' : ''}</div>
        ${doc.conversationSummary ? `<div class="lib-summary">${esc(doc.conversationSummary)}</div>` : ''}
        <div class="lib-meta">${n} discussion${n!==1?'s':''} · ${timeAgo(doc.updated)}</div>
      </div>
      <button class="lib-del" title="Delete">×</button>`;
    card.addEventListener('click', e => {
      if (e.target.classList.contains('lib-del')) return;
      reopenDoc(doc.id);
    });
    card.querySelector('.lib-del').addEventListener('click', async e => {
      e.stopPropagation();
      await PaperStore.deleteDoc(doc.id);
      renderLibrary();
    });
    cards.appendChild(card);
  }
}

// ═══════════════════════════════════════════════════════
//  READ LATER
// ═══════════════════════════════════════════════════════
export async function addToReadLater(item) {
  const id = item.id || (item.url ? 'rl::' + simpleHash(item.url) : 'rl::' + simpleHash(item.citationText || item.title));
  const added = await PaperStore.addReadLater({ ...item, id });
  if (added) renderReadLater();
  return added;
}

export function renderReadLater() {
  const items = PaperStore.getReadLater();
  const section = document.getElementById('read-later');
  const cards = document.getElementById('read-later-cards');
  if (!items.length) { section.classList.remove('show'); return; }
  section.classList.add('show');
  cards.innerHTML = '';
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'lib-card rl-card';
    const canOpen = !!(item.url || item.docId);
    const sourceBits = [];
    if (item.sourceDoc) sourceBits.push(`from ${esc(item.sourceDoc)}`);
    if (item.citationText) {
      const c = item.citationText.trim();
      sourceBits.push(esc(c.slice(0, 60)) + (c.length > 60 ? '…' : ''));
    }
    card.innerHTML = `
      <div class="lib-icon">${item.url ? '🔗' : (item.docId ? '📄' : '📌')}</div>
      <div class="lib-info">
        <div class="lib-name">${esc(item.title)}</div>
        ${sourceBits.length ? `<div class="rl-source">${sourceBits.join(' · ')}</div>` : ''}
        ${!canOpen ? '<div class="rl-unresolved">No URL — open source paper to resolve</div>' : ''}
        <div class="lib-meta">${timeAgo(item.addedAt)}</div>
      </div>
      <button class="lib-del" title="Remove">×</button>`;
    card.addEventListener('click', e => {
      if (e.target.classList.contains('lib-del')) return;
      openReadLaterItem(item);
    });
    card.querySelector('.lib-del').addEventListener('click', async e => {
      e.stopPropagation();
      await PaperStore.removeReadLater(item.id);
      renderReadLater();
    });
    cards.appendChild(card);
  }
}

export async function openReadLaterItem(item) {
  if (item.url) {
    document.getElementById('url-input').value = item.url;
    await _loadWebPage(item.url);
    return;
  }
  // Linkless citation: reopen its source paper — but only if that doc actually
  // exists in the store (the docId can dangle, e.g. the source paper was
  // deleted; reopenDoc would silently no-op).
  if (item.docId && loadStore()[item.docId]) {
    await reopenDoc(item.docId);
    return;
  }
  alert('This citation has no link yet' +
    (item.sourceDoc ? ` — open "${item.sourceDoc}" and select the citation again to resolve it.` : '. Try selecting it again in the source paper.'));
}

// Reopen a saved doc. For web docs we can re-fetch + reposition highlights.
// For PDFs we can't re-render without the file, so we show discussions in a
// restored (list-only) state and invite re-opening the file.
export async function reopenDoc(docId) {
  const store = loadStore();
  const doc = store[docId];
  if (!doc) return;

  if (doc.mode === 'web' && doc.url) {
    document.getElementById('url-input').value = doc.url;
    await _loadWebPage(doc.url, docId);
    return;
  }

  // PDF: try stored bytes, or re-fetch arXiv PDF from saved abs URL
  _startApp(doc.name, doc.badge || 'PDF');
  setCurrentMode(doc.mode);
  setCurrentDocId(docId);
  setDocMeta({ name:doc.name, mode:doc.mode, badge:doc.badge, url:doc.url });
  replaceDiscussions(restoreDiscussions(doc.discussions));
  loadDocSummary(doc);
  setCitationFormat(doc.citationFormat || null);

  if (doc.mode === 'pdf') {
    _setStatus('Loading saved PDF…');
    const blob = await PaperStore.getPdf(docId);
    if (blob) {
      try {
        const buf = await blob.arrayBuffer();
        await _renderFromBuffer(buf);
        _restoreHighlightsForLoadedPages();
        _renderList();
        return;
      } catch(e) { console.warn('Stored PDF failed to render:', e); }
    }
    if (doc.url && _parseArxivId(doc.url)) {
      document.getElementById('url-input').value = doc.url;
      await _loadArxivPdf(doc.url, docId);
      return;
    }
    // Fallback: bytes missing (e.g. cleared) → list-only + reopen prompt
    document.getElementById('content-loading').style.display = 'none';
    document.getElementById('reload-note').style.display = 'block';
    document.getElementById('reload-note').innerHTML =
      `Saved file unavailable. Discussions for “${esc(doc.name)}” restored — ` +
      `<button id="reopen-file">open the PDF again</button> to see highlights on the page.`;
    const rf = document.getElementById('reopen-file');
    if (rf) rf.addEventListener('click', () => document.getElementById('pdf-input').click());
    _showList();
    return;
  }

  // web without url (rare) → list only
  document.getElementById('content-loading').style.display = 'none';
  document.getElementById('reload-note').style.display = 'block';
  document.getElementById('reload-note').innerHTML = `Discussions restored.`;
  _showList();
}

// ═══════════════════════════════════════════════════════
//  AUTH  (login widget + sync status — real Supabase session)
// ═══════════════════════════════════════════════════════
function isUploadScreenVisible() {
  const upload = document.getElementById('upload-screen');
  return upload && upload.style.display !== 'none';
}

export function updateAuthBar(info) {
  const loginWidget = document.getElementById('login-widget');
  const btn = document.getElementById('login-btn');
  const label = btn && btn.querySelector('.lw-label');
  const statusEl = document.getElementById('login-status');
  const signinBtn = document.getElementById('google-signin-btn');
  const logoutBtn = document.getElementById('auth-logout-btn');
  const avatar = document.getElementById('login-avatar');
  if (!btn) return;

  const identity = info && info.identity ? info.identity : null;
  const signedIn = !!identity;
  const who = identity ? (identity.name || identity.email || 'Signed in') : null;
  const localOnly = !!info && info.mode === 'local';

  let status = '<strong>Sign in with Google</strong> to sync your library across devices.';
  let dotColor = '';

  if (signedIn) {
    if (info.lastSyncError) {
      dotColor = '#d6453f';
      status = `<strong>${esc(who)}</strong> — sync issue.<span class="sync-err">${esc(info.lastSyncError)}</span>`;
    } else if (info.syncing) {
      dotColor = '#e0a000';
      status = `<strong>${esc(who)}</strong> — syncing ${info.docCount || 0} paper${info.docCount === 1 ? '' : 's'} from cloud…`;
    } else if (info.useCloud) {
      dotColor = '#36b37e';
      status = `<strong>${esc(who)}</strong> — ${info.docCount || 0} paper${info.docCount === 1 ? '' : 's'} synced. Sign in with the same Google account on any device to load your library.`;
    } else {
      dotColor = '#9aa0a6';
      status = `<strong>${esc(who)}</strong> — saved locally only.`;
    }
  } else if (localOnly) {
    status = info.error
      ? `<strong>Local only</strong><span class="sync-err">${esc(info.error)}</span>`
      : '<strong>Local only</strong> — cloud not configured.';
  }

  if (label) {
    label.textContent = signedIn ? who : 'Sign in';
    // When signed in, the avatar + status dot are enough — hide the name to save space.
    label.style.display = signedIn ? 'none' : '';
  }
  btn.title = signedIn ? who : '';

  if (avatar) {
    if (signedIn && identity.avatar) {
      avatar.src = identity.avatar;
      avatar.style.display = '';
    } else {
      avatar.style.display = 'none';
    }
  }

  let dot = btn.querySelector('.lw-dot');
  if (signedIn) {
    if (!dot) { dot = document.createElement('span'); dot.className = 'lw-dot'; btn.insertBefore(dot, label); }
    dot.style.background = dotColor;
  } else if (dot) {
    dot.remove();
  }

  statusEl.innerHTML = status;
  // Sign-in is only possible when a Supabase project is configured.
  if (signinBtn) signinBtn.style.display = signedIn || localOnly ? 'none' : 'flex';
  logoutBtn.style.display = signedIn ? 'block' : 'none';

  // Signed-out sign-in lives on the upload screen only — hide the widget in the reader.
  if (loginWidget) {
    const hideWidget = !signedIn && !isUploadScreenVisible();
    loginWidget.style.display = hideWidget ? 'none' : '';
    if (hideWidget) loginWidget.classList.remove('open');
  }
}

// Starts the Google OAuth redirect via Supabase Auth. The page navigates away
// to Google and returns with a session, which boot()/init() picks up.
export async function signIn() {
  try {
    await PaperStore.signInWithGoogle();
  } catch (e) {
    alert(e.message || 'Sign-in failed.');
  }
}

// Kept for existing callers — the login widget reflects auth state directly.
export function updateLogoutFab() {
  updateAuthBar(PaperStore.getSyncStatus());
}

// Wire library/read-later UI, auth widget, PaperStore callbacks, and tab-hide
// persistence. Called once from main boot() after setLibraryHooks().
export function initLibrary() {
  document.getElementById('clear-lib').addEventListener('click', async () => {
    if (confirm('Delete all saved documents and discussions?')) {
      await PaperStore.clearLibrary();
      renderLibrary();
    }
  });

  document.getElementById('clear-read-later').addEventListener('click', async () => {
    if (confirm('Clear your Read later list?')) {
      await PaperStore.clearReadLater();
      renderReadLater();
    }
  });

  const loginWidget = document.getElementById('login-widget');
  document.getElementById('login-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    loginWidget.classList.toggle('open');
  });
  loginWidget.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => loginWidget.classList.remove('open'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') loginWidget.classList.remove('open');
  });

  document.getElementById('google-signin-btn').addEventListener('click', signIn);
  document.getElementById('auth-logout-btn').addEventListener('click', async () => {
    // Persist + clear the open doc WHILE still signed in, so saveDoc targets
    // the user's namespace — not .local after signOut.
    _backToUpload();
    await PaperStore.signOut();
    updateAuthBar(PaperStore.getSyncStatus());
    renderLibrary();
    renderReadLater();
    loginWidget.classList.remove('open');
  });

  window.onPaperStoreSyncChange = (info) => {
    updateAuthBar(info);
    renderLibrary();
    renderReadLater();
  };

  window.onPaperStoreAuthChange = () => {
    renderLibrary();
    renderReadLater();
    updateAuthBar(PaperStore.getSyncStatus());
  };

  window.addEventListener('beforeunload', () => { void persistCurrentDoc(); });
  window.addEventListener('pagehide', () => { void persistCurrentDoc(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void persistCurrentDoc();
      if (summaryDirty) maybeUpdateSummary(true);
    }
  });
}
