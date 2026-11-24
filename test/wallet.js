// Test wallets for this chain: Solana keys signing the way a wallet's signMessage does.
import { generateKeyPairSync, sign } from 'node:crypto';
import { b58enc } from '../server/sol.js';
export const TAG = 'NYX', CHAIN_ID = 'nyx-1', ASSET = 'SOL', ONE = 1_000_000_000n, OUTSIDE = '4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T';
export function wallet() { const k = generateKeyPairSync('ed25519'); return { address: b58enc(k.publicKey.export({ format: 'der', type: 'spki' }).subarray(12)), sign: (m) => b58enc(sign(null, Buffer.from(m, 'utf8'), k.privateKey)) }; }
