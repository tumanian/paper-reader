'use strict';

// Functional test for end-to-end chat request assembly. Drives the REAL
// sendMessage() from index.html with a mocked Claude call and inspects the
// exact request body posted to /api/chat. This pins the contract the proxy
// depends on: model passthrough, an ARRAY system with a cached full-paper
// block, citation/math/figure framing blocks, and the highlighted-passage +
// cross-highlight memory block.

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');

before(async () => { await app.ready; });

beforeEach(async () => {
  app.reset();
  await app.PaperStore.init();
});

// Send one message through the real flow, returning the parsed /api/chat body.
async function sendAndCapture(setup) {
  let chatBody = null;
  app.setFetchHandler(async (url, opts) => {
    if (url.includes('/api/chat')) {
      chatBody = JSON.parse(opts.body);
      return app.jsonResponse({ content: [{ type: 'text', text: 'mock reply' }] });
    }
    return undefined; // fall through to defaults (config / onboarding)
  });
  setup();
  app.document.getElementById('msg-input').value = 'What is going on here?';
  await app.sendMessage();
  return chatBody;
}

function findBlock(system, re) {
  return system.find((b) => re.test(b.text || ''));
}

test('posts model passthrough and a 1000 max_tokens default', async () => {
  const body = await sendAndCapture(() => {
    app.state.paperText = 'Body text. '.repeat(10);
    app.state.currentDocId = 'web::x';
    app.state.currentMode = 'web';
    app.state.docMeta = { name: 'Paper', mode: 'web', badge: 'Web', url: 'http://x' };
    app.state.discussions = [{ id: 1, txt: 'a passage', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [] }];
    app.state.activeId = 1;
  });
  assert.equal(body.model, app.constants.CHAT_MODEL);
  assert.equal(body.max_tokens, 1000);
});

test('system is an array whose full-paper block carries cache_control ephemeral', async () => {
  const body = await sendAndCapture(() => {
    app.state.paperText = 'The transformer relies on attention. '.repeat(10);
    app.state.currentDocId = 'web::x';
    app.state.currentMode = 'web';
    app.state.docMeta = { name: 'Attention Paper', mode: 'web', badge: 'Web', url: 'http://x' };
    app.state.discussions = [{ id: 1, txt: 'attention', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [] }];
    app.state.activeId = 1;
  });
  assert.equal(Array.isArray(body.system), true);
  const full = findBlock(body.system, /=== FULL DOCUMENT:/);
  assert.ok(full, 'expected a full-document block');
  assert.deepEqual(app.plain(full.cache_control), { type: 'ephemeral' });
  assert.match(full.text, /=== FULL DOCUMENT: Attention Paper ===/);
  assert.match(full.text, /attention/);
});

test('first system block is the instruction block (no cache_control)', async () => {
  const body = await sendAndCapture(() => {
    app.state.paperText = 'x'.repeat(50);
    app.state.currentDocId = 'web::x';
    app.state.docMeta = { name: 'P', mode: 'web', badge: 'Web', url: 'http://x' };
    app.state.discussions = [{ id: 1, txt: 'p', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [] }];
    app.state.activeId = 1;
  });
  assert.match(body.system[0].text, /research assistant/i);
  assert.equal(body.system[0].cache_control, undefined);
});

test('includes the highlighted-passage block with the selection text', async () => {
  const body = await sendAndCapture(() => {
    app.state.paperText = 'context '.repeat(20);
    app.state.currentDocId = 'web::x';
    app.state.docMeta = { name: 'P', mode: 'web', badge: 'Web', url: 'http://x' };
    app.state.discussions = [{ id: 1, txt: 'THE HIGHLIGHTED SNIPPET', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [] }];
    app.state.activeId = 1;
  });
  const hl = findBlock(body.system, /HIGHLIGHTED THIS PASSAGE/);
  assert.ok(hl);
  assert.match(hl.text, /THE HIGHLIGHTED SNIPPET/);
});

test('falls back to a NEARBY CONTEXT block when there is no paper text', async () => {
  const body = await sendAndCapture(() => {
    app.state.paperText = ''; // no full paper available
    app.state.currentDocId = 'web::x';
    app.state.docMeta = { name: 'P', mode: 'web', badge: 'Web', url: 'http://x' };
    app.state.discussions = [{ id: 1, txt: 'p', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [] }];
    app.state.activeId = 1;
  });
  // With empty paperText buildPaperBlock → kind:none, and findNearbyContext also
  // returns '' → neither a full-document nor a nearby block is present.
  assert.equal(findBlock(body.system, /=== FULL DOCUMENT:/), undefined);
});

test('adds a MATH framing block for a math discussion and forwards the user turn', async () => {
  const body = await sendAndCapture(() => {
    app.state.paperText = 'paper with a formula '.repeat(10);
    app.state.currentDocId = 'web::x';
    app.state.docMeta = { name: 'P', mode: 'web', badge: 'Web', url: 'http://x' };
    app.state.discussions = [{
      id: 1, txt: 'E = mc^2', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [],
      mathKind: 'explain', mathTex: 'E = mc^2',
    }];
    app.state.activeId = 1;
  });
  const math = findBlock(body.system, /=== MATH EXPLANATION REQUEST ===/);
  assert.ok(math);
  assert.match(math.text, /E = mc\^2/); // captured TeX is included
});

test('adds a CITATION CONTEXT block when opened from another paper', async () => {
  const body = await sendAndCapture(() => {
    app.state.paperText = 'cited paper body '.repeat(10);
    app.state.currentDocId = 'web::cited';
    app.state.docMeta = { name: 'Cited', mode: 'web', badge: 'Web', url: 'http://cited' };
    app.state.discussions = [{
      id: 1, txt: 'topic', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [],
      citationMeta: { parentName: 'Parent Paper', citationText: '[12]', refText: 'Ref twelve' },
    }];
    app.state.activeId = 1;
  });
  const cite = findBlock(body.system, /=== CITATION CONTEXT ===/);
  assert.ok(cite);
  assert.match(cite.text, /Parent Paper/);
  assert.match(cite.text, /\[12\]/);
});

test('a 429 from the proxy shows the friendly budget message instead of a raw error', async () => {
  app.setFetchHandler(async (url) => {
    if (url.includes('/api/chat')) {
      return app.jsonResponse({ error: 'Daily request limit reached. Please try again later.' }, 429);
    }
    return undefined;
  });
  app.state.paperText = 'p '.repeat(20);
  app.state.currentDocId = 'web::x';
  app.state.docMeta = { name: 'P', mode: 'web', badge: 'Web', url: 'http://x' };
  app.state.discussions = [{ id: 1, txt: 'passage', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [] }];
  app.state.activeId = 1;
  app.document.getElementById('msg-input').value = 'Will this work?';
  await app.sendMessage();

  // Only the user turn is recorded — the failed reply is not persisted.
  assert.deepEqual(app.state.discussions[0].messages.map((m) => m.role), ['user']);

  // The rendered chat bubble carries the friendly message, without an "Error:" prefix.
  const box = app.document.getElementById('chat-messages');
  const last = box.children[box.children.length - 1];
  assert.match(last.innerHTML, /come back tomorrow/i);
  assert.doesNotMatch(last.innerHTML, /Error:/);
});

test('callClaude flags budget exhaustion for Anthropic billing errors too', async () => {
  app.setFetchHandler(async () =>
    app.jsonResponse({ error: { type: 'invalid_request_error', message: 'Your credit balance is too low.' } }, 400));
  await assert.rejects(
    app.callClaude([], [{ role: 'user', content: 'hi' }]),
    (e) => e.budgetExhausted === true && e.message === app.constants.BUDGET_EXHAUSTED_MESSAGE,
  );
});

test('an ordinary server error still surfaces as a plain error', async () => {
  app.setFetchHandler(async () => app.jsonResponse({ error: 'Upstream request failed: boom' }, 502));
  await assert.rejects(
    app.callClaude([], [{ role: 'user', content: 'hi' }]),
    (e) => !e.budgetExhausted && /Upstream request failed/.test(e.message),
  );
});

test('the user turn and assistant reply are recorded on the discussion', async () => {
  let d;
  const body = await sendAndCapture(() => {
    app.state.paperText = 'p '.repeat(20);
    app.state.currentDocId = 'web::x';
    app.state.docMeta = { name: 'P', mode: 'web', badge: 'Web', url: 'http://x' };
    d = { id: 1, txt: 'passage', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [] };
    app.state.discussions = [d];
    app.state.activeId = 1;
  });
  // last message in the request is the user's question
  const lastMsg = body.messages[body.messages.length - 1];
  assert.equal(lastMsg.role, 'user');
  assert.equal(lastMsg.content, 'What is going on here?');
  // the discussion now holds the user turn + the mocked assistant reply
  const roles = app.state.discussions[0].messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant']);
  assert.equal(app.state.discussions[0].messages[1].content, 'mock reply');
});
