// The front door. It owns the public port, serves the site itself and passes API calls to the node, which runs as a
// separate process. If the node stops for any reason the site keeps answering: pages load, public reads come from the
// last good copy, and the node is started again. Nothing here depends on keys, the settlement chain or the state file.
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { site } from './site.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 8312, ENGINE_PORT = +process.env.ENGINE_PORT || PORT + 1, HEAP = +process.env.ENGINE_HEAP || 320;
const DEV = process.env.L2_DEV === '1' && process.env.NODE_ENV !== 'production';
process.on('uncaughtException', (e) => { console.error('front uncaught', e?.stack || e); if (e?.code === 'EADDRINUSE' || e?.code === 'EACCES') process.exit(1); });
process.on('unhandledRejection', (e) => console.error('front unhandled', e?.stack || e));

// ---------- the node, restarted whenever it exits ----------
let child = null, startedAt = 0, backoff = 1000, stopping = false, restarts = 0;
function startNode() {
  if (stopping) return; startedAt = Date.now();
  child = spawn(process.execPath, ['--max-old-space-size=' + HEAP, path.join(ROOT, 'index.js')], { env: { ...process.env, PORT: String(ENGINE_PORT), HOST: '127.0.0.1' }, stdio: 'inherit' });
  child.on('error', (e) => console.error('node could not start: ' + e.message));
  child.on('exit', (code, sig) => { child = null; if (stopping) return; if (Date.now() - startedAt > 60_000) backoff = 1000; restarts++; console.error(`node stopped (${sig || code}), starting it again in ${backoff} ms`); setTimeout(startNode, backoff).unref?.(); backoff = Math.min(15_000, backoff * 2); });
}
startNode();
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stopping = true; if (!child) process.exit(0); child.once('exit', () => process.exit(0)); child.kill(s); setTimeout(() => process.exit(0), 6000).unref(); });

// ---------- last good copy of public reads ----------
const KEEP = /^\/api\/(chain|blocks|coins|checkpoints|door)(\/|$)/, cache = new Map();
const remember = (key, status, type, body) => { if (cache.size > 300) cache.delete(cache.keys().next().value); cache.delete(key); cache.set(key, { status, type, body, at: Date.now() }); };
const JSONH = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
function down(req, res, key) {
  if (res.headersSent) return res.end();
  const hit = key && cache.get(key);
  if (hit) { res.writeHead(hit.status, { ...JSONH, 'content-type': hit.type, 'x-node': 'catching-up', 'x-as-of': String(hit.at) }); return res.end(hit.body); }
  res.writeHead(503, { ...JSONH, 'retry-after': '3', 'x-node': 'catching-up' }); res.end(JSON.stringify({ error: 'The node is catching up. Try again in a few seconds', retry: true }));
}

function pass(req, res, url) {
  const key = req.method === 'GET' && KEEP.test(url.pathname) && !req.headers['x-l2-pubkey'] ? url.pathname + url.search : null;
  const fwd = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');
  const up = http.request({ host: '127.0.0.1', port: ENGINE_PORT, method: req.method, path: req.url, headers: { ...req.headers, 'x-forwarded-for': fwd } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    if (key && r.statusCode === 200) { const parts = []; let n = 0; r.on('data', (d) => { n += d.length; if (n <= 600_000) parts.push(d); }); r.on('end', () => { if (n <= 600_000) remember(key, 200, r.headers['content-type'] || JSONH['content-type'], Buffer.concat(parts)); }); }
    r.pipe(res); r.on('error', () => res.end());
  });
  up.setTimeout(key ? 8000 : 30_000, () => up.destroy(new Error('timeout')));
  up.on('error', () => down(req, res, key));
  req.on('aborted', () => up.destroy()); res.on('close', () => { if (!res.writableEnded) up.destroy(); });
  req.pipe(up);
}

http.createServer((req, res) => {
  let url; try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end('bad request'); }
  try {
    if (url.pathname === '/healthz') { res.writeHead(200, JSONH); return res.end(JSON.stringify({ ok: true, node: child ? 'running' : 'restarting', restarts })); }
    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') return pass(req, res, url);
    site(req, res, url, DEV);
  } catch (e) { console.error('front', e); try { if (res.headersSent) res.end(); else { res.writeHead(500, JSONH); res.end('{"error":"Something went wrong on our side"}'); } } catch {} }
}).listen(PORT, () => console.log(`front door on http://localhost:${PORT}, node on ${ENGINE_PORT}`));
