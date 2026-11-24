// The chain: accounts, signed transactions, blocks with Merkle roots, the launchpad curve, pay links,
// withdrawals and the receipts that get sealed to the settlement chain. Nothing in here knows which
// settlement chain it runs on: that lives in the adapter passed to createChain().
import { createHash, generateKeyPairSync, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import fs from 'node:fs';

export const sha = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p); return h.digest(); };
export const hex = (b) => Buffer.from(b).toString('hex');
export function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
// Merkle tree. Leaf: SHA256(0x00 || key || 0x00 || SHA256(value)). Pair: SHA256(0x01 || left || right). An odd node moves up unchanged.
const B0 = Buffer.of(0), B1 = Buffer.of(1);
export const leaf = (key, value) => sha(B0, key, B0, sha(value));
export function merkle(nodes) {
  if (!nodes.length) return sha('');
  let row = nodes;
  while (row.length > 1) { const next = []; for (let i = 0; i < row.length; i += 2) next.push(i + 1 < row.length ? sha(B1, row[i], row[i + 1]) : row[i]); row = next; }
  return row[0];
}
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };

export class TxError extends Error { constructor(m, code = 400) { super(m); this.code = code; } }
const fail = (m, code) => { throw new TxError(m, code); };
const big = (v, name = 'amount') => { if (typeof v !== 'string' || !/^\d{1,40}$/.test(v)) fail(name + ' must be a whole number in base units, sent as a string'); return BigInt(v); };
const cdiv = (a, b) => (a + b - 1n) / b;

export const RULES = { blockMs: 1000, quietMs: 60_000, maxTxs: 500, receiptMs: +process.env.RECEIPT_MS || 10_000, feeBps: 100n, creatorShare: 50n, supply: 1_000_000_000n, curveTokens: 793_100_000n, virtualTokens: 1_073_000_000n, coinDecimals: 6, linkMaxDays: 90, authMs: 5 * 60_000 };
const UNIT = 10n ** BigInt(RULES.coinDecimals), KEEP_BLOCKS = +process.env.KEEP_BLOCKS || 3000, KEEP_TXS = +process.env.KEEP_TXS || 20000, KEEP_HIST = 200, KEEP_RECEIPTS = 2000, KEEP_CANDLES = 1500;
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

export function createChain(A, file) {
  // A: the settlement adapter { name, chainId, asset, decimals, virtualAsset, minWithdraw, isAddress, norm, verify }
  const TXTAG = A.tag + ' tx v1\n', AUTHTAG = A.tag + ' auth v1\n', ASSET = A.asset;
  let S = { chainId: A.chainId, height: 0, lastHash: '0'.repeat(64), txCount: 0, base: 1, blocks: [], accounts: {}, coins: {}, links: {}, withdrawals: {}, deposits: {}, txs: {}, txOrder: [], hist: {}, receipts: [], sealed: { to: 0, checkpoint: '0'.repeat(64), count: 0 }, unsealed: [], fees: '0', producer: null, wseq: 0 };
  if (file && fs.existsSync(file)) { try { S = { ...S, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { console.error('state file unreadable, starting clean: ' + e.message); } }
  if (S.chainId !== A.chainId) fail('state file belongs to chain ' + S.chainId);
  if (!S.producer) { const seed = process.env.PRODUCER_SEED ? Buffer.from(process.env.PRODUCER_SEED, 'hex') : null; const k = seed ? createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' }) : generateKeyPairSync('ed25519').privateKey; S.producer = hex(k.export({ format: 'der', type: 'pkcs8' }).subarray(16)); }
  const PKEY = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(S.producer, 'hex')]), format: 'der', type: 'pkcs8' }), PRODUCER = hex(createPublicKey(PKEY).export({ format: 'der', type: 'spki' }).subarray(12));

  // ---------- persistence: one small JSON file, written atomically ----------
  let dirty = false;
  const save = () => { if (!file || !dirty) return; dirty = false; try { fs.writeFileSync(file + '.tmp', JSON.stringify(S)); fs.renameSync(file + '.tmp', file); } catch (e) { dirty = true; console.error('save failed: ' + e.message); } };
  const touch = () => { dirty = true; };

  // ---------- state and its root ----------
  const leaves = new Map(), stale = new Set(); let root = null;
  const mark = (k) => { stale.add(k); root = null; };
  const acct = (a) => (S.accounts[a] ||= { nonce: 0, bal: {} });
  const bal = (a, asset) => BigInt(S.accounts[a]?.bal[asset] || '0');
  function move(a, asset, delta) { const ac = acct(a), v = BigInt(ac.bal[asset] || '0') + delta; if (v < 0n) fail('Not enough ' + (asset === ASSET ? ASSET : (S.coins[asset]?.symbol || 'balance'))); if (v === 0n) delete ac.bal[asset]; else ac.bal[asset] = String(v); mark('a:' + a); }
  const value = (k) => { const id = k.slice(2); return k[0] === 'a' ? canon(S.accounts[id]) : k[0] === 'c' ? canon(S.coins[id]) : k[0] === 'l' ? canon(S.links[id]) : k[0] === 'w' ? canon(S.withdrawals[id]) : canon({ fees: S.fees }); };
  function stateRoot() {
    if (root) return root;
    for (const k of stale) leaves.set(k, leaf(k, value(k))); stale.clear();
    return (root = hex(merkle([...leaves.keys()].sort().map((k) => leaves.get(k)))));
  }
  for (const a in S.accounts) stale.add('a:' + a); for (const c in S.coins) stale.add('c:' + c); for (const l in S.links) stale.add('l:' + l); for (const w in S.withdrawals) stale.add('w:' + w); stale.add('p:fees');

  // ---------- the curve ----------
  const VT0 = RULES.virtualTokens * UNIT, CURVE = RULES.curveTokens * UNIT, VS0 = BigInt(A.virtualAsset);
  function quoteBuy(c, grossIn) {
    const vS = BigInt(c.vS), vT = BigInt(c.vT), k = vS * vT, left = CURVE - BigInt(c.sold);
    let fee = grossIn * RULES.feeBps / 10000n, net = grossIn - fee, out = vT - cdiv(k, vS + net);
    if (out >= left) { out = left; net = cdiv(k, vT - left) - vS; fee = cdiv(net * RULES.feeBps, 10000n - RULES.feeBps); }
    return { out, net, fee, spent: net + fee, completes: out === left };
  }
  function quoteSell(c, tokensIn) { const vS = BigInt(c.vS), vT = BigInt(c.vT), gross = vS - cdiv(vS * vT, vT + tokensIn), fee = gross * RULES.feeBps / 10000n; return { gross, fee, out: gross - fee }; }
  const price = (c) => Number(BigInt(c.vS) * 10n ** 12n / BigInt(c.vT)) / 1e12 * 10 ** RULES.coinDecimals / 10 ** A.decimals; // asset per whole token
  function candle(c, ts, p, vol) { const t = Math.floor(ts / 60000) * 60, k = c.candles, last = k[k.length - 1]; if (last && last[0] === t) { last[2] = Math.max(last[2], p); last[3] = Math.min(last[3], p); last[4] = p; last[5] += vol; } else { k.push([t, last ? last[4] : p, Math.max(p, last ? last[4] : p), Math.min(p, last ? last[4] : p), p, vol]); if (k.length > KEEP_CANDLES) k.shift(); } }
  function payFee(c, fee) { const cut = fee * RULES.creatorShare / 100n; move(c.creator, ASSET, cut); S.fees = String(BigInt(S.fees) + fee - cut); mark('p:fees'); return cut; }
  function buy(c, from, grossIn, minOut, ts) {
    if (c.status !== 'curve') fail('This curve is complete');
    if (grossIn <= 0n) fail('Amount must be more than zero');
    const q = quoteBuy(c, grossIn); if (q.out <= 0n) fail('Amount is too small'); if (q.out < minOut) fail('Price moved past your limit');
    move(from, ASSET, -q.spent); move(from, c.id, q.out); payFee(c, q.fee);
    c.vS = String(BigInt(c.vS) + q.net); c.vT = String(BigInt(c.vT) - q.out); c.sold = String(BigInt(c.sold) + q.out); c.real = String(BigInt(c.real) + q.net); c.volume = String(BigInt(c.volume) + q.spent); c.trades++;
    if (q.completes) { c.status = c.publicGraduation ? 'graduating' : 'complete'; c.completedAt = ts; }
    candle(c, ts, price(c), Number(q.spent) / 10 ** A.decimals); mark('c:' + c.id); return q;
  }

  // ---------- transactions ----------
  const note = (a, e) => { const h = (S.hist[a] ||= []); h.push(e); if (h.length > KEEP_HIST) h.shift(); };
  const H = {
    'pay.transfer'(tx, ctx) { const { to, asset, amount, memo } = tx.body, n = big(amount); if (!A.isAddress(to)) fail('That is not a valid address'); const dst = A.norm(to); if (dst === tx.from) fail('You cannot pay yourself'); if (n <= 0n) fail('Amount must be more than zero'); if (asset !== ASSET && !S.coins[asset]) fail('Unknown asset'); if (memo !== undefined && (typeof memo !== 'string' || memo.length > 140)) fail('Memo is limited to 140 characters');
      move(tx.from, asset, -n); move(dst, asset, n); note(dst, { hash: ctx.hash, type: 'pay.receive', ts: ctx.ts, height: ctx.height, status: 'ok', asset, amount: String(n), memo }); return { asset, amount: '-' + n, to: dst, memo }; },
    'pay.link.create'(tx, ctx) { const { asset, amount, claimHash, expiresAt } = tx.body, n = big(amount); if (n <= 0n) fail('Amount must be more than zero'); if (asset !== ASSET && !S.coins[asset]) fail('Unknown asset'); if (typeof claimHash !== 'string' || !/^[0-9a-f]{64}$/.test(claimHash)) fail('claimHash must be a SHA256 in hex'); if (!Number.isInteger(expiresAt) || expiresAt <= ctx.ts || expiresAt > ctx.ts + RULES.linkMaxDays * 864e5) fail('A pay link can stay open for up to ' + RULES.linkMaxDays + ' days');
      const id = ctx.hash.slice(0, 20); move(tx.from, asset, -n); S.links[id] = { id, from: tx.from, asset, amount: String(n), claimHash, expiresAt, status: 'open', createdAt: ctx.ts }; mark('l:' + id); return { asset, amount: '-' + n, link: id }; },
    'pay.link.claim'(tx, ctx) { const { id, secret } = tx.body, l = S.links[id]; if (!l) fail('No such pay link'); if (l.status !== 'open') fail('This pay link was already ' + l.status); if (ctx.ts > l.expiresAt) fail('This pay link has expired'); if (typeof secret !== 'string' || hex(sha(secret)) !== l.claimHash) fail('Wrong secret for this pay link');
      l.status = 'claimed'; l.claimedAt = ctx.ts; mark('l:' + id); move(tx.from, l.asset, BigInt(l.amount)); return { asset: l.asset, amount: l.amount, link: id }; },
    'pay.link.cancel'(tx, ctx) { const l = S.links[tx.body.id]; if (!l || l.from !== tx.from) fail('No such pay link'); if (l.status !== 'open') fail('This pay link was already ' + l.status); l.status = 'cancelled'; l.cancelledAt = ctx.ts; mark('l:' + l.id); move(tx.from, l.asset, BigInt(l.amount)); return { asset: l.asset, amount: l.amount, link: l.id }; },
    'coin.launch'(tx, ctx) { const { name, symbol, publicGraduation, uri, initialBuy } = tx.body; if (typeof name !== 'string' || !name.trim() || name.length > 32) fail('Name must be 1 to 32 characters'); if (typeof symbol !== 'string' || !/^[A-Za-z0-9]{1,10}$/.test(symbol)) fail('Symbol must be 1 to 10 letters or digits'); if (uri !== undefined && (typeof uri !== 'string' || uri.length > 300 || !/^https:\/\//.test(uri))) fail('Image must be an https link');
      const id = ctx.hash.slice(0, 24), c = S.coins[id] = { id, name: name.trim(), symbol: symbol.toUpperCase(), uri: uri || '', publicGraduation: !!publicGraduation, creator: tx.from, status: 'curve', vS: String(VS0), vT: String(VT0), sold: '0', real: '0', volume: '0', trades: 0, createdAt: ctx.ts, candles: [], claims: 0 }; mark('c:' + id);
      const first = initialBuy !== undefined ? big(initialBuy, 'initialBuy') : 0n; let q = null; try { if (first > 0n) q = buy(c, tx.from, first, 0n, ctx.ts); } catch (e) { delete S.coins[id]; leaves.delete('c:' + id); stale.delete('c:' + id); root = null; throw e; } return { coin: id, asset: ASSET, amount: q ? '-' + q.spent : '0', tokens: q ? String(q.out) : '0' }; },
    'coin.buy'(tx, ctx) { const c = S.coins[tx.body.coin]; if (!c) fail('No such coin'); const q = buy(c, tx.from, big(tx.body.solIn ?? tx.body.amountIn, 'solIn'), big(tx.body.minOut ?? '0', 'minOut'), ctx.ts); return { coin: c.id, asset: ASSET, amount: '-' + q.spent, tokens: String(q.out) }; },
    'coin.sell'(tx, ctx) { const c = S.coins[tx.body.coin]; if (!c) fail('No such coin'); if (c.status === 'graduating' || c.status === 'graduated') fail('This coin has left the curve. Claim it instead'); const n = big(tx.body.amountIn, 'amountIn'); if (n <= 0n) fail('Amount must be more than zero'); const q = quoteSell(c, n); if (q.out <= 0n) fail('Amount is too small'); if (q.out < big(tx.body.minSolOut ?? tx.body.minOut ?? '0', 'minOut')) fail('Price moved past your limit');
      move(tx.from, c.id, -n); move(tx.from, ASSET, q.out); payFee(c, q.fee); c.vS = String(BigInt(c.vS) - q.gross); c.vT = String(BigInt(c.vT) + n); c.sold = String(BigInt(c.sold) - n); c.real = String(BigInt(c.real) - q.gross); c.volume = String(BigInt(c.volume) + q.gross); c.trades++; if (c.status === 'complete') c.status = 'curve';
      candle(c, ctx.ts, price(c), Number(q.gross) / 10 ** A.decimals); mark('c:' + c.id); return { coin: c.id, asset: ASSET, amount: String(q.out), tokens: '-' + n }; },
    'coin.graduate.claim'(tx, ctx) { const c = S.coins[tx.body.coin]; if (!c) fail('No such coin'); if (c.status !== 'graduating' && c.status !== 'graduated') fail('This coin has not graduated'); if (!A.isAddress(tx.body.to)) fail('That is not a valid ' + A.name + ' address'); const n = bal(tx.from, c.id); if (n <= 0n) fail('You hold none of this coin');
      move(tx.from, c.id, -n); const id = 'g' + (++S.wseq); S.withdrawals[id] = { id, kind: 'claim', from: tx.from, coin: c.id, asset: c.id, amount: String(n), to: A.norm(tx.body.to), status: 'queued', ts: ctx.ts }; c.claims++; mark('c:' + c.id); mark('w:' + id); return { coin: c.id, tokens: '-' + n, withdrawal: id }; },
    'bridge.withdraw'(tx, ctx) { const { asset, amount, to } = tx.body, n = big(amount); if (asset !== ASSET) fail('Only ' + ASSET + ' leaves through the door'); if (!A.isAddress(to)) fail('That is not a valid ' + A.name + ' address'); if (n < BigInt(A.minWithdraw)) fail('The smallest withdrawal is ' + A.minWithdrawText);
      move(tx.from, ASSET, -n); const id = 'w' + (++S.wseq); S.withdrawals[id] = { id, kind: 'withdraw', from: tx.from, asset, amount: String(n), to: A.norm(to), status: 'queued', ts: ctx.ts }; mark('w:' + id); return { asset, amount: '-' + n, withdrawal: id }; },
  };
  // System transactions: value entering and leaving through the door. They carry no signature and can only be queued by the node itself.
  const SYS = {
    'sys.deposit'(b, ctx) { move(b.to, ASSET, BigInt(b.amount)); note(b.to, { hash: ctx.hash, type: 'sys.deposit', ts: ctx.ts, height: ctx.height, status: 'ok', asset: ASSET, amount: b.amount, l1: b.l1 }); },
    'sys.payout'(b, ctx) { const w = S.withdrawals[b.id]; w.status = 'paid'; w.l1 = b.l1; w.paidAt = ctx.ts; mark('w:' + w.id); note(w.from, { hash: ctx.hash, type: 'sys.payout', ts: ctx.ts, height: ctx.height, status: 'ok', asset: w.asset, amount: w.amount, l1: b.l1, to: w.to }); },
    'sys.refund'(b, ctx) { const w = S.withdrawals[b.id]; if (w.status === 'paid' || w.status === 'refunded') return; w.status = 'refunded'; w.reason = b.reason; mark('w:' + w.id); move(w.from, w.asset, BigInt(w.amount)); note(w.from, { hash: ctx.hash, type: 'sys.refund', ts: ctx.ts, height: ctx.height, status: 'ok', asset: w.asset, amount: w.amount }); },
  };

  const pool = [], waiting = new Map(), pendingNonce = new Map(), listeners = new Set();
  const unsigned = (tx) => ({ chainId: tx.chainId, from: tx.from, nonce: tx.nonce, type: tx.type, body: tx.body });
  const signBytes = (tx) => Buffer.from(TXTAG + canon(unsigned(tx)), 'utf8');
  function submit(raw) {
    if (!raw || typeof raw !== 'object') fail('Send a JSON transaction');
    if (raw.chainId !== A.chainId) fail('Wrong chainId. This chain is ' + A.chainId);
    if (!H[raw.type]) fail('Unknown transaction type');
    if (!raw.body || typeof raw.body !== 'object' || Array.isArray(raw.body)) fail('Transaction body is missing');
    if (!A.isAddress(raw.from)) fail('Sender is not a valid address');
    const tx = { chainId: raw.chainId, from: A.norm(raw.from), nonce: raw.nonce, type: raw.type, body: raw.body, sig: raw.sig }, bytes = signBytes({ ...tx, from: raw.from });
    if (bytes.length > 4000) fail('Transaction is too large');
    if (typeof tx.sig !== 'string' || !A.verify(raw.from, bytes, tx.sig)) fail('Signature does not match the sender', 401);
    const expect = (S.accounts[tx.from]?.nonce || 0) + (pendingNonce.get(tx.from) || 0);
    if (tx.nonce !== expect) fail('Wrong nonce. The next one is ' + expect, 409);
    if (pool.length >= RULES.maxTxs * 20) fail('The chain is busy. Try again in a moment', 503);
    tx.hash = hex(sha(bytes)); pendingNonce.set(tx.from, (pendingNonce.get(tx.from) || 0) + 1); pool.push(tx);
    return tx.hash;
  }
  const system = (type, body) => { const tx = { sys: true, type, body, hash: hex(sha(A.tag + ' sys v1\n' + canon({ type, body, n: ++S.wseq }))) }; pool.push(tx); touch(); return tx.hash; };
  const record = (hash, pub) => { S.txs[hash] = pub; S.txOrder.push(hash); while (S.txOrder.length > KEEP_TXS) delete S.txs[S.txOrder.shift()]; };

  function produce(now = Date.now()) {
    const last = S.blocks[S.blocks.length - 1];
    if (!pool.length && last && now - last.timestamp < RULES.quietMs) return null;
    const txs = pool.splice(0, RULES.maxTxs), height = S.height + 1, ctxBase = { ts: now, height }, done = [];
    for (const tx of txs) {
      const ctx = { ...ctxBase, hash: tx.hash }; let status = 'ok', error, result;
      if (tx.sys) { try { SYS[tx.type](tx.body, ctx); } catch (e) { status = 'failed'; error = e.message; console.error('system tx failed', tx.type, e); } }
      else {
        const left = (pendingNonce.get(tx.from) || 1) - 1; if (left) pendingNonce.set(tx.from, left); else pendingNonce.delete(tx.from);
        const ac = acct(tx.from);
        try { if (tx.nonce !== ac.nonce) fail('Wrong nonce'); result = H[tx.type](tx, ctx); }
        catch (e) { status = 'failed'; error = e instanceof TxError ? e.message : 'Transaction could not be applied'; if (!(e instanceof TxError)) console.error(e); }
        acct(tx.from).nonce = tx.nonce + 1; mark('a:' + tx.from);
        note(tx.from, { hash: tx.hash, type: tx.type, ts: now, height, status, error, ...(result || {}) });
      }
      record(tx.hash, { hash: tx.hash, type: tx.type, status, height, ts: now }); done.push({ tx, status, error, result });
    }
    const header = { height, parentHash: S.lastHash, timestamp: now, txCount: txs.length, txRoot: hex(merkle(txs.map((t) => Buffer.from(t.hash, 'hex')))), stateRoot: stateRoot() };
    const hash = hex(sha(canon(header))), block = { ...header, hash, sig: hex(edSign(null, Buffer.from(hash, 'hex'), PKEY)), txs: txs.map((t) => t.hash) };
    S.blocks.push(block); while (S.blocks.length > KEEP_BLOCKS) { S.blocks.shift(); S.base++; }
    S.height = height; S.lastHash = hash; S.txCount += txs.length; if (sealing) S.unsealed.push([hash, txs.length]); touch();
    for (const d of done) { const w = waiting.get(d.tx.hash); if (w) { waiting.delete(d.tx.hash); w({ hash: d.tx.hash, status: d.status, error: d.error, height, result: d.result }); } }
    const pub = publicBlock(block); for (const fn of listeners) { try { fn(pub); } catch {} }
    return block;
  }
  const wait = (hash, ms = 8000) => new Promise((ok) => { const t = setTimeout(() => { waiting.delete(hash); ok({ hash, status: 'pending' }); }, ms); waiting.set(hash, (r) => { clearTimeout(t); ok(r); }); });

  // ---------- receipts: a forward-only hash chain over ranges of blocks ----------
  let sealing = false, sealBusy = false;
  function nextReceipt(limit) {
    if (!S.unsealed.length) return null;
    const from = S.sealed.to + 1, list = S.unsealed.slice(0, limit || undefined), to = from + list.length - 1, lastBlock = getBlock(to); if (!lastBlock) return null;
    const txs = list.reduce((n, x) => n + x[1], 0), blocksRoot = hex(merkle(list.map((x) => Buffer.from(x[0], 'hex')))), r = { from, to, txs, blocksRoot, stateRoot: lastBlock.stateRoot, lastBlockHash: lastBlock.hash };
    r.checkpoint = hex(sha(Buffer.from(S.sealed.checkpoint, 'hex'), u64(from), u64(to), Buffer.from(blocksRoot, 'hex'), Buffer.from(r.stateRoot, 'hex'), Buffer.from(r.lastBlockHash, 'hex'), u64(txs)));
    return r;
  }
  // Turn sealing on. The first time, receipts start at the next block. After a restart the list of unsealed blocks must line up with the chain head.
  function enableSealing() {
    if (sealing) return; sealing = true;
    if (!S.sealOn) { S.sealOn = true; S.sealed.to = S.height; S.unsealed = []; touch(); return; }
    if (S.sealed.to + S.unsealed.length === S.height) return;
    const rebuilt = []; for (let h = S.sealed.to + 1; h <= S.height; h++) { const b = getBlock(h); if (!b) { console.error('sealing gap: blocks ' + (S.sealed.to + 1) + ' to ' + S.height + ' can no longer be sealed in order'); S.sealed.to = S.height; S.unsealed = []; touch(); return; } rebuilt.push([b.hash, b.txCount]); }
    S.unsealed = rebuilt; touch();
  }
  async function seal(write, limit) { // write(receipt, prevCheckpoint) resolves to the settlement transaction id
    if (sealBusy || !sealing) return; const r = nextReceipt(limit); if (!r) return; sealBusy = true;
    try { r.l1 = await write(r, S.sealed.checkpoint); r.ts = Date.now(); S.receipts.push(r); if (S.receipts.length > KEEP_RECEIPTS) S.receipts.shift(); S.unsealed.splice(0, r.to - r.from + 1); S.sealed = { to: r.to, checkpoint: r.checkpoint, count: S.sealed.count + 1 }; touch(); }
    finally { sealBusy = false; }
  }

  // ---------- reads ----------
  const getBlock = (h) => S.blocks[h - S.base] || null;
  const receiptFor = (h) => { for (let i = S.receipts.length - 1; i >= 0; i--) { const r = S.receipts[i]; if (h > r.to) return null; if (h >= r.from) return r; } return null; };
  const publicBlock = (b) => b && { height: b.height, hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp, txCount: b.txCount, txRoot: b.txRoot, stateRoot: b.stateRoot, sig: b.sig, txs: b.txs, receipt: receiptFor(b.height)?.l1 || null };
  const findBlock = (id) => publicBlock(/^\d+$/.test(id) ? getBlock(+id) : S.blocks.find((b) => b.hash === id));
  function coinView(c, usd = 0) { const p = price(c), sold = Number(BigInt(c.sold) / UNIT); return { id: c.id, name: c.name, symbol: c.symbol, uri: c.uri, status: c.status, publicGraduation: c.publicGraduation, price: p, priceUsd: p * usd, marketCapUsd: p * Number(RULES.supply) * usd, marketCap: p * Number(RULES.supply), progress: sold / Number(RULES.curveTokens), volume: c.volume, volumeUsd: Number(BigInt(c.volume)) / 10 ** A.decimals * usd, trades: c.trades, createdAt: c.createdAt, change: change(c) }; }
  const change = (c) => { const k = c.candles; if (k.length < 1) return 0; const cut = Date.now() / 1000 - 86400; let o = k[0][1]; for (const x of k) if (x[0] >= cut) { o = x[1]; break; } return o ? (k[k.length - 1][4] - o) / o : 0; };
  function verifyAuth(pubkey, ts, sig, now = Date.now()) { if (!A.isAddress(pubkey || '')) return null; const t = +ts; if (!Number.isFinite(t) || Math.abs(now - t) > RULES.authMs) return null; return A.verify(pubkey, Buffer.from(AUTHTAG + pubkey + '\n' + ts, 'utf8'), sig || '') ? A.norm(pubkey) : null; }
  function me(a) {
    const ac = S.accounts[a] || { nonce: 0, bal: {} };
    return { address: a, nonce: ac.nonce, balances: Object.entries(ac.bal).map(([asset, amount]) => ({ asset, amount, symbol: asset === ASSET ? ASSET : S.coins[asset]?.symbol, name: asset === ASSET ? A.assetName : S.coins[asset]?.name, decimals: asset === ASSET ? A.decimals : RULES.coinDecimals, price: asset === ASSET ? 1 : (S.coins[asset] ? price(S.coins[asset]) : 0), status: S.coins[asset]?.status })),
      created: Object.values(S.coins).filter((c) => c.creator === a).map((c) => c.id) };
  }

  return {
    A, RULES, PRODUCER, get S() { return S; }, submit, system, produce, wait, seal, enableSealing, nextReceipt, save, touch, stateRoot, getBlock, findBlock, publicBlock, coinView, verifyAuth, me, quoteBuy, quoteSell, price, bal,
    get sealing() { return sealing; }, nonce: (a) => (S.accounts[a]?.nonce || 0) + (pendingNonce.get(a) || 0), onBlock: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    history: (a) => (S.hist[a] || []).slice().reverse(), links: (a) => Object.values(S.links).filter((l) => l.from === a).sort((x, y) => y.createdAt - x.createdAt).slice(0, 100),
    withdrawalsOf: (a) => Object.values(S.withdrawals).filter((w) => w.from === a).sort((x, y) => y.ts - x.ts).slice(0, 100),
    linkPublic: (id) => { const l = S.links[id]; return l ? { id: l.id, asset: l.asset, symbol: l.asset === ASSET ? ASSET : S.coins[l.asset]?.symbol, decimals: l.asset === ASSET ? A.decimals : RULES.coinDecimals, amount: l.amount, status: l.status === 'open' && Date.now() > l.expiresAt ? 'expired' : l.status, expiresAt: l.expiresAt } : null; },
  };
}
