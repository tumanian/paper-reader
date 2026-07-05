'use strict';

// Property-based convergence test (fast-check). For ANY number of devices making
// message-adds in ANY interleaving with syncs, after a final sync round every
// replica converges to the same state and every unique message survives exactly
// once. fast-check shrinks any failure to a minimal counterexample.
//
// fast-check is a DEV-ONLY dependency. To keep `node --test` runnable with no
// `npm install`, this file skips itself when fast-check isn't present.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const app = require('./helpers/app.js');
const { PaperStore, plain } = app;

let fc = null;
try { fc = require('fast-check'); } catch { /* not installed — skip below */ }

before(async () => { await app.ready; });

const merge = (a, b) => plain(PaperStore.mergeConversation(a, b));
const seed = () => ({ discussions: ['d1', 'd2', 'd3'].map((id) => ({ id, deleted: false, updated: 0, txt: 'hl-' + id, messages: [] })) });

function allIds(conv) {
  return conv.discussions.flatMap((d) => d.messages.map((m) => m.id));
}

test('convergence + no-loss under arbitrary device interleavings', { skip: fc ? false : 'fast-check not installed (npm i)' }, async () => {
  // messageClientId is async (Web Crypto), so this is an async property.
  await fc.assert(fc.asyncProperty(
    fc.record({
      devices: fc.integer({ min: 2, max: 4 }),
      ops: fc.array(fc.record({
        kind: fc.constantFrom('add', 'sync'),
        dev: fc.nat({ max: 3 }),
        disc: fc.constantFrom('d1', 'd2', 'd3'),
        role: fc.constantFrom('user', 'assistant'),
        content: fc.string({ minLength: 1, maxLength: 6 }),
      }), { maxLength: 60 }),
    }),
    async ({ devices, ops }) => {
      let store = seed();
      const replicas = Array.from({ length: devices }, () => seed());
      const expected = new Set();
      let clock = 0;

      for (const op of ops) {
        const i = op.dev % devices;
        if (op.kind === 'add') {
          const id = await PaperStore.messageClientId(op.disc, op.role, op.content);
          const disc = replicas[i].discussions.find((d) => d.id === op.disc);
          if (!disc.messages.some((m) => m.id === id)) {
            disc.messages.push({ id, role: op.role, content: op.content, createdMs: clock++ });
          }
          expected.add(id);
        } else {
          store = merge(store, replicas[i]);   // push
          replicas[i] = merge(replicas[i], store); // pull
        }
      }

      // Final sync round: every replica pushes, then every replica pulls.
      for (const r of replicas) store = merge(store, r);
      for (let i = 0; i < replicas.length; i++) replicas[i] = merge(replicas[i], store);

      // (a) every unique added message is present exactly once in the store
      const ids = allIds(store);
      assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
      assert.deepEqual(new Set(ids), expected, 'every added message survives, none invented');

      // (b) all replicas converged to the store
      for (const r of replicas) assert.deepStrictEqual(r, store, 'replica diverged from converged state');
      return true;
    },
  ), { numRuns: 300 });
});
