// The static site. Shared by the front door (start.js) and the node (index.js), so pages are served even while the node restarts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const PAGES = { '': 'index.html', app: 'app.html', explorer: 'explorer.html', block: 'explorer.html', tx: 'explorer.html', docs: 'docs.html', whitepaper: 'docs.html', developers: 'docs.html', coin: 'app.html', pay: 'app.html' };

export function site(req, res, url, dev = false) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let dec; try { dec = decodeURIComponent(url.pathname); } catch { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end('{"error":"Bad request"}'); }
  const seg = url.pathname.split('/').filter(Boolean); const file = PAGES[seg[0] || ''] && !path.extname(url.pathname) ? PAGES[seg[0] || ''] : path.normalize(dec).replace(/^([/\\])+/, '');
  let full = path.join(CLIENT, file), code = 200;
  try { if (!full.startsWith(CLIENT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { full = path.join(CLIENT, '404.html'); code = 404; } } catch { full = path.join(CLIENT, '404.html'); code = 404; }
  const ext = path.extname(full), sw = path.basename(full) === 'sw.js';
  res.writeHead(code, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': ext === '.html' || dev || sw ? 'no-cache' : 'public, max-age=300', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' });
  if (req.method === 'HEAD') return res.end(); fs.createReadStream(full).on('error', () => res.end()).pipe(res);
}
