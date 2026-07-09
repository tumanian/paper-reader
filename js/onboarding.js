// ═══════════════════════════════════════════════════════
//  ONBOARDING  (first-time guided tour — paints from static curation)
// ═══════════════════════════════════════════════════════
// Loads onboarding-curation.json, opens the featured annotated example, and
// paints its curated highlights onto the rendered page (reusing the normal
// discussion + paintHighlight path). Also drives the "auto-run the advertised
// feature on first click" demo behaviour for teaching highlights.

import { isTodoValue, normalizeForMatch } from './util.js';
import { currentMode, discussions, docMeta, nextColor } from './state.js';
import { setPendingSel, setPendingCitation, clearDiscussions, addDiscussion } from './state.js';
import { persistCurrentDoc } from './persistence.js';
import { parseCitation, parseParentheticalAuthorYear } from './citation-parse.js';
import { findEquationAfter, rectsForElement, equationDisplayText, equationHighlightId } from './equation-highlight.js';
import { loadWebPage, locateTextRange, rectsForRange } from './web-loader.js';
import { loadCitationPreview, seedOnboardingCitationCache } from './citation-resolve.js';
import { positionPopover } from './selection.js';
import { armFigureCapture, figureToast, FIGURE_CAPTURE_ENABLED } from './figure.js';
import { openChat, sendMessage, paintHighlight, renderList, playOnboardingCachedChat } from './chat.js';

// Onboarding demo highlights auto-run the feature they advertise on first click,
// so a first-time visitor sees citations / explain-math / to-code in action
// without having to discover the gesture. After the demo has run once (math/code
// leave a chat behind) clicks fall through to the normal discussion.
export function runOnboardingDemo(d) {
  if (!d || !d.feature || d.feature === 'discuss') return false;
  if (d.messages && d.messages.length) return false;
  // Figure can't be auto-run (it needs a real drag) — clicking the teaching
  // highlight arms the one-shot capture so the user performs the gesture.
  if (d.feature === 'figure') {
    if (!FIGURE_CAPTURE_ENABLED) return false;
    armFigureCapture();
    figureToast('Drag a box around the figure above to capture it.');
    return true;
  }
  if (d.feature === 'citation') { showOnboardingCitationDemo(d); return true; }
  if (d.feature === 'math' || d.feature === 'code') {
    d.mathKind = d.feature === 'code' ? 'code' : 'explain';
    d.mathTex = d.tex || d.mathTex || null;
    const cached = getOnboardingChatCache(activeOnboardingPaperId, d.feature);
    if (cached) {
      playOnboardingCachedChat(d, cached.user, cached.assistant)
        .catch((e) => console.warn('playOnboardingCachedChat failed:', e));
      return true;
    }
    openChat(d.id);
    const input = document.getElementById('msg-input');
    input.value = d.feature === 'code' ? 'Translate this formula to code.' : 'Explain this math.';
    sendMessage();
    return true;
  }
  return false;
}

// Replay the real citation flow: re-locate the snippet, synthesize the same
// pendingSel a live selection would produce, then show the preview popover.
function showOnboardingCitationDemo(d) {
  const aw = document.getElementById('article-wrapper');
  const body = document.getElementById('article-body');
  const range = (aw && body) ? locateTextRange(body, d.txt) : null;
  if (!range) { openChat(d.id); return; }
  const anchor = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
  anchor?.scrollIntoView({ block: 'center' });
  const rects = Array.from(range.getClientRects()).filter(r => r.width > 1);
  if (!rects.length) { openChat(d.id); return; }
  const ar = aw.getBoundingClientRect();
  // d.cite (e.g. "[13]") drives the matcher directly; passing range:null skips
  // expandSelectionText so the marker isn't clobbered by the prose anchor text.
  const txt = d.cite || range.toString();
  setPendingSel({
    txt, range: d.cite ? null : range.cloneRange(), mode: 'web', pageNum: null, wrapper: aw,
    relRects: rects.map(r => ({ left: r.left - ar.left, top: r.top - ar.top, width: r.width, height: r.height })),
    mathTex: null, math: null,
  });
  setPendingCitation(parseCitation(txt) || parseParentheticalAuthorYear(txt));
  document.getElementById('explain-math-btn').style.display = 'none';
  document.getElementById('to-code-btn').style.display = 'none';
  positionPopover(rects[rects.length - 1]);
  loadCitationPreview();
}

let onboardingData = null;
let onboardingActionCache = null;
let activeOnboardingPaperId = null;
// Tear-down handle for an in-flight onboarding highlight placement (its
// MutationObserver + safety timer). Called when a new paper starts loading so
// a stale observer can't fire against the next paper's DOM.
let _onboardingCancel = null;
// Tear down the observer/timer only. Does NOT clear activeOnboardingPaperId —
// applyOnboardingItems restarts placement for the SAME paper and the demo
// chat cache is keyed by that id (nulling it here broke cached math/code demos).
function stopOnboardingPlacement() {
  if (_onboardingCancel) { try { _onboardingCancel(); } catch (_) {} _onboardingCancel = null; }
}
export function cancelOnboardingPlacement() {
  stopOnboardingPlacement();
  activeOnboardingPaperId = null;
}
let pendingOnboarding = null;

// Defensive parse: tolerate malformed entries without losing the rest.
export function sanitizeOnboarding(json) {
  const out = { tracks: [], papers: {}, featured: '' };
  if (!json || typeof json !== 'object') return out;
  if (typeof json.featured === 'string') out.featured = json.featured;
  if (json.papers && typeof json.papers === 'object') {
    for (const [k, v] of Object.entries(json.papers)) {
      if (!v || typeof v !== 'object') continue;
      const items = Array.isArray(v.items)
        ? v.items.filter((it) => it && typeof it.snippet === 'string')
                 .map((it) => ({
                   snippet: it.snippet,
                   type: it.type || 'prose',
                   note: typeof it.note === 'string' ? it.note : '',
                   feature: ['math', 'code', 'citation', 'discuss', 'figure'].includes(it.feature) ? it.feature : 'discuss',
                   tex: typeof it.tex === 'string' ? it.tex : null,
                   cite: typeof it.cite === 'string' ? it.cite : null,
                 }))
        : [];
      out.papers[k] = { paperId: k, title: v.title || k, url: v.url || '', hook: v.hook || '', startLabel: typeof v.startLabel === 'string' ? v.startLabel : '', items };
    }
  }
  if (Array.isArray(json.tracks)) {
    for (const t of json.tracks) {
      if (!t || typeof t !== 'object') continue;
      const paperIds = Array.isArray(t.paperIds) ? t.paperIds.filter((id) => out.papers[id]) : [];
      out.tracks.push({ id: t.id || '', label: t.label || 'Untitled', blurb: t.blurb || '', paperIds });
    }
  }
  return out;
}

export function sanitizeOnboardingActionCache(json) {
  const out = { papers: {} };
  if (!json || typeof json !== 'object') return out;
  if (!json.papers || typeof json.papers !== 'object') return out;
  for (const [paperId, paper] of Object.entries(json.papers)) {
    if (!paper || typeof paper !== 'object') continue;
    const entry = { citations: {}, chat: {} };
    if (paper.citations && typeof paper.citations === 'object') {
      for (const [citeKey, citeVal] of Object.entries(paper.citations)) {
        if (citeVal && typeof citeVal === 'object' && typeof citeVal.preview === 'string') {
          entry.citations[citeKey] = citeVal;
        }
      }
    }
    if (paper.chat && typeof paper.chat === 'object') {
      for (const feature of ['math', 'code', 'discuss']) {
        const c = paper.chat[feature];
        if (c && typeof c.user === 'string' && typeof c.assistant === 'string') {
          entry.chat[feature] = { user: c.user, assistant: c.assistant };
        }
      }
    }
    if (Object.keys(entry.citations).length || Object.keys(entry.chat).length) {
      out.papers[paperId] = entry;
    }
  }
  return out;
}

export async function loadOnboardingActionCache() {
  if (onboardingActionCache) return onboardingActionCache;
  try {
    const r = await fetch('/onboarding-action-cache.json', { cache: 'no-cache' });
    onboardingActionCache = sanitizeOnboardingActionCache(await r.json());
  } catch (e) {
    console.warn('[Onboarding] could not load action cache:', e?.message);
    onboardingActionCache = { papers: {} };
  }
  return onboardingActionCache;
}

function getOnboardingChatCache(paperId, feature) {
  if (!paperId || !feature) return null;
  return onboardingActionCache?.papers?.[paperId]?.chat?.[feature] || null;
}

function applyOnboardingActionCache(paperId) {
  const cache = onboardingActionCache?.papers?.[paperId];
  if (!cache) return;
  if (cache.citations && Object.keys(cache.citations).length) {
    seedOnboardingCitationCache(cache.citations);
  }
}

export async function loadOnboardingData() {
  if (onboardingData) return onboardingData;
  try {
    const r = await fetch('/onboarding-curation.json', { cache: 'no-cache' });
    onboardingData = sanitizeOnboarding(await r.json());
  } catch (e) {
    console.warn('[Onboarding] could not load curation:', e?.message);
    onboardingData = { tracks: [], papers: {} };
  }
  return onboardingData;
}

// The featured annotated paper, surfaced as a sparkled card in the library
// for everyone. Reads the cached curation (preloaded at boot); returns null
// until loaded.
export function getFeaturedPaper() {
  const data = onboardingData;
  if (!data || !data.papers) return null;
  return data.papers[data.featured]
    || data.papers['attention-is-all-you-need']
    || Object.values(data.papers)[0]
    || null;
}

// Open the featured annotated example. Its pre-placed annotations are applied
// via maybeApplyOnboardingCuration once the page renders.
export async function openFeaturedExample() {
  await loadOnboardingData();
  await openOnboardingPaper(getFeaturedPaper());
}

export async function openOnboardingPaper(paper) {
  if (!paper || isTodoValue(paper.url)) {
    alert('This example has no URL yet — add a real one in onboarding-curation.json.');
    return;
  }
  pendingOnboarding = paper;
  await loadWebPage(paper.url);
}

// Locate a verbatim snippet in a rendered container and return a DOM Range.
// Walks text nodes, builds a whitespace-normalized concatenation with a char→
// (node, offset) map, finds the snippet, and rebuilds a Range. Returns null if
// not found (caller skips silently).
// locateTextRange + rectsForRange live in web-loader.js (shared with resize reflow).
// findEquationAfter + rectsForElement live there too (math/code highlight placement).

// The demo auto-run leaves exactly one canned user/assistant pair behind; any
// other messages mean the visitor actually engaged with the thread.
const DEMO_PROMPTS = ['Explain this math.', 'Translate this formula to code.'];
function isUntouchedOnboardingDemo(d) {
  if (!d.onboarding) return false;
  const msgs = d.messages || [];
  if (msgs.length === 0) return true;
  return msgs.length === 2
    && msgs[0].role === 'user' && DEMO_PROMPTS.includes(msgs[0].content)
    && msgs[1].role === 'assistant';
}

// Paint precomputed highlights for the just-opened onboarding paper. Reuses the
// normal discussion + paintHighlight path; skips unmatched snippets silently.
function onboardingPaperForUrl(url) {
  const data = onboardingData;
  if (!data?.papers || !url) return null;
  const norm = String(url).replace(/\/$/, '');
  for (const paper of Object.values(data.papers)) {
    if (paper?.url && String(paper.url).replace(/\/$/, '') === norm) return paper;
  }
  return null;
}

export function maybeApplyOnboardingCuration() {
  let paper = pendingOnboarding;
  pendingOnboarding = null;
  if (!paper && currentMode === 'web' && docMeta?.url) {
    paper = onboardingPaperForUrl(docMeta.url);
  }
  if (!paper || currentMode !== 'web' || !Array.isArray(paper.items)) {
    activeOnboardingPaperId = null;
    return;
  }
  activeOnboardingPaperId = paper.paperId || null;
  applyOnboardingActionCache(activeOnboardingPaperId);
  if (discussions.length > 0) {
    // Re-patch math/code highlights that were placed before equation targeting
    // worked (e.g. ar5iv tables after DOMPurify drop ltx_equation classes).
    if (repatchOnboardingEquationHighlights(paper.items)) return;
    // Reopened. If the visitor never engaged (every highlight is an onboarding
    // demo that's untouched, or holds only the auto-played demo exchange),
    // refresh from the latest curation so fixes/new demos replace stale
    // highlights. If they have a real discussion going, leave it alone.
    const refreshable = discussions.every(isUntouchedOnboardingDemo);
    if (!refreshable) return;
    const layer = document.getElementById('article-wrapper')?.querySelector('.highlights-layer');
    if (layer) layer.innerHTML = '';
    clearDiscussions();
  }
  applyOnboardingItems(paper.items.slice());
}

// Fix stale math/code demo highlights in place (keeps messages) when equation
// placement metadata is missing or rects still cover the prose anchor.
function repatchOnboardingEquationHighlights(items) {
  const aw = document.getElementById('article-wrapper');
  const body = document.getElementById('article-body');
  if (!aw || !body) return false;
  let changed = false;
  for (const d of discussions) {
    if (!d.onboarding || (d.feature !== 'math' && d.feature !== 'code')) continue;
    if (d.equationId) continue;
    const item = items.find((it) => it.feature === d.feature && it.tex === d.tex);
    if (!item) continue;
    const range = locateTextRange(body, item.snippet);
    if (!range) continue;
    const eq = findEquationAfter(range);
    if (!eq) continue;
    const eqRects = rectsForElement(eq, aw);
    if (!eqRects.length) continue;
    d.relRects = eqRects;
    d.txt = equationDisplayText(eq, item.tex);
    d.equationId = equationHighlightId(eq);
    d._range = range.cloneRange();
    changed = true;
  }
  if (!changed) return false;
  const layer = aw.querySelector('.highlights-layer');
  if (layer) layer.innerHTML = '';
  for (const d of discussions) {
    if (d.mode === 'web' && d.wrapper == null) d.wrapper = aw;
    if (d.mode === 'web' && !d.figure) paintHighlight(d);
  }
  renderList();
  persistCurrentDoc();
  return true;
}

// Place curated highlights, reusing the normal discussion + paintHighlight path.
// Some sites (e.g. Distill) hydrate custom elements (<d-cite>, math) well after
// first render, so a snippet may not be locatable for several seconds. We do an
// immediate pass for what's ready, then re-attempt the rest on every DOM
// mutation (debounced) until everything places or a 20s safety deadline hits.
// Unmatched snippets are skipped silently — partial success is fine.
function applyOnboardingItems(items) {
  stopOnboardingPlacement();
  const startedAt = Date.now();
  let remaining = items.slice();
  let observer = null, debounce = null, finished = false;

  function attempt() {
    const aw = document.getElementById('article-wrapper');
    const body = document.getElementById('article-body');
    if (!aw || !body) return;
    const stillMissing = [];
    let placedAny = false;
    for (const item of remaining) {
      try {
        if (!item || typeof item.snippet !== 'string' || isTodoValue(item.snippet)) continue;
        // Figure capture is disabled — don't paint its teaching highlight.
        if (item.feature === 'figure' && !FIGURE_CAPTURE_ENABLED) continue;
        const range = locateTextRange(body, item.snippet);
        if (!range) { stillMissing.push(item); continue; }
        const feature = ['math', 'code', 'citation', 'discuss', 'figure'].includes(item.feature) ? item.feature : 'discuss';
        let relRects = rectsForRange(range, aw);
        let highlightTxt = normalizeForMatch(range.toString());
        let equationId = null;
        // Math/code snippets anchor on prose next to the equation — highlight the
        // equation itself so the selection isn't scattered across the paragraph.
        if (feature === 'math' || feature === 'code') {
          const eq = findEquationAfter(range);
          if (!eq) { stillMissing.push(item); continue; }
          const eqRects = rectsForElement(eq, aw);
          if (!eqRects.length) { stillMissing.push(item); continue; }
          relRects = eqRects;
          highlightTxt = equationDisplayText(eq, item.tex);
          equationId = equationHighlightId(eq);
        }
        if (!relRects.length) { stillMissing.push(item); continue; }
        const d = {
          id: PaperStore.newId(),
          txt: highlightTxt,
          mode: 'web', pageNum: null, color: nextColor(), wrapper: aw,
          relRects, messages: [],
          _range: range.cloneRange(),
          equationId,
          note: item.note || null, onboarding: true,
          feature, tex: item.tex || null, cite: item.cite || null,
          // Stamp math metadata at placement (not first click) so the formula
          // is persisted with the discussion from the start.
          mathKind: feature === 'math' ? 'explain' : (feature === 'code' ? 'code' : null),
          mathTex: (feature === 'math' || feature === 'code') ? (item.tex || null) : null,
        };
        addDiscussion(d);
        paintHighlight(d);
        placedAny = true;
      } catch (e) { console.warn('[Onboarding] skipped a curation item:', e?.message); }
    }
    remaining = stillMissing;
    if (placedAny) { renderList(); persistCurrentDoc(); maybeShowOnboardingHint(); }
    if (!remaining.length || Date.now() - startedAt > 20000) finish();
  }

  function finish() {
    if (finished) return;
    finished = true;
    if (observer) observer.disconnect();
    if (debounce) clearTimeout(debounce);
    if (_onboardingCancel === finish) _onboardingCancel = null;
    if (remaining.length) console.info('[Onboarding]', remaining.length, 'snippet(s) never matched the rendered page.');
  }
  _onboardingCancel = finish;

  attempt();
  if (finished) return;

  const body = document.getElementById('article-body');
  if (body && 'MutationObserver' in window) {
    observer = new MutationObserver(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(attempt, 250);
    });
    observer.observe(body, { childList: true, subtree: true, characterData: true });
  }
  setTimeout(finish, 20000);
}

function maybeShowOnboardingHint() {
  const rect = document.querySelector('#article-wrapper .hl-rect[data-onboarding="1"]');
  if (!rect) return;
  document.getElementById('ob-hint')?.remove();
  const hint = document.createElement('div');
  hint.id = 'ob-hint';
  hint.textContent = 'Tap a highlight to discuss it with Claude →';
  document.body.appendChild(hint);
  const r = rect.getBoundingClientRect();
  hint.style.top = Math.max(8, r.top - 4) + 'px';
  hint.style.left = Math.min(r.right + 12, window.innerWidth - 236) + 'px';
  const dismiss = () => {
    hint.remove();
    document.removeEventListener('click', dismiss, true);
    document.removeEventListener('keydown', dismiss, true);
  };
  setTimeout(() => {
    document.addEventListener('click', dismiss, true);
    document.addEventListener('keydown', dismiss, true);
  }, 60);
  setTimeout(dismiss, 9000);
}
