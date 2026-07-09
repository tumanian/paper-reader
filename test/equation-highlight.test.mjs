import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EQUATION_SELECTOR,
  findEquationAfter,
  equationDisplayText,
  equationHighlightId,
  equationRootFromNode,
  elementById,
} from '../js/equation-highlight.js';

function mockEl(tag, { id, className = '', attrs = {}, parent = null, next = null, children = [] } = {}) {
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    id,
    className,
    parentElement: parent,
    nextElementSibling: next,
    children,
    _attrs: attrs,
    textContent: attrs.textContent || '',
    matches(sel) {
      if (sel.includes('math[display="block"]') && tag === 'math' && attrs.display === 'block') return true;
      if (sel.includes('math[alttext]') && tag === 'math') return true;
      if (sel.includes('ltx_equation') && className.includes('ltx_equation')) return true;
      if (sel.includes('table') && tag === 'table') return true;
      return false;
    },
    closest(sel) {
      if (sel === 'table' && tag === 'math') return parent?.tagName === 'TABLE' ? parent : null;
      return null;
    },
    querySelector(sel) {
      const findIn = (nodes) => {
        for (const c of nodes) {
          if (c.matches?.(sel)) return c;
          const nested = c.children?.length ? findIn(c.children) : null;
          if (nested) return nested;
        }
        return null;
      };
      if (sel.includes('annotation')) {
        const math = findIn(children);
        return math?.children?.find((c) => c.tagName === 'ANNOTATION') || null;
      }
      return findIn(children);
    },
    getAttribute(k) { return this._attrs[k]; },
    getBoundingClientRect() { return { left: 10, top: 100, width: 280, height: 36, right: 290, bottom: 136 }; },
  };
  for (const c of children) c.parentElement = el;
  return el;
}

test('findEquationAfter walks to the display equation after prose anchor', () => {
  const math = mockEl('math', { attrs: { display: 'block', alttext: 'Attention(Q,K,V)=softmax(...)' } });
  const table = mockEl('table', { id: 'S3.E1', className: 'ltx_equation ltx_eqn_table', children: [math] });
  const eqWrap = mockEl('div', { children: [table] });
  const p = mockEl('p');
  const proseWrap = mockEl('div', { children: [p], next: eqWrap });
  p.parentElement = proseWrap;
  const text = { nodeType: 3, parentElement: p };
  const range = { endContainer: text };
  const found = findEquationAfter(range);
  assert.equal(found, table);
});

test('equationRootFromNode finds display math when ltx classes were stripped', () => {
  const math = mockEl('math', { attrs: { display: 'block', alttext: 'E=mc^2' } });
  const table = mockEl('table', { id: 'S3.E1', children: [math] });
  assert.equal(equationRootFromNode(table), table);
  assert.equal(equationHighlightId(table), 'S3.E1');
});

test('findEquationAfter finds sanitized ar5iv tables without ltx_equation class', () => {
  const math = mockEl('math', { attrs: { display: 'block' } });
  const table = mockEl('table', { id: 'S3.E1', children: [math] });
  const eqWrap = mockEl('div', { children: [table] });
  const p = mockEl('p');
  const proseWrap = mockEl('div', { children: [p], next: eqWrap });
  const text = { nodeType: 3, parentElement: p };
  assert.equal(findEquationAfter({ endContainer: text }), table);
});

test('equationDisplayText prefers MathML alttext over tex fallback', () => {
  const ann = { tagName: 'ANNOTATION', textContent: '\\mathrm{Attention}(Q,K,V)' };
  const math = mockEl('math', { attrs: { alttext: 'Attention(Q,K,V)=softmax(...)' }, children: [ann] });
  const table = mockEl('table', { className: 'ltx_equation', children: [math] });
  assert.equal(equationDisplayText(table, 'fallback'), 'Attention(Q,K,V)=softmax(...)');
});

test('elementById finds ids containing dots via attribute selector', () => {
  const table = mockEl('table', { id: 'S3.E1', className: 'ltx_equation' });
  const root = {
    querySelector(sel) {
      if (sel.includes('S3.E1')) return table;
      return null;
    },
  };
  assert.equal(elementById(root, 'S3.E1'), table);
});

test('EQUATION_SELECTOR includes ar5iv ltx_equation tables', () => {
  assert.match(EQUATION_SELECTOR, /ltx_equation/);
});
