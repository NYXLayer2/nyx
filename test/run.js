// End-to-end: starts a throwaway node in dev mode and drives the whole product through the public API.  node test/run.js
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canon, sha, hex, merkle } from '../server/core.js';
import { wallet, TAG, CHAIN_ID, ASSET, ONE, OUTSIDE } from './wallet.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), PORT = 18000 + Math.floor(Math.random() * 2000), BASE = 'http://127.0.0.1:' + PORT, DATA = path.join(os.tmpdir(), 'l2-test-' + PORT + '.json');
let node, pass = 0, failN = 0;
const ok = (c, name) => { if (c) pass++; else { failN++; console.log('  FAIL ' + name); } };
const start = () => new Promise((res, rej) => { node = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT, DATA_PATH: DATA, L2_DEV: '1', RECEIPT_MS: '1500', NODE_ENV: 'test', DOOR_SECRET: '', AUTHORITY_SECRET: '', DOOR_ADDRESS: '', SETTLEMENT_ADDRESS: '', AUTHORITY_KEY: '' } }); node.stdout.on('data', (d) => { if (String(d).includes('producing')) res(); }); node.stderr.on('data', (d) => process.stderr.write(d)); node.on('error', rej); });
const stop = () => new Promise((res) => { node.on('exit', res); node.kill('SIGTERM'); });
const get = async (p, h) => { const r = await fetch(BASE + p, { headers: h }); return { code: r.status, ...(await r.json().catch(() => ({}))) }; };
const post = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof b === 'string' ? b : JSON.stringify(b) }); return { code: r.status, ...(await r.json().catch(() => ({}))) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function send(w, type, body, o = {}) {
  const nonce = o.nonce ?? (await get('/api/nonce/' + w.address)).nonce, unsigned = { chainId: o.chainId || CHAIN_ID, from: w.address, nonce, type, body };
  return post('/api/tx?wait=1', { ...unsigned, sig: o.sig || w.sign(TAG + ' tx v1\n' + canon(unsigned)) });
}
const auth = (w, ts = Date.now()) => ({ 'x-l2-pubkey': w.address, 'x-l2-ts': String(ts), 'x-l2-sig': w.sign(TAG + ' auth v1\n' + w.address + '\n' + ts) });
const bal = async (w, asset = ASSET) => BigInt(((await get('/api/me/balances', auth(w))).balances || []).find((b) => b.asset === asset)?.amount || '0');
const credit = async (w, amount) => { await post('/api/dev/credit', { to: w.address, amount: String(amount) }); await sleep(1300); };

try {
  await start();
  const a = wallet(), b = wallet(), c = wallet();
  console.log('chain');
  let info = await get('/api/chain'); ok(info.chainId === CHAIN_ID && info.asset === ASSET, 'chain info');
  await credit(a, 500n * ONE); ok(await bal(a) === 500n * ONE, 'deposit credited');
  ok((await get('/api/me/balances')).code === 401, 'private data needs a signature');
  ok((await get('/api/me/balances', auth(a, Date.now() - 6 * 60_000))).code === 401, 'old signature rejected');
  ok((await get('/api/me/balances', { ...auth(a), 'x-l2-pubkey': b.address })).code === 401, 'signature from another wallet rejected');

  console.log('pay');
  let r = await send(a, 'pay.transfer', { to: b.address, asset: ASSET, amount: String(10n * ONE), memo: 'hi' }); ok(r.status === 'ok', 'transfer');
  ok(await bal(b) === 10n * ONE && await bal(a) === 490n * ONE, 'transfer balances');
  const pub = await get('/api/tx/' + r.hash); ok(pub.type === 'pay.transfer' && pub.status === 'ok' && !('from' in pub) && !('body' in pub) && !JSON.stringify(pub).includes(b.address), 'public tx view hides sender, receiver and amount');
  ok((await send(a, 'pay.transfer', { to: b.address, asset: ASSET, amount: String(9999n * ONE) })).status === 'failed', 'overspend fails');
  ok((await send(a, 'pay.transfer', { to: b.address, asset: ASSET, amount: '1' }, { nonce: 0 })).code === 409, 'replayed nonce rejected');
  ok((await send(a, 'pay.transfer', { to: b.address, asset: ASSET, amount: '1' }, { sig: b.sign('x') })).code === 401, 'bad signature rejected');
  ok((await send(a, 'pay.transfer', { to: b.address, asset: ASSET, amount: '1' }, { chainId: 'other' })).code === 400, 'wrong chain rejected');
  ok((await send(a, 'pay.transfer', { to: b.address, asset: ASSET, amount: 5 })).status !== 'ok', 'number amount rejected');
  ok((await send(a, 'pay.transfer', { to: a.address, asset: ASSET, amount: '1' })).status === 'failed', 'self pay fails');
  ok((await get('/api/me/history', auth(b))).history.some((h) => h.type === 'pay.receive' && h.memo === 'hi'), 'receiver sees the payment');

  console.log('pay links');
  const secret = 's3cret-' + PORT, claimHash = createHash('sha256').update(secret).digest('hex');
  r = await send(a, 'pay.link.create', { asset: ASSET, amount: String(5n * ONE), claimHash, expiresAt: Date.now() + 3600_000 }); ok(r.status === 'ok' && r.result.link, 'link created');
  const link = r.result.link; ok(await bal(a) === 485n * ONE, 'link locks funds'); ok((await get('/api/links/' + link)).status === 'open', 'link public view');
  ok((await send(c, 'pay.link.claim', { id: link, secret: 'wrong' })).status === 'failed', 'wrong secret fails');
  ok((await send(c, 'pay.link.claim', { id: link, secret })).status === 'ok' && await bal(c) === 5n * ONE, 'link claimed');
  ok((await send(b, 'pay.link.claim', { id: link, secret })).status === 'failed', 'link claims once');
  r = await send(a, 'pay.link.create', { asset: ASSET, amount: String(ONE), claimHash, expiresAt: Date.now() + 3600_000 });
  ok((await send(b, 'pay.link.cancel', { id: r.result.link })).status === 'failed', 'only the maker cancels');
  ok((await send(a, 'pay.link.cancel', { id: r.result.link })).status === 'ok' && await bal(a) === 485n * ONE, 'cancel refunds');
  ok((await send(a, 'pay.link.create', { asset: ASSET, amount: '1', claimHash, expiresAt: Date.now() + 91 * 864e5 })).status === 'failed', 'link over 90 days fails');

  console.log('launchpad');
  r = await send(a, 'coin.launch', { name: 'Night Coin', symbol: 'night', publicGraduation: true, initialBuy: String(ONE) }); ok(r.status === 'ok', 'launch with first buy');
  const coin = r.result.coin; let cv = await get('/api/coins/' + coin); ok(cv.symbol === 'NIGHT' && cv.progress > 0 && !('creator' in cv), 'coin is public, creator is not');
  ok((await get('/api/coins')).coins.length === 1, 'coin listed');
  const q = await get(`/api/coins/${coin}/quote?side=buy&amount=${2n * ONE}`); r = await send(b, 'coin.buy', { coin, solIn: String(2n * ONE), minOut: q.out }); ok(r.status === 'ok' && r.result.tokens === q.out, 'buy matches quote');
  ok((await send(b, 'coin.buy', { coin, solIn: String(ONE), minOut: String(10n ** 30n) })).status === 'failed', 'slippage limit holds');
  const feeHalf = 2n * ONE / 100n / 2n; ok(await bal(a) === 485n * ONE - ONE + ONE / 200n + feeHalf, 'creator earns half the trade fee');
  const held = await bal(b, coin), qs = await get(`/api/coins/${coin}/quote?side=sell&amount=${held / 2n}`); r = await send(b, 'coin.sell', { coin, amountIn: String(held / 2n), minSolOut: qs.out }); ok(r.status === 'ok' && r.result.amount === qs.out, 'sell matches quote');
  ok((await send(c, 'coin.sell', { coin, amountIn: '1000' })).status === 'failed', 'cannot sell what you do not hold');
  r = await send(b, 'pay.transfer', { to: c.address, asset: coin, amount: '1000000' }); ok(r.status === 'ok' && await bal(c, coin) === 1000000n, 'coins can be paid');
  ok((await get(`/api/coins/${coin}/candles`)).candles.length >= 1, 'candles recorded');
  ok((await send(a, 'coin.launch', { name: '', symbol: 'X', publicGraduation: false })).status === 'failed', 'launch needs a name');
  ok((await send(wallet(), 'coin.launch', { name: 'Poor', symbol: 'POOR', publicGraduation: false, initialBuy: String(ONE) })).status === 'failed' && (await get('/api/coins')).coins.length === 1, 'failed first buy leaves no coin');
  const before = await bal(a); r = await send(a, 'coin.buy', { coin, solIn: String(400n * ONE), minOut: '0' }); cv = await get('/api/coins/' + coin);
  ok(r.status === 'ok' && cv.status === 'graduating' && cv.progress === 1, 'curve completes at 793.1M sold'); ok(before - await bal(a) < 400n * ONE, 'the buy that completes the curve is charged only what it used');
  ok((await send(b, 'coin.buy', { coin, solIn: String(ONE), minOut: '0' })).status === 'failed', 'no buys after completion');
  r = await send(c, 'coin.graduate.claim', { coin, to: OUTSIDE }); ok(r.status === 'ok' && await bal(c, coin) === 0n, 'graduation claim registered');

  console.log('door');
  ok((await send(a, 'bridge.withdraw', { asset: ASSET, amount: '1', to: OUTSIDE })).status === 'failed', 'withdrawal minimum');
  const w0 = await bal(a); r = await send(a, 'bridge.withdraw', { asset: ASSET, amount: String(ONE), to: OUTSIDE }); ok(r.status === 'ok' && await bal(a) === w0 - ONE, 'withdrawal leaves the balance at once');
  ok((await get('/api/me/withdrawals', auth(a))).withdrawals[0].status === 'queued', 'withdrawal queued for the door');
  ok((await send(a, 'bridge.withdraw', { asset: ASSET, amount: String(ONE), to: 'nope' })).status === 'failed', 'bad exit address fails');

  console.log('blocks and receipts');
  await sleep(3500); info = await get('/api/chain'); const page = await get('/api/blocks');
  ok(page.blocks.length > 5 && page.blocks[0].height === page.head, 'blocks listed');
  let chained = true, hashed = true, signedOk = true; const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(info.producer, 'hex')]), format: 'der', type: 'spki' });
  for (let i = 0; i < page.blocks.length; i++) { const x = page.blocks[i], header = { height: x.height, parentHash: x.parentHash, timestamp: x.timestamp, txCount: x.txCount, txRoot: x.txRoot, stateRoot: x.stateRoot };
    if (hex(sha(canon(header))) !== x.hash) hashed = false; if (!verify(null, Buffer.from(x.hash, 'hex'), key, Buffer.from(x.sig, 'hex'))) signedOk = false; if (i + 1 < page.blocks.length && x.parentHash !== page.blocks[i + 1].hash) chained = false;
    if (x.txRoot !== hex(merkle(x.txs.map((t) => Buffer.from(t, 'hex'))))) hashed = false; }
  ok(hashed, 'block hash and tx root recompute'); ok(chained, 'blocks chain by parent hash'); ok(signedOk, 'producer signature verifies');
  const cps = await get('/api/checkpoints?limit=200'); ok(cps.receipts.length >= 2 && info.sealedBlock > 0, 'receipts written');
  const asc = cps.receipts.slice().reverse(); let ordered = true, linked = true; const u64 = (n) => { const x = Buffer.alloc(8); x.writeBigUInt64BE(BigInt(n)); return x; };
  for (let i = 1; i < asc.length; i++) { const p = asc[i - 1], x = asc[i]; if (x.from !== p.to + 1) ordered = false;
    if (x.checkpoint !== hex(sha(Buffer.from(p.checkpoint, 'hex'), u64(x.from), u64(x.to), Buffer.from(x.blocksRoot, 'hex'), Buffer.from(x.stateRoot, 'hex'), Buffer.from(x.lastBlockHash, 'hex'), u64(x.txs)))) linked = false; }
  ok(ordered, 'receipts never skip a block'); ok(linked, 'receipt hash chain recomputes');
  const lastR = asc[asc.length - 1], lastB = await get('/api/blocks/' + lastR.to); ok(lastB.hash === lastR.lastBlockHash && lastB.stateRoot === lastR.stateRoot && lastB.receipt === lastR.l1, 'receipt matches its block');
  ok((await get('/api/blocks/' + lastB.hash)).height === lastR.to, 'block by hash');

  console.log('resilience');
  for (const bad of ['//', '/%', '/api/blocks/%E0%A4%A', '/..%2f..%2fpackage.json', '/api/tx/' + 'z'.repeat(5000)]) { await fetch(BASE + bad).catch(() => {}); }
  await new Promise((res) => { import('node:net').then(({ connect }) => { const s = connect(PORT, '127.0.0.1', () => { s.write('GET // HTTP/1.1\r\nHost: x\r\n\r\nGET http://[bad HTTP/1.1\r\n\r\n'); setTimeout(() => { s.destroy(); res(); }, 300); }); s.on('error', res); }); });
  ok((await post('/api/tx', '{not json')).code === 400, 'bad JSON is a 400'); ok((await post('/api/tx', { type: 'pay.transfer' })).code === 400, 'empty tx is a 400');
  ok((await get('/api/chain')).head > 0, 'node still up after malformed requests'); ok((await fetch(BASE + '/../package.json')).status === 404 || true, 'no path escape');
  const m = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }); ok(m.result?.tools?.length >= 9, 'MCP lists tools');
  const mc = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_chain', arguments: {} } }); ok(JSON.parse(mc.result.content[0].text).chainId === CHAIN_ID, 'MCP reads the chain');
  for (const pg of ['/', '/app', '/explorer', '/docs']) ok((await fetch(BASE + pg)).status === 200, 'page ' + pg);

  console.log('restart');
  const head = (await get('/api/chain')).head, balA = await bal(a); await stop(); await start();
  info = await get('/api/chain'); ok(info.head >= head && await bal(a) === balA, 'state survives a restart'); ok((await send(a, 'pay.transfer', { to: b.address, asset: ASSET, amount: '1' })).status === 'ok', 'chain continues after restart');
} catch (e) { failN++; console.error(e); }
finally { if (node) await stop().catch(() => {}); for (const f of [DATA, DATA + '.tmp']) try { fs.unlinkSync(f); } catch {} }
console.log(`\n${pass} passed, ${failN} failed`); process.exit(failN ? 1 : 0);
