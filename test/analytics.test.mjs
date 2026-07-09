import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTransformerPaper,
  markTransformerOpenSource,
  maybeTrackTransformerPaperOpen,
  trackTransformerPaperOpen,
  TRANSFORMER_ARXIV_ID,
} from '../js/analytics.js';

test('isTransformerPaper matches arxiv id and onboarding paper id', () => {
  assert.equal(isTransformerPaper('https://ar5iv.org/abs/1706.03762'), true);
  assert.equal(isTransformerPaper('attention-is-all-you-need'), true);
  assert.equal(isTransformerPaper('https://arxiv.org/abs/1234.5678'), false);
});

test('trackTransformerPaperOpen is a no-op without gtag', () => {
  assert.doesNotThrow(() => trackTransformerPaperOpen({ source: 'featured' }));
});

test('maybeTrackTransformerPaperOpen consumes marked source', () => {
  const calls = [];
  globalThis.gtag = (...args) => calls.push(args);
  markTransformerOpenSource('featured');
  maybeTrackTransformerPaperOpen(`https://ar5iv.org/abs/${TRANSFORMER_ARXIV_ID}`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'event');
  assert.equal(calls[0][1], 'open_transformer_paper');
  assert.equal(calls[0][2].source, 'featured');
  delete globalThis.gtag;
});

test('maybeTrackTransformerPaperOpen infers library source from knownDocId', () => {
  const calls = [];
  globalThis.gtag = (...args) => calls.push(args);
  maybeTrackTransformerPaperOpen(`https://ar5iv.org/abs/${TRANSFORMER_ARXIV_ID}`, { knownDocId: 'doc-1' });
  assert.equal(calls[0][2].source, 'library');
  delete globalThis.gtag;
});
