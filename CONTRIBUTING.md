# Contributing

Thanks for looking. NYX is one Node.js program with no dependencies.

## Getting set up

```bash
git clone https://github.com/NYXLayer2/nyx
cd nyx
npm start            # http://localhost:8312
npm test             # end-to-end: real ed25519 signatures against a throwaway node
```

Node 22 or newer.

## Where things live

- `server/core.js` is the chain: accounts, transactions, blocks, the curve, pay links and receipts.
- `server/sol.js` is the Solana adapter. Nothing else knows which chain NYX settles to.
- `server/bridge.js` credits deposits, pays withdrawals once and writes receipts.
- `server/index.js` is the HTTP layer; `server/start.js` is the front door that keeps the site up.
- `client/` is the site: one HTML file per page, a shared `style.css` and `common.js`.
- `test/` holds the end-to-end suites.

## Making a change

1. Branch from `dev`.
2. Keep the change small and add a check that fails without it.
3. Run `npm test` and `node test/front.js`.
4. Open a pull request against `dev`, and say which tests you ran.

Security issues go through [private reporting](https://github.com/NYXLayer2/nyx/security/advisories/new), not pull requests.
