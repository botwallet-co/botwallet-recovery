# BotWallet Recovery Tool

**Sweep funds from a BotWallet FROST 2-of-2 threshold wallet to any Solana address.**

A standalone, open-source tool that runs entirely in your browser. No servers, no dependencies on BotWallet infrastructure. Just your two 12-word backup mnemonics and a destination address.

---

## Overview

[BotWallet](https://botwallet.co) uses FROST 2-of-2 threshold signing to secure wallet funds. Every wallet's private key is split into two shares:

- **S1** — a 12-word mnemonic held by the AI agent
- **S2** — a 12-word mnemonic held by BotWallet's server (exportable by the wallet owner)

This tool combines both shares, reconstructs the full signing key, and transfers all funds (SOL + all SPL tokens) to any standard Solana address you choose — Phantom, Coinbase, an exchange, or any other wallet.

With both mnemonics backed up, you always have full access to your funds — even if BotWallet's servers are unreachable.

---

## Usage

1. Open the tool at [recovery.botwallet.co](https://recovery.botwallet.co) or download `dist/index.html` and open it locally
2. Enter your **S1 mnemonic** (12 words — from your agent's seed file)
3. Enter your **S2 mnemonic** (12 words — exported from BotWallet dashboard)
4. Verify the derived wallet address matches yours
5. Enter a destination Solana address
6. Review balances and confirm the sweep

For maximum security, disconnect from the internet before entering your mnemonics. Reconnect only when you're ready to submit the transaction.

---

## Why Not Just Import Into Phantom?

BotWallet's FROST key shares use a custom derivation path:

```
SHA-512(entropy ‖ "botwallet/frost/v1/key-share") → reduce mod l → scalar
```

Standard Solana wallets expect keys derived via `SHA-512(seed) → clamp → scalar`. The two paths are cryptographically incompatible — there's no seed phrase or private key you can paste into Phantom to access a FROST wallet.

This tool handles the difference by signing directly with the reconstructed scalar using `@noble/curves`, producing standard Ed25519 signatures that Solana accepts.

---

## How It Works

```
Input:  S1 mnemonic (12 words) + S2 mnemonic (12 words)

1. entropy₁ = BIP39_decode(S1_mnemonic)                          // 16 bytes
2. entropy₂ = BIP39_decode(S2_mnemonic)                          // 16 bytes
3. s₁ = reduce_mod_l(SHA-512(entropy₁ ‖ "botwallet/frost/v1/key-share"))
4. s₂ = reduce_mod_l(SHA-512(entropy₂ ‖ "botwallet/frost/v1/key-share"))
5. s  = s₁ + s₂  mod l                                          // Full signing key
6. A  = s × G                                                    // Public key (wallet address)
7. Discover all SPL token accounts via getTokenAccountsByOwner
8. Build Solana transfer transaction (all tokens + SOL → destination)
9. Sign with scalar s (deterministic nonce: SHA-512(s ‖ message))
10. Submit to Solana public RPC
```

---

## Security

- **Runs entirely in your browser** — your mnemonics never leave the page
- **No analytics, tracking, or telemetry** — zero external requests besides Solana RPC
- **Works offline** — signing happens locally; only the final submission needs internet
- **Unminified output** — the built HTML contains readable JavaScript you can audit
- **Single file** — `dist/index.html` has all JS and CSS inlined, no external dependencies at runtime

### Cryptographic Dependencies

All libraries are by [Paul Miller](https://paulmillr.com/) — audited, zero-dependency, widely used across the crypto ecosystem:

| Library | Purpose |
|---------|---------|
| [@scure/bip39](https://github.com/paulmillr/scure-bip39) | BIP39 mnemonic ↔ entropy |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) | SHA-512, SHA-256 |
| [@noble/curves](https://github.com/paulmillr/noble-curves) | Ed25519 scalar arithmetic and signing |
| [@scure/base](https://github.com/paulmillr/scure-base) | Base58 encoding |

---

## Verifying the Tool

**Compare the file hash** — after downloading, compute the SHA-256 hash and compare it against the hash in this repo's releases:

```bash
# macOS / Linux
shasum -a 256 botwallet-recovery.html

# Windows (PowerShell)
Get-FileHash botwallet-recovery.html -Algorithm SHA256
```

**Build from source** — clone, install, and build it yourself:

```bash
git clone https://github.com/botwallet-co/botwallet-recovery.git
cd botwallet-recovery
npm install
npm run build     # → dist/index.html
```

**Read the source** — the built HTML is intentionally unminified. Open it in a text editor and read the ~150 lines of crypto logic directly.

---

## Building from Source

```bash
# Prerequisites: Node.js 18+
git clone https://github.com/botwallet-co/botwallet-recovery.git
cd botwallet-recovery
npm install
npm run build     # → dist/index.html
npm run dev       # → local dev server at http://localhost:5173
```

---

## Project Structure

```
├── src/
│   ├── index.html    # UI — page layout and form elements
│   ├── main.ts       # Application logic — step orchestration, validation
│   ├── crypto.ts     # FROST key reconstruction + raw-scalar Ed25519 signing
│   ├── solana.ts     # Minimal Solana transaction builder + RPC client
│   └── styles.css    # Tailwind CSS
├── dist/
│   └── index.html    # Built single-file output (all JS/CSS inlined)
├── vite.config.ts
├── package.json
├── SECURITY.md
├── LICENSE           # MIT
└── README.md
```

---

## Where to Find Your Mnemonics

**S1 (Agent Key Share)** — stored on the machine running your AI agent at `~/.botwallet/seeds/<wallet-name>.seed`. You can also reveal it via the CLI: `botwallet wallet backup` → `botwallet wallet reveal-backup --code <code>`.

**S2 (Server Key Share)** — export from the BotWallet dashboard under your wallet's Settings → Export Server Share.

---

## FAQ

**Q: What tokens does this sweep?**
SOL (native) and all SPL tokens in the wallet. The tool dynamically discovers every token account — no hardcoded mint list.

**Q: What if my wallet has no SOL for fees?**
Solana requires SOL to pay transaction fees. If your wallet has tokens but no SOL, the tool will tell you exactly how much SOL to send (usually under 0.01 SOL) and provide a Refresh button to retry after you deposit.

**Q: Can I use a custom RPC endpoint?**
Yes. Edit the `MAINNET_RPC` constant in `src/solana.ts` and rebuild.

**Q: Is the deterministic nonce safe?**
Yes. The nonce is derived as `SHA-512(scalar ‖ message) mod l` — the same pattern as RFC 8032 Ed25519, with the same determinism and replay safety guarantees.

**Q: Does this work on devnet?**
Yes. Use the network toggle in the tool's header to switch between Mainnet and Devnet.

---

## License

MIT — see [LICENSE](LICENSE).

Built by [BotWallet](https://botwallet.co).
