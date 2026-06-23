// Local dev server — zero dependencies, pure Node.
// Serves the static frontend and proxies /api/chat to Anthropic.
//
//   ANTHROPIC_API_KEY=sk-ant-... node dev-server.js
//   → open http://localhost:3000

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { handleChatRequest, handleFetchRequest } = require('./handler');

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  // ── Public config ──────────────────────────────────────
  if (req.url === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      supabaseUrl: process.env.SUPABASE_URL || null,
      supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    }));
    return;
  }

  // ── URL fetch proxy (avoids brittle public CORS proxies) ──
  if (req.url.startsWith('/api/fetch') && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const target = u.searchParams.get('url');
    const { status, json } = await handleFetchRequest(target);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(json));
    return;
  }

  // ── API proxy ──────────────────────────────────────
  if (req.url === '/api/chat' && req.method === 'POST') {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw); }
      catch { res.writeHead(400, {'Content-Type':'application/json'});
              return res.end(JSON.stringify({ error: 'Invalid JSON.' })); }

      const { status, json } = await handleChatRequest(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
    return;
  }

  // ── Static files ───────────────────────────────────
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // prevent directory traversal
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(__dirname, safePath);

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\n  ⚠️  ANTHROPIC_API_KEY is not set — the chat will return an error.');
    console.log('     Restart with:  ANTHROPIC_API_KEY=sk-ant-... node dev-server.js\n');
  }
  console.log(`  ✓ Paper Reader running at  http://localhost:${PORT}\n`);
});
