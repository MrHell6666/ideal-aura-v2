/* Local test server — serves public/ and the API exactly like Vercel does.
   Uses an in-memory database unless KV_REST_API_URL / KV_REST_API_TOKEN are set.
   Run:  node dev-server.js   then open http://localhost:3000   (setup token: dev-setup-token) */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
if (!process.env.KV_REST_API_URL) process.env.IPK_MEMORY_DB = '1';
process.env.SETUP_TOKEN = process.env.SETUP_TOKEN || 'dev-setup-token';
const { default: api } = await import('./api/main.js');
const root = path.join(path.dirname(new URL(import.meta.url).pathname), 'public');
const PORT = Number(process.env.PORT) || 3000;
http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    const u = new URL(req.url, 'http://x');
    req.url = '/api/main?route=' + encodeURIComponent(u.pathname.slice(5)) + (u.search ? '&' + u.search.slice(1) : '');
    return api(req, res);
  }
  const f = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = fs.existsSync(f) && fs.statSync(f).isFile() ? f : path.join(root, 'index.html');
  res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`HR ERP dev server on http://localhost:${PORT} (database: ${process.env.IPK_MEMORY_DB ? 'in-memory' : 'Upstash'})`));
