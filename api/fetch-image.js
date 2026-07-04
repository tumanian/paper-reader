// Vercel serverless function — GET /api/fetch-image?url=...
const { handleFetchImageRequest } = require('../handler');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const url = req.query?.url;
  const result = await handleFetchImageRequest(url);
  if (result.body) {
    res.setHeader('Content-Type', result.contentType || 'image/png');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (result.finalUrl) res.setHeader('X-Final-Url', result.finalUrl);
    res.status(result.status).send(result.body);
    return;
  }

  res.status(result.status).json(result.json);
};
