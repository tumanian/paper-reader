// Real-ESM graph guard. The main vm harness (test/helpers/app.js) strips
// import/export and runs every module in ONE shared scope, so it cannot catch a
// wrong/missing `import` name or a reference to a symbol that was moved but not
// imported — those resolve anyway in the shared scope yet break the browser.
//
// This test closes that gap: it loads the REAL js/ module graph as native ES
// modules (js/package.json marks the dir "type":"module") under the DOM stubs
// and asserts the graph links and boot() runs. A bad import name fails module
// linking; a missed reference throws at boot. Node runs each test file in its
// own process, so installing browser stubs on globalThis here can't leak into
// the other (vm-based) test files.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import fs from 'fs';
import vm from 'vm';

const require = createRequire(import.meta.url);
const { buildSandbox } = require('./helpers/dom-stub.js');

// Keep Node's native timers/built-ins (clobbering setTimeout would break the
// stub's own unref wrapper, which closes over the real setTimeout → recursion).
const SKIP = new Set([
  'window', 'self', 'console',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'Promise', 'Math', 'Date', 'JSON', 'RegExp', 'Array', 'Object', 'Number', 'String',
  'Boolean', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Error',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'AbortController', 'AbortSignal', 'crypto', 'btoa', 'atob', 'Blob',
]);

let bootError = null;

before(async () => {
  let onboardingJson = { tracks: [], papers: {}, featured: '' };
  try {
    onboardingJson = JSON.parse(fs.readFileSync(new URL('../onboarding-curation.json', import.meta.url), 'utf8'));
  } catch {}

  const { sandbox } = buildSandbox({ onboardingJson });
  for (const [k, v] of Object.entries(sandbox)) {
    if (SKIP.has(k)) continue;
    try { globalThis[k] = v; } catch {}
  }
  globalThis.window = globalThis;
  globalThis.self = globalThis;

  process.on('unhandledRejection', (e) => { bootError = bootError || e; });

  // store.js is a classic script that assigns window.PaperStore — run it in the
  // global context so the module graph's bare PaperStore reference resolves.
  const storeSrc = fs.readFileSync(fileURLToPath(new URL('../store.js', import.meta.url)), 'utf8');
  vm.runInThisContext(storeSrc);

  try {
    await import(new URL('../js/main.js', import.meta.url));
    await new Promise((r) => setTimeout(r, 150)); // let boot()'s async tail run
  } catch (e) {
    bootError = e;
  }
});

test('js/ module graph links as native ESM and boot() runs cleanly', () => {
  assert.equal(bootError, null, bootError && (bootError.stack || String(bootError)));
});
