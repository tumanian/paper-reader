// Shared proxy logic. Routes chat to Anthropic and conversation summaries to a
// cheaper model (Groq). Used by dev-server.js (local) and api/chat.js (Vercel).

const DEFAULT_CHAT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_SUMMARY_MODEL = 'llama-3.1-8b-instant';

async function callAnthropic(body) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { status: 500, json: { error: 'ANTHROPIC_API_KEY not set on the server.' } };
  }

  const { model, max_tokens, system, messages } = body || {};
  if (!Array.isArray(messages)) {
    return { status: 400, json: { error: 'Request must include a messages array.' } };
  }

  // `system` may be a plain string OR an array of content blocks. When the
  // frontend sends the full paper as its own block tagged with
  // cache_control: { type: 'ephemeral' }, Anthropic caches it so repeat
  // questions on the same paper bill cached input (~10% of normal). We pass
  // whatever structure we're given straight through.
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      model      || DEFAULT_CHAT_MODEL,
        max_tokens: max_tokens || 1000,
        system,
        messages,
      }),
    });

    const data = await r.json();
    return { status: r.status, json: data };
  } catch (err) {
    return { status: 502, json: { error: 'Upstream request failed: ' + err.message } };
  }
}

async function callCheapSummary(body) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { status: 500, json: { error: 'GROQ_API_KEY not set on the server.' } };
  }

  const { text, model, max_tokens } = body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { status: 400, json: { error: 'Summarize requests must include a non-empty text field.' } };
  }

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || DEFAULT_SUMMARY_MODEL,
        max_tokens: max_tokens || 400,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content:
              'You summarize a researcher\'s reading notes from a paper. ' +
              'Write 2–4 concise sentences covering: main topics discussed, key insights, ' +
              'and open questions. Plain prose, no bullet lists, no preamble.',
          },
          { role: 'user', content: text.slice(0, 12000) },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = data?.error?.message || data?.error || 'Summary request failed.';
      return { status: r.status, json: { error: msg } };
    }

    const summary = data.choices?.[0]?.message?.content?.trim() || '';
    if (!summary) {
      return { status: 502, json: { error: 'Summary model returned an empty response.' } };
    }

    return { status: 200, json: { summary } };
  } catch (err) {
    return { status: 502, json: { error: 'Summary upstream failed: ' + err.message } };
  }
}

async function callCitationMatch(body) {
  const { references, selection, passage } = body || {};
  if (!selection || typeof selection !== 'string' || !selection.trim()) {
    return { status: 400, json: { error: 'Citation match needs a selection string.' } };
  }
  if (!Array.isArray(references) || !references.length) {
    return { status: 400, json: { error: 'Citation match needs a non-empty references array.' } };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { status: 500, json: { error: 'GROQ_API_KEY not set on the server.' } };
  }

  const refLines = references.slice(0, 80).map((r) => {
    const id = r.id != null ? r.id : r.n;
    const text = String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    return `[${id}] ${text}`;
  }).join('\n');

  const prompt =
    `Selected text (may be partial): ${selection.trim().slice(0, 300)}\n\n` +
    (passage ? `Surrounding passage from the paper being read:\n${passage.slice(0, 2000)}\n\n` : '') +
    `Bibliography of the paper being read:\n${refLines}`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEFAULT_SUMMARY_MODEL,
        max_tokens: 120,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Match a text selection to one bibliography entry from the paper being read. ' +
              'The selection may be incomplete (e.g. "(Marshall & Kirch" or "[12"). ' +
              'Reply JSON only: {"isCitation":boolean,"matchId":number|null,"confidence":0-1,"reason":"..."}. ' +
              'matchId is the [id] from the bibliography list. ' +
              'If the selection is normal prose, not a citation, isCitation=false and matchId=null.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = data?.error?.message || data?.error || 'Citation match failed.';
      return { status: r.status, json: { error: msg } };
    }

    const raw = data.choices?.[0]?.message?.content?.trim() || '';
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch (_) {}
    }
    if (!parsed || typeof parsed.isCitation !== 'boolean') {
      return { status: 502, json: { error: 'Citation match returned invalid JSON.' } };
    }

    return {
      status: 200,
      json: {
        isCitation: !!parsed.isCitation,
        matchId: parsed.matchId != null ? Number(parsed.matchId) : null,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
        reason: parsed.reason ? String(parsed.reason).slice(0, 200) : null,
      },
    };
  } catch (err) {
    return { status: 502, json: { error: 'Citation match upstream failed: ' + err.message } };
  }
}

async function callCitationPreview(body) {
  const { parentTitle, parentExcerpt, citationText, citedTitle, citedText } = body || {};
  if (!citedText || typeof citedText !== 'string' || !citedText.trim()) {
    return { status: 400, json: { error: 'Citation preview needs cited paper text (abstract or excerpt).' } };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      status: 200,
      json: {
        preview: citedText.trim().slice(0, 420),
        sufficient: false,
        source: 'abstract',
      },
    };
  }

  const prompt =
    `Paper being read: ${parentTitle || 'Unknown'}\n` +
    (parentExcerpt ? `Relevant passage:\n${parentExcerpt.slice(0, 2500)}\n\n` : '') +
    `Selected citation: ${citationText || ''}\n\n` +
    `Cited paper: ${citedTitle || 'Unknown'}\n` +
    `Abstract / excerpt:\n${citedText.slice(0, 6000)}`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEFAULT_SUMMARY_MODEL,
        max_tokens: 220,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'A researcher selected a citation while reading a paper. ' +
              'Write a 2–3 sentence summary of the cited paper\'s main idea and why it matters for the passage they are reading. ' +
              'Reply JSON only: {"preview":"...","sufficient":boolean,"reason":"..."}. ' +
              'Set sufficient=false if the abstract is missing/too vague, unrelated to the passage, or you cannot explain relevance confidently.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = data?.error?.message || data?.error || 'Citation preview failed.';
      return { status: r.status, json: { error: msg } };
    }

    const raw = data.choices?.[0]?.message?.content?.trim() || '';
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch (_) {}
    }
    const preview = parsed?.preview?.trim() || raw;
    if (!preview) {
      return { status: 502, json: { error: 'Preview model returned an empty response.' } };
    }

    return {
      status: 200,
      json: {
        preview,
        sufficient: parsed?.sufficient !== false,
        reason: parsed?.reason || null,
        source: 'groq',
      },
    };
  } catch (err) {
    return { status: 502, json: { error: 'Citation preview upstream failed: ' + err.message } };
  }
}

async function callCitationPreviewClaude(body) {
  const { parentTitle, parentExcerpt, citationText, citedTitle, citedText } = body || {};
  if (!citedText || typeof citedText !== 'string' || !citedText.trim()) {
    return { status: 400, json: { error: 'Citation preview needs cited paper text.' } };
  }

  const userPrompt =
    `Paper being read: ${parentTitle || 'Unknown'}\n` +
    (parentExcerpt ? `Relevant passage:\n${parentExcerpt.slice(0, 3000)}\n\n` : '') +
    `Selected citation: ${citationText || ''}\n\n` +
    `Cited paper: ${citedTitle || 'Unknown'}\n` +
    `Abstract / excerpt:\n${citedText.slice(0, 8000)}\n\n` +
    `In 2–3 sentences, state the cited paper's main idea and why it is relevant to the passage. Plain prose, no preamble.`;

  const result = await callAnthropic({
    model: DEFAULT_CHAT_MODEL,
    max_tokens: 220,
    system:
      'You help a researcher understand citations while reading a paper. ' +
      'Be concise and connect the cited work to the passage they are reading.',
    messages: [{ role: 'user', content: userPrompt }],
  });

  if (result.status !== 200) return result;

  const preview = result.json.content?.[0]?.text?.trim() || '';
  if (!preview) {
    return { status: 502, json: { error: 'Claude returned an empty citation preview.' } };
  }

  return { status: 200, json: { preview, sufficient: true, source: 'claude' } };
}

async function callCitationDetect(body) {
  const { text } = body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { status: 400, json: { error: 'Citation detect requests must include a non-empty text field.' } };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { status: 200, json: { isCitation: false, reason: 'no-groq-key' } };
  }

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEFAULT_SUMMARY_MODEL,
        max_tokens: 120,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Classify whether a text selection from an academic paper is a bibliographic citation. ' +
              'Reply with JSON only: {"isCitation":boolean,"authors":["LastName1","LastName2"],' +
              '"year":"2024","searchQuery":"Author1 Author2 2024","kind":"author-year|numeric|doi|url|other"}. ' +
              'Examples: "(Marshall & Kirchner, 2024)" → isCitation true, authors ["Marshall","Kirchner"], year "2024", ' +
              'searchQuery "Marshall Kirchner 2024", kind "author-year". ' +
              '"[12]" → isCitation true, kind "numeric". ' +
              'Normal prose sentences → isCitation false, empty authors, kind "other".',
          },
          { role: 'user', content: text.trim().slice(0, 500) },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = data?.error?.message || data?.error || 'Citation detect failed.';
      return { status: r.status, json: { error: msg } };
    }

    const raw = data.choices?.[0]?.message?.content?.trim() || '';
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) try { parsed = JSON.parse(m[0]); } catch (_) {}
    }
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
  } catch (err) {
    return { status: 502, json: { error: 'Citation detect upstream failed: ' + err.message } };
  }
}

async function handleChatRequest(body) {
  if (body?.task === 'summarize') return callCheapSummary(body);
  if (body?.task === 'citation-match') return callCitationMatch(body);
  if (body?.task === 'citation-preview') return callCitationPreview(body);
  if (body?.task === 'citation-preview-claude') return callCitationPreviewClaude(body);
  if (body?.task === 'citation-detect') return callCitationDetect(body);
  return callAnthropic(body);
}

module.exports = {
  callAnthropic,
  callCheapSummary,
  callCitationMatch,
  callCitationPreview,
  callCitationPreviewClaude,
  callCitationDetect,
  handleChatRequest,
};
