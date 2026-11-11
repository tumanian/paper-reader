// First-visit tutorial interstitial — a one-off modal with the walkthrough GIF.
// Shows once per browser until dismissed; purely local state. The footer's
// "How it works" link reopens it on demand.

export const TUTORIAL_KEY = 'paperReader.tutorialSeen.v1';

export const TUTORIAL_STEPS = [
  'Paste a paper link or drop a PDF',
  'Highlight any passage',
  'Ask Claude about it',
];

export function isTutorialSeen(storage = localStorage) {
  try { return storage.getItem(TUTORIAL_KEY) === '1'; }
  catch { return false; }
}

export function markTutorialSeen(storage = localStorage) {
  try { storage.setItem(TUTORIAL_KEY, '1'); } catch {}
}

export function shouldShowTutorial({ seen } = {}) {
  return !(seen ?? isTutorialSeen());
}

export function openTutorial(doc = document) {
  if (doc.getElementById('tutorial-overlay')) return;

  const overlay = doc.createElement('div');
  overlay.id = 'tutorial-overlay';
  overlay.innerHTML =
    `<div class="tutorial-card" role="dialog" aria-modal="true" aria-labelledby="tutorial-title">` +
      `<button type="button" class="tutorial-close" aria-label="Close">×</button>` +
      `<div class="tutorial-title" id="tutorial-title">How Paper Reader works</div>` +
      `<img class="tutorial-gif" src="paper-reader-tutorial.gif" width="1440" height="697" ` +
        `alt="Walkthrough: paste a paper link, highlight a line, and ask Claude a question about it">` +
      `<ol class="tutorial-steps">` +
        TUTORIAL_STEPS.map((s) => `<li>${s}</li>`).join('') +
      `</ol>` +
      `<button type="button" class="tutorial-done">Got it</button>` +
    `</div>`;
  doc.body.appendChild(overlay);

  const close = () => {
    markTutorialSeen();
    overlay.remove();
    doc.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  doc.addEventListener('keydown', onKey);
  // Backdrop click dismisses; clicks inside the card do not.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.tutorial-close').addEventListener('click', close);
  const done = overlay.querySelector('.tutorial-done');
  done.addEventListener('click', close);
  done.focus();
}

export function initTutorial(doc = document) {
  const link = doc.getElementById('tutorial-link');
  if (link) {
    link.addEventListener('click', (e) => { e.preventDefault(); openTutorial(doc); });
  }
  if (shouldShowTutorial()) openTutorial(doc);
}
