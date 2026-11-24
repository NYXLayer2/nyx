// Local preview: a dev-mode node with a few coins and trades so every page has something to show.  node test/dev.js
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { canon } from '../server/core.js';
import { wallet, TAG, CHAIN_ID, ONE } from './wallet.js';
const DATA = path.join(os.tmpdir(), TAG.toLowerCase() + '-dev.json'); try { fs.unlinkSync(DATA); } catch {}
Object.assign(process.env, { L2_DEV: '1', DATA_PATH: DATA, RECEIPT_MS: '6000' });
const { A } = await import('../server/chain.js'); await import('../server/index.js');
const BASE = 'http://127.0.0.1:' + (process.env.PORT || A.port), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
async function send(w, type, body) { const { nonce } = await (await fetch(BASE + '/api/nonce/' + w.address)).json(), u = { chainId: CHAIN_ID, from: w.address, nonce, type, body }; return post('/api/tx?wait=1', { ...u, sig: w.sign(TAG + ' tx v1\n' + canon(u)) }); }
await sleep(800); const ws = [wallet(), wallet(), wallet(), wallet()]; for (const w of ws) await post('/api/dev/credit', { to: w.address, amount: String(400n * ONE) }); await sleep(1500);
const coins = []; for (const [name, symbol, first] of [['Midnight Oil', 'OIL', 3n], ['Blackout', 'DARK', 12n], ['Quiet Money', 'HUSHH', 1n], ['Umbral Cat', 'UCAT', 40n], ['New Moon', 'MOON', 6n]]) { const r = await send(ws[coins.length % 4], 'coin.launch', { name, symbol, publicGraduation: coins.length % 2 === 0, initialBuy: String(first * ONE / 10n) }); coins.push(r.result.coin); }
console.log('seeded ' + coins.length + ' coins; trading in the background');
for (;;) { const w = ws[Math.floor(Math.random() * 4)], coin = coins[Math.floor(Math.random() * coins.length)]; await send(w, 'coin.buy', { coin, solIn: String(BigInt(Math.floor(Math.random() * 40) + 1) * ONE / 100n), minOut: '0' }).catch(() => {}); await sleep(1500 + Math.random() * 5000); }
