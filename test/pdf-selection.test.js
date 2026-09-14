'use strict';

// Regression tests for PDF selection text drifting from the highlighted region.
//
// pdf.js 3.x sizes every text-layer span with `calc(var(--scale-factor) * px)`
// and scaleX-fits it to the glyph run on the canvas. Without the variable the
// spans render at the inherited font size, so their left edges are right but
// the characters inside are stretched: dragging over "DINOv3" at the end of a
// merged line highlights DINOv3 (the highlight comes from the range's rects)
// while Selection.toString() returns characters from further left.
//
// These tests model that browser behaviour with synthetic geometry and drive
// the real app code: pdfSelectionTextFromRects / collectPdfSelectionSpans
// (selection side) and renderPDFPages (the --scale-factor contract).

const { test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');

before(async () => { await app.ready; });
beforeEach(() => { app.reset(); });

// ── Browser model ──────────────────────────────────────────────────────────
// A text-layer span whose glyphs really sit at `left + i*charW` on the canvas,
// but which the browser lays out `k` times too wide (k = inherited font size /
// intended font size when --scale-factor is missing; 1 when it is set).
function makeSpan(text, { left = 100, top = 200, charW = 10, lineH = 14, k = 1 } = {}) {
  const renderedW = charW * k;
  const trueWidth = text.length * charW;
  const box = { left, top, right: left + trueWidth * k, bottom: top + lineH, width: trueWidth * k, height: lineH };
  const charBoxes = () => Array.from(text, (_, i) => ({ left: left + i * renderedW, right: left + (i + 1) * renderedW }));
  return { text, box, trueWidth, charBoxes, renderedW };
}

// What the browser does when the user drags from x0 to x1 across `span`: the
// caret snaps to the nearest rendered character boundary at each end, the
// selection's text is the characters between, and its client rect is their
// rendered box. This is the rect the highlight is painted from.
function browserDrag(span, x0, x1) {
  const idx = (x) => Math.max(0, Math.min(span.text.length, Math.round((x - span.box.left) / span.renderedW)));
  const a = idx(x0), b = idx(x1);
  return {
    domText: span.text.slice(a, b),
    rect: { left: span.box.left + a * span.renderedW, right: span.box.left + b * span.renderedW,
            top: span.box.top, bottom: span.box.bottom,
            width: (b - a) * span.renderedW, height: span.box.height },
  };
}

const LINE = 'Table 2 shows results on DINOv3';
const WORD = 'DINOv3';
const wordStart = LINE.indexOf(WORD);

// Visual x-range of DINOv3 on the canvas (independent of how the DOM is sized).
function visualRange(span) {
  const s = span.box.left + wordStart * (span.trueWidth / span.text.length);
  return [s, s + WORD.length * (span.trueWidth / span.text.length)];
}

test('stretched text layer: DOM text is offset from the highlight, rect-derived text is not', () => {
  // 9pt body at 1.5× should be 13.5px; without --scale-factor it renders at the
  // inherited 16px, i.e. every span is 16/13.5 ≈ 1.185× too wide.
  const span = makeSpan(LINE, { k: 16 / 13.5 });
  const [x0, x1] = visualRange(span);
  const { domText, rect } = browserDrag(span, x0, x1);

  // Reproduce the bug: the highlight rect covers DINOv3 on the canvas …
  assert.ok(rect.left <= x0 + span.renderedW / 2 && rect.right >= x1 - span.renderedW / 2);
  // … but the selection's own text is shifted left and the wrong length.
  assert.notEqual(domText.trim(), WORD);
  assert.ok(LINE.indexOf(domText) < wordStart, `expected "${domText}" to start left of DINOv3`);

  // The fix: derive the text from the rects that painted the highlight.
  const fixed = app.pdfSelectionTextFromRects([rect], [span]);
  assert.equal(fixed, WORD);
  assert.equal(app.normalizePdfSelectionText(fixed), WORD);
});

test('aligned text layer: DOM selection text is trusted (returns null)', () => {
  const span = makeSpan(LINE, { k: 1 });
  const [x0, x1] = visualRange(span);
  const { domText, rect } = browserDrag(span, x0, x1);
  assert.equal(domText, WORD);
  assert.equal(app.pdfSelectionTextFromRects([rect], [span]), null);
});

test('sub-tolerance layout jitter does not trigger re-derivation', () => {
  const k = 1 + app.constants.TEXT_LAYER_STRETCH_TOLERANCE / 2;
  const span = makeSpan(LINE, { k });
  const [x0, x1] = visualRange(span);
  const { rect } = browserDrag(span, x0, x1);
  assert.equal(app.pdfSelectionTextFromRects([rect], [span]), null);
});

test('single-glyph spans are never judged (pdf.js does not scaleX-fit them)', () => {
  const glyph = makeSpan('x', { k: 1.6 });
  const rect = { ...glyph.box };
  assert.equal(app.pdfSelectionTextFromRects([rect], [glyph]), null);
});

test('stretched multi-line selection joins the lines touched by each rect', () => {
  const k = 16 / 13.5;
  const l1 = makeSpan('results on DINOv3', { top: 200, k });
  const l2 = makeSpan('and SigLIP backbones', { top: 220, k });
  const x0 = l1.box.left + l1.text.indexOf('DINOv3') * 10;     // start of "DINOv3" on line 1
  const d1 = browserDrag(l1, x0, l1.box.left + l1.trueWidth);  // to end of line 1
  const d2 = browserDrag(l2, l2.box.left, l2.box.left + 3 * 10); // "and" on line 2
  const out = app.pdfSelectionTextFromRects([d1.rect, d2.rect], [l1, l2]);
  assert.equal(out, 'DINOv3 and');
});

test('empty inputs return null', () => {
  assert.equal(app.pdfSelectionTextFromRects([], [makeSpan(LINE)]), null);
  assert.equal(app.pdfSelectionTextFromRects([{ left: 0, right: 10, top: 0, bottom: 10, width: 10, height: 10 }], []), null);
});

// ── collectPdfSelectionSpans: builds the model above from real DOM objects ──
test('collectPdfSelectionSpans reads span geometry, data-w and per-character rects', () => {
  const k = 16 / 13.5;
  const model = makeSpan(LINE, { k });
  const tn = { nodeType: 3, nodeValue: LINE, length: LINE.length };
  const span = {
    firstChild: tn,
    dataset: { w: model.trueWidth.toFixed(2) },
    getBoundingClientRect: () => ({ ...model.box }),
  };
  const other = { firstChild: { nodeType: 3, nodeValue: 'elsewhere', length: 9 }, dataset: { w: '90' }, getBoundingClientRect: () => ({}) };
  const rotated = { firstChild: { nodeType: 3, nodeValue: 'sideways', length: 8 }, dataset: { w: '80' },
                    style: { transform: 'rotate(90deg) scaleX(1.02)' }, getBoundingClientRect: () => ({ left: 0, top: 0, right: 14, bottom: 80, width: 14, height: 80 }) };
  const pageWrap = { querySelectorAll: (sel) => (sel === '.textLayer span' ? [span, other, rotated] : []) };
  const range = { intersectsNode: (n) => n === span || n === rotated };

  // Per-character rects come from a Range over (textNode, i..i+1).
  const origCreateRange = app.document.createRange;
  app.document.createRange = () => {
    let i = 0;
    return {
      setStart(_n, off) { i = off; }, setEnd() {},
      getBoundingClientRect() { const b = model.charBoxes()[i]; return { left: b.left, right: b.right }; },
    };
  };
  try {
    const spans = app.collectPdfSelectionSpans(range, pageWrap);
    assert.equal(spans.length, 2);
    assert.equal(spans[1].text, 'sideways');
    assert.equal(spans[1].trueWidth, 0, 'rotated runs are never judged for stretch');
    assert.equal(spans[0].text, LINE);
    assert.equal(spans[0].trueWidth, model.trueWidth);
    assert.deepEqual(app.plain(spans[0].box), model.box);
    assert.deepEqual(app.plain(spans[0].charBoxes()), model.charBoxes());

    // End-to-end through the DOM-built model: same drag, same correction.
    const [x0, x1] = visualRange(model);
    const { domText, rect } = browserDrag(model, x0, x1);
    assert.notEqual(domText.trim(), WORD);
    assert.equal(app.pdfSelectionTextFromRects([rect], spans), WORD);
  } finally {
    app.document.createRange = origCreateRange;
  }
});

// ── renderPDFPages: the --scale-factor contract (root cause) ───────────────
function item(str, x, y, opts = {}) {
  return {
    str,
    transform: [opts.size || 9, 0, 0, opts.size || 9, x, y],
    width: opts.width != null ? opts.width : str.length * 5,
    height: opts.height || 9,
    fontName: 'F1',
    hasEOL: !!opts.hasEOL,
  };
}

let origRenderTextLayer;
afterEach(() => { if (origRenderTextLayer) { app.sandbox.pdfjsLib.renderTextLayer = origRenderTextLayer; origRenderTextLayer = null; } });

test('renderPDFPages sets --scale-factor to the viewport scale and stamps each span with its intended width', async () => {
  const SCALE = 1.5;
  const items = [
    item('Table 2 shows results on', 72, 700, { width: 120 }),
    item('DINOv3', 194, 700, { width: 40 }),
  ];
  const page = {
    getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale, scale }),
    render: () => ({ promise: Promise.resolve() }),
    getTextContent: async () => ({ items, styles: {} }),
  };
  app.state.pdfDoc = { numPages: 1, getPage: async () => page };

  // Mimic pdf.js 3.x: one span per text item, pushed into `textDivs` in order,
  // sized via the CSS variable the host page must define.
  const rendered = [];
  origRenderTextLayer = app.sandbox.pdfjsLib.renderTextLayer;
  app.sandbox.pdfjsLib.renderTextLayer = ({ textContentSource, container, viewport, textDivs }) => {
    for (const it of textContentSource.items) {
      const span = app.document.createElement('span');
      span.textContent = it.str;
      span.style.fontSize = `calc(var(--scale-factor)*${(it.transform[3]).toFixed(2)}px)`;
      textDivs.push(span);
      container.appendChild(span);
      rendered.push({ span, item: it, viewport });
    }
    return { promise: Promise.resolve() };
  };

  const container = app.document.getElementById('pdf-pages');
  container.children.length = 0;
  await app.renderPDFPages();

  const wrap = container.children[0];
  assert.ok(wrap, 'page wrapper appended');
  assert.equal(wrap.style.getPropertyValue('--scale-factor'), String(SCALE));

  // The merged line is one span whose intended width is the run width × scale.
  assert.equal(rendered.length, 1);
  const { span, item: merged } = rendered[0];
  assert.equal(merged.str, 'Table 2 shows results on DINOv3');
  assert.equal(span.dataset.w, (merged.width * SCALE).toFixed(2));
  assert.equal(span.dataset.w, ((194 + 40 - 72) * SCALE).toFixed(2));

  // With the variable defined, pdf.js's calc() resolves to the intended size
  // (9pt × 1.5 = 13.5px) instead of falling back to the inherited 16px.
  const px = parseFloat(span.style.fontSize.match(/\*([\d.]+)px/)[1]);
  assert.equal(px * parseFloat(wrap.style.getPropertyValue('--scale-factor')), 13.5);
});
