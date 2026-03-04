# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in the BotWallet Recovery Tool, please report it responsibly.

**Email:** security@botwallet.co

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and provide an estimated timeline for a fix. We will not take legal action against security researchers who follow responsible disclosure practices.

## Scope

This policy covers:
- The recovery tool source code (`src/crypto.ts`, `src/solana.ts`, `src/main.ts`)
- The built single-file output (`dist/index.html`)
- The cryptographic derivation and signing logic

## Out of Scope

- Vulnerabilities in third-party dependencies (@noble/curves, @scure/bip39, etc.) — please report these to their respective maintainers
- Social engineering or phishing attacks that trick users into entering mnemonics on fake sites
- Malware on the user's machine (keyloggers, screen capture)
- Issues with Solana's RPC endpoints or blockchain

## Cryptographic Design Decisions

The following are intentional design choices, not vulnerabilities:

- **Raw scalar signing** — The tool signs using a raw Ed25519 scalar rather than a standard seed. This is necessary because FROST key shares produce unclamped scalars that cannot be represented as standard Ed25519 seeds.
- **Deterministic nonces via SHA-512(scalar || message)** — This provides the same safety guarantees as RFC 8032's deterministic nonce derivation, just with a different key material input.
- **Unminified output** — The built HTML file is intentionally unminified to enable source code auditing.
