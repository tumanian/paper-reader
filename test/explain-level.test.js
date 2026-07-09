'use strict';

// Explanation-level control (Practitioner vs ELI5).
//   * pure logic: level sanitizing, the ELI5 instruction modifier, the
//     localStorage-backed global default and its persistence round trip
//   * functional: the level actually reaches the /api/chat request as the
//     first system block, and the ELI5 re-ask APPENDS (never replaces)

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');

before(async () => { await app.ready; });

beforeEach(async () => {
  app.reset();
  await app.PaperStore.init();
});

// ── Pure logic ───────────────────────────────────────────────────────────────
test('sanitizeExplainLevel maps anything but eli5 to practitioner', () => {
  assert.equal(app.sanitizeExplainLevel('eli5'), 'eli5');
  assert.equal(app.sanitizeExplainLevel('practitioner'), 'practitioner');
  assert.equal(app.sanitizeExplainLevel('expert'), 'practitioner');
  assert.equal(app.sanitizeExplainLevel(null), 'practitioner');
  assert.equal(app.sanitizeExplainLevel(undefined), 'practitioner');
});

test('instructionForLevel returns the baseline unchanged for practitioner', () => {
  assert.equal(app.instructionForLevel('practitioner'), app.constants.BASE_INSTRUCTION);
  // Unknown levels degrade to the rigorous default — never accidentally ELI5.
  assert.equal(app.instructionForLevel('bogus'), app.constants.BASE_INSTRUCTION);
});

test('instructionForLevel prepends the ELI5 modifier for eli5', () => {
  const out = app.instructionForLevel('eli5');
  assert.ok(out.startsWith(app.constants.ELI5_MODIFIER), 'modifier must lead');
  assert.ok(out.endsWith(app.constants.BASE_INSTRUCTION), 'baseline must be intact after it');
});

test('default level is practitioner when nothing (or junk) is stored', () => {
  assert.equal(app.getDefaultExplainLevel(), 'practitioner');
  app.localStorage.setItem(app.constants.EXPLAIN_LEVEL_KEY, 'garbage');
  assert.equal(app.getDefaultExplainLevel(), 'practitioner');
});

test('setDefaultExplainLevel persists and round-trips through storage', () => {
  assert.equal(app.setDefaultExplainLevel('eli5'), 'eli5');
  assert.equal(app.localStorage.getItem(app.constants.EXPLAIN_LEVEL_KEY), 'eli5');
  assert.equal(app.getDefaultExplainLevel(), 'eli5');
  assert.equal(app.setDefaultExplainLevel('practitioner'), 'practitioner');
  assert.equal(app.getDefaultExplainLevel(), 'practitioner');
});

test('setDefaultExplainLevel sanitizes junk to practitioner', () => {
  app.setDefaultExplainLevel('eli5');
  assert.equal(app.setDefaultExplainLevel('sorta-simple'), 'practitioner');
  assert.equal(app.getDefaultExplainLevel(), 'practitioner');
});

// ── Functional: the level reaches the request ────────────────────────────────
function seedDiscussion() {
  app.state.paperText = 'Attention is all you need. '.repeat(10);
  app.state.currentDocId = 'web::x';
  app.state.docMeta = { name: 'P', mode: 'web', badge: 'Web', url: 'http://x' };
  app.state.discussions = [{ id: 1, txt: 'attention', mode: 'web', pageNum: null, color: { bg: 'b', dot: 'd' }, relRects: [], messages: [] }];
  app.state.activeId = 1;
}

function captureChat() {
  const bodies = [];
  app.setFetchHandler(async (url, opts) => {
    if (url.includes('/api/chat')) {
      bodies.push(JSON.parse(opts.body));
      return app.jsonResponse({ content: [{ type: 'text', text: 'mock reply' }] });
    }
    return undefined;
  });
  return bodies;
}

test('a normal send uses the practitioner instruction by default', async () => {
  const bodies = captureChat();
  seedDiscussion();
  app.document.getElementById('msg-input').value = 'What is this?';
  await app.sendMessage();
  assert.equal(bodies[0].system[0].text, app.constants.BASE_INSTRUCTION);
});

test('with the global default set to eli5, a new question starts simple', async () => {
  app.setDefaultExplainLevel('eli5');
  const bodies = captureChat();
  seedDiscussion();
  app.document.getElementById('msg-input').value = 'What is this?';
  await app.sendMessage();
  assert.ok(bodies[0].system[0].text.startsWith(app.constants.ELI5_MODIFIER));
});

test('an ELI5 re-ask appends a new exchange — the original answer stays', async () => {
  const bodies = captureChat();
  seedDiscussion();
  app.document.getElementById('msg-input').value = 'What is this?';
  await app.sendMessage();
  const d = app.state.discussions[0];
  assert.equal(d.messages.length, 2); // user + practitioner answer

  await app.askQuestion(d, app.constants.ELI5_FOLLOWUP_TEXT, { level: 'eli5' });
  assert.equal(d.messages.length, 4, 'ELI5 exchange must APPEND, not replace');
  assert.deepEqual(d.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(d.messages[2].content, app.constants.ELI5_FOLLOWUP_TEXT);

  // The re-ask went through the same pipeline with the ELI5 instruction and
  // carried the prior exchange so Claude re-explains the same thing.
  assert.ok(bodies[1].system[0].text.startsWith(app.constants.ELI5_MODIFIER));
  assert.equal(bodies[1].messages.length, 3);
  assert.equal(bodies[1].model, app.constants.CHAT_MODEL);
});

test('an ELI5 re-ask that hits a 429 surfaces the existing budget message', async () => {
  const bodies = captureChat();
  seedDiscussion();
  app.document.getElementById('msg-input').value = 'What is this?';
  await app.sendMessage();
  const d = app.state.discussions[0];

  app.setFetchHandler(async (url) => {
    if (url.includes('/api/chat')) return app.jsonResponse({ error: 'rate_limited' }, 429);
    return undefined;
  });
  await app.askQuestion(d, app.constants.ELI5_FOLLOWUP_TEXT, { level: 'eli5' });

  // The failed reply is not persisted; the rendered bubble carries the same
  // friendly budget message every other 429 gets (no ELI5-specific error UI).
  assert.deepEqual(d.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  const box = app.document.getElementById('chat-messages');
  const last = box.children[box.children.length - 1];
  assert.match(last.innerHTML, /come back tomorrow/i);
  void bodies;
});
