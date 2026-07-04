// HTML sanitization for untrusted remote content.
//
// The web-article path fetches HTML from an arbitrary user-supplied URL and
// injects it into the DOM (see renderWebArticle in web-loader.js). Without
// sanitization an attacker-controlled page could run script in our origin —
// which has access to the Supabase session in localStorage — so this is the
// security boundary for that feature, not a cosmetic cleanup.
//
// Primary path: DOMPurify (loaded from CDN in index.html), the audited,
// battle-tested sanitizer. It keeps SVG/MathML (academic papers, e.g. ar5iv,
// render math with them) while stripping scripts, event handlers, and unsafe
// URIs, including the mutation-XSS cases a regex cannot catch.
//
// Fallback path (scrubHtml): a conservative string scrub used ONLY if DOMPurify
// failed to load (CDN outage). Regex-level scrubbing has known bypasses, so it
// is deliberately aggressive and is the floor, never the intended boundary. In
// practice every browser loads DOMPurify; the fallback exists so a CDN failure
// degrades safely instead of injecting raw markup.

// Tags dropped entirely (with their contents where applicable). SVG/MathML are
// intentionally NOT here — DOMPurify sanitizes them and papers need them.
const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form',
  'input', 'button', 'textarea', 'select', 'base', 'link', 'meta', 'noscript', 'template'];

const DOMPURIFY_CONFIG = {
  FORBID_TAGS,
  FORBID_ATTR: ['srcset'],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['target', 'rel'],
};

function getDOMPurify() {
  if (typeof window !== 'undefined' && window.DOMPurify) return window.DOMPurify;
  if (typeof globalThis !== 'undefined' && globalThis.DOMPurify) return globalThis.DOMPurify;
  return null;
}

// Best-effort string scrub. Order matters: remove paired dangerous blocks
// (incl. their inner content) first, then stray/self-closing dangerous tags,
// then event-handler attributes, then unsafe URI schemes in link/src attrs.
export function scrubHtml(html) {
  let s = String(html == null ? '' : html);
  const blockTags = 'script|style|iframe|object|embed|noscript|template';
  const voidTags = 'script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select';

  s = s
    // <script>…</script> and friends, including their contents
    .replace(new RegExp(`<\\s*(${blockTags})\\b[\\s\\S]*?<\\s*/\\s*\\1\\s*>`, 'gi'), '')
    // any remaining open/self-closing dangerous tags
    .replace(new RegExp(`<\\s*/?\\s*(${voidTags})\\b[^>]*>`, 'gi'), '')
    // on*="…" / on*='…' / on*=bareword event handlers
    .replace(/\son[a-z0-9_-]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z0-9_-]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z0-9_-]+\s*=\s*[^\s>]+/gi, '')
    // javascript:/vbscript:/data: in href/src/xlink:href → neutralize to #
    .replace(/((?:href|src|xlink:href)\s*=\s*")\s*(?:javascript|vbscript|data)\s*:[^"]*(")/gi, '$1#$2')
    .replace(/((?:href|src|xlink:href)\s*=\s*')\s*(?:javascript|vbscript|data)\s*:[^']*(')/gi, "$1#$2")
    .replace(/((?:href|src|xlink:href)\s*=\s*)(?:javascript|vbscript|data)\s*:[^\s>]*/gi, '$1"#"');

  return s;
}

// Sanitize untrusted HTML for injection via innerHTML. Always routes through a
// sanitizer — never returns the input untouched.
export function sanitizeHtml(html) {
  const input = String(html == null ? '' : html);
  const DP = getDOMPurify();
  if (DP && typeof DP.sanitize === 'function') {
    return DP.sanitize(input, DOMPURIFY_CONFIG);
  }
  return scrubHtml(input);
}
