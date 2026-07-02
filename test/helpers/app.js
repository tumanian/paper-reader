'use strict';

// Loads the REAL front-end code (store.js + the app modules under js/) into a
// single Node `vm` context, mirroring the browser's script load order. Returns
// a table of the app's functions plus accessors for the module-level mutable
// state they read/write.
//
// IMPORTANT (refactor contract): test files import named functions FROM THIS
// HELPER, never by re-parsing the source themselves. This is the single seam
// between the Phase-1 behavioural assertions and the code's physical layout.
// As the app is split into more ES modules, only this loader changes (extend
// APP_MODULES below) — the test assertions stay byte-for-byte identical.
//
// Browser delivery is native ES modules (`<script type="module" src=...>`);
// here we evaluate the same source in a vm for isolation (own timers / fetch /
// console). `import`/`export` statements are stripped before concatenation so
// the modules share one scope, exactly as the single inline script did. See
// stripModuleSyntax().

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildSandbox } = require('./dom-stub');

const ROOT = path.resolve(__dirname, '..', '..');

// App modules in browser load order. The browser resolves the graph via
// `import`; the vm shares one scope, so order only needs to satisfy top-level
// (non-hoisted) execution — function declarations hoist across the bundle.
const APP_MODULES = ['js/util.js', 'js/state.js', 'js/persistence.js', 'js/library.js', 'js/pdf.js', 'js/main.js'];

// Strip ES-module syntax so the files can be concatenated into one vm script
// sharing a single scope (function declarations hoist; cross-file references
// resolve by name). This is a TEST-ONLY transform — the shipped files are real
// ES modules served as-is. Kept deliberately simple: the app's own modules use
// only `import ... from '...'` / bare `import '...'` and `export` on
// declarations / `export { ... }` lists.
function stripModuleSyntax(src) {
  return src
    // import ... from '...'; (single- or multi-line)
    .replace(/^[ \t]*import\b[\s\S]*?\sfrom\s*['"][^'"]+['"]\s*;[ \t]*(?:\n|$)/gm, '')
    // bare side-effect import: import '...';
    .replace(/^[ \t]*import\s+['"][^'"]+['"]\s*;[ \t]*(?:\n|$)/gm, '')
    // whole-line `export { ... };` / `export { ... } from '...';`
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*(from\s*['"][^'"]+['"])?;?[ \t]*$/gm, '')
    // `export ` prefix on declarations (function/const/let/var/class/async)
    .replace(/^([ \t]*)export\s+(?=(async\s+)?(function|const|let|var|class)\b)/gm, '$1');
}

// Additive test shim, concatenated into the SAME script scope so its getters/
// setters and function references resolve against the app's own top-level
// bindings. Purely read/write of existing bindings — changes no app behaviour.
const SHIM = `
;globalThis.__PR__ = (function () {
  function acc(getter, setter) { return { get: getter, set: setter }; }
  return {
    fns: {
      migrateDoc, migrateStore, migrateReadLaterList, restoreDiscussions, docIdFor, simpleHash,
      conversationMessageCount, buildSummarySource, nextColor,
      sanitizePdfString, pdfFontSize, combinePdfTextItems, pdfTextItemsToString, normalizePdfSelectionText,
      parseArxivId, arxivAbsUrl, arxivPdfUrl, arxivIdFromUrl,
      asGlobalRegex, looksLikeCitation, extractRefNumber, extractReferencesSection, resolveReferenceEntry,
      isPlausibleAuthorPart, parseAuthorYearFromSelection, authorMatchRequirements, yearMatchesRef,
      authorTokenInRef, scoreRefForAuthorYear, findBestAuthorYearMatch, refMatchesAuthorYear, authorLastNames,
      findReferenceInPaper, findReferenceByAuthorYear, parseParentheticalAuthorYear, parseAuthorYearCitation, parseCitation,
      significantTitleWords, parseBibliographyMetadata, scoreCrossrefItem, verifyFetchedPaperAgainstBib,
      sanitizeCitationFormat, buildFallbackCitationFormat, matchWithStoredFormat, authorTokens, refMatchesAuthorTokens, matchCitationToReferences,
      shouldTryCitationPreview, findNearbyContext, buildPaperBlock, buildDocContext,
      esc, renderPreviewHtml, md, timeAgo,
      sanitizeOnboarding, isTodoValue, normalizeForMatch, getFeaturedPaper,
      buildPaperReferences, parseReferencesFromSection, parseAuthorYearReferenceLines,
      initStorage, loadStore, persistCurrentDoc,
      sendMessage, callClaude, buildRatingRecord, ratingIdFor,
    },
    state: {
      paperText: acc(function(){return paperText;}, function(v){paperText=v;}),
      paperRefText: acc(function(){return paperRefText;}, function(v){paperRefText=v;}),
      discussions: acc(function(){return discussions;}, function(v){discussions=v;}),
      paperReferences: acc(function(){return paperReferences;}, function(v){paperReferences=v;}),
      bibByNumber: acc(function(){return bibByNumber;}, function(v){bibByNumber=v;}),
      currentDocId: acc(function(){return currentDocId;}, function(v){currentDocId=v;}),
      currentMode: acc(function(){return currentMode;}, function(v){currentMode=v;}),
      citationFormat: acc(function(){return citationFormat;}, function(v){citationFormat=v;}),
      docMeta: acc(function(){return docMeta;}, function(v){docMeta=v;}),
      activeId: acc(function(){return activeId;}, function(v){activeId=v;}),
      conversationSummary: acc(function(){return conversationSummary;}, function(v){conversationSummary=v;}),
      summaryMessageCount: acc(function(){return summaryMessageCount;}, function(v){summaryMessageCount=v;}),
    },
    constants: {
      MAX_PAPER_CHARS: (function(){return MAX_PAPER_CHARS;})(),
      CHAT_MODEL: (function(){return CHAT_MODEL;})(),
    },
  };
})();
`;

let cached = null;

function loadApp() {
  if (cached) return cached;

  const storeJs = fs.readFileSync(path.join(ROOT, 'store.js'), 'utf8');
  const appSrc = APP_MODULES
    .map((rel) => stripModuleSyntax(fs.readFileSync(path.join(ROOT, rel), 'utf8')))
    .join('\n;\n');

  let onboardingJson = { tracks: [], papers: {}, featured: '' };
  try { onboardingJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'onboarding-curation.json'), 'utf8')); } catch (_) {}

  const { sandbox, helpers } = buildSandbox({ onboardingJson });
  vm.createContext(sandbox);

  const combined = `${storeJs}\n;\n${appSrc}\n;\n${SHIM}\n`;
  vm.runInContext(combined, sandbox, { filename: 'paper-reader-app.bundle.js' });

  const PR = sandbox.__PR__;

  // Flatten state accessors into a live object with get/set props.
  const state = {};
  for (const [k, a] of Object.entries(PR.state)) {
    Object.defineProperty(state, k, { get: a.get, set: a.set, enumerable: true });
  }

  // Reset app state to a clean baseline (used in beforeEach).
  function reset() {
    helpers.localStorage.clear();
    state.paperText = '';
    state.paperRefText = '';
    state.discussions = [];
    state.paperReferences = [];
    state.bibByNumber = {};
    state.currentDocId = null;
    state.currentMode = null;
    state.citationFormat = null;
    state.docMeta = { name: '', mode: '', badge: '', url: null };
    state.activeId = null;
    state.conversationSummary = null;
    state.summaryMessageCount = 0;
    helpers.clearFetchCalls();
  }

  cached = {
    ...PR.fns,
    fns: PR.fns,
    state,
    constants: PR.constants,
    reset,
    // Normalizes a value produced inside the vm realm into host-realm plain
    // objects/arrays so assert.deepStrictEqual works (cross-realm prototypes
    // otherwise differ even when structures match).
    plain: (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x))),
    // Resolves after the page's boot() IIFE has finished its async tail
    // (init + onboarding fetch + initial renders). Await this in a test
    // `before()` hook so boot can never interleave with a test body.
    ready: new Promise((res) => setTimeout(res, 0)),
    PaperStore: sandbox.window.PaperStore,
    sandbox,
    ...helpers,
  };
  return cached;
}

module.exports = loadApp();
