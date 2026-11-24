# Security

The code that matters most is the signature and settlement path: every transaction is checked against its owner's ed25519 key and nonce in `server/core.js`, and every deposit and payout passes through `server/bridge.js` and `server/sol.js`.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: [report a vulnerability](https://github.com/NYXLayer2/nyx/security/advisories/new). Include the steps to reproduce and what you observed. Please do not open a public issue for anything in the list below.

You will get an acknowledgement within 72 hours and a fix or a written assessment within 14 days.

## In scope

- Accepting a transaction whose signature does not verify, or replaying a signed one (nonce handling)
- Moving or minting balance without a valid signature from the owner
- Crediting a deposit that did not arrive, crediting one twice, or paying a withdrawal more than once
- Reading another account's private balance or history through the owner-only API
- Forging or reordering block receipts, or breaking the receipt hash chain
- Halting block production or corrupting chain state from the public API

## Supported versions

The `main` branch and the latest tag.
