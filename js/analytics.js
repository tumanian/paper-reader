// Lightweight Google Analytics helpers. gtag is defined in index.html; these
// calls no-op in tests and when the tag is blocked.

export const TRANSFORMER_PAPER_ID = 'attention-is-all-you-need';
export const TRANSFORMER_ARXIV_ID = '1706.03762';

export function isTransformerPaper(urlOrId) {
  const s = String(urlOrId || '').toLowerCase();
  return s.includes(TRANSFORMER_ARXIV_ID) || s.includes(TRANSFORMER_PAPER_ID);
}

let pendingTransformerSource = null;

// Call before loadWebPage when the open path is known (e.g. featured example).
export function markTransformerOpenSource(source) {
  pendingTransformerSource = source || null;
}

function consumeTransformerOpenSource() {
  const source = pendingTransformerSource;
  pendingTransformerSource = null;
  return source;
}

export function trackTransformerPaperOpen(opts = {}) {
  if (typeof gtag !== 'function') return;
  try {
    gtag('event', 'open_transformer_paper', {
      paper_id: TRANSFORMER_PAPER_ID,
      arxiv_id: TRANSFORMER_ARXIV_ID,
      source: opts.source || 'unknown',
    });
  } catch (_) {}
}

export function maybeTrackTransformerPaperOpen(urlOrId, opts = {}) {
  if (!isTransformerPaper(urlOrId)) return;
  const source = opts.source || consumeTransformerOpenSource()
    || (opts.knownDocId ? 'library' : opts.citation ? 'citation' : 'url');
  trackTransformerPaperOpen({ source });
}
