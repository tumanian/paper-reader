// Security tests for js/sanitize.js — the boundary that neutralizes untrusted
// remote HTML before it is injected into the article view (renderWebArticle).
//
// These exercise BOTH layers:
//   • scrubHtml — the string fallback used when DOMPurify failed to load. Its
//     job is to neutralize the common XSS vectors an attacker page would carry.
//   • sanitizeHtml — the dispatcher: delegates to DOMPurify when present, else
//     falls back to scrubHtml. Never returns input untouched.
//
// The real browser path uses DOMPurify (audited); we don't re-test that library
// here. What matters for our code is (a) the fallback is genuinely defensive and
// (b) sanitizeHtml always routes through a sanitizer.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { scrubHtml, sanitizeHtml } from '../js/sanitize.js';

afterEach(() => { delete globalThis.DOMPurify; });

// ── scrubHtml: XSS vector neutralization ──────────────────────────────────

test('scrubHtml strips <script> blocks and their contents', () => {
  const out = scrubHtml('<p>ok</p><script>alert(1)</script>');
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /alert\(1\)/);
  assert.match(out, /<p>ok<\/p>/);
});

test('scrubHtml removes inline event handlers (the innerHTML XSS vector)', () => {
  // <img onerror> fires on innerHTML assignment even though <script> does not.
  assert.doesNotMatch(scrubHtml('<img src=x onerror=alert(1)>'), /onerror/i);
  assert.doesNotMatch(scrubHtml('<img src="x" onerror="alert(1)">'), /onerror/i);
  assert.doesNotMatch(scrubHtml("<div onmouseover='steal()'>hi</div>"), /onmouseover/i);
  assert.doesNotMatch(scrubHtml('<svg onload=alert(1)>'), /onload/i);
});

test('scrubHtml neutralizes javascript:/vbscript:/data: URIs in links', () => {
  assert.doesNotMatch(scrubHtml('<a href="javascript:alert(1)">x</a>'), /javascript:/i);
  assert.doesNotMatch(scrubHtml('<a href=javascript:alert(1)>x</a>'), /javascript:/i);
  assert.doesNotMatch(scrubHtml('<img src="data:text/html,<script>alert(1)</script>">'), /data:/i);
  assert.doesNotMatch(scrubHtml('<a href="vbscript:msgbox(1)">x</a>'), /vbscript:/i);
});

test('scrubHtml drops iframe/object/embed/form/meta/base/link tags', () => {
  const out = scrubHtml(
    '<iframe src="//evil"></iframe><object data="x"></object><embed src="x">' +
    '<form action="//evil"><input name="p"></form><meta http-equiv="refresh">' +
    '<base href="//evil"><link rel="stylesheet" href="//evil">');
  for (const tag of ['iframe', 'object', 'embed', 'form', 'input', 'meta', 'base', 'link']) {
    assert.doesNotMatch(out, new RegExp('<' + tag, 'i'), `${tag} should be removed`);
  }
});

test('scrubHtml preserves ordinary formatting and safe links', () => {
  const html = '<p>Hello <strong>world</strong> and <em>math</em>.</p>' +
    '<a href="https://arxiv.org/abs/1706.03762">paper</a><ul><li>a</li></ul>';
  const out = scrubHtml(html);
  assert.match(out, /<strong>world<\/strong>/);
  assert.match(out, /<em>math<\/em>/);
  assert.match(out, /href="https:\/\/arxiv\.org\/abs\/1706\.03762"/);
  assert.match(out, /<li>a<\/li>/);
});

test('scrubHtml is case- and whitespace-insensitive', () => {
  assert.doesNotMatch(scrubHtml('<ScRiPt >alert(1)</ScRiPt>'), /alert/i);
  assert.doesNotMatch(scrubHtml('<img src=x OnErRoR = alert(1) >'), /onerror/i);
});

test('scrubHtml handles null/undefined without throwing', () => {
  assert.equal(scrubHtml(null), '');
  assert.equal(scrubHtml(undefined), '');
});

// ── sanitizeHtml: dispatcher behavior ──────────────────────────────────────

test('sanitizeHtml falls back to scrubHtml when DOMPurify is absent', () => {
  delete globalThis.DOMPurify;
  const out = sanitizeHtml('<img src=x onerror=alert(1)><p>ok</p>');
  assert.doesNotMatch(out, /onerror/i);
  assert.match(out, /<p>ok<\/p>/);
});

test('sanitizeHtml delegates to DOMPurify with a hardened config when present', () => {
  let received = null;
  globalThis.DOMPurify = {
    sanitize(html, config) { received = { html, config }; return 'SANITIZED'; },
  };
  const out = sanitizeHtml('<p>hi</p>');
  assert.equal(out, 'SANITIZED');
  assert.equal(received.html, '<p>hi</p>');
  // Config must forbid script and disallow data-attributes.
  assert.ok(received.config.FORBID_TAGS.includes('script'));
  assert.equal(received.config.ALLOW_DATA_ATTR, false);
});

test('sanitizeHtml never returns input untouched (always routes through a sanitizer)', () => {
  delete globalThis.DOMPurify;
  const evil = '<script>alert(1)</script>';
  assert.notEqual(sanitizeHtml(evil), evil);
});
