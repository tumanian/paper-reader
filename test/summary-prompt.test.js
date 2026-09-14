'use strict';

// The conversation-summary request (task: 'summarize'). The transcript is
// handed to the model as quoted reference material with an instruction to
// describe the discussion in the third person — otherwise Haiku tends to
// answer the last turn ("It looks like your message got cut off…") and that
// reply lands verbatim on the library card.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../handler.js');

let savedFetch;
let savedKey;
const ISOLATED_VARS = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'DAILY_REQUEST_LIMIT',
  'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'SUPABASE_ANON_KEY',
];
let savedVars;

beforeEach(() => {
  savedFetch = global.fetch;
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  savedVars = {};
  for (const k of ISOLATED_VARS) { savedVars[k] = process.env[k]; delete process.env[k]; }
  handler._setDnsLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
});
afterEach(() => {
  global.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  for (const k of ISOLATED_VARS) {
    if (savedVars[k] === undefined) delete process.env[k];
    else process.env[k] = savedVars[k];
  }
});

function mockFetch(captured, response = { content: [{ text: 'A blurb.' }] }) {
  global.fetch = async (url, opts) => {
    captured.url = url;
    captured.body = JSON.parse(opts.body);
    return { status: 200, json: async () => response };
  };
}

const TRANSCRIPT = '[Highlight] "scaled dot-product attention"\nResearcher: why divide by sqrt(d_k)?\nAssistant: Large dot products…';

test('summarize quotes the transcript as reference material and asks for a third-person description', async () => {
  const cap = {};
  mockFetch(cap);
  const r = await handler.handleChatRequest({ task: 'summarize', text: TRANSCRIPT });
  assert.equal(r.status, 200);
  assert.equal(r.json.summary, 'A blurb.');

  const [msg] = cap.body.messages;
  assert.equal(msg.role, 'user');
  assert.match(msg.content, /<transcript>\n[\s\S]*<\/transcript>/);
  assert.ok(msg.content.includes(TRANSCRIPT));
  // The transcript is data; the actual request comes after it.
  assert.ok(msg.content.indexOf('</transcript>') < msg.content.indexOf('Write the library-card blurb'));

  const system = String(cap.body.system);
  assert.match(system, /third person/i);
  assert.match(system, /never reply to it/i);
  assert.match(system, /never address the researcher/i);
  assert.match(system, /cut off/i);
  assert.match(system, /no bullet lists/i);
});

test('summarize still caps the transcript it forwards', async () => {
  const cap = {};
  mockFetch(cap);
  const r = await handler.handleChatRequest({ task: 'summarize', text: 'x'.repeat(20000) });
  assert.equal(r.status, 200);
  const content = cap.body.messages[0].content;
  assert.ok(content.length < 12500, `forwarded ${content.length} chars`);
  assert.ok(content.includes('</transcript>'), 'closing tag survives the cap');
});
