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
export function decodeXmlText(s) {
  if (!s) return '';
  const el = document.createElement('textarea');
  el.innerHTML = s.replace(/\s+/g, ' ').trim();
  return el.value;
}
