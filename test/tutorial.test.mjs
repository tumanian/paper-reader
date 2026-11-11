import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TUTORIAL_KEY,
  isTutorialSeen,
  markTutorialSeen,
  shouldShowTutorial,
} from '../js/tutorial.js';

function mockStorage(initial = {}) {
  const map = { ...initial };
  return {
    getItem(k) { return map[k] ?? null; },
    setItem(k, v) { map[k] = String(v); },
  };
}

test('tutorial shows on a first visit', () => {
  assert.equal(isTutorialSeen(mockStorage()), false);
  assert.equal(shouldShowTutorial({ seen: false }), true);
});

test('tutorial is one-off: dismissing persists and suppresses it', () => {
  const storage = mockStorage();
  markTutorialSeen(storage);
  assert.equal(storage.getItem(TUTORIAL_KEY), '1');
  assert.equal(isTutorialSeen(storage), true);
  assert.equal(shouldShowTutorial({ seen: true }), false);
});

test('storage failures never throw and fall back to showing', () => {
  const broken = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  assert.equal(isTutorialSeen(broken), false);
  assert.doesNotThrow(() => markTutorialSeen(broken));
});
