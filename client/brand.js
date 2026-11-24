// Everything that names this chain in the browser. The rest of the client reads from here.
window.BRAND = {
  name: 'NYX', ticker: '$NYX', tag: 'NYX', chainId: 'nyx-1', settles: 'Solana', asset: 'SOL', decimals: 9, wallet: 'sol', walletName: 'Phantom',
  x: '', buy: '',
  tx: (id) => 'https://solscan.io/tx/' + id, account: (a) => 'https://solscan.io/account/' + a,
  // scene: corona colours (linear RGB-ish, 0..1) and the shape of the light
  scene: { a: [0.60, 0.27, 1.00], b: [0.08, 0.95, 0.58], hot: [1.0, 0.95, 0.90], rays: 1.0, ring: [0.72, 0.52, 1.0], sealed: [0.20, 0.98, 0.66] },
};
