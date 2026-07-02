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

beforeEach(() => {
  savedFetch = global.fetch;
  savedKey = process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  global.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
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

test('callAnthropic passes model through and defaults max_tokens to 1000', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  const cap = {};
  mockFetch(cap);
  await handler.callAnthropic({ model: 'claude-custom-9', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(cap.body.model, 'claude-custom-9');
  assert.equal(cap.body.max_tokens, 1000);
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

// ── URL allow-list for the fetch proxies ─────────────────────────────────────
test('handleFetchRequest rejects private / loopback / non-http targets', async () => {
  for (const bad of ['http://localhost/x', 'http://127.0.0.1/y', 'http://10.0.0.5/z', 'ftp://example.com', 'not a url']) {
    const r = await handler.handleFetchRequest(bad);
    assert.equal(r.status, 400, `expected 400 for ${bad}`);
  }
});
