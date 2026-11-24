// Solana by hand, with no dependencies: base58, RPC, ed25519, reading deposits into the door,
// signing payouts out of it, and writing block receipts with the Memo program.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz', B58I = Object.fromEntries([...B58].map((c, i) => [c, BigInt(i)]));
export function b58enc(bytes) { let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b === 0) s = '1' + s; else break; } return s; }
export function b58dec(str) { let n = 0n; for (const c of str) { const v = B58I[c]; if (v === undefined) throw new Error('not base58'); n = n * 58n + v; } const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; } for (const c of str) { if (c === '1') out.unshift(0); else break; } return Uint8Array.from(out); }
const isAddress = (s) => { try { return typeof s === 'string' && s.length >= 32 && s.length <= 44 && b58dec(s).length === 32; } catch { return false; } };
const SYSTEM = '11111111111111111111111111111111', MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex'), SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const verifySig = (raw32, message, signature) => { try { return verify(null, Buffer.from(message), createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(raw32)]), format: 'der', type: 'spki' }), Buffer.from(signature)); } catch { return false; } };
function signer(secret, name) {
  if (!secret) return null;
  try { const raw = secret.trim().startsWith('[') ? Uint8Array.from(JSON.parse(secret)) : b58dec(secret.trim()); if (raw.length !== 64) throw new Error('expected a 64-byte secret key');
    const key = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(raw.subarray(0, 32))]), format: 'der', type: 'pkcs8' });
    return { address: b58enc(raw.subarray(32)), sign: (m) => sign(null, Buffer.from(m), key) };
  } catch (e) { console.error(name + ' could not be read: ' + e.message); return null; }
}

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
async function rpc(method, params = []) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { last = new Error('Solana RPC is busy'); await new Promise((ok) => setTimeout(ok, 700 * (i + 1))); continue; }
      const j = await r.json(); if (j.error) throw new Error(j.error.message || 'RPC error'); return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}
const cat = (...p) => Buffer.concat(p.map((x) => Buffer.from(x)));
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const compact = (n) => (n < 128 ? [n] : [(n & 127) | 128, n >> 7]);
// Legacy messages. Transfer: payer and recipient writable, system program read-only. Memo: the payer signs, the memo program reads.
export const transferMessage = (from, to, blockhash, lamports) => cat([1, 0, 1, 3], b58dec(from), b58dec(to), b58dec(SYSTEM), b58dec(blockhash), [1, 2, 2, 0, 1, 12, 2, 0, 0, 0], u64le(lamports));
const memoMessage = (from, blockhash, text) => { const d = Buffer.from(text, 'utf8'); return cat([1, 0, 1, 2], b58dec(from), b58dec(MEMO), b58dec(blockhash), [1, 1, 1, 0], compact(d.length), d); };
async function signed(key, build) {
  const { blockhash, lastValidBlockHeight } = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value, message = build(blockhash), sig = key.sign(message);
  return { l1: b58enc(sig), raw: cat([1], sig, message).toString('base64'), expiry: lastValidBlockHeight };
}
const broadcast = (raw) => rpc('sendTransaction', [raw, { encoding: 'base64', skipPreflight: true, maxRetries: 5 }]);
async function status(l1, expiry) {
  const st = (await rpc('getSignatureStatuses', [[l1], { searchTransactionHistory: true }])).value[0];
  if (st) return st.err ? 'failed' : (st.confirmationStatus === 'processed' ? 'pending' : 'confirmed');
  return (await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) > expiry ? 'expired' : 'pending';
}

const DOOR = signer(process.env.DOOR_SECRET, 'DOOR_SECRET'), AUTH = signer(process.env.AUTHORITY_SECRET, 'AUTHORITY_SECRET') || DOOR, DOOR_ADDRESS = DOOR?.address || (isAddress(process.env.DOOR_ADDRESS) ? process.env.DOOR_ADDRESS : null);
let usd = { v: 0, at: 0 };

export const A = {
  port: 8312, name: 'Solana', tag: 'NYX', chainId: 'nyx-1', asset: 'SOL', assetName: 'Solana', decimals: 9, virtualAsset: '30000000000', minWithdraw: '1000000', minWithdrawText: '0.001 SOL',
  isAddress, norm: (s) => s, verify: (addr, bytes, sig) => { try { return verifySig(b58dec(addr), bytes, b58dec(sig)); } catch { return false; } },
  door: DOOR_ADDRESS, authority: AUTH?.address || null, canPay: !!DOOR, canSeal: !!AUTH, settlement: MEMO, settlementKind: 'Memo program',
  explorerTx: (id) => 'https://solscan.io/tx/' + id, explorerAddress: (a) => 'https://solscan.io/account/' + a,
  async usd() { if (Date.now() - usd.at > 60_000) { usd.at = Date.now(); try { const j = await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { signal: AbortSignal.timeout(8000) })).json(); if (j?.solana?.usd) usd.v = j.solana.usd; } catch {} } return usd.v; },
  blockhash: async () => (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash,
  // What one confirmed transaction paid into the door, and who paid it (the fee payer).
  async deposit(l1) {
    const tx = await rpc('getTransaction', [l1, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]); if (!tx) return null; if (tx.meta?.err) return { amount: 0n };
    const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey)), i = keys.indexOf(DOOR_ADDRESS); if (i < 0) return { amount: 0n };
    return { from: keys[0], amount: BigInt(tx.meta.postBalances[i] - tx.meta.preBalances[i]) };
  },
  // New transactions touching the door since the cursor, oldest first.
  async scan(cursor) { const list = await rpc('getSignaturesForAddress', [DOOR_ADDRESS, { limit: 50, ...(cursor ? { until: cursor } : {}), commitment: 'confirmed' }]); return list.filter((x) => !x.err).map((x) => x.signature).reverse(); },
  preparePayout: (to, amount) => signed(DOOR, (bh) => transferMessage(DOOR.address, to, bh, amount)),
  broadcast, status,
  async writeReceipt(r) {
    const text = [A.chainId, 'receipt', 'v1', r.from, r.to, r.txs, r.blocksRoot, r.stateRoot, r.lastBlockHash, r.checkpoint].join('|'), t = await signed(AUTH, (bh) => memoMessage(AUTH.address, bh, text));
    await broadcast(t.raw);
    for (let i = 0; i < 40; i++) { await new Promise((ok) => setTimeout(ok, 1500)); const s = await status(t.l1, t.expiry).catch(() => 'pending'); if (s === 'confirmed') return t.l1; if (s === 'failed') throw new Error('receipt transaction failed'); if (s === 'expired') throw new Error('receipt transaction expired'); if (i % 5 === 4) broadcast(t.raw).catch(() => {}); }
    throw new Error('receipt not confirmed in time');
  },
};
