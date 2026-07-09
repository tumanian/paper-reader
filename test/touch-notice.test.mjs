import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOUCH_NOTICE_KEY,
  isTouchPrimaryDevice,
  isTouchNoticeDismissed,
  dismissTouchNotice,
  shouldShowTouchNotice,
} from '../js/touch-notice.js';

function mockMatchMedia(coarse) {
  return (q) => ({ matches: q === '(pointer: coarse)' ? coarse : false });
}

function mockStorage(initial = {}) {
  const map = { ...initial };
  return {
    getItem(k) { return map[k] ?? null; },
    setItem(k, v) { map[k] = String(v); },
  };
}

test('isTouchPrimaryDevice uses coarse pointer, not mere touch capability', () => {
  assert.equal(isTouchPrimaryDevice(mockMatchMedia(true)), true);
  assert.equal(isTouchPrimaryDevice(mockMatchMedia(false)), false);
  // Hybrid laptop: touch events exist but primary pointer is fine → no notice.
  assert.equal(isTouchPrimaryDevice(mockMatchMedia(false)), false);
});

test('isTouchPrimaryDevice returns false when matchMedia throws', () => {
  assert.equal(isTouchPrimaryDevice(() => { throw new Error('no media'); }), false);
});

test('shouldShowTouchNotice is false when dismissed', () => {
  assert.equal(shouldShowTouchNotice({
    matchMedia: mockMatchMedia(true),
    dismissed: true,
  }), false);
});

test('shouldShowTouchNotice is false on fine pointer even when not dismissed', () => {
  assert.equal(shouldShowTouchNotice({
    matchMedia: mockMatchMedia(false),
    dismissed: false,
  }), false);
});

test('shouldShowTouchNotice is true on coarse pointer when not dismissed', () => {
  assert.equal(shouldShowTouchNotice({
    matchMedia: mockMatchMedia(true),
    dismissed: false,
  }), true);
});

test('dismissTouchNotice persists and round-trips through storage', () => {
  const storage = mockStorage();
  assert.equal(isTouchNoticeDismissed(storage), false);
  dismissTouchNotice(storage);
  assert.equal(storage.getItem(TOUCH_NOTICE_KEY), '1');
  assert.equal(isTouchNoticeDismissed(storage), true);
  assert.equal(shouldShowTouchNotice({
    matchMedia: mockMatchMedia(true),
    dismissed: isTouchNoticeDismissed(storage),
  }), false);
});
