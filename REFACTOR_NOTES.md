# index.html modularization — working notes

> Continuity note so this refactor can resume cleanly if context is lost.
> Branch: `modularization`. Last updated: Phase 3 Step 3 DONE (js/persistence.js extracted, 119 green). Next: Step 4 extract js/library.js (+ auth).
>
> Step 2 final approach (better than the original "state object" idea): used ES module LIVE BINDINGS. state.js `export let`s each shared value; main.js imports them and READS them unchanged (live bindings reflect writer updates), so ~all read sites were untouched. Only WRITES changed: every reassignment + every `discussions` array mutation now routes through named writer fns (setX / addDiscussion / removeDiscussion / clearDiscussions / replaceDiscussions). In-place object/array mutations that are legal on imported bindings were left as-is (`docMeta.name=`, `bibByNumber[n]=`, `paperReferences.push`). discussions stays ONE mutable array, mutated in place (never reassigned) — verified by test/state.test.mjs. Pure helper `removeById` is exported + unit-tested. The SHIM in test/helpers/app.js needed NO change (it references the same variable names, now declared in the state.js portion of the shared vm bundle).

## APPROVED DECISIONS (Phase 2 sign-off)
1. **Granularity: ~13 files.** Do sensible folds (highlights→chat, citation-log→citation-resolve, math→selection, + others) to land ~13. **Keep these three ISOLATED regardless** (high-risk, heavily-tested pure-logic cores): `state.js`, `persistence.js`, `citation-parse.js`. Split by "what's risky / changes together," not maximal tidiness.
2. **State mutability: CONSERVATIVE (not full immutable).** `discussions` stays a SINGLE MUTABLE array; funnel ALL writes through named functions; keep pure transition functions as tested helpers. Do **NOT** convert the hot slice to immutable replacement in this refactor (stale-captured-array risk = the discussion-loss bug class to avoid). Full immutability can come later as its own change. **The immutable-conversion step is DROPPED from sequencing.** Single source of truth + named accessors/writers + pure transitions all stay — just without immutable replacement of the live array.

## PROCESS REQUIREMENTS (Phase 3)
- Phase 1 suite + REFACTOR_NOTES.md committed as a focused checkpoint BEFORE any Phase 3 code. (Notes stay committed, not git-ignored; standalone file, not in .cursorrules.)
- **Step 0 (harness swap) is its OWN commit**: move inline script verbatim into `js/main.js` as a module, swap the test loader to import it, prove all 116 green BEFORE any real splitting. No extraction until Step 0 is green AND committed.
- After EACH module extraction: run full suite, confirm green, commit that single extraction. One module per commit = one rollback point. Never leave the app broken.
- Pure refactor only: no feature changes / improvements / behavior-altering renames. Bugs found → list in the "BUGS FOUND" section below, do NOT fix here.
- Never weaken/delete/edit a Phase 1 test to make it pass. Red test = behavior changed → fix the refactor, not the test. Flag any case a test genuinely must change.
- Keep this file updated at each checkpoint (done / next / current state).

## Goal
Split the single large `index.html` inline `<script>` into maintainable ES modules so future features / parallel agents don't collide. **Pure structural refactor** — behavior, deploy, and the no-build-step constraint must be completely unchanged.

## Hard requirements (all phases)
- No build step, bundler, transpiler, or build script for the main app.
- `node dev-server.js` and Vercel serve unchanged (serving extra static `/js/*.js` is fine).
- Server-side key handling (`handler.js` / `api/chat.js`) unchanged.
- Storage model intact: localStorage keys, IndexedDB stores, the empty-overwrite persistence guard — preserved exactly.
- No new runtime dependencies. Dev-only test deps require asking first (so far: none — Node's built-in `node --test` only).

## Three ordered phases (don't start a later one until the earlier is approved)
1. **Phase 1 — tests first** against current behavior. ✅ DONE, all green.
2. **Phase 2 — propose refactor plan**, no code. ✅ PROPOSED (below). ⏳ awaiting approval.
3. **Phase 3 — execute refactor**, tests stay green after every step. ❌ NOT STARTED.

---

## Phase 1 status — DONE (116 tests green)

Run: `npm test` (or `node --test`). All 116 pass; process exits clean (app timers `unref()`'d).

Test harness (test-only; zero external deps; loads real code in a Node `vm`):
- `test/helpers/dom-stub.js` — in-memory stubs for `document`/`window`/`localStorage`/`indexedDB`/`fetch`; timers unref'd; app `console` silenced.
- `test/helpers/app.js` — extracts the inline `<script>` from `index.html` + loads `store.js` into one `vm` context; exposes `fns`, `state` (get/set accessors), `constants`, `reset()`, `ready`, `plain()` (cross-realm JSON normalize), `PaperStore`, fetch helpers.
  - **Test seam:** every assertion routes through this loader. When the app becomes ES modules, ONLY this loader changes (it will `import` the modules); the test assertions stay byte-for-byte identical.

Test files (counts):
- `test/handler.test.js` (16) — proxy request construction w/ mocked fetch: key handling, model passthrough, system+image blocks intact, `cache_control` preserved, upstream errors, local `citation-match`/`summarize` routing.
- `test/citations.test.js` (30) — citation parse/match/score, Crossref scoring, bib extraction, fallback/sanitize formatting, preview gating.
- `test/pdf-text.test.js` (9) — PDF text utils.
- `test/persistence.test.js` (15) — migrations, `restoreDiscussions`, `docIdFor`, `simpleHash`, `initStorage`.
- `test/utils.test.js` (20) — `esc`/`md`/preview, arXiv parsing, `timeAgo`, `findNearbyContext`, `buildPaperBlock`, `buildDocContext`, onboarding sanitize, match normalize.
- `test/store.test.js` (11) — FUNCTIONAL, real `store.js` local mode: saveDoc↔getStore, localStorage mirror, fresh-init reload, delete/clear, putPdf↔getPdf (IndexedDB), read-later, figures.
- `test/guard.test.js` (5) — FUNCTIONAL: `persistCurrentDoc` empty-overwrite guard + save→close→reopen preserves discussions/messages.
- `test/request-assembly.test.js` (8) — FUNCTIONAL: real `sendMessage()` w/ mocked Claude — model passthrough, `max_tokens`, system is array, full-paper block carries `cache_control:{type:'ephemeral'}`, instruction block first (uncached), highlighted-passage block, math/citation framing, user+assistant turns recorded.

Added `"test": "node --test"` to `package.json` scripts. No other prod changes.

### Coverage gaps (known blind spots)
- Pure-visual/layout: popover positioning, highlight rect painting, scroll-into-view, CSS.
- pdf.js & Readability rendering libs themselves are stubbed (text utils around them are tested).
- Real network paths mocked (Claude, Crossref, CORS web-fetch proxies).
- Supabase cloud sync: local mode only; cloud branch of `store.js` only via local fallback.
- Figure capture pixel pipeline (canvas→dataURL) stubbed; only the figure record IDB round-trip tested.
- DOM event wiring / onboarding UI flow not driven through real events; underlying fns tested.

---

## Phase 2 proposal — module breakdown (FINAL: 13 files)

All app modules under `/js/`. `store.js`, `handler.js`, `api/*`, `dev-server.js` untouched. Entry: `<script type="module" src="/js/main.js">` replaces the inline block. Head's classic CDN scripts (Supabase, store.js, pdf.js, Readability) still load first.

1. `js/state.js` **(ISOLATED)** — single state singleton + named accessors + named writers + pure transition helpers.
2. `js/util.js` — `esc`, `md`, `renderPreviewHtml`, `timeAgo`, `simpleHash`, `asGlobalRegex`, `normalizeForMatch`, `isTodoValue`, `decodeXmlText`.
3. `js/persistence.js` **(ISOLATED)** — STORE/READ_LATER/SCHEMA keys, migrations, `initStorage`, `loadStore`, `persistCurrentDoc` (+guard), `docIdFor`, `restoreDiscussions`, `loadDocSummary`, summary pipeline (`conversationMessageCount`, `buildSummarySource`, `scheduleSummaryUpdate`, `maybeUpdateSummary`), `callSummarize`.
4. `js/library.js` — `renderLibrary`, `renderReadLater`, `addToReadLater`, `openReadLaterItem`, `reopenDoc`; **+ auth folded in** (`updateAuthBar`, `loadLibraryForEmail`, `updateLogoutFab`, login-widget + `onPaperStore*` hooks, beforeunload/pagehide/visibilitychange handlers).
5. `js/pdf.js` — `loadPDF`, `renderFromBuffer`, PDF text utils (`sanitizePdfString`, `pdfFontSize`, `combinePdfTextItems`, `pdfTextItemsToString`, `normalizePdfSelectionText`), `renderPDFPages`, `restoreHighlightsForLoadedPages`.
6. `js/web-loader.js` — `loadWebPage`, `smartRewrite`, arXiv helpers, `fetchViaProxy`/`fetchPdfViaProxy`, `renderWebArticle`, `restoreWebHighlights`, `startApp`, `setStatus`, `showViewer`, `arxivIdFromUrl`; **+ references/bibliography indexing folded in** (`buildPaperReferences`, `parseReferencesFromSection`, `parseAuthorYearReferenceLines`, `indexBibliographyFromDoc`, `indexWebBibliography`, `addBibliographyItem`, `extractReferencesSectionFromDoc`, `expandSelectionText`, `dumpBibliography`).
7. `js/citation-parse.js` **(ISOLATED)** — pure parse/match/score core (covered by citations.test.js): `parseCitation`, `parseAuthorYear*`, `scoreRefForAuthorYear`, `matchCitationToReferences`, `parseBibliographyMetadata`, `scoreCrossrefItem`, `verifyFetchedPaperAgainstBib`, `sanitizeCitationFormat`, `buildFallbackCitationFormat`, `shouldTryCitationPreview`, `looksLikeCitation`, `extractRefNumber`, `extractReferencesSection`, `resolveReferenceEntry`, `findReferenceInPaper`, `findReferenceByAuthorYear`, `authorTokens`, `refMatchesAuthorTokens`, `matchWithStoredFormat`, `significantTitleWords`, etc.
8. `js/citation-resolve.js` — network + preview UI (`lookupCrossrefBibliography`, `resolveCitationUrl`, fetch abstracts/excerpt, `fetchCitedPaperInfo`, `callCitationMatch/Preview*`, `loadCitationPreview`, `openCitationPaper`, `finishCitationNavigation`, `updateReturnButton`, `addSelectionToReadLater`, `ensureCitationFormat`, `sampleCitationContext`); **+ citation-log folded in** (`loadCitationLogStore`, `persistCitationLog`, `citeLogKey`, `getCitationLogEntry`, `writeCitationLogEntry`, `logCitation`, `normalizeCitationText`, `isCitationLogExpired`).
9. `js/selection.js` — mouseup/mousedown listeners, `positionPopover`, `hidePopover`, `updatePopoverButtons`, `updateMathButtons`, `classifySelection`, ask-btn handler; **+ math folded in** (`findMathAncestor`, `extractTexFromMathNode`, `captureSelectionTex`, `startMathDiscussion` + math button handlers).
10. `js/figure.js` — full capture pipeline (pdf + web): `armFigureCapture`→`startFigureDiscussion`, `capturePdfRegion`, `pdfCaptionForRect`, `captureWebRegion`, rasterize/crop helpers, `fetchImageViaProxy`, `ensureFigureImage`, keydown + hint wiring.
11. `js/chat.js` — discussions/chat + request assembly: `renderList`, `deleteDiscussion`, `openChat`, `showList`, `rebuildChat`, `renderChatFigure`, `addMsg`, `buildDocContext`, `findNearbyContext`, `buildPaperBlock`, `sendMessage`, `CHAT_MODEL`, `callClaude`, send/keydown handlers; **+ highlights folded in** (`paintHighlight`, `scrollHighlightIntoView`); **+ ratings folded in** (ratings IDB + thumbs UI: `openRatingsDB`…`exportRatings`, `buildRatingRecord`, `ratingIdFor`, `renderRatingControl`).
12. `js/onboarding.js` — curation: `sanitizeOnboarding`, `loadOnboardingData`, `getFeaturedPaper`, `openFeaturedExample`, `openOnboardingPaper`, `locateTextRange`, `rectsForRange`, `maybeApplyOnboardingCuration`, `applyOnboardingItems`, `runOnboardingDemo`, `showOnboardingCitationDemo`, `maybeShowOnboardingHint`, `cancelOnboardingPlacement`, FEATURE_CTA.
13. `js/main.js` — entry: imports modules, runs `boot()`; **+ nav folded in** (`new-btn`, `backToUpload`, drop-zone/file-input wiring).

Notes on folds: ratings is fairly independent (own IDB) but only invoked from chat rendering, so it rides with chat ("changes together"). If chat.js gets unwieldy, ratings is the natural re-split. Minor fold boundaries adjustable mid-refactor as long as the 3 isolated cores stay isolated and tests stay green.

### Mechanism: native ES modules
Chosen over (a) multiple classic `<script src>` sharing global scope — keeps the ~25 mutable globals, the collision risk we're removing; (b) keeping one HTML — the status quo. ES modules give real per-file scope + explicit deps + a clean home for the state singleton, are natively supported (no transpile), need only HTTP serving (app never runs from file://). Module scripts are deferred → matches today's "inline script at end of body" timing; head CDN globals present first.

### Shared-state design (CONSERVATIVE — as approved)
- **One `js/state.js` singleton**, imported everywhere as the source of truth. No other module declares app state.
- **Named accessors / writers** — no scattered direct reassignment. Readers use getters (`getDiscussions()`, `getActiveId()`, `getDocMeta()`, `getPaperText()`…); ALL writes go through named functions (`addDiscussion(d)`, `removeDiscussion(id)`, `setActiveId(id)`, `setPendingSel(sel)`, `setPaperText(t)`, `resetReader()`, …).
- **`discussions` stays a SINGLE MUTABLE array.** Named writers mutate it in place (`arr.push`, `arr.splice`/filter-reassign INTERNALLY within the writer is fine as long as the singleton keeps holding the same identity readers expect — prefer in-place mutation to avoid stale refs). NO immutable replacement of the live array in this refactor.
- **Pure transition helpers, independently unit-testable** (NEW tests for NEW code; do NOT touch Phase 1 tests): pure functions like `applyAddDiscussion(list, d) → list'`, etc., used by the writers and tested in isolation. These exist for testability; the live array is still mutated by the writer.
- **Plain references for large, cold data**: `paperText`, `paperRefText`, `pdfDoc` (PDF bytes/proxy) assigned by reference, NEVER deep-cloned.
- No state-management library, no new dependency.

The ~25 current globals (lines 840–859 in index.html): `pdfDoc, discussions, activeId, pendingSel, currentDocId, currentMode, docMeta, conversationSummary, summaryMessageCount, summaryDirty, _summaryTimer, _summaryInFlight, pendingCitation, returnToDocId, returnToDocName, citePreviewAbort, citePreviewTimer, classifyTimer, classifyToken, bibByNumber, paperReferences, citationFormat, citationFormatPromise, paperText, paperRefText` (+ `onboardingData`, `pendingOnboarding`, `_onboardingCancel`, capture flags `captureArmed`/`_captureEls`/`_captureDrag`).

### Stale-array note (why conservative)
Immutable replacement of `discussions` would force EVERY reader to read live `getDiscussions()` or risk a stale captured array = discussion-loss bug. Avoided by keeping the array mutable + funneling writes. Trip-wire tests if anything regresses: `guard.test.js` + `request-assembly.test.js`.

### Deploy/no-build confirmation
- No build/bundler/transpiler/dep. Plain `.js` + one `type="module"` tag.
- `dev-server.js` already serves arbitrary static files w/ `.js` MIME (lines 80–96) — unchanged.
- Vercel serves `/js/*.js` like `store.js` today; `api/chat.js`+`handler.js` untouched.
- Storage keys / IndexedDB stores / guard preserved verbatim.

---

## Phase 3 sequencing (tests green + commit after EVERY step; immutable step DROPPED)
- **Step 0 (own commit):** Move inline script verbatim into `js/main.js` as a module + export surface; swap the test harness to `import` it (install DOM stub on `globalThis` first); run suite → 116 green. Proves ESM + harness with zero behavior change. NO extraction before this is green + committed.
- **Step 1:** Extract `js/util.js` → green → commit.
- **Step 2:** Extract `js/state.js` (singleton + accessors + named writers + pure transition helpers; conservative, mutable array) → green → commit.
- **Steps 3..N (one module per commit):** persistence → library(+auth) → pdf → web-loader(+references) → citation-parse → citation-resolve(+citation-log) → selection(+math) → figure → chat(+highlights+ratings) → onboarding. Full suite after EACH; commit each.
- Final: `main.js` is just the entry (imports + boot + nav wiring).

Rules: pure refactor only; no feature changes / no behavior-altering renames; bugs found are LISTED (below), not fixed; never weaken/delete/adjust a Phase 1 test (red = behavior changed → fix the refactor); app stays working between steps; one module per commit = one rollback point.

## Open decisions — RESOLVED
1. Granularity → ~13 files (see FINAL breakdown). state.js / persistence.js / citation-parse.js kept isolated.
2. State mutability → CONSERVATIVE (mutable array + named writers + pure transition helpers for tests). Immutable step dropped.

## BUGS FOUND (list only — do NOT fix during refactor)
- (none yet)

## PROGRESS LOG
- Phase 1: 116 tests green. Harness: test/helpers/{dom-stub,app}.js. `npm test` = `node --test`.
- Phase 2: proposed + APPROVED with decisions above.
- Phase 3:
  - Commit `461091a` — Phase 1 test suite + REFACTOR_NOTES.md checkpoint.
  - **Step 0 DONE (116 green):** inline `<script>` moved verbatim → `js/main.js`; `index.html` now loads `<script type="module" src="/js/main.js">`. Test loader (`test/helpers/app.js`) now reads `APP_MODULES` (currently `['js/main.js']`), strips ES-module syntax, concatenates into the vm (browser uses native ESM; vm shares one scope for isolation). Verified strict-mode ESM eval + boot() via a throwaway `.mjs` smoke (deleted). Pre-checks: no inline HTML event handlers, no `javascript:` URLs, only `window.onPaperStore*` cross-scope assignments (survive module scope), `node --check --input-type=module` clean.
  - **Step 1 DONE (116 green):** extracted `js/util.js` (esc, renderPreviewHtml, md, timeAgo, simpleHash, asGlobalRegex, isTodoValue, normalizeForMatch, decodeXmlText). main.js `import`s them (single-line import at top); util.js `export`s them. APP_MODULES = ['js/util.js','js/main.js']. Verified with real-ESM graph check (see below).
  - **Step 2 DONE (119 green):** extracted `js/state.js` — single source of truth for the genuinely SHARED state (pdfDoc, discussions, activeId, pendingSel, pendingCitation, currentDocId, currentMode, docMeta, conversationSummary, summaryMessageCount, summaryDirty, returnToDocId, returnToDocName, bibByNumber, paperReferences, citationFormat, paperText, paperRefText) + named writers + pure `removeById`. Feature-local plumbing kept in main.js for now: _summaryTimer/_summaryInFlight, citePreviewAbort, citePreviewTimer, classifyTimer, classifyToken, citationFormatPromise (move into their feature modules later). Added test/state.test.mjs (2 tests).
  - **Step 3 DONE (119 green):** extracted `js/persistence.js` — STORE/READ_LATER/SCHEMA keys, migrations (`migrateDoc`, `migrateStore`, `migrateReadLaterList`), `initStorage`, `loadStore`, `persistCurrentDoc` (+ empty-overwrite guard intact), `docIdFor`, `restoreDiscussions`, `loadDocSummary`, summary pipeline (`conversationMessageCount`, `buildSummarySource`, `scheduleSummaryUpdate`, `maybeUpdateSummary`, `callSummarize`), `_summaryTimer`/`_summaryInFlight`, `clearScheduledSummaryUpdate`. UI side-effects decoupled via `setPersistenceHooks({ onCloudSaveError, onAfterSummaryPersist })` wired in main.js to `updateAuthBar` / `renderLibrary` (avoids circular imports; behavior unchanged). APP_MODULES = ['js/util.js','js/state.js','js/persistence.js','js/main.js']. Harness `stripModuleSyntax()` extended for multi-line `import` statements.
  - **NEXT → Step 4:** extract `js/library.js` (+ auth folded in): `renderLibrary`, `renderReadLater`, `addToReadLater`, `openReadLaterItem`, `reopenDoc`, `updateAuthBar`, `loadLibraryForEmail`, `updateLogoutFab`, login widget + `onPaperStore*` hooks, beforeunload/pagehide/visibilitychange handlers. Run suite + ESM guard, commit.
  - Harness note for splitting: when a module uses `import`/`export`, add it to APP_MODULES in load order; `stripModuleSyntax()` removes the syntax so the shared-scope vm bundle still works. Function declarations hoist across the bundle; only top-level non-hoisted execution order matters (keep util/state/const-defining modules before main.js).
  - **HARNESS BLIND SPOT (now guarded):** the vm bundle strips import/export and shares one scope, so it does NOT catch a wrong/missing `import` name or a missed reference (the symbol resolves anyway via the shared scope). The browser WOULD break. PERMANENT GUARD added: `test/esm-graph.test.mjs` loads the REAL js/ graph as native ESM (enabled by `js/package.json` `{"type":"module"}`) under DOM stubs and asserts the graph links + boot() runs. Runs inside `node --test` (now 117 tests). Verified it FAILS on a bad import name while the 116 vm tests still pass — confirming the guard is real. Gotcha when stubbing globals for ESM: install browser stubs on globalThis but DO NOT override Node's timers/built-ins (clobbering setTimeout breaks the stub's own unref wrapper → infinite recursion). `js/package.json` is inert for the browser/Vercel/dev-server and only affects Node's module resolution; root stays CJS (dev-server.js/handler.js/api unaffected).

## Final acceptance
Full Phase 1 suite green; app loads; PDF + arXiv/web render; selection/discuss/math/figure/ELI5 work; highlights paint; Claude responds (proxy + cached full-paper context intact); persistence round-trips + guard holds; onboarding works for a new user; `node dev-server.js` and Vercel both serve it.
