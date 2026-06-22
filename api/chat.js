// Vercel serverless function — handles POST /api/chat in production.
// Reuses the same shared handler as the local server.

const { handleChatRequest } = require('../handler');

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

  const { status, json } = await handleChatRequest(body);
  res.status(status).json(json);
};
