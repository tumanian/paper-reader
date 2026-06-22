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

async function handleChatRequest(body) {
  if (body?.task === 'summarize') return callCheapSummary(body);
  return callAnthropic(body);
}

module.exports = { callAnthropic, callCheapSummary, handleChatRequest };
