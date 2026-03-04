// =============================================================================
// BotWallet Recovery — FROST Key Reconstruction
// =============================================================================
//
// Reconstructs a full Ed25519 signing scalar from two FROST 2-of-2 key share
// mnemonics (S1 + S2). This is the ONLY module that handles secret material.
//
// DERIVATION (must match both the Go CLI and the server TypeScript):
//   1. mnemonic → BIP39 entropy (16 bytes for 12-word mnemonic)
//   2. SHA-512(entropy || "botwallet/frost/v1/key-share") → 64 bytes
//   3. Reduce mod l → uniform Ed25519 scalar
//
// SIGNING:
//   Uses @noble/curves Ed25519 extended point arithmetic to sign with a raw
//   scalar directly, bypassing the standard seed→SHA-512→clamp path.
//
// LIBRARIES:
//   @scure/bip39 — audited BIP39 implementation by Paul Miller
//   @noble/hashes — audited SHA-512
//   @noble/curves — audited Ed25519
//
// =============================================================================

import { mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { sha512 } from "@noble/hashes/sha512";
import { ed25519 } from "@noble/curves/ed25519";

const DOMAIN_SEPARATOR = "botwallet/frost/v1/key-share";
const L = ed25519.CURVE.n;

// -- Helpers ------------------------------------------------------------------

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = result * 256n + BigInt(bytes[i]);
  }
  return result;
}

function numberToBytes32LE(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

function mod(a: bigint, m: bigint): bigint {
  const result = a % m;
  return result >= 0n ? result : result + m;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// -- Core derivation ----------------------------------------------------------

function scalarFromEntropy(entropy: Uint8Array): bigint {
  const domainBytes = new TextEncoder().encode(DOMAIN_SEPARATOR);
  const input = concatBytes(entropy, domainBytes);
  const digest = sha512(input);
  return mod(bytesToNumberLE(digest), L);
}

function scalarFromMnemonic(mnemonic: string): bigint {
  const entropy = mnemonicToEntropy(mnemonic, wordlist);
  return scalarFromEntropy(new Uint8Array(entropy));
}

// -- Public API ---------------------------------------------------------------

export function validateShareMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}

/**
 * Derive the wallet's public key (Solana address bytes) from both mnemonics.
 * Returns the 32-byte Ed25519 public key.
 */
export function derivePublicKey(
  mnemonic1: string,
  mnemonic2: string
): Uint8Array {
  const s1 = scalarFromMnemonic(mnemonic1);
  const s2 = scalarFromMnemonic(mnemonic2);
  const s = mod(s1 + s2, L);
  const pub = ed25519.ExtendedPoint.BASE.multiply(s);
  return pub.toRawBytes();
}

/**
 * Sign a message using the combined FROST scalar (s1 + s2).
 *
 * Standard Ed25519 signing derives the nonce deterministically from
 * SHA-512(seed)[32:64] || message. Since we have no seed (only a raw scalar),
 * we use a secure deterministic nonce: SHA-512(scalar_bytes || message).
 *
 * The resulting signature is a valid Ed25519 signature verifiable against
 * the group public key.
 */
export function signWithCombinedKey(
  mnemonic1: string,
  mnemonic2: string,
  message: Uint8Array
): { signature: Uint8Array; publicKey: Uint8Array } {
  const s1 = scalarFromMnemonic(mnemonic1);
  const s2 = scalarFromMnemonic(mnemonic2);
  const s = mod(s1 + s2, L);

  const G = ed25519.ExtendedPoint.BASE;
  const publicPoint = G.multiply(s);
  const publicKey = publicPoint.toRawBytes();

  // Deterministic nonce: r = SHA-512(s_bytes || message) mod l
  const sBytes = numberToBytes32LE(s);
  const nonceHash = sha512(concatBytes(sBytes, message));
  const r = mod(bytesToNumberLE(nonceHash), L);

  if (r === 0n) {
    throw new Error("Degenerate nonce — should never happen with SHA-512");
  }

  // R = r * G
  const R = G.multiply(r);
  const RBytes = R.toRawBytes();

  // Challenge: k = SHA-512(R || A || message) mod l
  const challengeHash = sha512(concatBytes(RBytes, publicKey, message));
  const k = mod(bytesToNumberLE(challengeHash), L);

  // Signature scalar: S = r + k * s  (mod l)
  const S = mod(r + k * s, L);

  // Ed25519 signature: R (32 bytes) || S (32 bytes)
  const signature = new Uint8Array(64);
  signature.set(RBytes, 0);
  signature.set(numberToBytes32LE(S), 32);

  // Zero out secret material
  sBytes.fill(0);

  return { signature, publicKey };
}
