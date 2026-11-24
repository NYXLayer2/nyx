// Everything that names this chain in the browser. The rest of the client reads from here.
window.BRAND = {
  name: 'NYX', ticker: '$NYX', tag: 'NYX', chainId: 'nyx-1', settles: 'Solana', asset: 'SOL', decimals: 9, wallet: 'sol', walletName: 'Phantom',
  x: '', github: 'https://github.com/NYXLayer2/nyx', buy: '',
  faqDoor: 'Send SOL from your Solana wallet into the door, a vault on Solana. NYX credits the same address in a system transaction a few seconds after Solana confirms it. To leave, sign a withdrawal naming any Solana address: the amount leaves your balance in the same block and the door pays it out as SOL. Every payout happens exactly once, and a payout that can never succeed is refunded on NYX.',
  faqSeal: 'Every ten seconds NYX writes a receipt to Solana covering its newest blocks: the block range, a Merkle root over the block hashes, the state root, the last block hash and the transaction count, carried in a Memo instruction signed by the chain authority and chained to the receipt before it.',
  tx: (id) => 'https://solscan.io/tx/' + id, account: (a) => 'https://solscan.io/account/' + a,
  // scene: corona colours (linear RGB-ish, 0..1) and the shape of the light
  scene: { a: [0.60, 0.27, 1.00], b: [0.08, 0.95, 0.58], hot: [1.0, 0.95, 0.90], rays: 1.0, ring: [0.72, 0.52, 1.0], sealed: [0.20, 0.98, 0.66] },
};
