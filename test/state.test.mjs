// Unit tests for js/state.js: the pure transition helper and the conservative
// guarantee that `discussions` stays ONE mutable array, mutated in place by the
// named writers (no reassignment) — the property that prevents the stale-array
// / discussion-loss class of bug this refactor is explicitly preserving.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  removeById,
  discussions,
  addDiscussion,
  removeDiscussion,
  clearDiscussions,
  replaceDiscussions,
} from '../js/state.js';

test('removeById filters by id without mutating its input', () => {
  const list = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const out = removeById(list, 2);
  assert.deepEqual(out.map((x) => x.id), [1, 3]);
  assert.equal(list.length, 3, 'source list is left untouched (pure)');
});

test('discussion writers mutate the single live array in place', () => {
  clearDiscussions();
  const ref = discussions; // capture the array identity up front

  addDiscussion({ id: 1 });
  addDiscussion({ id: 2 });
  assert.deepEqual(discussions.map((d) => d.id), [1, 2]);

  removeDiscussion(1);
  assert.deepEqual(discussions.map((d) => d.id), [2]);

  replaceDiscussions([{ id: 9 }, { id: 10 }]);
  assert.deepEqual(discussions.map((d) => d.id), [9, 10]);

  clearDiscussions();
  assert.equal(discussions.length, 0);

  assert.equal(discussions, ref, 'same array object throughout — never reassigned');
});
