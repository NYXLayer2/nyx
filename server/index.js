// HTTP: the open API, the owner-only API, the live block stream, the MCP endpoint and the site.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChain, TxError, RULES } from './core.js';
import { startBridge } from './bridge.js';
import { A } from './chain.js';
import { site as serveSite } from './site.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || A.port, DEV = process.env.L2_DEV === '1' && process.env.NODE_ENV !== 'production';
const DATA = process.env.DATA_PATH || path.join(ROOT, '..', 'data', 'chain.json'); try { fs.mkdirSync(path.dirname(DATA), { recursive: true }); } catch (e) { console.error('data folder is not writable, state will not survive a restart: ' + e.message); }
const MINT = (process.env.TOKEN_MINT || '').trim();

// one bad request or a failed timer must never take the site down: log it and keep serving
process.on('uncaughtException', (e) => { console.error('uncaught', e?.stack || e); if (e?.code === 'EADDRINUSE' || e?.code === 'EACCES') process.exit(1); });
process.on('unhandledRejection', (e) => console.error('unhandled', e?.stack || e));

// a state file that parses but cannot be loaded is set aside, never allowed to stop the node from starting
let chain; try { chain = createChain(A, DATA); } catch (e) { console.error('state could not be loaded, starting clean: ' + (e?.stack || e)); try { fs.renameSync(DATA, DATA + '.unreadable-' + Date.now()); } catch {} chain = createChain(A, DATA); }
const bridge = startBridge(chain, { dev: DEV }), S = () => chain.S;
setInterval(() => { try { chain.produce(); } catch (e) { console.error('block production failed', e); } }, RULES.blockMs);
setInterval(() => chain.save(), 4000);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { chain.touch(); chain.save(); process.exit(0); });

// ---------- helpers ----------
const json = (res, code, body) => { const b = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(b); };
const err = (m, code = 400) => { throw new TxError(m, code); };
function readBody(req, max = 16_000) { return new Promise((ok, no) => { let n = 0; const parts = []; req.on('data', (d) => { n += d.length; if (n > max) { no(new TxError('Request is too large', 413)); req.destroy(); } else parts.push(d); }); req.on('end', () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { no(new TxError('Body must be JSON')); } }); req.on('error', no); }); }
const hits = new Map();
function limit(ip, bucket, max) { const k = bucket + ip, now = Date.now(); let h = hits.get(k); if (!h || now > h.reset) hits.set(k, h = { n: 0, reset: now + 60_000 }); if (++h.n > max) err('Too many requests. Slow down for a minute', 429); }
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now > h.reset) hits.delete(k); }, 60_000).unref();
const owner = (req) => chain.verifyAuth(req.headers['x-l2-pubkey'], req.headers['x-l2-ts'], req.headers['x-l2-sig']) || err('Sign in with your wallet to read this', 401);

// ---------- views ----------
async function chainInfo() {
  const s = S(), last = s.blocks[s.blocks.length - 1], r = s.receipts[s.receipts.length - 1];
  return { name: A.tag, chainId: A.chainId, settlesOn: A.name, asset: A.asset, decimals: A.decimals, coinDecimals: RULES.coinDecimals, head: s.height, headHash: s.lastHash, stateRoot: last?.stateRoot || null, headTime: last?.timestamp || null, txCount: s.txCount, coins: Object.keys(s.coins).length,
    producer: chain.PRODUCER, sealing: chain.sealing, sealedBlock: s.sealed.count ? s.sealed.to : null, receipts: s.sealed.count, latestReceipt: r || null, checkpoint: s.sealed.count ? s.sealed.checkpoint : null,
    door: A.door, authority: A.authority, settlement: A.settlement, settlementKind: A.settlementKind, withdrawals: A.canPay, usd: await A.usd(), mint: MINT || null,
    rules: { blockMs: RULES.blockMs, quietMs: RULES.quietMs, maxTxs: RULES.maxTxs, receiptMs: RULES.receiptMs, feePercent: 1, creatorSharePercent: 50, supply: String(RULES.supply), curveTokens: String(RULES.curveTokens), linkMaxDays: RULES.linkMaxDays, minWithdraw: A.minWithdraw } };
}
function blocksPage(before, n = 25) { const s = S(), top = Math.min(s.height, before ? before - 1 : s.height), out = []; for (let h = top; h > top - n && h >= s.base; h--) { const b = chain.getBlock(h); if (b) out.push(chain.publicBlock(b)); } return { head: s.height, oldest: s.base, blocks: out }; }
const coinById = (id) => S().coins[id] || err('No such coin', 404);
function quote(c, side, amount) { if (!/^\d{1,40}$/.test(amount || '')) err('amount must be a whole number in base units'); const n = BigInt(amount);
  if (side === 'buy') { const q = chain.quoteBuy(c, n); return { side, in: String(q.spent), out: String(q.out), fee: String(q.fee), completes: q.completes }; }
  if (side === 'sell') { const q = chain.quoteSell(c, n); return { side, in: String(n), out: String(q.out), fee: String(q.fee) }; }
  err('side must be buy or sell'); }

// ---------- MCP: the same reads, plus sending a transaction the agent signed itself ----------
const TOOLS = [
  ['get_chain', 'Chain id, head block, state root and the latest settlement receipt.', {}, async () => chainInfo()],
  ['get_blocks', 'The latest blocks with their tx root and state root.', { before: { type: 'number', description: 'Only blocks below this height' } }, async (a) => blocksPage(a.before, 20)],
  ['get_block', 'One block by height or hash.', { id: { type: 'string' } }, async (a) => chain.findBlock(String(a.id)) || err('No such block', 404)],
  ['get_transaction', 'The public view of a transaction: type, status and block.', { hash: { type: 'string' } }, async (a) => S().txs[a.hash] || err('No such transaction', 404)],
  ['get_receipts', 'Receipts written to ' + A.name + '.', {}, async () => S().receipts.slice(-50).reverse()],
  ['get_coins', 'Every coin with price, market cap and curve progress.', {}, async () => { const u = await A.usd(); return Object.values(S().coins).map((c) => chain.coinView(c, u)); }],
  ['get_coin', 'One coin.', { id: { type: 'string' } }, async (a) => chain.coinView(coinById(a.id), await A.usd())],
  ['get_quote', 'Quote a buy or a sell before sending it.', { id: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] }, amount: { type: 'string', description: 'Base units' } }, async (a) => quote(coinById(a.id), a.side, a.amount)],
  ['get_nonce', 'The next nonce for an account.', { address: { type: 'string' } }, async (a) => ({ nonce: chain.nonce(A.norm(a.address)) })],
  ['send_transaction', 'Send a transaction you have already signed with your own key.', { tx: { type: 'object', description: '{ chainId, from, nonce, type, body, sig }' } }, async (a) => chain.wait(chain.submit(a.tx))],
];
async function mcp(msg) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result }), fault = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fault(-32600, 'Invalid request');
  if (msg.method.startsWith('notifications/')) return null;
  if (msg.method === 'initialize') return reply({ protocolVersion: msg.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: A.tag.toLowerCase(), version: '1.0.0' }, instructions: A.tag + ' is a private L2 on ' + A.name + '. Amounts are strings in base units.' });
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'tools/list') return reply({ tools: TOOLS.map(([name, description, props]) => ({ name, description, inputSchema: { type: 'object', properties: props, required: Object.keys(props).filter((k) => k !== 'before') } })) });
  if (msg.method === 'tools/call') { const t = TOOLS.find((x) => x[0] === msg.params?.name); if (!t) return fault(-32602, 'Unknown tool');
    try { return reply({ content: [{ type: 'text', text: JSON.stringify(await t[3](msg.params.arguments || {})) }] }); } catch (e) { return reply({ isError: true, content: [{ type: 'text', text: e instanceof TxError ? e.message : 'Something went wrong on our side' }] }); } }
  return fault(-32601, 'Method not found');
}

// ---------- routes ----------
async function api(req, res, url, ip) {
  const p = url.pathname, q = url.searchParams, seg = p.split('/').filter(Boolean), GET = req.method === 'GET', POST = req.method === 'POST';
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, x-l2-pubkey, x-l2-ts, x-l2-sig', 'access-control-allow-methods': 'GET, POST, OPTIONS' }); return res.end(); }
  if (p === '/mcp') { if (!POST) { res.writeHead(405, { allow: 'POST' }); return res.end(); } limit(ip, 'api', 300); const body = await readBody(req, 64_000), out = Array.isArray(body) ? (await Promise.all(body.map(mcp))).filter(Boolean) : await mcp(body); if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); } return json(res, 200, out); }
  if (p === '/api/stream' && GET) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'access-control-allow-origin': '*', 'x-accel-buffering': 'no' }); res.write('retry: 3000\n\n');
    const off = chain.onBlock((b) => res.write('event: block\ndata: ' + JSON.stringify(b) + '\n\n')), beat = setInterval(() => res.write(': ok\n\n'), 20_000);
    req.on('close', () => { off(); clearInterval(beat); }); return;
  }
  limit(ip, 'api', 300);
  if (GET && p === '/api/chain') return json(res, 200, await chainInfo());
  if (GET && p === '/api/blocks') return json(res, 200, blocksPage(+q.get('before') || 0, Math.min(50, +q.get('limit') || 25)));
  if (GET && seg[1] === 'blocks' && seg[2]) return json(res, 200, chain.findBlock(seg[2]) || err('No such block', 404));
  if (GET && seg[1] === 'tx' && seg[2]) return json(res, 200, S().txs[seg[2]] || err('No such transaction', 404));
  if (GET && p === '/api/checkpoints') return json(res, 200, { sealedBlock: S().sealed.count ? S().sealed.to : null, count: S().sealed.count, receipts: S().receipts.slice(-(Math.min(200, +q.get('limit') || 25))).reverse() });
  if (GET && p === '/api/coins') { const u = await A.usd(); return json(res, 200, { usd: u, coins: Object.values(S().coins).map((c) => chain.coinView(c, u)).sort((a, b) => b.createdAt - a.createdAt) }); }
  if (GET && seg[1] === 'coins' && seg[2]) { const c = coinById(seg[2]);
    if (seg[3] === 'candles') return json(res, 200, { candles: c.candles });
    if (seg[3] === 'quote') return json(res, 200, quote(c, q.get('side'), q.get('amount')));
    return json(res, 200, chain.coinView(c, await A.usd())); }
  if (GET && seg[1] === 'nonce' && seg[2]) { if (!A.isAddress(seg[2])) err('That is not a valid address'); return json(res, 200, { nonce: chain.nonce(A.norm(seg[2])) }); }
  if (GET && seg[1] === 'links' && seg[2]) return json(res, 200, chain.linkPublic(seg[2]) || err('No such pay link', 404));
  if (GET && p === '/api/door') return json(res, 200, { address: A.door, ...(A.blockhash && A.door ? { blockhash: await A.blockhash().catch(() => null) } : {}), errors: bridge.errors });
  if (POST && p === '/api/tx') { limit(ip, 'tx', 60); const hash = chain.submit(await readBody(req)); return json(res, 200, q.get('wait') ? await chain.wait(hash) : { hash, status: 'pending' }); }
  if (POST && p === '/api/deposit') { limit(ip, 'tx', 60); const { l1 } = await readBody(req); if (typeof l1 !== 'string' || l1.length < 32 || l1.length > 100 || !A.door) err('Send the settlement transaction id'); return json(res, 200, { status: await bridge.credit(l1) }); }
  if (GET && seg[1] === 'me') { const a = owner(req);
    if (seg[2] === 'balances') return json(res, 200, { ...chain.me(a), usd: await A.usd() });
    if (seg[2] === 'history') return json(res, 200, { history: chain.history(a) });
    if (seg[2] === 'links') return json(res, 200, { links: chain.links(a) });
    if (seg[2] === 'withdrawals') return json(res, 200, { withdrawals: chain.withdrawalsOf(a).map((w) => ({ ...w, l1: w.l1 || S().bridge?.[w.id]?.l1 || null })) }); }
  if (DEV && POST && p === '/api/dev/credit') { const { to, amount } = await readBody(req); return json(res, 200, { hash: chain.system('sys.deposit', { to: A.norm(to), amount: String(amount), l1: 'dev-' + Date.now() }) }); }
  err('Not found', 404);
}

const site = (req, res, url) => serveSite(req, res, url, DEV);

http.createServer(async (req, res) => {
  let url; try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end('bad request'); }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try { if (url.pathname === '/healthz') return json(res, 200, { ok: true, head: chain.S.height }); if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') await api(req, res, url, ip); else site(req, res, url); }
  catch (e) { try { if (res.headersSent) res.end(); else json(res, e instanceof TxError ? e.code : 500, { error: e instanceof TxError ? e.message : 'Something went wrong on our side' }); } catch {} if (!(e instanceof TxError)) console.error(e); }
}).listen(PORT, process.env.HOST || undefined, () => console.log(`${A.tag} is producing blocks on http://localhost:${PORT}  door ${A.door || 'not set'}  sealing ${chain.sealing ? 'on' : 'off'}${DEV ? '  (dev mode)' : ''}`));
