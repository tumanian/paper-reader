// Pure, dependency-free helpers shared across the app: HTML escaping, the tiny
// markdown renderer, citation-preview formatting, relative timestamps, hashing,
// regex/whitespace normalization, and XML entity decoding.

export function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
export function renderPreviewHtml(text) {
  const lines = String(text || '')
    .split(/\r?\n+/)
    .map((l) => l.replace(/^\s*[•\-*]\s*/, '').trim())
    .filter(Boolean);
  if (lines.length <= 1) return esc(text || '');
  return `<ul class="cite-takeaways">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
}
export function md(s) {
  return s
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.*?)\*/g,'<em>$1</em>')
    .replace(/`([^`]+)`/g,'<code style="background:#2a2a2a;padding:1px 4px;border-radius:3px;font-size:11px">$1</code>')
    .replace(/\n\n/g,'</p><p style="margin-top:8px">')
    .replace(/\n/g,'<br>');
}
export function timeAgo(ts) {
  const s = Math.floor((Date.now()-ts)/1000);
  if (s < 60)     return 'just now';
  if (s < 3600)   return Math.floor(s/60)+'m ago';
  if (s < 86400)  return Math.floor(s/3600)+'h ago';
  if (s < 604800) return Math.floor(s/86400)+'d ago';
  return new Date(ts).toLocaleDateString();
}
export function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
export function asGlobalRegex(re) {
  const flags = re.flags || '';
  if (flags.includes('g')) return re;
  return new RegExp(re.source, flags + 'g');
}
export function isTodoValue(s) { return !s || /^\s*TODO/i.test(String(s)); }
export function normalizeForMatch(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
// Turn a root-relative or page-relative media URL into an absolute https URL.
// Used when rendering web articles and when fetching figure images for capture.
export function resolveMediaUrl(src, baseUrl) {
  const s = String(src || '').trim();
  if (!s || /^data:/i.test(s)) return s;

  const base = String(baseUrl || '').trim();
  let url;
  try {
    if (/^https?:\/\//i.test(s)) {
      url = new URL(s);
    } else if (base) {
      url = new URL(s, base);
    } else if (/^\/html\/[\d.]+(?:v\d+)?\//i.test(s)) {
      url = new URL(s, 'https://ar5iv.org/');
    } else {
      return s;
    }
  } catch (_) {
    return s;
  }

  const host = url.hostname.toLowerCase();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local');
  // ar5iv HTML assets (/html/<id>/...) must be fetched from ar5iv, not localhost.
  if (isLoopback && /^\/html\/[\d.]+(?:v\d+)?\//i.test(url.pathname)) {
    return `https://ar5iv.org${url.pathname}${url.search}`;
  }

  return url.href;
}
// Decode XML character references without touching the DOM: the five XML
// predefined entities plus numeric (&#NN; / &#xHH;) references. Unknown named
// entities are left verbatim rather than guessed at. Pure so it can run in the
// test harness and in workers.
const XML_NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeXmlEntities(s) {
  if (!s) return '';
  return String(s).replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z]+));/gi, (m, hex, dec, name) => {
    if (hex || dec) {
      const cp = hex ? parseInt(hex, 16) : parseInt(dec, 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return m;
      try { return String.fromCodePoint(cp); } catch (_) { return m; }
    }
    const v = XML_NAMED_ENTITIES[name.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

// Decode an XML text node into a single-line string: entities resolved and
// runs of whitespace (including the newline+indent an Atom feed wraps long
// titles with) collapsed to one space.
export function decodeXmlText(s) {
  if (!s) return '';
  return decodeXmlEntities(s).replace(/\s+/g, ' ').trim();
}

// ── Paper descriptions (library card text) ─────────────────────────────────
// A doc's `description` is a paper-level one-liner: the arXiv summary, the
// abstract lifted from the text, or a web page's excerpt. Kept short enough
// for a card and normalised to a single line.

export const DESCRIPTION_MAX_CHARS = 500;

// Single-line, de-hyphenated, capped at DESCRIPTION_MAX_CHARS on a sentence
// boundary when one is available. Returns null for empty/unusable input.
export function cleanDescription(raw, maxChars = DESCRIPTION_MAX_CHARS) {
  let t = String(raw || '')
    .replace(/\u00ad/g, '')                       // soft hyphens from justified text
    .replace(/([A-Za-z])-\r?\n\s*([a-z])/g, '$1$2')   // "trans-\nformer" line wraps
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return null;
  if (t.length > maxChars) {
    const head = t.slice(0, maxChars);
    const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
    t = cut >= maxChars * 0.4 ? head.slice(0, cut + 1) : head.replace(/\s+\S*$/, '') + '…';
  }
  return t;
}

// Lift the abstract out of extracted paper text (PDF page text or a web page's
// innerText). Anchors on an "Abstract" heading at the start of a line — with
// or without the "Abstract." / "Abstract—" prefix styles — and stops at the
// next section heading, keyword list, or page marker. Null when the text has
// no recognisable abstract.
// The heading must stand alone on its line or be joined to the text by
// punctuation ("Abstract. We…", "Abstract—In…"); "Abstract PDF Cite" (a nav
// strip) is not an abstract.
const ABSTRACT_HEADING = /(?:^|\n)[ \t]*abstract(?![a-z])[ \t]*(?:[:.—–\-]+[ \t]*\n?|\n)/i;
const ABSTRACT_END = new RegExp(
  '\\n[ \\t]*(?:' +
    '\\[Page \\d+\\]' +
    '|(?:[1I][.:]?[ \\t]+)?introduction\\b' +
    '|keywords?\\b|key words\\b|index terms\\b|ccs concepts\\b|acm reference format\\b' +
    '|\\d+(?:\\.\\d+)*\\.?[ \\t]+[A-Z][A-Za-z]+(?:[ \\t]+[A-Za-z]+){0,6}[ \\t]*\\n' +
  ')', 'i');
export function abstractFromText(text, maxChars = DESCRIPTION_MAX_CHARS) {
  const s = String(text || '');
  const m = s.match(ABSTRACT_HEADING);
  if (!m) return null;
  let body = s.slice(m.index + m[0].length);
  const end = body.search(ABSTRACT_END);
  if (end >= 0) body = body.slice(0, end);
  // Don't run far past one abstract's worth of text when no heading follows.
  body = body.slice(0, maxChars * 3);
  const cleaned = cleanDescription(body, maxChars);
  if (!cleaned || cleaned.length < 40 || !/[A-Za-z]{3}/.test(cleaned)) return null;
  return cleaned;
}

// A conversation summary that reads like a chat turn — the model answered the
// transcript instead of describing it ("It looks like your message got cut
// off…", "I don't have additional context beyond…"). Such text says nothing
// about the paper or the discussion, so the card must not show it.
const CHAT_REPLY_OPENERS = new RegExp(
  '^(?:' +
    "i(?:'m| am) (?:sorry|afraid|not sure|unable|happy|glad|here)" +
    "|i (?:don'?t|do not|can'?t|cannot|couldn'?t|could not|apologi[sz]e|need|would need|notice|see|understand|think you|believe you)" +
    "|i'?d (?:be happy|need)" +
    "|(?:it|this) (?:looks|seems|appears) like" +
    '|it seems (?:that|like|you|your|the message)' +
    "|(?:your|the) (?:message|question|text|input|selection|request)\\b.*\\b(?:cut off|truncated|incomplete|unclear|missing|empty|seems)" +
    '|(?:unfortunately|sorry|apologies)\\b' +
    '|(?:could|can|would) you (?:please )?(?:clarify|provide|share|tell|paste|rephrase|let)' +
    '|(?:please|kindly) (?:provide|share|clarify|paste|let me know)' +
    "|(?:sure|certainly|of course|absolutely|great question|good question|here'?s|here is|let me)\\b" +
    '|(?:thanks|thank you)\\b' +
    '|without (?:more|additional|further|the) (?:context|information|details)' +
    '|there (?:is|are|was)(?: no|n\'t any)? (?:additional|more|further|enough) (?:context|information|text)' +
    "|(?:no|there'?s no) (?:additional|more|further) (?:context|information|text)" +
    '|(?:what|which|how|why|when|where|who|do|does|did|is|are|can|could|would|should) .*\\?$' +
  ')', 'i');
export function looksLikeChatReply(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (CHAT_REPLY_OPENERS.test(t)) return true;
  // Talking to the reader about their turn ("your message", "your question")
  // is a reply, not a description. (A bare "you" is not enough — it appears
  // in titles such as "Attention Is All You Need".)
  return /\byour (?:message|question|text|input|request|last message|previous message)\b/i.test(t.slice(0, 200));
}
