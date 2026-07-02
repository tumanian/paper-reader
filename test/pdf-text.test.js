'use strict';

// Characterization tests for the PDF text-extraction helpers in index.html.
// These run on synthetic pdf.js text items (transform = [a,b,c,d,x,y]) so they
// stay fast and deterministic without a real PDF.

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');
const { plain } = app;

before(async () => { await app.ready; });
beforeEach(() => { app.reset(); });

function item(str, x, y, opts = {}) {
  return {
    str,
    transform: [opts.size || 10, 0, 0, opts.size || 10, x, y],
    width: opts.width != null ? opts.width : str.length * 5,
    height: opts.height || 10,
    fontName: 'F1',
    hasEOL: !!opts.hasEOL,
  };
}

test('sanitizePdfString strips NUL characters', () => {
  assert.equal(app.sanitizePdfString('a\u0000b\u0000c'), 'abc');
  assert.equal(app.sanitizePdfString(null), '');
});

test('pdfFontSize derives size from the transform matrix', () => {
  assert.equal(app.pdfFontSize({ transform: [12, 0, 0, 12, 0, 0] }), 12);
  assert.equal(app.pdfFontSize(null), 10); // default
});

test('combinePdfTextItems merges adjacent items on the same line', () => {
  const items = [
    item('Hello', 0, 100, { width: 30 }),
    item('world', 32, 100, { width: 30 }),
  ];
  const out = app.combinePdfTextItems(items);
  assert.equal(out.length, 1);
  assert.equal(out[0].str, 'Hello world');
});

test('combinePdfTextItems breaks items onto separate runs across lines', () => {
  const items = [
    item('Line one', 0, 100, { width: 40, hasEOL: true }),
    item('Line two', 0, 80, { width: 40 }),
  ];
  const out = app.combinePdfTextItems(items);
  assert.deepEqual(plain(out.map((o) => o.str)), ['Line one', 'Line two']);
});

test('pdfTextItemsToString inserts newlines on vertical jumps and trims', () => {
  const items = [
    item('First', 0, 100, { width: 30, hasEOL: true }),
    item('Second', 0, 80, { width: 35 }),
  ];
  const s = app.pdfTextItemsToString(items);
  assert.equal(s, 'First\nSecond');
});

test('pdfTextItemsToString returns empty string for no items', () => {
  assert.equal(app.pdfTextItemsToString([]), '');
});

test('normalizePdfSelectionText rejoins letter-spaced runs', () => {
  assert.equal(app.normalizePdfSelectionText('h e l l o'), 'hello');
  assert.equal(app.normalizePdfSelectionText('T r a n s f o r m e r'), 'Transformer');
});

test('normalizePdfSelectionText leaves ordinary multi-word text intact', () => {
  assert.equal(app.normalizePdfSelectionText('the quick brown fox'), 'the quick brown fox');
});

test('normalizePdfSelectionText collapses runs of whitespace', () => {
  assert.equal(app.normalizePdfSelectionText('foo    bar\n\tbaz'), 'foo bar baz');
});
