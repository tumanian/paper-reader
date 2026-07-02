// Single source of truth for the app's SHARED, cross-cutting state.
//
// Design (conservative, per refactor decision):
//  - Each shared value is a module-level binding, exported for READS. Consumers
//    `import` them and read the live binding directly (ES module live bindings
//    reflect every writer update), so existing read sites are unchanged.
//  - ALL writes go through the named writer functions below — reassignments
//    happen here (importers cannot reassign an imported binding anyway), and
//    `discussions` is kept as a single mutable array, mutated IN PLACE so any
//    held reference stays valid (avoids the stale-array / discussion-loss bug).
//  - Pure transition helpers (e.g. removeById) carry the logic and are unit
//    tested in isolation; the writers apply them to the live state.
//
// Feature-local plumbing (timers, abort controllers, classify token, capture
// flags, onboarding handles, citationFormatPromise) intentionally stays with
// its feature for now and moves into the owning module later — only genuinely
// shared state lives here.

export let pdfDoc = null;
export let discussions = [];
export let activeId = null;
export let pendingSel = null;
export let pendingCitation = null;
export let currentDocId = null;
export let currentMode = null;
export let docMeta = { name: '', mode: '', badge: '', url: null };
export let conversationSummary = null;
export let summaryMessageCount = 0;
export let summaryDirty = false;
export let returnToDocId = null;
export let returnToDocName = null;
export let bibByNumber = {};
export let paperReferences = [];
export let citationFormat = null;
// Full extracted text of the current paper (for context + caching), capped so
// we never blow past the long-context surcharge threshold. Large, rarely
// changing data — held by reference, never cloned.
export let paperText = '';
export let paperRefText = '';

// Cap on the extracted paper text, ~150k tokens, safely under the 200k cap.
export const MAX_PAPER_CHARS = 600000;

// In-flight guard for the async citation-format detection (shared between the
// web/pdf loaders that reset it and the resolver that populates it).
export let citationFormatPromise = null;
export function setCitationFormatPromise(v) { citationFormatPromise = v; }

// Highlight color palette + next-color picker (cycles by discussion count).
// Shared by selection, chat, and onboarding — a discussion-level helper.
export const COLORS = [
  { bg:'rgba(255,215,0,.45)',   dot:'#c9a000' },
  { bg:'rgba(80,210,130,.45)',  dot:'#1a9950' },
  { bg:'rgba(100,165,255,.45)', dot:'#2e72e0' },
  { bg:'rgba(255,110,150,.45)', dot:'#d02060' },
  { bg:'rgba(195,115,255,.45)', dot:'#8830d8' },
  { bg:'rgba(255,145,60,.45)',  dot:'#d05010' },
];
export function nextColor() { return COLORS[discussions.length % COLORS.length]; }

// ── Pure transition helpers (unit-tested in isolation) ──────────────────────
export function removeById(list, id) {
  return list.filter((x) => x.id !== id);
}

// ── Discussions writers (keep one mutable array; mutate in place) ───────────
export function addDiscussion(d) { discussions.push(d); }
export function removeDiscussion(id) {
  const kept = removeById(discussions, id);
  discussions.length = 0;
  discussions.push(...kept);
}
export function clearDiscussions() { discussions.length = 0; }
export function replaceDiscussions(list) {
  discussions.length = 0;
  if (list && list.length) discussions.push(...list);
}

// ── Scalar / object writers ─────────────────────────────────────────────────
export function setPdfDoc(v) { pdfDoc = v; }
export function setActiveId(v) { activeId = v; }
export function setPendingSel(v) { pendingSel = v; }
export function setPendingCitation(v) { pendingCitation = v; }
export function setCurrentDocId(v) { currentDocId = v; }
export function setCurrentMode(v) { currentMode = v; }
export function setDocMeta(v) { docMeta = v; }
export function setConversationSummary(v) { conversationSummary = v; }
export function setSummaryMessageCount(v) { summaryMessageCount = v; }
export function setSummaryDirty(v) { summaryDirty = v; }
export function setReturnToDocId(v) { returnToDocId = v; }
export function setReturnToDocName(v) { returnToDocName = v; }
export function setBibByNumber(v) { bibByNumber = v; }
export function setPaperReferences(v) { paperReferences = v; }
export function setCitationFormat(v) { citationFormat = v; }
export function setPaperText(v) { paperText = v; }
export function setPaperRefText(v) { paperRefText = v; }
