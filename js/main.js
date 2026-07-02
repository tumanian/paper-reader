import { initStorage, persistCurrentDoc, maybeUpdateSummary, setPersistenceHooks, clearScheduledSummaryUpdate } from './persistence.js';
import { setPdfDoc, setActiveId, setPendingSel, setCurrentDocId, setCurrentMode, setConversationSummary, setSummaryMessageCount, setSummaryDirty, setReturnToDocId, setReturnToDocName, clearDiscussions } from './state.js';
import { renderLibrary, renderReadLater, updateAuthBar, updateLogoutFab, initLibrary, setLibraryHooks } from './library.js';
import { initPdf, setPdfHooks, renderFromBuffer, restoreHighlightsForLoadedPages } from './pdf.js';
import { extractReferencesSection } from './citation-parse.js';
import { initWebLoader, setWebLoaderHooks, loadWebPage, loadArxivPdf, startApp, setStatus, showViewer, parseArxivId, buildPaperReferences } from './web-loader.js';
import { setCitationResolveHooks, logCitation, ensureCitationFormat } from './citation-resolve.js';
import { initSelection, setSelectionHooks, updateReturnButton, finishCitationNavigation } from './selection.js';
import { initFigure, setFigureHooks } from './figure.js';
import { initChat, setChatHooks, paintHighlight, renderList, openChat, sendMessage, showList, findNearbyContext } from './chat.js';
import { runOnboardingDemo, cancelOnboardingPlacement, maybeApplyOnboardingCuration, getFeaturedPaper, openFeaturedExample, loadOnboardingData } from './onboarding.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// This is the entry/wiring module: it imports every feature module, injects the
// cross-module dependencies each one needs via its set*Hooks() setter (kept as
// hooks to avoid import cycles), owns the "back to library" nav, and runs boot()
// to initialise storage + all the feature init*() listeners. All shared state
// lives in state.js; all real behaviour lives in the feature modules.

// ═══════════════════════════════════════════════════════
//  NAV: back to library
// ═══════════════════════════════════════════════════════
document.getElementById('new-btn').addEventListener('click', async () => {
  await maybeUpdateSummary(true);
  backToUpload();
});
function backToUpload() {
  cancelOnboardingPlacement();
  persistCurrentDoc();
  clearScheduledSummaryUpdate();
  setPdfDoc(null); clearDiscussions(); setActiveId(null); setPendingSel(null);
  setCurrentDocId(null); setCurrentMode(null);
  setConversationSummary(null); setSummaryMessageCount(0); setSummaryDirty(false);
  setReturnToDocId(null); setReturnToDocName(null);
  updateReturnButton();
  document.getElementById('pdf-pages').innerHTML='';
  document.getElementById('pdf-pages').style.display='none';
  document.getElementById('web-reader').style.display='none';
  document.getElementById('article-body').innerHTML='';
  document.getElementById('article-heading').textContent='';
  document.getElementById('article-source-url').innerHTML='';
  document.getElementById('main-app').style.display='none';
  document.getElementById('url-input').value='';
  document.getElementById('pdf-input').value='';
  document.getElementById('upload-screen').style.display='flex';
  showList();
  renderLibrary();
}


setPersistenceHooks({
  onCloudSaveError: () => updateAuthBar(PaperStore.getSyncStatus()),
  onAfterSummaryPersist: () => renderLibrary(),
});

setLibraryHooks({
  loadWebPage,
  loadArxivPdf,
  startApp,
  setStatus,
  renderFromBuffer,
  restoreHighlightsForLoadedPages,
  renderList,
  showList,
  parseArxivId,
  getFeaturedPaper,
  openFeaturedExample,
  backToUpload,
});

setPdfHooks({
  startApp,
  setStatus,
  showViewer,
  renderList,
  extractReferencesSection,
  buildPaperReferences,
  ensureCitationFormat,
  paintHighlight,
});

setWebLoaderHooks({
  renderList,
  paintHighlight,
  ensureCitationFormat,
  logCitation,
  maybeApplyOnboardingCuration,
  finishCitationNavigation,
  cancelOnboardingPlacement,
  backToUpload,
});

setCitationResolveHooks({
  findNearbyContext,
});

setSelectionHooks({
  openChat,
  sendMessage,
  paintHighlight,
  renderList,
});

setFigureHooks({
  openChat,
  paintHighlight,
});

setChatHooks({
  runOnboardingDemo,
});

(async function boot() {
  initStorage();
  initLibrary();
  initPdf();
  initWebLoader();
  initSelection();
  initFigure();
  initChat();
  const info = await PaperStore.init();
  updateAuthBar(info);
  await loadOnboardingData();
  renderLibrary();
  renderReadLater();
  renderList();
  // Everyone — logged in or not — lands on the upload/library page. The
  // annotated Transformer example is available to all via the explore button.
  updateLogoutFab();
})();
