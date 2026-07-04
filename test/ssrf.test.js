'use strict';

// SSRF guard tests for the fetch proxies in handler.js.
//
// The proxies fetch caller-supplied URLs, so they must refuse loopback,
// link-local (incl. cloud metadata 169.254.169.254), and private networks — in
// any IP encoding, via a hostname that resolves to one, or via a redirect that
// hops into one. DNS is stubbed (_setDnsLookup) so these stay hermetic.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../handler.js');

let savedFetch;
const PUBLIC = async () => [{ address: '93.184.216.34', family: 4 }];

beforeEach(() => {
  savedFetch = global.fetch;
  handler._setDnsLookup(PUBLIC);
});
afterEach(() => {
  global.fetch = savedFetch;
  handler._setDnsLookup(PUBLIC);
});

// ── isPrivateAddress ────────────────────────────────────────────────────────
test('isPrivateAddress flags loopback / private / link-local / reserved ranges', () => {
  for (const ip of [
    '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1',
    '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', // IPv4-mapped loopback & metadata
  ]) {
    assert.equal(handler.isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test('isPrivateAddress allows genuine public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '192.167.0.1', '2606:4700::1111']) {
    assert.equal(handler.isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

// ── isFetchUrlAllowed (sync structural check) ──────────────────────────────
test('isFetchUrlAllowed blocks private targets in every IP encoding', () => {
  for (const bad of [
    'http://localhost/', 'http://svc.local/', 'http://svc.internal/',
    'http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/',
    'http://2130706433/',      // decimal  → 127.0.0.1
    'http://0x7f000001/',      // hex      → 127.0.0.1
    'http://0177.0.0.1/',      // octal    → 127.0.0.1
    'http://[::1]/', 'http://[::ffff:a9fe:a9fe]/',
    'ftp://example.com/', 'file:///etc/passwd', 'not a url', '',
  ]) {
    assert.equal(handler.isFetchUrlAllowed(bad), false, `${bad} should be blocked`);
  }
});

test('isFetchUrlAllowed permits ordinary public http(s) URLs', () => {
  for (const ok of ['https://example.com/', 'https://arxiv.org/abs/1706.03762', 'http://8.8.8.8/', 'https://ar5iv.org/html/x']) {
    assert.equal(handler.isFetchUrlAllowed(ok), true, `${ok} should be allowed`);
  }
});

// ── assertUrlPublic (adds DNS resolution) ──────────────────────────────────
test('assertUrlPublic rejects a hostname that resolves to a private address', async () => {
  handler._setDnsLookup(async () => [{ address: '10.1.2.3', family: 4 }]);
  await assert.rejects(() => handler.assertUrlPublic('https://sneaky.example.com/'), /private/i);
});

test('assertUrlPublic rejects when any resolved address is private (mixed answers)', async () => {
  handler._setDnsLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }]);
  await assert.rejects(() => handler.assertUrlPublic('https://mixed.example.com/'), /private/i);
});

test('assertUrlPublic allows a hostname that resolves to a public address', async () => {
  handler._setDnsLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
  await handler.assertUrlPublic('https://example.com/'); // resolves clean → no throw
});

// ── safeFetch (manual redirect re-validation) ──────────────────────────────
test('safeFetch follows a redirect to another public URL', async () => {
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    if (seen.length === 1) {
      return { status: 302, headers: { get: (k) => (k.toLowerCase() === 'location' ? 'https://cdn.example.com/final' : null) } };
    }
    return { status: 200, url, headers: { get: () => null } };
  };
  const r = await handler.safeFetch('https://example.com/start');
  assert.equal(r.status, 200);
  assert.deepEqual(seen, ['https://example.com/start', 'https://cdn.example.com/final']);
});

test('safeFetch blocks a redirect that hops into a private/metadata address', async () => {
  global.fetch = async () => ({
    status: 302,
    headers: { get: (k) => (k.toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data/' : null) },
  });
  await assert.rejects(() => handler.safeFetch('https://example.com/start'), /blocked|private|invalid/i);
});

test('safeFetch gives up after too many redirects', async () => {
  global.fetch = async () => ({
    status: 302,
    headers: { get: (k) => (k.toLowerCase() === 'location' ? 'https://example.com/next' : null) },
  });
  await assert.rejects(() => handler.safeFetch('https://example.com/start'), /too many redirects/i);
});

// ── End-to-end through a proxy handler ─────────────────────────────────────
test('handleFetchRequest rejects an encoded-IP loopback target with 400', async () => {
  global.fetch = async () => { throw new Error('must not fetch a blocked URL'); };
  const r = await handler.handleFetchRequest('http://2130706433/'); // 127.0.0.1
  assert.equal(r.status, 400);
});
