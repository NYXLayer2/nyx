# Changelog

All notable changes to NYX are listed here. Versions follow [Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.1.0] - 2026-11-24

First public release.

### Added

- **Chain.** Signed canonical-JSON transactions with nonces, one-second blocks with Merkle transaction and state roots, an ed25519 producer signature on every block.
- **Seal.** Block receipts written to Solana with the Memo program in a forward-only hash chain.
- **Door.** SOL deposits read from the door wallet and withdrawals paid exactly once.
- **Pay.** Private transfers and pay links.
- **Trade and Launch.** A bonding-curve launchpad with a fixed supply and a creator share of fees.
- **API.** Open JSON API, owner-only routes behind a wallet signature, a live block stream and an MCP endpoint.
- **Explorer, app and docs.**
- **Front door.** The site keeps answering, and public reads come from a last-good copy, while the node restarts.

[Unreleased]: https://github.com/NYXLayer2/nyx/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/NYXLayer2/nyx/releases/tag/v0.1.0
