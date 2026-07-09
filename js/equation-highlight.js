// Display-equation discovery for web-reader highlights. Pure DOM helpers with
// no feature imports — shared by onboarding placement and web highlight reflow.

export const EQUATION_SELECTOR = '.ltx_equation, .ltx_equationgroup, .ltx_eqn_table, math[display="block"], mjx-container[display="true"], .MathJax_Display, .katex-display';

const DISPLAY_MATH_SEL = 'math[display="block"], mjx-container[display="true"], .MathJax_Display, .katex-display';

// ar5iv HTML keeps <math display="block"> after sanitization but often drops the
// ltx_equation class from the wrapping <table>. Recognize both shapes.
export function equationRootFromNode(el) {
  if (!el) return null;
  if (el.matches?.(DISPLAY_MATH_SEL)) return el.closest?.('table') || el;
  if (el.matches?.('table') && el.querySelector?.(DISPLAY_MATH_SEL)) return el;
  if (el.matches?.(EQUATION_SELECTOR)) return el.closest?.('table') || el;
  const inner = el.querySelector?.(`${EQUATION_SELECTOR}, ${DISPLAY_MATH_SEL}`);
  if (!inner) return null;
  return inner.closest?.('table') || inner;
}

// Prefer the table id (e.g. S3.E1) over the inner <math> id for stable reflow.
export function equationHighlightId(el) {
  if (!el) return null;
  const table = el.matches?.('table') ? el : el.closest?.('table');
  if (table?.id) return table.id;
  return el.id || null;
}

// Formula snippets in onboarding curation anchor on prose *before* the equation
// (MathML isn't text-locatable). Walk forward from the anchor range to find the
// display equation that follows.
export function findEquationAfter(range) {
  if (!range) return null;
  let el = range.endContainer.nodeType === 3 ? range.endContainer.parentElement : range.endContainer;
  while (el?.parentElement && typeof getComputedStyle === 'function' && getComputedStyle(el).display === 'inline') {
    el = el.parentElement;
  }
  for (let hops = 0; el && hops < 8; hops++) {
    let sib = el.nextElementSibling;
    for (let i = 0; sib && i < 6; i++, sib = sib.nextElementSibling) {
      const found = equationRootFromNode(sib);
      if (found) return found;
    }
    el = el.parentElement;
  }
  return null;
}

export function equationDisplayText(el, texFallback) {
  if (!el) return texFallback || 'Formula';
  const math = el.matches?.('math') ? el : el.querySelector?.('math[display="block"], math[alttext]');
  const alt = math?.getAttribute?.('alttext');
  if (alt) return alt;
  const ann = math?.querySelector?.('annotation[encoding="application/x-tex"]');
  if (ann?.textContent?.trim()) return ann.textContent.trim();
  return texFallback || 'Formula';
}

export function rectsForElement(el, wrapperEl) {
  if (!el || !wrapperEl) return [];
  const wrap = wrapperEl.getBoundingClientRect();
  const target = el.matches?.('table') ? el : (el.querySelector?.('math[display="block"]') || el.querySelector?.(DISPLAY_MATH_SEL) || el);
  const r = target.getBoundingClientRect?.();
  if (!r || r.width <= 1 || r.height <= 1) return [];
  return [{ left: r.left - wrap.left, top: r.top - wrap.top, width: r.width, height: r.height }];
}

export function elementById(root, id) {
  if (!root || !id) return null;
  try {
    if (typeof CSS !== 'undefined' && CSS.escape) return root.querySelector(`#${CSS.escape(id)}`);
  } catch (_) {}
  return root.querySelector(`[id="${String(id).replace(/"/g, '\\"')}"]`);
}
