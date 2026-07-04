'use strict';

// Characterization tests for the shared server proxy (handler.js). These pin
// the request construction sent to Anthropic and the cheap-task routing, so the
// refactor can be proven not to change server behaviour. No real network: the
// global fetch is mocked and inspected.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../handler.js');

let savedFetch;
let savedKey;
const CEILING_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DAILY_REQUEST_LIMIT'];
let savedCeiling;

beforeEach(() => {
  savedFetch = global.fetch;
  savedKey = process.env.ANTHROPIC_API_KEY;
  // Isolate the global-ceiling config: unset by default so tests that don't opt
  // in run with the ceiling disabled (no extra counter fetch).
  savedCeiling = {};
  for (const k of CEILING_VARS) { savedCeiling[k] = process.env[k]; delete process.env[k]; }
  // Resolve any hostname to a public IP so the SSRF DNS guard stays hermetic
  // (the fetch proxies now validate every host + redirect hop). Real network is
  // never touched; global.fetch is mocked per-test.
  handler._setDnsLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
});
afterEach(() => {
  global.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  for (const k of CEILING_VARS) {
    if (savedCeiling[k] === undefined) delete process.env[k];
    else process.env[k] = savedCeiling[k];
  }
});

function mockFetch(captured, response = { content: [{ text: 'ok' }] }, status = 200) {
  global.fetch = async (url, opts) => {
    captured.url = url;
    captured.opts = opts;
    captured.body = JSON.parse(opts.body);
    return { status, json: async () => response };
  };
}

// ── Key handling ────────────────────────────────────────────────────────────
test('callAnthropic returns 500 when ANTHROPIC_API_KEY is unset', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  global.fetch = async () => { throw new Error('should not be called'); };
  const r = await handler.callAnthropic({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 500);
  assert.match(r.json.error, /ANTHROPIC_API_KEY not set/);
});

test('callAnthropic rejects a non-array messages field with 400', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  global.fetch = async () => { throw new Error('should not be called'); };
  const r = await handler.callAnthropic({ messages: 'nope' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /messages array/);
});

// ── Request construction ─────────────────────────────────────────────────────
test('callAnthropic sends the API key header and the Anthropic endpoint', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-secret';
  const cap = {};
  mockFetch(cap);
  await handler.callAnthropic({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(cap.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(cap.opts.headers['x-api-key'], 'sk-secret');
  assert.equal(cap.opts.headers['anthropic-version'], '2023-06-01');
});

test('callAnthropic coerces an unknown model to the default and defaults max_tokens to 1000', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const cap = {};
  mockFetch(cap);
  await handler.callAnthropic({ model: 'claude-custom-9', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(cap.body.model, 'claude-sonnet-4-6', 'unknown model pinned to the default');
  assert.equal(cap.body.max_tokens, 1000);
});

test('callAnthropic passes an allow-listed model through', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const cap = {};
  mockFetch(cap);
  await handler.callAnthropic({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(cap.body.model, 'claude-haiku-4-5');
});

test('callAnthropic clamps an over-ceiling max_tokens', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const cap = {};
  mockFetch(cap);
  await handler.callAnthropic({ max_tokens: 999999, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(cap.body.max_tokens, 4096);
});

test('callAnthropic rejects an oversize payload with 413 before calling upstream', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  global.fetch = async () => { throw new Error('must not call upstream for an oversize request'); };
  const huge = 'x'.repeat(2100000);
  const r = await handler.callAnthropic({ messages: [{ role: 'user', content: huge }] });
  assert.equal(r.status, 413);
  assert.match(r.json.error, /too large/i);
});

test('callAnthropic forwards a STRING system field untouched', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const cap = {};
  mockFetch(cap);
  await handler.callAnthropic({ system: 'plain string system', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(cap.body.system, 'plain string system');
});

test('callAnthropic forwards ARRAY system blocks intact, preserving cache_control on the full-paper block', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const cap = {};
  mockFetch(cap);
  const system = [
    { type: 'text', text: 'instructions' },
    { type: 'text', text: '=== FULL DOCUMENT ===', cache_control: { type: 'ephemeral' } },
  ];
  await handler.callAnthropic({ system, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(Array.isArray(cap.body.system), true);
  assert.equal(cap.body.system.length, 2);
  assert.deepEqual(cap.body.system[1].cache_control, { type: 'ephemeral' });
});

test('callAnthropic forwards image content blocks in messages intact', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const cap = {};
  mockFetch(cap);
  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'explain this figure' },
    ],
  }];
  await handler.callAnthropic({ messages });
  const block = cap.body.messages[0].content[0];
  assert.equal(block.type, 'image');
  assert.equal(block.source.media_type, 'image/png');
  assert.equal(block.source.data, 'AAAA');
  assert.equal(cap.body.messages[0].content[1].text, 'explain this figure');
});

// ── Global daily ceiling ─────────────────────────────────────────────────────
function ceilingConfig(limit) {
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-secret';
  if (limit != null) process.env.DAILY_REQUEST_LIMIT = String(limit);
}

test('callAnthropic returns 429 (and skips the model) when over the daily ceiling', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  ceilingConfig(5);
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('/rpc/bump_api_usage')) return { ok: true, status: 200, json: async () => 6 };
    throw new Error('must not call Anthropic when over the ceiling');
  };
  const r = await handler.callAnthropic({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 429);
  assert.match(r.json.error, /limit/i);
  assert.ok(seen.some((u) => u.includes('/rpc/bump_api_usage')), 'counter was consulted');
  assert.ok(!seen.some((u) => u.includes('api.anthropic.com')), 'model was not called');
});

test('callAnthropic proceeds to the model when under the daily ceiling', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  ceilingConfig(100);
  const cap = {};
  global.fetch = async (url, opts) => {
    if (String(url).includes('/rpc/bump_api_usage')) return { ok: true, status: 200, json: async () => 3 };
    cap.url = url;
    return { status: 200, json: async () => ({ content: [{ text: 'ok' }] }) };
  };
  const r = await handler.callAnthropic({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 200);
  assert.equal(cap.url, 'https://api.anthropic.com/v1/messages');
});

test('callAnthropic fails open (still calls the model) when the counter RPC errors', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  ceilingConfig(5);
  let calledModel = false;
  global.fetch = async (url) => {
    if (String(url).includes('/rpc/bump_api_usage')) return { ok: false, status: 500, json: async () => ({}) };
    calledModel = true;
    return { status: 200, json: async () => ({ content: [{ text: 'ok' }] }) };
  };
  const r = await handler.callAnthropic({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 200);
  assert.ok(calledModel, 'a counter hiccup must never block legitimate traffic');
});

test('callAnthropic skips the ceiling entirely when Supabase is not configured', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    return { status: 200, json: async () => ({ content: [{ text: 'ok' }] }) };
  };
  await handler.callAnthropic({ messages: [{ role: 'user', content: 'x' }] });
  assert.ok(!seen.some((u) => u.includes('/rpc/bump_api_usage')), 'no counter call when unconfigured');
});

test('callAnthropic maps an upstream fetch throw to a 502', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  global.fetch = async () => { throw new Error('network down'); };
  const r = await handler.callAnthropic({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.status, 502);
  assert.match(r.json.error, /network down/);
});

// ── Cheap-task routing (handleChatRequest) ───────────────────────────────────
test('handleChatRequest routes numeric citation-match locally without any network call', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  global.fetch = async () => { throw new Error('should not be called for a numeric match'); };
  const r = await handler.handleChatRequest({
    task: 'citation-match',
    selection: '[2]',
    references: [{ id: 1, text: 'one' }, { id: 2, text: 'two' }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.isCitation, true);
  assert.equal(r.json.matchId, 2);
});

test('handleChatRequest matches an author-year citation locally without network', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  global.fetch = async () => { throw new Error('should not be called for a local author match'); };
  const refs = [
    { id: 1, text: 'Vaswani, A. et al. Attention is all you need. NeurIPS 2017.' },
    { id: 2, text: 'Devlin, J. et al. BERT. 2019.' },
  ];
  const r = await handler.handleChatRequest({ task: 'citation-match', selection: 'Vaswani et al., 2017', references: refs });
  assert.equal(r.status, 200);
  assert.equal(r.json.isCitation, true);
  assert.equal(r.json.matchId, 1);
});

test('citation-match validates required fields', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const r1 = await handler.handleChatRequest({ task: 'citation-match', references: [{ id: 1, text: 'x' }] });
  assert.equal(r1.status, 400);
  const r2 = await handler.handleChatRequest({ task: 'citation-match', selection: '[1]', references: [] });
  assert.equal(r2.status, 400);
});

test('summarize validates a non-empty text field', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const r = await handler.handleChatRequest({ task: 'summarize', text: '   ' });
  assert.equal(r.status, 400);
});

test('summarize routes to the model and returns its summary text', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const cap = {};
  mockFetch(cap, { content: [{ text: 'A concise summary.' }] });
  const r = await handler.handleChatRequest({ task: 'summarize', text: 'some reading notes' });
  assert.equal(r.status, 200);
  assert.equal(r.json.summary, 'A concise summary.');
  // cheap tasks must use the Haiku model, not the default chat model
  assert.match(cap.body.model, /haiku/i);
});

test('classify-selection requires a selection', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const r = await handler.handleChatRequest({ task: 'classify-selection', selection: '' });
  assert.equal(r.status, 400);
});

test('citation-format-detect falls back to built-in patterns when the model is unavailable', async () => {
  // No key → callHaiku returns 500 → handler builds the fallback format.
  delete process.env.ANTHROPIC_API_KEY;
  const r = await handler.handleChatRequest({
    task: 'citation-format-detect',
    bodySample: 'Some text with a citation [12] inline.',
    inTextExamples: ['[12]'],
    refCount: 20,
  });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.patterns) && r.json.patterns.length >= 1);
  assert.equal(r.json.source, 'fallback');
});

test('citation-format-detect preserves label-id patterns and normalizes refEntryPattern', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const cap = {};
  const haikuJson = {
    style: 'alpha-bracket',
    description: 'Alphanumeric bracket labels',
    patterns: [{ name: 'alpha', regex: '\\[([A-Za-z][A-Za-z0-9+]{1,10})\\]', flags: '', matchType: 'label-id', idGroup: 1 }],
    refEntryPattern: { regex: '^\\[([A-Za-z][A-Za-z0-9+]{1,10})\\]', flags: 'm', labelGroup: 1 },
    examples: ['[Vas17]'],
  };
  mockFetch(cap, { content: [{ text: JSON.stringify(haikuJson) }] });
  const r = await handler.handleChatRequest({
    task: 'citation-format-detect',
    bodySample: 'As shown in [Vas17], matrices multiply quickly.',
    refSample: '[Vas17] Vassilevska Williams. 2017.',
    inTextExamples: ['[Vas17]'],
    refCount: 0,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.patterns[0].matchType, 'label-id');
  assert.ok(r.json.refEntryPattern);
  assert.ok(r.json.refEntryPattern.flags.includes('g'));
  assert.equal(r.json.refEntryPattern.labelGroup, 1);
});

test('citation-format-detect nulls an invalid refEntryPattern but keeps the patterns', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const cap = {};
  const haikuJson = {
    style: 'numeric',
    patterns: [{ name: 'num', regex: '\\[(\\d{1,3})\\]', flags: '', matchType: 'numeric-id', idGroup: 1 }],
    refEntryPattern: { regex: '(', flags: '' },
    examples: ['[12]'],
  };
  mockFetch(cap, { content: [{ text: JSON.stringify(haikuJson) }] });
  const r = await handler.handleChatRequest({
    task: 'citation-format-detect',
    bodySample: 'Cited as [12] here.',
    inTextExamples: ['[12]'],
    refCount: 30,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.refEntryPattern, null);
  assert.equal(r.json.patterns.length, 1);
});

test('citation-match accepts a string matchId from the model for alpha labels', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const cap = {};
  mockFetch(cap, { content: [{ text: '{"isCitation":true,"matchId":"Vas17","confidence":0.9,"reason":"label match"}' }] });
  const refs = [
    { id: 'Vas17', text: 'Vassilevska Williams. Multiplying matrices faster. 2017.' },
    { id: 'BLM+20', text: 'Blum et al. Foundations of data science. 2020.' },
  ];
  const r = await handler.handleChatRequest({ task: 'citation-match', selection: '[Vas17]', references: refs });
  assert.equal(r.status, 200);
  assert.equal(r.json.isCitation, true);
  assert.equal(r.json.matchId, 'Vas17');
});

test('citation-match rejects a string matchId that is not in the bibliography', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const cap = {};
  mockFetch(cap, { content: [{ text: '{"isCitation":true,"matchId":"Nope99","confidence":0.9,"reason":"?"}' }] });
  const refs = [{ id: 'Vas17', text: 'Vassilevska Williams. 2017.' }];
  const r = await handler.handleChatRequest({ task: 'citation-match', selection: '[Nope99]', references: refs });
  assert.equal(r.status, 200);
  assert.equal(r.json.isCitation, false);
  assert.equal(r.json.matchId, null);
});

// ── URL allow-list for the fetch proxies ─────────────────────────────────────
test('handleFetchRequest rejects private / loopback / non-http targets', async () => {
  for (const bad of ['http://localhost/x', 'http://127.0.0.1/y', 'http://10.0.0.5/z', 'ftp://example.com', 'not a url']) {
    const r = await handler.handleFetchRequest(bad);
    assert.equal(r.status, 400, `expected 400 for ${bad}`);
  }
});

test('handleFetchImageRequest rejects private / loopback / non-http targets', async () => {
  for (const bad of ['http://localhost/x', 'http://127.0.0.1/y', 'http://10.0.0.5/z', 'ftp://example.com', 'not a url']) {
    const r = await handler.handleFetchImageRequest(bad);
    assert.equal(r.status, 400, `expected 400 for ${bad}`);
  }
});

test('handleFetchImageRequest returns image bytes and content-type on success', async () => {
  const png = Buffer.alloc(128, 0xab);
  png[0] = 0x89; png[1] = 0x50; png[2] = 0x4e; png[3] = 0x47;
  const cap = {};
  global.fetch = async (url, opts) => {
    cap.url = url;
    cap.opts = opts;
    return {
      ok: true,
      status: 200,
      url: 'https://cdn.example.com/fig.png',
      headers: { get: (k) => (k === 'content-type' ? 'image/png' : null) },
      arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    };
  };
  const r = await handler.handleFetchImageRequest('https://ar5iv.org/html/1706.03762/assets/Figures/ModalNet-21.png');
  assert.equal(r.status, 200);
  assert.equal(r.contentType, 'image/png');
  assert.equal(r.finalUrl, 'https://cdn.example.com/fig.png');
  assert.ok(Buffer.isBuffer(r.body));
  assert.equal(r.body.length, png.length);
  assert.match(cap.opts.headers.Accept, /image\/\*/);
});

test('handleFetchImageRequest rejects upstream non-image content', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://example.com/oops',
    headers: { get: () => 'text/html' },
    arrayBuffer: async () => Buffer.alloc(128, 0x3c),
  });
  const r = await handler.handleFetchImageRequest('https://example.com/not-an-image');
  assert.equal(r.status, 502);
  assert.match(r.json.error, /did not return an image/i);
});

test('handleFetchImageRequest rejects an empty upstream body', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://example.com/tiny.png',
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => Buffer.alloc(8),
  });
  const r = await handler.handleFetchImageRequest('https://example.com/tiny.png');
  assert.equal(r.status, 502);
  assert.match(r.json.error, /empty image/i);
});
