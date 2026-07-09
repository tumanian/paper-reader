// Vercel serverless function — handles POST /api/chat in production.
// Reuses the same shared handler as the local server.

const { handleChatRequest } = require('../handler');
const { parseBearerToken } = require('../abuse-guard');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  // Vercel parses JSON bodies automatically, but guard for safety.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); }
    catch { res.status(400).json({ error: 'Invalid JSON.' }); return; }
  }

  const ctx = {
    headers: req.headers || {},
    socketRemote: req.socket?.remoteAddress,
    authToken: parseBearerToken(req.headers?.authorization),
  };

  const { status, json, headers } = await handleChatRequest(body, ctx);
  if (headers) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  }
  res.status(status).json(json);
};
