// Touch-primary device notice — launch expectation-setter, not a gate.
// Shows once on coarse-pointer devices until dismissed; purely local state.

export const TOUCH_NOTICE_KEY = 'paperReader.touchNoticeDismissed.v1';

export const TOUCH_NOTICE_COPY =
  'paper-reader works best on desktop. Text selection and figure capture are still rough on touch devices.';

// Primary input is a finger when the coarse pointer media query matches.
// We deliberately do NOT use 'ontouchstart' in window — hybrid laptops
// report touch capability while the primary pointer stays fine.
export function isTouchPrimaryDevice(matchMedia = (q) => window.matchMedia(q)) {
  try { return !!matchMedia('(pointer: coarse)').matches; }
  catch { return false; }
}

export function isTouchNoticeDismissed(storage = localStorage) {
  try { return storage.getItem(TOUCH_NOTICE_KEY) === '1'; }
  catch { return false; }
}

export function dismissTouchNotice(storage = localStorage) {
  try { storage.setItem(TOUCH_NOTICE_KEY, '1'); } catch {}
}

export function shouldShowTouchNotice({ matchMedia, dismissed } = {}) {
  if (dismissed ?? isTouchNoticeDismissed()) return false;
  return isTouchPrimaryDevice(matchMedia);
}

export function initTouchNotice(doc = document, win = window) {
  if (!shouldShowTouchNotice({ matchMedia: (q) => win.matchMedia(q) })) return;

  const bar = doc.createElement('div');
  bar.id = 'touch-notice';
  bar.setAttribute('role', 'status');
  bar.innerHTML =
    `<span class="touch-notice-text">${TOUCH_NOTICE_COPY}</span>` +
    `<button type="button" class="touch-notice-close" aria-label="Dismiss">×</button>`;
  doc.body.appendChild(bar);
  doc.body.classList.add('has-touch-notice');

  bar.querySelector('.touch-notice-close').addEventListener('click', () => {
    dismissTouchNotice();
    bar.remove();
    doc.body.classList.remove('has-touch-notice');
  });
}
