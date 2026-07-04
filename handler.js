// Shared proxy logic. Routes highlight chat to Sonnet and cheap tasks to Haiku.
// Used by dev-server.js (local) and api/chat.js (Vercel).

const DEFAULT_CHAT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5';

// Caller-influenced limits for the chat proxy. Until per-user auth/rate limiting
// lands, these cap the per-request cost an unauthenticated caller can drive:
// pin the model to the two the app actually uses, ceiling the output tokens, and
// bound total payload size. Input can be large by design — the full paper (up to
// MAX_PAPER_CHARS ~600k chars) rides in the cached system block — so the size
// cap is deliberately generous.
const ALLOWED_MODELS = new Set([DEFAULT_CHAT_MODEL, DEFAULT_HAIKU_MODEL]);
const MAX_OUTPUT_TOKENS = 4096;
const MAX_REQUEST_CHARS = 2000000;

// Global daily circuit-breaker for total model calls. Serverless functions are
// stateless, so the counter lives in Supabase (a single row per day, bumped via
// an atomic RPC) and is shared across every invocation. It's a coarse cost cap —
// per-IP throttling is handled at the edge (Cloudflare); this stops a runaway
// total from any source. Disabled (fail-open) when Supabase isn't configured, so
// local dev and Supabase-less deploys are unaffected. Uses the SERVICE ROLE key,
// which is server-only and never sent to the browser.
async function overGlobalCeiling() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return false; // not configured → ceiling disabled
  const limit = Number(process.env.DAILY_REQUEST_LIMIT) || 2000;
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/bump_api_usage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ p_amount: 1 }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return false; // counter error → fail open (edge rules still apply)
    const count = Number(await r.json());
    return Number.isFinite(count) && count > limit;
  } catch {
    return false; // never let the counter itself take the app down
  }
}

async function callAnthropic(body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { status: 500, json: { error: 'ANTHROPIC_API_KEY not set on the server.' } };
  }

  const { model, max_tokens, system, messages } = body || {};
  if (!Array.isArray(messages)) {
    return { status: 400, json: { error: 'Request must include a messages array.' } };
  }

  // Clamp caller-influenced fields (see limits above): pin the model to the
  // allow-list and ceiling the output tokens so the proxy can't be pushed into
  // an expensive request.
  const safeModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_CHAT_MODEL;
  const safeMaxTokens = Math.min(Math.max(1, Number(max_tokens) || 1000), MAX_OUTPUT_TOKENS);

  // `system` may be a plain string OR an array of content blocks. When the
  // frontend sends the full paper as its own block tagged with
  // cache_control: { type: 'ephemeral' }, Anthropic caches it so repeat
  // questions on the same paper bill cached input (~10% of normal). We pass
  // whatever structure we're given straight through.
  const payload = JSON.stringify({ model: safeModel, max_tokens: safeMaxTokens, system, messages });
  if (payload.length > MAX_REQUEST_CHARS) {
    return { status: 413, json: { error: 'Request too large.' } };
  }

  // Global daily ceiling: check + increment before spending on the model call.
  if (await overGlobalCeiling()) {
    return { status: 429, json: { error: 'Daily request limit reached. Please try again later.' } };
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: payload,
    });

    const data = await r.json();
    return { status: r.status, json: data };
  } catch (err) {
    return { status: 502, json: { error: 'Upstream request failed: ' + err.message } };
  }
}

function anthropicText(json) {
  return json.content?.[0]?.text?.trim() || '';
}

function parseJsonFromText(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) try { parsed = JSON.parse(m[0]); } catch (_) {}
  }
  return parsed;
}

function normalizeCitationMatch(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.isCitation === 'string') {
    parsed.isCitation = parsed.isCitation.toLowerCase() === 'true';
  }
  if (typeof parsed.isCitation !== 'boolean') return null;
  if (parsed.matchId != null && parsed.matchId !== 'null') {
    // Bibliography ids may be alphanumeric labels ([Vas17]), not just numbers.
    const raw = String(parsed.matchId).trim();
    const n = Number(raw);
    if (raw && !Number.isNaN(n)) parsed.matchId = n;
    else parsed.matchId = raw ? raw.slice(0, 40) : null;
  } else {
    parsed.matchId = null;
  }
  if (typeof parsed.confidence === 'string') parsed.confidence = Number(parsed.confidence);
  if (parsed.reason != null) parsed.reason = String(parsed.reason).slice(0, 200);
  return parsed;
}

function parseCitationMatchFromText(raw) {
  const parsed = normalizeCitationMatch(parseJsonFromText(raw));
  if (parsed) return parsed;

  const isCitation = raw.match(/"isCitation"\s*:\s*(true|false)/i);
  if (!isCitation) return null;
  const matchId = raw.match(/"matchId"\s*:\s*(?:"([^"]{1,40})"|(\d+)|null)/i);
  const confidence = raw.match(/"confidence"\s*:\s*([\d.]+)/);
  const reason = raw.match(/"reason"\s*:\s*"([^"]*)"/);
  return normalizeCitationMatch({
    isCitation: isCitation[1].toLowerCase() === 'true',
    matchId: matchId ? (matchId[2] != null ? Number(matchId[2]) : matchId[1]) : null,
    confidence: confidence ? Number(confidence[1]) : null,
    reason: reason ? reason[1] : null,
  });
}

function matchNumericCitation(selection, references) {
  const t = String(selection || '').trim();
  const patterns = [
    /^\[(\d{1,3})\]$/,
    /^\((\d{1,3})\)$/,
    /^\[(\d{1,3})\][\s,;.]?$/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const id = +m[1];
    if (references.some((r) => r.id === id)) {
      return { isCitation: true, matchId: id, confidence: 1, reason: 'numeric citation' };
    }
  }
  const embedded = t.match(/\[(\d{1,3})\]/);
  if (embedded) {
    const id = +embedded[1];
    if (references.some((r) => r.id === id)) {
      return { isCitation: true, matchId: id, confidence: 0.95, reason: 'bracket citation' };
    }
  }
  return null;
}

function authorTokensFromSelection(selection) {
  const t = String(selection || '').trim().replace(/^\(|\)$/g, '');
  const yearM = t.match(/,?\s*((19|20)\d{2}[a-z]?)\s*$/i);
  const yearStr = yearM ? yearM[1] : null;
  const authorPart = yearStr ? t.replace(/,?\s*(19|20)\d{2}[a-z]?\s*$/i, '').trim() : t;
  const tokens = authorPart
    .replace(/\s+et\s+al\.?/gi, '')
    .split(/\s*(?:&|and)\s*|\s*,\s*|\s*;\s*/i)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const parts = chunk.split(/\s+/).filter(Boolean);
      return (parts[parts.length - 1] || chunk).replace(/[.,;]+$/, '');
    })
    .filter((tok) => tok.length > 1);
  return { tokens, yearStr };
}

function isPlausibleAuthorPart(authorPart) {
  const t = String(authorPart || '').trim();
  if (!t || t.length > 100) return false;
  if (/^(see|cf|cited in|according to|e\.g\.|eg\.|in)\b/i.test(t)) return false;
  if (/\b(the|for|from|with|this|that|these|those|however|also)\b/i.test(t)) return false;
  return /[A-Z][A-Za-z\-']/.test(t);
}

function parseAuthorYearFromSelection(text) {
  const t = String(text || '').trim();
  if (!t) return null;

  const patterns = [
    /\(([^()]+?),\s*((?:19|20)\d{2}[a-z]?)\)/,
    /\b([A-Z][A-Za-z\-']+(?:\s+(?:et\s+al\.?|&\s+[A-Z][A-Za-z\-']+))*)\s*\(((?:19|20)\d{2}[a-z]?)\)/,
    /\b([A-Z][A-Za-z\-']+(?:\s+(?:et\s+al\.?|&\s+[A-Z][A-Za-z\-']+))*)\s*,\s*((?:19|20)\d{2}[a-z]?)\b/,
    /^([A-Z][A-Za-z\-']+(?:\s+(?:et\s+al\.?|&\s+[A-Z][A-Za-z\-']+))*)\s*,\s*((?:19|20)\d{2}[a-z]?)(?:\s|$|[.;])/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && isPlausibleAuthorPart(m[1])) {
      return { authorPart: m[1].trim(), yearStr: m[2] };
    }
  }
  return null;
}

function authorSearchTokens(authorPart) {
  const cleaned = String(authorPart || '')
    .replace(/\s+et\s+al\.?/gi, '')
    .trim();
  const chunks = cleaned.split(/\s*(?:&|and)\s*|\s*,\s*|\s*;\s*/i).filter(Boolean);
  const tokens = [];
  for (const chunk of chunks) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);
    const last = (parts[parts.length - 1] || chunk).replace(/[.,;]+$/, '');
    if (last.length > 1) tokens.push(last);
  }
  return [...new Set(tokens)];
}

function authorMatchRequirements(authorPart) {
  const hasEtAl = /\bet\s+al\.?/i.test(authorPart);
  const tokens = authorSearchTokens(authorPart);
  if (!tokens.length) return { required: [], optional: [] };
  if (hasEtAl) return { required: [tokens[0]], optional: tokens.slice(1) };
  if (/\s(?:&|and)\s/i.test(authorPart) || tokens.length > 1) {
    return { required: tokens, optional: [] };
  }
  return { required: [tokens[0]], optional: tokens.slice(1) };
}

function yearMatchesRef(refText, yearStr) {
  if (!yearStr) return true;
  const y = String(yearStr).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${y}\\b`).test(String(refText || ''));
}

function authorTokenInRef(refText, token) {
  const tok = String(token || '').toLowerCase();
  if (tok.length < 2) return false;
  const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (tok.length >= 3) return new RegExp(`\\b${escaped}\\b`, 'i').test(refText);
  return String(refText || '').toLowerCase().includes(tok);
}

function scoreRefForAuthorYear(refText, authorPart, yearStr) {
  if (!yearMatchesRef(refText, yearStr)) return 0;
  const { required, optional } = authorMatchRequirements(authorPart);
  if (!required.length) return 0;

  let score = 10;
  for (const token of required) {
    if (!authorTokenInRef(refText, token)) return 0;
    score += 20;
  }
  for (const token of optional) {
    if (authorTokenInRef(refText, token)) score += 5;
  }
  return score;
}

function findBestAuthorYearMatch(references, authorPart, yearStr) {
  const scored = [];
  for (const ref of references) {
    const score = scoreRefForAuthorYear(ref.text, authorPart, yearStr);
    if (score > 0) scored.push({ ref, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (second && best.score - second.score < 10) return null;

  return {
    isCitation: true,
    matchId: best.ref.id,
    confidence: !second || best.score - second.score >= 20 ? 0.94 : 0.88,
    reason: 'author-year match',
  };
}

function parsePartialAuthorYearFromSelection(text) {
  const t = String(text || '').trim();
  const patterns = [
    /\(([^()]+?),\s*((?:19|20)\d{0,2})\)?$/,
    /\b([A-Z][A-Za-z\-']+(?:\s+(?:et\s+al\.?|&\s+[A-Z][A-Za-z\-']+))*)\s*,\s*((?:19|20)\d{0,2})\s*\)?$/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m || !isPlausibleAuthorPart(m[1])) continue;
    const yearToken = m[2];
    if (/^(?:19|20)\d{2}[a-z]?$/.test(yearToken)) {
      return { authorPart: m[1].trim(), yearStr: yearToken, yearPrefix: null };
    }
    if (yearToken.length >= 2 && yearToken.length <= 3 && /^(?:19|20)\d*$/.test(yearToken)) {
      return { authorPart: m[1].trim(), yearStr: null, yearPrefix: yearToken };
    }
  }
  return null;
}

function findBestAuthorYearMatchByPrefix(references, authorPart, yearPrefix) {
  const prefix = String(yearPrefix || '').trim();
  if (!prefix || prefix.length < 2 || prefix.length > 3 || !/^(?:19|20)\d*$/.test(prefix)) return null;
  const scored = [];
  for (const ref of references) {
    const yearM = String(ref.text || '').match(/\b((?:19|20)\d{2}[a-z]?)\b/);
    if (!yearM || !yearM[1].startsWith(prefix)) continue;
    const score = scoreRefForAuthorYear(ref.text, authorPart, yearM[1]);
    if (score > 0) scored.push({ ref, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  if (second && best.score - second.score < 10) return null;
  return {
    isCitation: true,
    matchId: best.ref.id,
    confidence: !second || best.score - second.score >= 20 ? 0.9 : 0.84,
    reason: 'author-year prefix match',
  };
}

function refMatchesAuthorYear(refText, authorPart, yearStr) {
  return scoreRefForAuthorYear(refText, authorPart, yearStr) > 0;
}

function rankReferencesForSelection(selection, references) {
  const parsed = parseAuthorYearFromSelection(selection);
  if (!parsed) return references;
  const scored = references.map((ref) => ({
    ref,
    score: scoreRefForAuthorYear(ref.text, parsed.authorPart, parsed.yearStr),
  }));
  scored.sort((a, b) => b.score - a.score);
  const matched = scored.filter((s) => s.score > 0).map((s) => s.ref);
  const rest = scored.filter((s) => s.score === 0).map((s) => s.ref);
  return matched.length ? [...matched, ...rest] : references;
}

function matchAuthorCitationLocally(selection, references) {
  const parsed = parseAuthorYearFromSelection(selection);
  if (parsed) {
    const best = findBestAuthorYearMatch(references, parsed.authorPart, parsed.yearStr);
    if (best) return best;
  }

  const partialAy = parsePartialAuthorYearFromSelection(selection);
  if (partialAy) {
    if (partialAy.yearStr) {
      const best = findBestAuthorYearMatch(references, partialAy.authorPart, partialAy.yearStr);
      if (best) return best;
    } else if (partialAy.yearPrefix) {
      const best = findBestAuthorYearMatchByPrefix(references, partialAy.authorPart, partialAy.yearPrefix);
      if (best) return best;
    }
  }

  const t = String(selection || '').trim();
  const looseAy = t.match(/^([A-Z][A-Za-z\-']+(?:\s+(?:et\s+al\.?|&\s+[A-Z][A-Za-z\-']+))*)\s*,\s*((19|20)\d{2}[a-z]?)$/i);
  if (looseAy && isPlausibleAuthorPart(looseAy[1])) {
    const best = findBestAuthorYearMatch(references, looseAy[1].trim(), looseAy[2]);
    if (best) return best;
  }

  return null;
}

function fuzzyMatchCitation(selection, references) {
  const numeric = matchNumericCitation(selection, references);
  if (numeric) return numeric;

  const author = matchAuthorCitationLocally(selection, references);
  if (author) return author;

  const words = String(selection || '')
    .toLowerCase()
    .replace(/[^\w\s&]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  if (!words.length) {
    return { isCitation: false, matchId: null, confidence: 0.2, reason: 'not a citation' };
  }

  let best = null;
  let bestScore = 0;
  for (const ref of references) {
    const rt = (ref.text || '').toLowerCase();
    let score = 0;
    for (const w of words) if (rt.includes(w)) score++;
    if (score > bestScore) { bestScore = score; best = ref; }
  }
  if (best && bestScore >= 2 && words.some((w) => w.length >= 6) && bestScore >= words.length) {
    return {
      isCitation: true,
      matchId: best.id,
      confidence: 0.7,
      reason: 'fuzzy token match',
    };
  }
  return { isCitation: false, matchId: null, confidence: 0.3, reason: 'not a citation' };
}

async function callHaiku({ system, userContent, max_tokens = 400 }) {
  const result = await callAnthropic({
    model: DEFAULT_HAIKU_MODEL,
    max_tokens,
    system,
    messages: [{ role: 'user', content: userContent }],
  });
  if (result.status !== 200) return result;
  return { status: 200, text: anthropicText(result.json), raw: result.json };
}

async function callClassifySelection(body) {
  const sel = String(body?.selection || '').trim();
  if (!sel) return { status: 400, json: { error: 'classify-selection needs a selection.' } };

  const system =
    'You classify a short snippet a reader selected inside an academic paper. ' +
    'Reply with a single JSON object only — no markdown, no extra text: {"kind":"math"|"citation"|"other"}. ' +
    '"math": the selection is or centers on a mathematical formula, equation, or notation ' +
    '(operators, sub/superscripts, fractions, integrals/sums, Greek letters, LaTeX commands). ' +
    '"citation": the selection is an in-text reference pointing to another work, e.g. "[12]", ' +
    '"Vaswani et al., 2017", "(Smith & Lee, 2020)". ' +
    '"other": ordinary prose, a heading, or anything else. ' +
    'Choose the single best label. If a formula also contains author names, prefer "math".';

  const result = await callHaiku({ max_tokens: 20, system, userContent: sel.slice(0, 600) });

  console.info('[Classify] haiku', {
    selection: sel.slice(0, 160),
    status: result.status,
    rawResponse: result.text != null ? String(result.text) : null,
  });

  if (result.status !== 200) return result;

  const parsed = parseJsonFromText(result.text);
  let kind = parsed && typeof parsed.kind === 'string' ? parsed.kind.toLowerCase().trim() : '';
  if (!['math', 'citation', 'other'].includes(kind)) {
    // tolerate a bare word answer
    const m = String(result.text || '').toLowerCase().match(/math|citation|other/);
    kind = m ? m[0] : 'other';
  }
  return { status: 200, json: { kind } };
}

async function callCheapSummary(body) {
  const { text, max_tokens } = body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { status: 400, json: { error: 'Summarize requests must include a non-empty text field.' } };
  }

  const result = await callHaiku({
    max_tokens: max_tokens || 400,
    system:
      'You summarize a researcher\'s reading notes from a paper. ' +
      'Write 2–4 concise sentences covering: main topics discussed, key insights, ' +
      'and open questions. Plain prose, no bullet lists, no preamble.',
    userContent: text.slice(0, 12000),
  });

  if (result.status !== 200) return result;

  const summary = result.text;
  if (!summary) {
    return { status: 502, json: { error: 'Summary model returned an empty response.' } };
  }

  return { status: 200, json: { summary } };
}

async function callCitationMatch(body) {
  const { references, selection } = body || {};
  if (!selection || typeof selection !== 'string' || !selection.trim()) {
    return { status: 400, json: { error: 'Citation match needs a selection string.' } };
  }
  if (!Array.isArray(references) || !references.length) {
    return { status: 400, json: { error: 'Citation match needs a non-empty references array.' } };
  }

  const numeric = matchNumericCitation(selection, references);
  if (numeric) return { status: 200, json: numeric };

  const localAuthor = matchAuthorCitationLocally(selection, references);
  if (localAuthor) return { status: 200, json: localAuthor };

  const ranked = rankReferencesForSelection(selection, references);
  const refLines = ranked.slice(0, 120).map((r) => {
    const id = r.id != null ? r.id : r.n;
    const text = String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    return `[${id}] ${text}`;
  }).join('\n');

  // Step 1 is pure key→bibliography matching: send only the selected citation
  // key (slightly padded by the client) and the bibliography — no surrounding
  // passage, which is noise here and only matters for the step-2 relevance call.
  const prompt =
    `Selected citation key (may be partial): ${selection.trim().slice(0, 200)}\n\n` +
    `Bibliography (${references.length} entries; relevant matches listed first):\n${refLines}`;

  const haikuSystem =
    'Match a selected in-text citation to one entry in the paper\'s bibliography. ' +
    'The selection is just the citation key and may be incomplete (e.g. "Casper et al., 2024" or "[12"). ' +
    'Reply with a single JSON object only — no markdown fences, no extra text. ' +
    '{"isCitation":boolean,"matchId":number|string|null,"confidence":0-1,"reason":"brief"}. ' +
    'matchId is the [id] from the bibliography list. Keep reason under 80 characters. ' +
    'Match on author surname(s) + year for author-year keys, the number for numeric keys, ' +
    'or the exact bracket label (e.g. Vas17) for alphanumeric keys. ' +
    'Search the FULL list (relevant entries are listed first). Return matchId when found; ' +
    'use null only if the key truly has no matching bibliography entry.';

  console.info('[CitationLookup] haiku-prompt · match', {
    selection: selection.trim().slice(0, 200),
    refCount: references.length,
    refsSent: Math.min(120, ranked.length),
    system: haikuSystem,
    userContent: prompt,
  });

  const result = await callHaiku({
    max_tokens: 200,
    system: haikuSystem,
    userContent: prompt,
  });

  console.info('[CitationLookup] haiku-response · match', {
    status: result.status,
    rawResponse: result.text != null ? String(result.text) : null,
  });

  if (result.status !== 200) {
    const fallback = fuzzyMatchCitation(selection, references);
    if (fallback.isCitation) return { status: 200, json: fallback };
    return result;
  }

  const parsed = parseCitationMatchFromText(result.text);
  if (!parsed) {
    const fallback = fuzzyMatchCitation(selection, references);
    return { status: 200, json: fallback };
  }

  const debug = {
    system: haikuSystem,
    userContent: prompt,
    rawResponse: result.text ? String(result.text).slice(0, 500) : null,
    haikuMatchId: parsed.matchId,
  };

  // Trust Haiku. No verifier: if it returns an index that exists in the
  // bibliography, use it directly (lookup by index).
  const matchId = parsed.matchId != null ? parsed.matchId : null;
  const inBib = matchId != null && references.some((r) => r.id == matchId);

  return {
    status: 200,
    json: {
      isCitation: !!parsed.isCitation && inBib,
      matchId: inBib ? matchId : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
      reason: inBib ? (parsed.reason || 'haiku match') : (parsed.reason || 'no bibliography match'),
      _debug: debug,
    },
  };
}

async function callCitationPreview(body) {
  const { parentTitle, parentExcerpt, citationText, citedTitle, citedText, citedTextKind } = body || {};
  if (!citedText || typeof citedText !== 'string' || !citedText.trim()) {
    return { status: 400, json: { error: 'Citation preview needs cited paper text (abstract or bibliography entry).' } };
  }

  const fromBib = citedTextKind === 'bibliography-entry';
  const sourceLabel = fromBib ? 'Bibliography entry (no abstract available)' : 'Abstract / excerpt';

  const prompt =
    `Paper being read: ${parentTitle || 'Unknown'}\n` +
    (parentExcerpt ? `Relevant passage:\n${parentExcerpt.slice(0, 2500)}\n\n` : '') +
    `Selected citation: ${citationText || ''}\n\n` +
    `Cited paper: ${citedTitle || 'Unknown'}\n` +
    `${sourceLabel}:\n${citedText.slice(0, 6000)}`;

  const previewSystem =
    'A researcher selected a citation while reading a paper. ' +
    'Give 2–4 key takeaways from the CITED paper that are relevant to the article they are reading — ' +
    'focus on findings, methods, or claims from the cited work that matter for the surrounding passage. ' +
    'Each takeaway must be one short, specific sentence. Do not summarize the article being read; ' +
    'summarize the cited paper as it pertains to the passage. ' +
    'When only a bibliography entry is provided (no abstract), infer takeaways from the title and ' +
    'be appropriately tentative; do not invent specific results you cannot support. ' +
    'Reply with a single JSON object only — no markdown fences. ' +
    '{"preview":"• takeaway one\\n• takeaway two","sufficient":boolean,"reason":"brief"}. ' +
    'The preview field is the takeaways as a bullet list, each line starting with "• " and separated by newlines. ' +
    'Set sufficient=false only if you cannot say anything useful even from the title.';

  console.info('[CitationLookup] haiku-prompt · preview', {
    model: DEFAULT_HAIKU_MODEL,
    citationText: String(citationText || '').slice(0, 200),
    citedTitle: String(citedTitle || '').slice(0, 200),
    citedTextKind: citedTextKind || 'abstract',
    system: previewSystem,
    userContent: prompt,
  });

  const result = await callHaiku({
    max_tokens: 220,
    system: previewSystem,
    userContent: prompt,
  });

  console.info('[CitationLookup] haiku-response · preview', {
    status: result.status,
    rawResponse: result.text != null ? String(result.text) : null,
  });

  if (result.status !== 200) return result;

  const parsed = parseJsonFromText(result.text);
  const preview = parsed?.preview?.trim() || result.text;
  if (!preview) {
    return { status: 502, json: { error: 'Preview model returned an empty response.' } };
  }

  return {
    status: 200,
    json: {
      preview,
      sufficient: parsed?.sufficient !== false,
      reason: parsed?.reason || null,
      source: 'haiku',
      _debug: {
        model: DEFAULT_HAIKU_MODEL,
        system: previewSystem,
        userContent: prompt,
        rawResponse: result.text ? String(result.text).slice(0, 600) : null,
      },
    },
  };
}

async function callCitationPreviewClaude(body) {
  const { parentTitle, parentExcerpt, citationText, citedTitle, citedText, citedTextKind } = body || {};
  if (!citedText || typeof citedText !== 'string' || !citedText.trim()) {
    return { status: 400, json: { error: 'Citation preview needs cited paper text.' } };
  }

  const fromBib = citedTextKind === 'bibliography-entry';
  const sourceLabel = fromBib ? 'Bibliography entry (no abstract available)' : 'Abstract / excerpt';

  const userPrompt =
    `Paper being read: ${parentTitle || 'Unknown'}\n` +
    (parentExcerpt ? `Relevant passage:\n${parentExcerpt.slice(0, 3000)}\n\n` : '') +
    `Selected citation: ${citationText || ''}\n\n` +
    `Cited paper: ${citedTitle || 'Unknown'}\n` +
    `${sourceLabel}:\n${citedText.slice(0, 8000)}\n\n` +
    (fromBib
      ? `Only the bibliography entry is available. Infer 2–4 key takeaways from the cited paper's title that are relevant to the passage, staying appropriately tentative.`
      : `Give 2–4 key takeaways from the cited paper that are relevant to the passage — focus on the cited work's findings, methods, or claims that matter here.`) +
    ` Each takeaway is one short, specific sentence on its own line starting with "• ". No preamble, no closing remarks.`;

  const previewSystem =
    'You help a researcher understand citations while reading a paper. ' +
    'Summarize the cited work as a short bullet list of key takeaways relevant to the passage. ' +
    'Be specific and concise; do not summarize the article being read.';

  console.info('[CitationLookup] sonnet-prompt · preview', {
    model: DEFAULT_CHAT_MODEL,
    citationText: String(citationText || '').slice(0, 200),
    citedTitle: String(citedTitle || '').slice(0, 200),
    citedTextKind: citedTextKind || 'abstract',
    system: previewSystem,
    userContent: userPrompt,
  });

  const result = await callAnthropic({
    model: DEFAULT_CHAT_MODEL,
    max_tokens: 220,
    system: previewSystem,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const previewText = result.status === 200 ? anthropicText(result.json) : null;
  console.info('[CitationLookup] sonnet-response · preview', {
    status: result.status,
    rawResponse: previewText != null ? String(previewText) : null,
  });

  if (result.status !== 200) return result;

  const preview = previewText;
  if (!preview) {
    return { status: 502, json: { error: 'Claude returned an empty citation preview.' } };
  }

  return {
    status: 200,
    json: {
      preview,
      sufficient: true,
      source: 'sonnet',
      _debug: {
        model: DEFAULT_CHAT_MODEL,
        system: previewSystem,
        userContent: userPrompt,
        rawResponse: preview ? String(preview).slice(0, 600) : null,
      },
    },
  };
}

function validateCitationPatterns(patterns) {
  if (!Array.isArray(patterns)) return [];
  const out = [];
  for (const p of patterns.slice(0, 6)) {
    if (!p?.regex || typeof p.regex !== 'string' || p.regex.length > 200) continue;
    const flags = String(p.flags || '').replace(/[^gimsuy]/g, '').slice(0, 5);
    try {
      new RegExp(p.regex, flags);
      out.push({
        name: String(p.name || 'pattern').slice(0, 40),
        regex: p.regex,
        flags,
        matchType: ['numeric-id', 'author-year', 'label-id', 'unknown'].includes(p.matchType) ? p.matchType : 'unknown',
        idGroup: p.idGroup != null ? Number(p.idGroup) : 1,
        authorGroup: p.authorGroup != null ? Number(p.authorGroup) : 1,
        yearGroup: p.yearGroup != null ? Number(p.yearGroup) : 2,
      });
    } catch (_) {}
  }
  return out;
}

function validateRefEntryPattern(p) {
  if (!p?.regex || typeof p.regex !== 'string' || p.regex.length > 300) return null;
  let flags = String(p.flags || '').replace(/[^gimsuy]/g, '');
  if (!flags.includes('g')) flags += 'g';
  if (!flags.includes('m')) flags += 'm';
  try {
    new RegExp(p.regex, flags);
  } catch (_) { return null; }
  const labelGroup = p.labelGroup != null && !Number.isNaN(Number(p.labelGroup)) ? Number(p.labelGroup) : 1;
  return { regex: p.regex, flags, labelGroup };
}

function parseCitationFormatFromText(raw) {
  if (!raw) return null;
  let parsed = parseJsonFromText(raw);
  if (parsed?.patterns) {
    if (typeof parsed.patterns === 'string') {
      try { parsed.patterns = JSON.parse(parsed.patterns); } catch (_) {}
    }
    if (Array.isArray(parsed.patterns)) return parsed;
  }

  const patternsBlock = raw.match(/"patterns"\s*:\s*(\[[\s\S]*?\])\s*(?:,\s*"examples"|,\s*"style"|\})/i);
  if (patternsBlock) {
    try {
      const patterns = JSON.parse(patternsBlock[1]);
      if (Array.isArray(patterns)) {
        const styleM = raw.match(/"style"\s*:\s*"([^"]*)"/);
        return {
          style: styleM ? styleM[1] : 'inferred',
          description: null,
          patterns,
          examples: [],
        };
      }
    } catch (_) {}
  }
  return null;
}

function inferDefaultCitationPatterns(examples) {
  const ex = Array.isArray(examples) ? examples : [];
  const patterns = [];
  const hasBracket = ex.some((e) => /\[\d{1,3}\]/.test(String(e)));
  const hasAuthorYear = ex.some((e) => /\([^()]{2,80},\s*(19|20)\d{2}/.test(String(e)));
  const hasAlphaLabel = ex.some((e) => /\[[A-Za-z][A-Za-z0-9+\-]{1,15}\]/.test(String(e)));

  if (hasAlphaLabel) {
    patterns.push({
      name: 'alpha-bracket',
      regex: '\\[([A-Za-z][A-Za-z0-9+\\-]{1,15})\\]',
      flags: '',
      matchType: 'label-id',
      idGroup: 1,
      authorGroup: 1,
      yearGroup: 2,
    });
  }
  if (hasBracket || !ex.length) {
    patterns.push({
      name: 'numeric-bracket',
      regex: '\\[(\\d{1,3})\\]',
      flags: '',
      matchType: 'numeric-id',
      idGroup: 1,
      authorGroup: 1,
      yearGroup: 2,
    });
  }
  if (hasAuthorYear || !ex.length) {
    patterns.push({
      name: 'author-year-paren',
      regex: '\\(([^()]{2,100}),\\s*((19|20)\\d{2}[a-z]?)\\)',
      flags: '',
      matchType: 'author-year',
      idGroup: 1,
      authorGroup: 1,
      yearGroup: 2,
    });
  }
  return patterns;
}

function buildCitationFormatResponse(parsed, examples, refCount, source) {
  const patterns = validateCitationPatterns(parsed?.patterns || []);
  const fallback = patterns.length ? patterns : validateCitationPatterns(inferDefaultCitationPatterns(examples));
  if (!fallback.length) return null;

  return {
    style: parsed?.style ? String(parsed.style).slice(0, 80) : (source === 'fallback' ? 'default' : 'unknown'),
    description: parsed?.description ? String(parsed.description).slice(0, 200) : null,
    patterns: fallback,
    refEntryPattern: validateRefEntryPattern(parsed?.refEntryPattern),
    examples: Array.isArray(parsed?.examples) ? parsed.examples.slice(0, 8).map(String) : (examples || []).slice(0, 8),
    refCount: refCount || null,
    learnedAt: Date.now(),
    source: source || 'haiku',
  };
}

async function callCitationFormatDetect(body) {
  const { bodySample, refSample, inTextExamples, bibSample, refCount } = body || {};
  if (!bodySample || typeof bodySample !== 'string') {
    return { status: 400, json: { error: 'Citation format detect needs bodySample text.' } };
  }

  const examples = Array.isArray(inTextExamples) ? inTextExamples.slice(0, 10) : [];
  const prompt =
    `In-text citation examples found in this paper:\n${examples.join('\n') || '(none auto-detected)'}\n\n` +
    `Main text sample:\n${bodySample.slice(0, 4500)}\n\n` +
    (refSample ? `References section sample:\n${refSample.slice(0, 2500)}\n\n` : '') +
    (bibSample ? `Parsed bibliography entries:\n${bibSample.slice(0, 2000)}\n\n` : '') +
    `Bibliography entry count: ${refCount || 'unknown'}`;

  const result = await callHaiku({
    max_tokens: 700,
    system:
      'Analyze how this academic paper formats in-text citations. ' +
      'Reply with ONLY valid JSON (no markdown, no commentary). ' +
      'Schema: {"style":"label","description":"one sentence","patterns":[{"name":"...","regex":"...","flags":"","matchType":"numeric-id|author-year|label-id","idGroup":1,"authorGroup":1,"yearGroup":2}],"examples":["..."]}. ' +
      'patterns: 1-3 entries. regex: JavaScript syntax, double-backslash escapes, max 100 chars. ' +
      'numeric-id for [12] style. author-year for (Author, 2020) style. ' +
      'label-id for alphanumeric bracket labels like [Vas17] or [BLM+20]; idGroup captures the label. ' +
      'idGroup/authorGroup/yearGroup are capture group numbers. ' +
      'If the bibliography entry count is 0 or the parsed entries look wrong, ALSO return ' +
      '"refEntryPattern":{"regex":"...","flags":"gm","labelGroup":1} — a regex matching the start of each entry ' +
      'in the references section sample, capturing its label (labelGroup 0 if entries are unlabeled).',
    userContent: prompt,
  });

  if (result.status !== 200) {
    const fallback = buildCitationFormatResponse(null, examples, refCount, 'fallback');
    if (fallback) return { status: 200, json: fallback };
    return result;
  }

  const parsed = parseCitationFormatFromText(result.text);
  const response = buildCitationFormatResponse(parsed, examples, refCount, parsed ? 'haiku' : 'fallback');
  if (!response) {
    return { status: 502, json: { error: 'Could not infer citation format patterns.' } };
  }

  return { status: 200, json: response };
}

async function callCitationDetect(body) {
  const { text } = body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { status: 400, json: { error: 'Citation detect requests must include a non-empty text field.' } };
  }

  const result = await callHaiku({
    max_tokens: 120,
    system:
      'Classify whether a text selection from an academic paper is a bibliographic citation. ' +
      'Reply with JSON only: {"isCitation":boolean,"authors":["LastName1","LastName2"],' +
      '"year":"2024","searchQuery":"Author1 Author2 2024","kind":"author-year|numeric|doi|url|other"}. ' +
      'Examples: "(Marshall & Kirchner, 2024)" → isCitation true, authors ["Marshall","Kirchner"], year "2024", ' +
      'searchQuery "Marshall Kirchner 2024", kind "author-year". ' +
      '"[12]" → isCitation true, kind "numeric". ' +
      'Normal prose sentences → isCitation false, empty authors, kind "other".',
    userContent: text.trim().slice(0, 500),
  });

  if (result.status !== 200) return result;

  const parsed = parseJsonFromText(result.text);
  if (!parsed || typeof parsed.isCitation !== 'boolean') {
    return { status: 502, json: { error: 'Citation detect returned invalid JSON.' } };
  }

  return {
    status: 200,
    json: {
      isCitation: !!parsed.isCitation,
      authors: Array.isArray(parsed.authors) ? parsed.authors.filter(Boolean) : [],
      year: parsed.year ? String(parsed.year) : null,
      searchQuery: parsed.searchQuery ? String(parsed.searchQuery).slice(0, 160) : null,
      kind: parsed.kind || 'other',
    },
  };
}

async function handleChatRequest(body) {
  if (body?.task === 'classify-selection') return callClassifySelection(body);
  if (body?.task === 'summarize') return callCheapSummary(body);
  if (body?.task === 'citation-match') return callCitationMatch(body);
  if (body?.task === 'citation-preview') return callCitationPreview(body);
  if (body?.task === 'citation-preview-claude') return callCitationPreviewClaude(body);
  if (body?.task === 'citation-detect') return callCitationDetect(body);
  if (body?.task === 'citation-format-detect') return callCitationFormatDetect(body);
  return callAnthropic(body);
}

// ── SSRF guard ──────────────────────────────────────────────────────────────
// The fetch proxies take a caller-supplied URL, so they must never be usable to
// reach loopback, link-local (incl. the cloud metadata endpoint 169.254.169.254),
// or private networks. Node's WHATWG URL parser normalizes IPv4 in decimal/hex/
// octal forms to dotted-decimal, so we validate the normalized host; for real
// hostnames we also check the addresses they resolve to (a name can point at an
// internal IP). Redirects are followed manually and each hop is re-validated so
// a public URL can't 30x into an internal one.

const dnsPromises = require('dns').promises;
let dnsLookup = (host) => dnsPromises.lookup(host, { all: true });
// Test seam: inject a fake resolver so URL-guard tests stay hermetic (no network).
function _setDnsLookup(fn) { dnsLookup = fn; }

function ipv4Octets(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = [m[1], m[2], m[3], m[4]].map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

function isPrivateIPv4(o) {
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true;   // this-net, private, loopback
  if (a === 169 && b === 254) return true;             // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;    // private
  if (a === 192 && b === 168) return true;             // private
  if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT 100.64/10
  if (a >= 224) return true;                           // multicast + reserved
  return false;
}

function isPrivateIPv6(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '::1' || h === '::') return true;          // loopback / unspecified
  if (/^f[cd]/.test(h)) return true;                   // unique-local fc00::/7
  if (/^fe[89ab]/.test(h)) return true;                // link-local fe80::/10
  let m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);     // IPv4-mapped, dotted
  if (m) { const o = ipv4Octets(m[1]); return o ? isPrivateIPv4(o) : true; }
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h); // IPv4-mapped, hextet
  if (m) {
    const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
    return isPrivateIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  return false;
}

function isPrivateAddress(addr) {
  const host = String(addr || '').replace(/^\[|\]$/g, '');
  const o = ipv4Octets(host);
  if (o) return isPrivateIPv4(o);
  if (host.includes(':')) return isPrivateIPv6(host);
  return true; // unrecognized numeric form → treat as unsafe
}

function isBlockedHostname(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost')
      || h.endsWith('.local') || h.endsWith('.internal');
}

function isIpLiteral(host) {
  const h = host.replace(/^\[|\]$/g, '');
  return !!ipv4Octets(h) || h.includes(':');
}

// Synchronous structural check (no DNS): protocol, blocked names, private IP
// literals. Real hostnames pass here and get the DNS check in assertUrlPublic.
function isFetchUrlAllowed(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  if (isBlockedHostname(host)) return false;
  if (isIpLiteral(host)) return !isPrivateAddress(host);
  return true;
}

// Full async check run on every fetch hop: structural + DNS resolution, so a
// hostname pointing at an internal address is caught too.
async function assertUrlPublic(rawUrl) {
  if (!isFetchUrlAllowed(rawUrl)) { const e = new Error('Blocked or invalid URL'); e.ssrf = true; throw e; }
  const host = new URL(rawUrl).hostname.toLowerCase();
  if (isIpLiteral(host)) return;
  let addrs;
  try { addrs = await dnsLookup(host.replace(/^\[|\]$/g, '')); }
  catch { const e = new Error('DNS resolution failed'); e.ssrf = true; throw e; }
  for (const a of (addrs || [])) {
    if (isPrivateAddress(a.address)) { const e = new Error('URL resolves to a private address'); e.ssrf = true; throw e; }
  }
}

// fetch() that follows redirects manually, re-validating each hop so a public
// URL cannot redirect into an internal one.
async function safeFetch(rawUrl, opts = {}, maxRedirects = 4) {
  let current = rawUrl;
  for (let hop = 0; ; hop++) {
    await assertUrlPublic(current);
    const r = await fetch(current, { ...opts, redirect: 'manual' });
    const redirecting = r.status >= 300 && r.status < 400;
    const loc = redirecting && r.headers ? (r.headers.get('location') || r.headers.get('Location')) : null;
    if (!loc) return r;
    if (hop >= maxRedirects) { const e = new Error('Too many redirects'); e.ssrf = true; throw e; }
    current = new URL(loc, current).toString();
  }
}

async function handleFetchRequest(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url || !isFetchUrlAllowed(url)) {
    return { status: 400, json: { error: 'Invalid or disallowed URL.' } };
  }

  try {
    const r = await safeFetch(url, {
      headers: {
        'User-Agent': 'PaperReader/1.0 (research tool)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) {
      return { status: 502, json: { error: `Upstream HTTP ${r.status}` } };
    }
    const html = await r.text();
    if (!html || html.length < 100) {
      return { status: 502, json: { error: 'Upstream returned empty content.' } };
    }
    return { status: 200, json: { html, finalUrl: r.url } };
  } catch (err) {
    return { status: 502, json: { error: 'Fetch failed: ' + err.message } };
  }
}

async function handleFetchPdfRequest(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url || !isFetchUrlAllowed(url)) {
    return { status: 400, json: { error: 'Invalid or disallowed URL.' } };
  }

  try {
    const r = await safeFetch(url, {
      headers: {
        'User-Agent': 'PaperReader/1.0 (research tool)',
        'Accept': 'application/pdf,*/*',
      },
      signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      return { status: 502, json: { error: `Upstream HTTP ${r.status}` } };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 100) {
      return { status: 502, json: { error: 'Upstream returned empty PDF.' } };
    }
    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('application/pdf') && !/\.pdf(\?|$)/i.test(url)) {
      return { status: 502, json: { error: 'URL did not return a PDF.' } };
    }
    return {
      status: 200,
      body: buf,
      contentType: 'application/pdf',
      finalUrl: r.url,
    };
  } catch (err) {
    return { status: 502, json: { error: 'PDF fetch failed: ' + err.message } };
  }
}

async function handleFetchImageRequest(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url || !isFetchUrlAllowed(url)) {
    return { status: 400, json: { error: 'Invalid or disallowed URL.' } };
  }

  try {
    const r = await safeFetch(url, {
      headers: {
        'User-Agent': 'PaperReader/1.0 (research tool)',
        'Accept': 'image/*,*/*',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) {
      return { status: 502, json: { error: `Upstream HTTP ${r.status}` } };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 64) {
      return { status: 502, json: { error: 'Upstream returned empty image.' } };
    }
    const contentType = (r.headers.get('content-type') || '').split(';')[0].trim();
    const looksLikeImage = /^image\//i.test(contentType)
      || /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|$)/i.test(url);
    if (!looksLikeImage) {
      return { status: 502, json: { error: 'URL did not return an image.' } };
    }
    return {
      status: 200,
      body: buf,
      contentType: contentType || 'image/png',
      finalUrl: r.url,
    };
  } catch (err) {
    return { status: 502, json: { error: 'Image fetch failed: ' + err.message } };
  }
}

module.exports = {
  callAnthropic,
  callCheapSummary,
  callCitationMatch,
  callCitationPreview,
  callCitationPreviewClaude,
  callCitationDetect,
  callCitationFormatDetect,
  handleChatRequest,
  handleFetchRequest,
  handleFetchPdfRequest,
  handleFetchImageRequest,
  // SSRF guard internals (exported for tests).
  isFetchUrlAllowed,
  isPrivateAddress,
  assertUrlPublic,
  safeFetch,
  _setDnsLookup,
};
