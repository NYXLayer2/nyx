# NYX

[![license](https://img.shields.io/badge/license-MIT-8b5cf6)](LICENSE) [![node](https://img.shields.io/badge/node-%E2%89%A5%2022-8b5cf6)](.node-version) [![dependencies](https://img.shields.io/badge/dependencies-0-8b5cf6)](package.json) [![tests](https://img.shields.io/badge/end--to--end%20checks-89-8b5cf6)](test)

**[nyxlayer2.xyz](https://nyxlayer2.xyz)** · [Docs](https://nyxlayer2.xyz/docs) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

A private layer 2 on Solana. Balances, payments, trades and launches stay private, and every block is sealed to Solana.

- **The chain.** Signed transactions, one block a second, a Merkle state root in every block, an ed25519 producer signature on every block.
- **The seal.** Every ten seconds a receipt of the newest blocks is written to Solana in a forward-only hash chain.
- **The door.** A vault on Solana. SOL comes in with a plain transfer and leaves through payouts that each happen once.
- **Four rooms.** Hold, Pay (transfers and pay links), Trade (bonding curves), Launch.

One Node.js program, no dependencies.

## Quick start

```bash
git clone https://github.com/NYXLayer2/nyx
cd nyx
npm start          # http://localhost:8312
npm test           # 65 end-to-end checks against a throwaway node
```

Node 22 or newer. `node test/dev.js` starts a local preview with a few coins trading.

## How it fits together

```
browser ──signed tx──▶ front door (server/start.js) ──▶ node (server/index.js)
                                                          │
                              chain core (server/core.js) ┤  blocks, state root, receipts
                                 bridge (server/bridge.js)┤  deposits in, pay-once withdrawals out
                              Solana adapter (server/sol.js) ──▶ Solana (door wallet, Memo receipts)
```

| Path | What it is |
|---|---|
| `server/core.js` | Accounts, signed transactions with nonces, blocks with Merkle roots, the curve, pay links, receipts |
| `server/sol.js` | Solana by hand: base58, RPC, ed25519, deposits, payouts, Memo receipts |
| `server/bridge.js` | The door and the seal |
| `server/index.js` | Open API, owner-only API, live block stream, MCP endpoint |
| `server/start.js` | Front door: serves the site, proxies the API, restarts the node, answers reads from a last-good copy |
| `client/` | Landing page, app, explorer and docs |
| `test/` | End-to-end suites |

## Configuration

| Variable | What it does |
|---|---|
| `PORT` | Port to listen on. Default 8312. |
| `DATA_PATH` | Where the chain state file lives. Put it on a persistent disk. |
| `RPC_URL` | Solana RPC. Default is the public mainnet endpoint; use a paid one in production. |
| `DOOR_SECRET` | Secret key of the door wallet (base58). Deposits are read from it and withdrawals are paid from it. |
| `DOOR_ADDRESS` | Door address without the key: deposits are credited, withdrawals wait. |
| `AUTHORITY_SECRET` | Secret key that signs receipts on Solana. Defaults to the door key. |
| `TOKEN_MINT` | Contract address shown on the site. |

Keys are read from the environment only. Never commit them.

## Tests

```bash
npm test                 # 65 checks: signatures, nonces, transfers, pay links, the curve, withdrawals, block hashes,
                         # producer signatures, the receipt hash chain, malformed requests and a restart
node test/front.js       # 24 checks: the site keeps answering while the node behind it is stopped
```

## API

Open JSON API, owner-only API behind a wallet signature, a live block stream and an MCP endpoint at `/mcp`. See `/docs` on a running node.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through [private reporting](https://github.com/NYXLayer2/nyx/security/advisories/new).

## License

[MIT](LICENSE)
