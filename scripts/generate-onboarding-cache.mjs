#!/usr/bin/env node
/**
 * Regenerate onboarding-action-cache.json from live API calls.
 *
 * Usage (requires ANTHROPIC_API_KEY):
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/generate-onboarding-cache.mjs
 *
 * Writes ../onboarding-action-cache.json with citation previews and chat
 * responses for the featured onboarding paper (Attention Is All You Need).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { handleFetchRequest } from '../handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PAPER_URL = 'https://ar5iv.org/abs/1706.03762';
const PAPER_ID = 'attention-is-all-you-need';
const OUT = path.join(ROOT, 'onboarding-action-cache.json');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY is required.');
  process.exit(1);
}

async function chat(body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.content?.[0]?.text ?? '';
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRef13(html) {
  const m = html.match(/id="bib\.bib13"[^>]*>[\s\S]*?<\/li>/);
  if (!m) throw new Error('Could not find bibliography entry [13]');
  return m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/^\s*\[13\]\s*/, '').trim();
}

async function main() {
  console.log('Fetching paper…');
  const fetched = await handleFetchRequest(PAPER_URL);
  const html = fetched.json?.html;
  if (!html) throw new Error('Failed to fetch paper HTML');

  const paperText = stripHtml(html).slice(0, 120000);
  const refText = extractRef13(html);
  console.log('Ref [13]:', refText.slice(0, 80) + '…');

  const systemBase =
    'You are a sharp, concise research assistant helping someone read a paper or article. ' +
    'Answer using the FULL DOCUMENT provided below as your source of truth.';

  const fullPaperBlock = `=== FULL DOCUMENT: Attention Is All You Need ===\n\n${paperText}`;

  console.log('Generating math explanation…');
  const mathAssistant = await chat({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: [
      { type: 'text', text: systemBase },
      { type: 'text', text: fullPaperBlock },
      {
        type: 'text',
        text:
          '=== MATH EXPLANATION REQUEST ===\n' +
          'The highlighted passage is a mathematical formula from this paper.\n' +
          'LaTeX source of the selected formula:\n' +
          '\\text{Attention}(Q,K,V)=\\text{softmax}\\!\\left(\\frac{QK^{\\top}}{\\sqrt{d_k}}\\right)V\n' +
          'Explain it tightly in three tiers, skipping obvious terms.',
      },
    ],
    messages: [{ role: 'user', content: 'Explain this math.' }],
  });

  console.log('Generating code translation…');
  const codeAssistant = await chat({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: [
      { type: 'text', text: systemBase },
      { type: 'text', text: fullPaperBlock },
      {
        type: 'text',
        text:
          '=== MATH-TO-CODE REQUEST ===\n' +
          'Translate the formula into readable PyTorch/NumPy-style code.\n' +
          'LaTeX: \\text{Attention}(Q,K,V)=\\text{softmax}\\!\\left(\\frac{QK^{\\top}}{\\sqrt{d_k}}\\right)V',
      },
    ],
    messages: [{ role: 'user', content: 'Translate this formula to code.' }],
  });

  console.log('Generating citation preview…');
  const citePreview = await chat({
    model: 'claude-haiku-4-5',
    max_tokens: 400,
    system: [
      {
        type: 'text',
        text:
          'Summarize why a cited paper matters to the passage the researcher is reading. ' +
          'Return 2-4 bullet takeaways as plain text lines (no markdown headers).',
      },
    ],
    messages: [{
      role: 'user',
      content:
        `Parent paper excerpt (Transformer, discussing RNNs/LSTMs):\n` +
        `"Recurrent neural networks, long short-term memory…"\n\n` +
        `Cited paper: Long Short-Term Memory\n` +
        `Bibliography: ${refText}\n\n` +
        `Why is [13] relevant here?`,
    }],
  });

  const out = {
    _comment: 'Pre-computed responses for onboarding demo actions (instant first click). Regenerate with: node scripts/generate-onboarding-cache.mjs',
    papers: {
      [PAPER_ID]: {
        citations: {
          '[13]': {
            status: 'ok',
            stage: 'preview',
            citationText: '[13]',
            refText,
            matchId: 13,
            url: null,
            urlMethod: null,
            citedTitle: 'Long Short-Term Memory',
            preview: citePreview.trim(),
            previewSource: 'cache',
            match: { isCitation: true, matchId: 13, confidence: 0.99, reason: 'numeric bracket' },
          },
        },
        chat: {
          math: { user: 'Explain this math.', assistant: mathAssistant.trim() },
          code: { user: 'Translate this formula to code.', assistant: codeAssistant.trim() },
        },
      },
    },
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log('Wrote', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
