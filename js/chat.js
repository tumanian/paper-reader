// ═══════════════════════════════════════════════════════
//  CHAT — highlights, discussion list, thread, ratings, send pipeline
// ═══════════════════════════════════════════════════════
// Owns the reader→chat surface: painting highlight rects, the discussion list,
// opening/rebuilding a thread, the response-rating "golden set" capture, and the
// sendMessage → callClaude round-trip (system-block assembly + prompt caching).

import { esc, md } from './util.js';
import { discussions, activeId, currentDocId, docMeta, paperText, MAX_PAPER_CHARS } from './state.js';
import { setActiveId, removeDiscussion } from './state.js';
import { persistCurrentDoc, scheduleSummaryUpdate } from './persistence.js';
import { renderChatFigure, ensureFigureImage } from './figure.js';

// Onboarding demo highlights auto-run the feature they advertise on first click,
// so a first-time visitor sees citations / explain-math / to-code in action
// without having to discover the gesture. runOnboardingDemo lives in the
// onboarding module and is injected here to avoid a chat↔onboarding import cycle.
let _chatRunOnboardingDemo = () => false;
export function setChatHooks({ runOnboardingDemo } = {}) {
  if (runOnboardingDemo) _chatRunOnboardingDemo = runOnboardingDemo;
}

const FEATURE_CTA = { math: '✨ Explain math', code: '{ } To code', citation: '📚 Show citation', figure: '🖼 Explain a figure' };

export function paintHighlight(d) {
  const layer = d.wrapper?.querySelector('.highlights-layer');
  if (!layer) return;
  for (const r of d.relRects) {
    const div = document.createElement('div');
    div.className = 'hl-rect';
    div.dataset.discId = d.id;
    if (d.onboarding) div.dataset.onboarding = '1';
    const cta = d.feature && FEATURE_CTA[d.feature] ? FEATURE_CTA[d.feature] + ' — click to try' : '';
    if (cta || d.note) div.title = [cta, d.note].filter(Boolean).join('  ·  ');
    Object.assign(div.style, { left:r.left+'px', top:r.top+'px', width:r.width+'px', height:r.height+'px', background:d.color.bg });
    div.addEventListener('click', () => { if (!_chatRunOnboardingDemo(d)) openChat(d.id); });
    layer.appendChild(div);
  }
}

// ═══════════════════════════════════════════════════════
//  DISCUSSION LIST
// ═══════════════════════════════════════════════════════
export function renderList() {
  const panel = document.getElementById('disc-list-panel');
  document.getElementById('disc-count').textContent = discussions.length;
  panel.innerHTML = '';
  if (!discussions.length) {
    panel.innerHTML = `<div class="empty-state"><div class="e-icon">💬</div>
      <p>Select any text to start a discussion with Claude</p></div>`;
    return;
  }
  for (const d of discussions) {
    const vis  = d.messages.filter(m => !m.hidden);
    const last = vis[vis.length-1];
    const lbl  = d.mode === 'pdf' ? `Page ${d.pageNum}` : 'Web';
    const card = document.createElement('div');
    card.className = 'disc-card' + (activeId === d.id ? ' active' : '');
    card.innerHTML = `
      <div class="dc-top">
        <div class="dc-dot" style="background:${d.color.dot}"></div>
        <span class="dc-meta">${lbl} · ${vis.length} msg</span>
        <button class="dc-del" title="Delete">×</button>
      </div>
      <div class="dc-quote">${esc(d.txt.slice(0,110))}${d.txt.length>110?'…':''}</div>
      ${ d.note ? `<div class="dc-note">💡 ${esc(d.note)}</div>` : '' }
      ${ last ? `<div class="dc-preview">${esc(last.content.slice(0,70))}…</div>`
              : (d.feature && FEATURE_CTA[d.feature]
                  ? `<span class="dc-cta">${FEATURE_CTA[d.feature]} →</span>`
                  : `<span class="dc-unanswered">${d.note ? 'Tap to discuss' : 'No question yet'}</span>`) }`;
    card.addEventListener('click', e => {
      if (e.target.classList.contains('dc-del')) return;
      if (!_chatRunOnboardingDemo(d)) openChat(d.id);
    });
    card.querySelector('.dc-del').addEventListener('click', e => {
      e.stopPropagation(); deleteDiscussion(d.id);
    });
    panel.appendChild(card);
  }
}

export function deleteDiscussion(id) {
  const d = discussions.find(x => x.id === id);
  if (d && d.wrapper) {
    // remove painted rects for this highlight (repaint all to be safe)
    const layer = d.wrapper.querySelector('.highlights-layer');
    if (layer) layer.innerHTML = '';
  }
  removeDiscussion(id);
  // repaint remaining on this wrapper
  const wraps = new Set(discussions.map(x => x.wrapper).filter(Boolean));
  wraps.forEach(w => { const l = w.querySelector('.highlights-layer'); if (l) l.innerHTML=''; });
  discussions.forEach(x => { if (x.wrapper) paintHighlight(x); });
  persistCurrentDoc();
  if (activeId === id) showList(); else renderList();
}

// ═══════════════════════════════════════════════════════
//  CHAT
// ═══════════════════════════════════════════════════════
export function openChat(id) {
  setActiveId(id);
  const d = discussions.find(x => x.id === id); if (!d) return;
  document.getElementById('disc-list-panel').style.display = 'none';
  document.getElementById('chat-panel').style.display = 'flex';
  document.getElementById('chat-hl-text').textContent =
    `"${d.txt.slice(0,180)}${d.txt.length>180?'…':''}"`;
  rebuildChat(d);
  scrollHighlightIntoView(d);
  const input = document.getElementById('msg-input');
  input.focus();
}

// Inject a pre-cached user/assistant exchange for onboarding demos (no API round-trip).
export function playOnboardingCachedChat(d, userText, assistantText) {
  if (!d || !userText || !assistantText) return false;
  openChat(d.id);
  d.messages.push({ role: 'user', content: userText });
  d.messages.push({ role: 'assistant', content: assistantText });
  persistCurrentDoc();
  scheduleSummaryUpdate();
  rebuildChat(d);
  renderList();
  return true;
}

// Bring the reader to the highlight for a discussion (PDF page or web article).
export function scrollHighlightIntoView(d) {
  if (!d) return;
  const rect = document.querySelector(`.hl-rect[data-disc-id="${d.id}"]`);
  if (rect && typeof rect.scrollIntoView === 'function') {
    rect.scrollIntoView({ block: 'center' });
  }
}
export function showList() {
  setActiveId(null);
  document.getElementById('chat-panel').style.display = 'none';
  document.getElementById('disc-list-panel').style.display = 'flex';
  renderList();
}

// ═══════════════════════════════════════════════════════
//  RESPONSE RATINGS — "golden set" capture (separate IDB)
// ═══════════════════════════════════════════════════════
// Stored in their OWN IndexedDB database, independent of paperReader.files
// (PDF bytes). Clearing the library or a document only touches the pdfs store,
// so collected ratings are never deleted as a side effect.
const RATINGS_DB = 'paperReader.ratings';
const RATINGS_STORE = 'ratings';
const RATING_SCHEMA_VERSION = 1;
const RATING_REASONS = ['incorrect', 'too verbose', 'missed the point', 'other'];
// A constant per page load; lets later analysis group by session without a schema change.
const SESSION_ID = (crypto?.randomUUID?.() || ('s' + Date.now() + Math.random().toString(36).slice(2)));

function openRatingsDB() {
  return new Promise((resolve) => {
    if (!('indexedDB' in window)) { resolve(null); return; }
    const req = indexedDB.open(RATINGS_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RATINGS_STORE)) {
        db.createObjectStore(RATINGS_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}
function ratingsTx(mode) {
  return openRatingsDB().then(db => db ? db.transaction(RATINGS_STORE, mode).objectStore(RATINGS_STORE) : null);
}
async function getRatingRecord(id) {
  const store = await ratingsTx('readonly'); if (!store) return null;
  return new Promise((res) => { const r = store.get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
}
async function putRatingRecord(rec) {
  const store = await ratingsTx('readwrite');
  if (store) await new Promise((res) => { const r = store.put(rec); r.onsuccess = () => res(true); r.onerror = () => res(false); });
  // Mirror to the backend (best-effort; local copy is the source of truth offline).
  try { await PaperStore.saveRating?.(rec); }
  catch (e) { console.warn('[Rating] cloud save failed (kept locally):', e.message); }
  return true;
}
async function deleteRatingRecord(id) {
  const store = await ratingsTx('readwrite');
  if (store) await new Promise((res) => { const r = store.delete(id); r.onsuccess = () => res(true); r.onerror = () => res(false); });
  try { await PaperStore.deleteRating?.(id); }
  catch (e) { console.warn('[Rating] cloud delete failed:', e.message); }
  return true;
}
async function getAllRatingRecords() {
  const store = await ratingsTx('readonly'); if (!store) return [];
  return new Promise((res) => {
    const r = store.getAll ? store.getAll() : null;
    if (r) { r.onsuccess = () => res(r.result || []); r.onerror = () => res([]); return; }
    res([]);
  });
}

function ratingIdFor(d, msgIndex) {
  return `${currentDocId || 'nodoc'}::${d.id}::m${msgIndex}`;
}

// Capture the full reproducible context for one assistant response.
function buildRatingRecord(d, msgIndex, rating, reason) {
  let question = '';
  for (let i = msgIndex - 1; i >= 0; i--) {
    if (d.messages[i] && d.messages[i].role === 'user') { question = d.messages[i].content; break; }
  }
  let userId = null;
  try { userId = PaperStore.getUserId?.() || null; } catch (_) {}
  return {
    id: ratingIdFor(d, msgIndex),
    schemaVersion: RATING_SCHEMA_VERSION,
    rating,
    reason: reason || null,
    selectedText: d.mathTex || d.txt || '',
    selectedTextKind: d.mathTex ? 'latex' : 'text',
    mathKind: d.mathKind || null,
    question,
    response: d.messages[msgIndex]?.content || '',
    model: CHAT_MODEL,
    docId: currentDocId || null,
    paperTitle: docMeta?.name || null,
    paperUrl: docMeta?.url || null,
    discussionId: d.id,
    messageIndex: msgIndex,
    citationMeta: d.citationMeta || null,
    sessionId: SESSION_ID,
    userId,
  };
}

// Subtle thumbs row appended BELOW the message body so it never overlaps the
// selectable response text. Reflects saved state and allows change/clear.
function renderRatingControl(msgDiv, d, msgIndex) {
  if (!msgDiv) return;
  const id = ratingIdFor(d, msgIndex);
  const row = document.createElement('div');
  row.className = 'msg-rate';
  row.innerHTML =
    `<button class="msg-rate-btn up" title="Good response">👍</button>` +
    `<button class="msg-rate-btn down" title="Bad response">👎</button>` +
    `<span class="msg-rate-thanks"></span>` +
    `<div class="msg-rate-reasons" style="display:none"></div>`;
  msgDiv.appendChild(row);

  const upBtn = row.querySelector('.up');
  const downBtn = row.querySelector('.down');
  const thanks = row.querySelector('.msg-rate-thanks');
  const reasons = row.querySelector('.msg-rate-reasons');

  RATING_REASONS.forEach((reason) => {
    const b = document.createElement('button');
    b.className = 'msg-rate-reason';
    b.dataset.reason = reason;
    b.textContent = reason;
    reasons.appendChild(b);
  });

  function paint(rec) {
    upBtn.classList.toggle('active', rec?.rating === 'up');
    downBtn.classList.toggle('active', rec?.rating === 'down');
    if (rec?.rating === 'down') {
      reasons.style.display = 'flex';
      reasons.querySelectorAll('.msg-rate-reason').forEach((b) =>
        b.classList.toggle('active', b.dataset.reason === rec.reason));
    } else {
      reasons.style.display = 'none';
    }
    thanks.textContent = rec ? 'saved' : '';
  }

  let current = null;
  getRatingRecord(id).then((rec) => { current = rec; paint(rec); });

  async function setRating(rating) {
    // Toggle off if clicking the already-active vote → clear the record.
    if (current && current.rating === rating) {
      await deleteRatingRecord(id);
      current = null; paint(null);
      return;
    }
    const now = Date.now();
    const rec = buildRatingRecord(d, msgIndex, rating, rating === 'down' ? (current?.reason || null) : null);
    rec.createdAt = current?.createdAt || now;
    rec.updatedAt = now;
    await putRatingRecord(rec);
    current = rec; paint(rec);
  }

  upBtn.addEventListener('click', () => setRating('up'));
  downBtn.addEventListener('click', () => setRating('down'));
  reasons.addEventListener('click', async (e) => {
    const b = e.target.closest('.msg-rate-reason');
    if (!b || !current) return;
    const reason = current.reason === b.dataset.reason ? null : b.dataset.reason; // toggle
    current.reason = reason;
    current.updatedAt = Date.now();
    await putRatingRecord(current);
    paint(current);
  });
}

async function exportRatings() {
  const local = await getAllRatingRecords();
  let cloud = [];
  try { cloud = await PaperStore.getRatingsFromCloud?.() || []; }
  catch (e) { console.warn('[Rating] cloud fetch for export failed; exporting local only:', e.message); }
  // Merge by id, preferring the most recently updated copy.
  const byId = new Map();
  for (const rec of [...local, ...cloud]) {
    const prev = byId.get(rec.id);
    if (!prev || (rec.updatedAt || 0) >= (prev.updatedAt || 0)) byId.set(rec.id, rec);
  }
  const records = [...byId.values()];
  const btn = document.getElementById('export-ratings-btn');
  if (!records.length) {
    if (btn) { const t = btn.textContent; btn.textContent = 'No rated responses yet'; setTimeout(() => { btn.textContent = t; }, 1600); }
    return;
  }
  const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `paper-reader-ratings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function rebuildChat(d) {
  const box = document.getElementById('chat-messages');
  box.innerHTML = '';
  // Captured figures show a thumbnail at the top of the thread (lazy-loaded
  // from IndexedDB), so the discussion always carries its image — fresh or
  // restored — even before the first message.
  if (d.figure) renderChatFigure(box, d);
  const vis = d.messages.filter(m => !m.hidden);
  if (!vis.length) {
    const citeHint = d.figure
      ? `${d.figureCaption ? '💡 ' + esc(d.figureCaption) + '<br><br>' : ''}Press Send to have Claude explain the captured figure above.`
      : d.note
      ? `💡 ${esc(d.note)}<br><br>Ask anything about this passage — try “Explain this”, or select a formula for the math tools.`
      : d.citationMeta
      ? `Opened from a citation in “${esc(d.citationMeta.parentName)}”.<br>Ask anything about this paper.`
      : `Ask anything about this highlight.<br>Claude has the context of your earlier highlights in this document.`;
    box.insertAdjacentHTML('beforeend', `<div id="chat-empty-hint">
      <div class="ceh-icon">✦</div>
      ${citeHint}
    </div>`);
    return;
  }
  d.messages.forEach((m, idx) => {
    if (m.hidden) return;
    const div = addMsg(m.role, m.content);
    if (m.role === 'assistant') renderRatingControl(div, d, idx);
  });
  box.scrollTop = box.scrollHeight;
}

// Render the captured figure thumbnail at the top of a figure discussion.
export function addMsg(role, content, typing=false) {
  const box = document.getElementById('chat-messages');
  const hint = document.getElementById('chat-empty-hint');
  if (hint) hint.remove();
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.innerHTML = typing
    ? `<div class="msg-role">${role==='assistant'?'Claude':'You'}</div>
       <div class="msg-body"><div class="typing-dots"><div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div></div></div>`
    : `<div class="msg-role">${role==='assistant'?'Claude':'You'}</div>
       <div class="msg-body">${md(esc(content))}</div>`;
  box.appendChild(div); box.scrollTop = box.scrollHeight;
  return div;
}

// Build cross-highlight context from OTHER discussions in this doc
export function buildDocContext(currentId) {
  const others = discussions.filter(d => d.id !== currentId && d.messages.some(m => !m.hidden));
  if (!others.length) return '';
  let ctx = `\n\nEarlier highlights and discussions from THIS SAME DOCUMENT (the researcher may build on them):\n`;
  others.forEach((d, i) => {
    ctx += `\n[Highlight ${i+1}] "${d.txt.slice(0,200)}${d.txt.length>200?'…':''}"\n`;
    const vis = d.messages.filter(m => !m.hidden);
    vis.forEach(m => {
      ctx += `  ${m.role === 'user' ? 'Researcher' : 'You'}: ${m.content.slice(0,300)}${m.content.length>300?'…':''}\n`;
    });
  });
  return ctx;
}

// ═══════════════════════════════════════════════════════

// Locate the highlight inside the full paper text and return the surrounding
// window. Used as a fallback when the full paper is too big to send, and also
// helps Claude resolve references like "this", "the above equation", etc.
export function findNearbyContext(highlightText, radius = 1500) {
  if (!paperText) return '';
  // normalize whitespace for a forgiving match
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const hay = norm(paperText);
  const needle = norm(highlightText).slice(0, 120); // first chunk is enough to locate
  let idx = hay.indexOf(needle);
  if (idx === -1) {
    // try a shorter, distinctive slice
    idx = hay.indexOf(needle.slice(0, 50));
  }
  if (idx === -1) return '';
  const start = Math.max(0, idx - radius);
  const end   = Math.min(hay.length, idx + needle.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < hay.length ? '…' : '';
  return prefix + hay.slice(start, end) + suffix;
}

// Decide what document context to attach, given the "full if it fits" policy.
// Returns { block, cacheable } where block is the text to send.
export function buildPaperBlock() {
  // Rough token estimate: ~4 chars/token. Send full paper if under ~150k tokens.
  if (paperText && paperText.length <= MAX_PAPER_CHARS) {
    return { text: paperText, kind: 'full' };
  }
  return { text: '', kind: 'none' };
}

export async function sendMessage() {
  const input = document.getElementById('msg-input');
  const txt   = input.value.trim();
  if (!txt || !activeId) return;
  const d = discussions.find(x => x.id === activeId); if (!d) return;

  input.value=''; input.style.height='auto';
  d.messages.push({role:'user',content:txt}); addMsg('user',txt);
  persistCurrentDoc();
  scheduleSummaryUpdate();

  const loader = addMsg('assistant','',true);
  document.getElementById('send-btn').disabled = true;

  // ── Assemble system as content blocks so the paper can be cached ──
  const systemBlocks = [];

  // 1) Instruction block (small, not cached separately)
  systemBlocks.push({
    type: 'text',
    text:
      `You are a sharp, concise research assistant helping someone read a paper or article. ` +
      `Answer using the FULL DOCUMENT provided below as your source of truth — resolve references ` +
      `like "this", "the above equation", or "the previous section" against it. ` +
      `Lead with the core point, then briefly elaborate. Use plain language even for dense technical content. ` +
      `If something genuinely isn't in the document, say so rather than guessing.`,
  });

  // 2) Full-paper block (CACHED — same text on every question → cheap repeats)
  const paper = buildPaperBlock();
  if (paper.kind === 'full') {
    systemBlocks.push({
      type: 'text',
      text: `=== FULL DOCUMENT: ${docMeta.name} ===\n\n${paper.text}`,
      cache_control: { type: 'ephemeral' },
    });
  } else {
    // Fallback: paper too large or unavailable → send nearby context only
    const near = findNearbyContext(d.txt, 2500);
    if (near) {
      systemBlocks.push({
        type: 'text',
        text: `=== NEARBY CONTEXT (full paper too large to include) ===\n\n${near}`,
      });
    }
  }

  // 3) Citation navigation context (when opened from another paper)
  if (d.citationMeta) {
    systemBlocks.push({
      type: 'text',
      text:
        `=== CITATION CONTEXT ===\n` +
        `The researcher opened this paper from a citation while reading "${d.citationMeta.parentName}".\n` +
        `Selected citation: "${d.citationMeta.citationText}"\n` +
        (d.citationMeta.refText ? `Bibliography entry: ${d.citationMeta.refText}\n` : '') +
        `Answer in light of both this paper and why they followed the citation.`,
    });
  }

  // 3b) Math framing (when the thread was started from a formula). Sits next to
  // the cached full-document block so notation resolves against the whole paper.
  if (d.mathKind) {
    const texLine = d.mathTex ? `\nLaTeX source of the selected formula:\n${d.mathTex}\n` : '';
    if (d.mathKind === 'code') {
      systemBlocks.push({
        type: 'text',
        text:
          `=== MATH-TO-CODE REQUEST ===\n` +
          `The highlighted passage is a mathematical formula from this paper.${texLine}` +
          `Translate it into readable PyTorch/NumPy-style code with named variables and tensor ` +
          `shapes in comments; use einsum where it maps cleanly. Lead with the code block, then ` +
          `one or two lines mapping the code back to the notation. Resolve every symbol against the ` +
          `FULL DOCUMENT above.`,
      });
    } else {
      systemBlocks.push({
        type: 'text',
        text:
          `=== MATH EXPLANATION REQUEST ===\n` +
          `The highlighted passage is a mathematical formula from this paper.${texLine}` +
          `Explain it tightly in three tiers, skipping obvious terms:\n` +
          `1. One sentence in plain language: what the formula does.\n` +
          `2. Term-by-term breakdown: for each symbol, what it is, its shape/dimensions if inferable, ` +
          `and where it was defined earlier in THIS paper (name the section or equation if findable).\n` +
          `3. Why it's here: what it accomplishes in the paper's argument.\n` +
          `Resolve every symbol against the FULL DOCUMENT above.`,
      });
    }
  }

  // 3c) Figure framing (when the thread was started from a captured figure). The
  // captured image rides on the first user turn (below); this block tells Claude
  // how to explain it, grounded in the cached full document above.
  if (d.figure) {
    const capLine = d.figureCaption ? `\nNearby caption / context text: "${d.figureCaption}"\n` : '';
    systemBlocks.push({
      type: 'text',
      text:
        `=== FIGURE EXPLANATION REQUEST ===\n` +
        `The researcher captured a figure (a diagram, plot, or attention/feature map) from this ` +
        `paper; it is attached as an image on their message.${capLine}` +
        `First, say in ONE line what the figure shows. Then walk through the key elements — axes, ` +
        `components, what is being compared, and the takeaway — in plain language, tying it directly ` +
        `to the paper's argument (use the FULL DOCUMENT above to ground it). Skip the obvious and be concise.`,
    });
  }

  // 4) The specific highlight + cross-highlight memory (small, dynamic)
  systemBlocks.push({
    type: 'text',
    text:
      `=== THE RESEARCHER HIGHLIGHTED THIS PASSAGE ===\n"${d.txt}"\n` +
      buildDocContext(d.id),
  });

  const apiMessages = d.messages.filter(m=>!m.hidden).slice(-14).map(({role,content})=>({role,content}));

  // Attach the captured figure to the FIRST user turn as an image content block.
  // handler.js forwards `messages` verbatim, so array content with a
  // {type:'image'} block reaches the API unchanged — no key handling touched.
  // Stored messages stay plain strings (cloud-safe); the image is materialized
  // here, at send time, from IndexedDB.
  if (d.figure) {
    const dataUrl = await ensureFigureImage(d);
    const firstUser = apiMessages.findIndex(m => m.role === 'user');
    if (dataUrl && firstUser !== -1) {
      const comma = dataUrl.indexOf(',');
      const mediaType = dataUrl.slice(5, dataUrl.indexOf(';')) || d.figure.mediaType || 'image/png';
      const userText = typeof apiMessages[firstUser].content === 'string' ? apiMessages[firstUser].content : 'Explain this figure.';
      apiMessages[firstUser] = {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: dataUrl.slice(comma + 1) } },
          { type: 'text', text: userText },
        ],
      };
    }
  }
  if (d.mathKind) {
    const mathBlock = systemBlocks.find(b => /=== MATH/.test(b.text || ''));
    console.groupCollapsed(`[Math] ${d.mathKind} · → Claude`);
    console.log('user message:', txt);
    console.log('math system block:', mathBlock?.text);
    console.log('TeX sent:', d.mathTex || '(none)');
    console.log('paper context:', paper.kind === 'full' ? `full (${paper.text.length} chars, cached)` : paper.kind);
    console.log('conversation turns sent:', apiMessages.length);
    console.groupEnd();
  }
  try {
    const reply = await callClaude(systemBlocks, apiMessages);
    if (d.mathKind) {
      console.groupCollapsed(`[Math] ${d.mathKind} · ← Claude`);
      console.log(reply);
      console.groupEnd();
    }
    d.messages.push({role:'assistant',content:reply});
    loader.remove();
    const replyDiv = addMsg('assistant',reply);
    renderRatingControl(replyDiv, d, d.messages.length - 1);
    persistCurrentDoc(); renderList();
    scheduleSummaryUpdate();
  } catch(e) {
    if (d.mathKind) console.warn(`[Math] ${d.mathKind} · roundtrip failed:`, e.message);
    loader.remove(); addMsg('assistant',`Error: ${e.message}`);
  }
  document.getElementById('send-btn').disabled = false;
}

const CHAT_MODEL = 'claude-sonnet-4-6';
export async function callClaude(system, messages) {
  const r = await fetch('/api/chat', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:CHAT_MODEL,max_tokens:1000,system,messages})
  });
  const data = await r.json();
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error.message);
  return data.content?.[0]?.text ?? 'No response.';
}

// Wire up chat DOM listeners. Called once from boot().
export function initChat() {
  document.getElementById('back-btn').addEventListener('click', showList);
  document.getElementById('export-ratings-btn')?.addEventListener('click', exportRatings);
  document.getElementById('send-btn').addEventListener('click', sendMessage);
  document.getElementById('msg-input').addEventListener('keydown', e => {
    if (e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}
  });
  document.getElementById('msg-input').addEventListener('input', function() {
    this.style.height='auto'; this.style.height=Math.min(this.scrollHeight,100)+'px';
  });
}
