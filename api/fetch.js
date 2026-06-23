// Vercel serverless function — GET /api/fetch?url=...
const { handleFetchRequest } = require('../handler');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const url = req.query?.url;
  const { status, json } = await handleFetchRequest(url);
  res.status(status).json(json);
};
