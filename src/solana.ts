// =============================================================================
// BotWallet Recovery — Solana Transaction Builder
// =============================================================================
//
// Minimal Solana transaction construction for sweeping funds. Hand-rolled to
// avoid pulling in @solana/web3.js (~400KB) and to keep the recovery tool
// small and auditable.
//
// Supports:
//   - SOL native transfers (System Program)
//   - Dynamic SPL token discovery (all tokens, not just USDC)
//   - SPL token transfers (Token Program)
//   - Associated Token Account (ATA) derivation + creation
//   - Fee estimation for ATA creation
//   - Transaction serialization in the legacy (v0) format
//
// All RPC calls go to public Solana endpoints — no BotWallet infrastructure.
//
// =============================================================================

import { base58 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";

// -- Constants ----------------------------------------------------------------

const MAINNET_RPCS = [
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
  "https://api.mainnet-beta.solana.com",
];

const DEVNET_RPCS = [
  "https://api.devnet.solana.com",
];

const SYSTEM_PROGRAM_B58 = "11111111111111111111111111111111";
const TOKEN_PROGRAM_B58 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM_B58 = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const FALLBACK_RENT_PER_ATA = 2039280n;
const FALLBACK_TX_FEE = 5000n;
const TOKEN_ACCOUNT_SIZE = 165; // bytes for an SPL token account
const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 50_000; // per compute unit
const DEFAULT_COMPUTE_UNITS = 200_000;
const COMPUTE_BUDGET_PROGRAM_B58 = "ComputeBudget111111111111111111111111111111";

const KNOWN_TOKENS: Record<string, { symbol: string; name: string }> = {
  // Mainnet
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { symbol: "USDC", name: "USD Coin" },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", name: "Tether USD" },
  "So11111111111111111111111111111111111111112":      { symbol: "wSOL", name: "Wrapped SOL" },
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So":  { symbol: "mSOL", name: "Marinade SOL" },
  "7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj": { symbol: "stSOL", name: "Lido Staked SOL" },
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": { symbol: "BONK", name: "Bonk" },
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN":  { symbol: "JUP", name: "Jupiter" },
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": { symbol: "WIF", name: "dogwifhat" },
  "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof":  { symbol: "RNDR", name: "Render" },
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3": { symbol: "PYTH", name: "Pyth Network" },
  // Devnet common
  "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr": { symbol: "USDC-Dev", name: "USDC (Devnet)" },
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": { symbol: "USDC-Dev", name: "USDC (Devnet)" },
};

export type Network = "mainnet-beta" | "devnet";

export interface TokenBalance {
  mint: string;
  amount: bigint;
  decimals: number;
  ataAddress: string;
  symbol?: string;
  name?: string;
}

let customRpcUrl: string | null = null;

export function setCustomRpcUrl(url: string | null) {
  customRpcUrl = url;
}

export function getCustomRpcUrl(): string | null {
  return customRpcUrl;
}

function getRpcUrls(network: Network): string[] {
  if (customRpcUrl) return [customRpcUrl];
  return network === "mainnet-beta" ? MAINNET_RPCS : DEVNET_RPCS;
}

function getRpcUrl(network: Network): string {
  return getRpcUrls(network)[0];
}

// -- Base58 helpers -----------------------------------------------------------

function b58decode(s: string): Uint8Array {
  return base58.decode(s);
}

function b58encode(bytes: Uint8Array): string {
  return base58.encode(bytes);
}

// -- RPC helpers --------------------------------------------------------------

async function rpcCallSingle(
  url: string,
  method: string,
  params: unknown[]
): Promise<unknown> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }

  const json = (await resp.json()) as {
    result?: unknown;
    error?: { message: string; code: number };
  };

  if (json.error) {
    throw new Error(`${json.error.message} (${json.error.code})`);
  }

  return json.result;
}

async function rpcCall(
  network: Network,
  method: string,
  params: unknown[]
): Promise<unknown> {
  const urls = getRpcUrls(network);
  let lastError: Error | null = null;

  for (const url of urls) {
    try {
      return await rpcCallSingle(url, method, params);
    } catch (e) {
      lastError = e as Error;
    }
  }

  throw new Error(`All RPC endpoints failed. Last error: ${lastError?.message}`);
}

// -- Public API: Balance queries ----------------------------------------------

export async function getSolBalance(
  address: string,
  network: Network
): Promise<number> {
  const result = (await rpcCall(network, "getBalance", [
    address,
    { commitment: "confirmed" },
  ])) as { value: number };
  return result.value;
}

/**
 * Discover all SPL token accounts owned by this address with non-zero balances.
 */
export async function getAllTokenBalances(
  ownerAddress: string,
  network: Network
): Promise<TokenBalance[]> {
  const result = (await rpcCall(network, "getTokenAccountsByOwner", [
    ownerAddress,
    { programId: TOKEN_PROGRAM_B58 },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ])) as {
    value: Array<{
      pubkey: string;
      account: {
        data: {
          parsed: {
            info: {
              mint: string;
              tokenAmount: { amount: string; decimals: number };
            };
          };
        };
      };
    }>;
  };

  return result.value
    .map((entry) => {
      const info = entry.account.data.parsed.info;
      const amount = BigInt(info.tokenAmount.amount);
      const known = KNOWN_TOKENS[info.mint];
      return {
        mint: info.mint,
        amount,
        decimals: info.tokenAmount.decimals,
        ataAddress: entry.pubkey,
        symbol: known?.symbol,
        name: known?.name,
      };
    })
    .filter((t) => t.amount > 0n);
}

export async function getRecentBlockhash(
  network: Network
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const result = (await rpcCall(network, "getLatestBlockhash", [
    { commitment: "confirmed" },
  ])) as { value: { blockhash: string; lastValidBlockHeight: number } };
  return result.value;
}

async function getRentExemption(
  dataSize: number,
  network: Network
): Promise<bigint> {
  try {
    const result = (await rpcCall(
      network,
      "getMinimumBalanceForRentExemption",
      [dataSize]
    )) as number;
    return BigInt(result);
  } catch {
    return FALLBACK_RENT_PER_ATA;
  }
}

/**
 * Check if an account exists on-chain.
 */
async function accountExists(
  address: string,
  network: Network
): Promise<boolean> {
  try {
    const result = (await rpcCall(network, "getAccountInfo", [
      address,
      { encoding: "base64", commitment: "confirmed" },
    ])) as { value: unknown | null };
    return result.value !== null;
  } catch {
    return false;
  }
}

// -- Fee estimation -----------------------------------------------------------

/**
 * Estimate the SOL needed to execute the sweep transaction.
 * Accounts for base tx fee + ATA creation rent for each token
 * whose destination ATA doesn't exist yet.
 */
export async function estimateRequiredSol(
  toAddress: string,
  tokens: TokenBalance[],
  network: Network
): Promise<{ totalLamports: bigint; ataCreations: number; rentPerAta: bigint }> {
  let ataCreations = 0;

  for (const token of tokens) {
    const destAta = await deriveATA(toAddress, token.mint);
    const destAtaB58 = b58encode(destAta);
    const exists = await accountExists(destAtaB58, network);
    if (!exists) ataCreations++;
  }

  const rentPerAta = await getRentExemption(TOKEN_ACCOUNT_SIZE, network);
  const priorityFeeLamports = BigInt(
    Math.ceil((DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS * DEFAULT_COMPUTE_UNITS) / 1_000_000)
  );
  const totalLamports =
    FALLBACK_TX_FEE + priorityFeeLamports + BigInt(ataCreations) * rentPerAta;
  return { totalLamports, ataCreations, rentPerAta };
}

// -- ATA derivation -----------------------------------------------------------

async function deriveATA(
  owner: string,
  mint: string
): Promise<Uint8Array> {
  const ownerBytes = b58decode(owner);
  const mintBytes = b58decode(mint);
  const ataProgramBytes = b58decode(ATA_PROGRAM_B58);
  const tokenProgramBytes = b58decode(TOKEN_PROGRAM_B58);

  return findProgramAddress(
    [ownerBytes, tokenProgramBytes, mintBytes],
    ataProgramBytes
  );
}

async function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array
): Promise<Uint8Array> {
  const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");
  const { ed25519 } = await import("@noble/curves/ed25519");

  for (let bump = 255; bump >= 0; bump--) {
    const parts = [
      ...seeds,
      new Uint8Array([bump]),
      programId,
      PDA_MARKER,
    ];
    const totalLen = parts.reduce((s, a) => s + a.length, 0);
    const buffer = new Uint8Array(totalLen);
    let offset = 0;
    for (const part of parts) {
      buffer.set(part, offset);
      offset += part.length;
    }
    const hash = sha256(buffer);
    try {
      ed25519.ExtendedPoint.fromHex(hash);
      continue;
    } catch {
      return hash;
    }
  }
  throw new Error("Could not find PDA");
}

// -- Transaction building -----------------------------------------------------

function encodeCompactU16(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>= 7;
  }
  bytes.push(v);
  return new Uint8Array(bytes);
}

function encodeLittleEndian64(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
}

interface Instruction {
  programId: Uint8Array;
  keys: { pubkey: Uint8Array; isSigner: boolean; isWritable: boolean }[];
  data: Uint8Array;
}

interface TransactionInstruction {
  programIdIndex: number;
  accountIndices: number[];
  data: Uint8Array;
}

function buildTransactionMessage(
  feePayer: Uint8Array,
  instructions: Instruction[],
  recentBlockhash: string
): Uint8Array {
  const accountMap = new Map<
    string,
    { pubkey: Uint8Array; isSigner: boolean; isWritable: boolean }
  >();

  const feePayerKey = b58encode(feePayer);
  accountMap.set(feePayerKey, {
    pubkey: feePayer,
    isSigner: true,
    isWritable: true,
  });

  for (const ix of instructions) {
    for (const key of ix.keys) {
      const keyStr = b58encode(key.pubkey);
      const existing = accountMap.get(keyStr);
      if (existing) {
        existing.isSigner = existing.isSigner || key.isSigner;
        existing.isWritable = existing.isWritable || key.isWritable;
      } else {
        accountMap.set(keyStr, { ...key });
      }
    }

    const progKey = b58encode(ix.programId);
    if (!accountMap.has(progKey)) {
      accountMap.set(progKey, {
        pubkey: ix.programId,
        isSigner: false,
        isWritable: false,
      });
    }
  }

  const accounts = Array.from(accountMap.values());
  const feePayerAccount = accounts.find(
    (a) => b58encode(a.pubkey) === feePayerKey
  )!;
  const others = accounts.filter(
    (a) => b58encode(a.pubkey) !== feePayerKey
  );

  others.sort((a, b) => {
    if (a.isSigner !== b.isSigner) return a.isSigner ? -1 : 1;
    if (a.isWritable !== b.isWritable) return a.isWritable ? -1 : 1;
    return 0;
  });

  const sortedAccounts = [feePayerAccount, ...others];

  let numRequiredSignatures = 0;
  let numReadonlySignedAccounts = 0;
  let numReadonlyUnsignedAccounts = 0;

  for (const acc of sortedAccounts) {
    if (acc.isSigner) {
      numRequiredSignatures++;
      if (!acc.isWritable) numReadonlySignedAccounts++;
    } else {
      if (!acc.isWritable) numReadonlyUnsignedAccounts++;
    }
  }

  const accountIndex = new Map<string, number>();
  sortedAccounts.forEach((acc, i) => {
    accountIndex.set(b58encode(acc.pubkey), i);
  });

  const encodedInstructions: TransactionInstruction[] = instructions.map(
    (ix) => ({
      programIdIndex: accountIndex.get(b58encode(ix.programId))!,
      accountIndices: ix.keys.map(
        (k) => accountIndex.get(b58encode(k.pubkey))!
      ),
      data: ix.data,
    })
  );

  const parts: Uint8Array[] = [];

  parts.push(
    new Uint8Array([
      numRequiredSignatures,
      numReadonlySignedAccounts,
      numReadonlyUnsignedAccounts,
    ])
  );

  parts.push(encodeCompactU16(sortedAccounts.length));
  for (const acc of sortedAccounts) {
    parts.push(acc.pubkey);
  }

  parts.push(b58decode(recentBlockhash));

  parts.push(encodeCompactU16(encodedInstructions.length));
  for (const ix of encodedInstructions) {
    parts.push(new Uint8Array([ix.programIdIndex]));
    parts.push(encodeCompactU16(ix.accountIndices.length));
    parts.push(new Uint8Array(ix.accountIndices));
    parts.push(encodeCompactU16(ix.data.length));
    parts.push(ix.data);
  }

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const message = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    message.set(part, offset);
    offset += part.length;
  }

  return message;
}

// -- Instruction builders -----------------------------------------------------

function buildSetComputeUnitLimitInstruction(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2; // SetComputeUnitLimit discriminator
  new DataView(data.buffer).setUint32(1, units, true);
  return {
    programId: b58decode(COMPUTE_BUDGET_PROGRAM_B58),
    keys: [],
    data,
  };
}

function buildSetComputeUnitPriceInstruction(microLamports: number): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3; // SetComputeUnitPrice discriminator
  data.set(encodeLittleEndian64(BigInt(microLamports)), 1);
  return {
    programId: b58decode(COMPUTE_BUDGET_PROGRAM_B58),
    keys: [],
    data,
  };
}

function buildSolTransferInstruction(
  from: Uint8Array,
  to: Uint8Array,
  lamports: bigint
): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  data.set(encodeLittleEndian64(lamports), 4);

  return {
    programId: b58decode(SYSTEM_PROGRAM_B58),
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data,
  };
}

function buildSplTransferInstruction(
  sourceAta: Uint8Array,
  destAta: Uint8Array,
  owner: Uint8Array,
  amount: bigint
): Instruction {
  const data = new Uint8Array(9);
  data[0] = 3;
  data.set(encodeLittleEndian64(amount), 1);

  return {
    programId: b58decode(TOKEN_PROGRAM_B58),
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: destAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  };
}

function buildCreateAtaInstruction(
  payer: Uint8Array,
  ata: Uint8Array,
  owner: Uint8Array,
  mint: Uint8Array
): Instruction {
  return {
    programId: b58decode(ATA_PROGRAM_B58),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: b58decode(SYSTEM_PROGRAM_B58), isSigner: false, isWritable: false },
      { pubkey: b58decode(TOKEN_PROGRAM_B58), isSigner: false, isWritable: false },
    ],
    data: new Uint8Array(0),
  };
}

// -- Public API: Build sweep transaction --------------------------------------

export interface SweepParams {
  fromPubkey: Uint8Array;
  toAddress: string;
  solLamports: bigint;
  tokens: TokenBalance[];
  network: Network;
}

/**
 * Build transaction message(s) for sweeping all funds to a destination.
 * Handles SOL + all discovered SPL tokens.
 */
export async function buildSweepTransaction(
  params: SweepParams
): Promise<{ message: Uint8Array; blockhash: string; lastValidBlockHeight: number }> {
  const { fromPubkey, toAddress, solLamports, tokens, network } = params;
  const toPubkey = b58decode(toAddress);

  const instructions: Instruction[] = [];

  // Compute budget: set unit limit and priority fee so tx lands during congestion
  instructions.push(buildSetComputeUnitLimitInstruction(DEFAULT_COMPUTE_UNITS));
  instructions.push(buildSetComputeUnitPriceInstruction(DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS));

  let ataCreations = 0;
  const rentPerAta = await getRentExemption(TOKEN_ACCOUNT_SIZE, network);

  // SPL token transfers
  for (const token of tokens) {
    const destAta = await deriveATA(toAddress, token.mint);
    const destAtaB58 = b58encode(destAta);

    const exists = await accountExists(destAtaB58, network);
    if (!exists) {
      ataCreations++;
      instructions.push(
        buildCreateAtaInstruction(
          fromPubkey,
          destAta,
          toPubkey,
          b58decode(token.mint)
        )
      );
    }

    instructions.push(
      buildSplTransferInstruction(
        b58decode(token.ataAddress),
        destAta,
        fromPubkey,
        token.amount
      )
    );
  }

  // SOL transfer — reserve for base fee + priority fee + ATA rent
  const priorityFeeLamports = BigInt(
    Math.ceil((DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS * DEFAULT_COMPUTE_UNITS) / 1_000_000)
  );
  const feeReserve =
    FALLBACK_TX_FEE + priorityFeeLamports + BigInt(ataCreations) * rentPerAta;
  if (solLamports > feeReserve) {
    const transferAmount = solLamports - feeReserve;
    instructions.push(buildSolTransferInstruction(fromPubkey, toPubkey, transferAmount));
  }

  if (instructions.length <= 2) {
    throw new Error("No funds to sweep");
  }

  const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(network);
  const message = buildTransactionMessage(fromPubkey, instructions, blockhash);

  return { message, blockhash, lastValidBlockHeight };
}

/**
 * Assemble a signed transaction from message + signature and submit to Solana.
 */
export async function submitSignedTransaction(
  message: Uint8Array,
  signature: Uint8Array,
  network: Network
): Promise<string> {
  const numSigs = encodeCompactU16(1);
  const totalLen = numSigs.length + 64 + message.length;
  const wire = new Uint8Array(totalLen);
  let offset = 0;
  wire.set(numSigs, offset);
  offset += numSigs.length;
  wire.set(signature, offset);
  offset += 64;
  wire.set(message, offset);

  const txBase64 = btoa(String.fromCharCode(...wire));

  const result = (await rpcCall(network, "sendTransaction", [
    txBase64,
    {
      encoding: "base64",
      skipPreflight: false,
      preflightCommitment: "confirmed",
    },
  ])) as string;

  return result;
}

// -- Public API: Address utilities --------------------------------------------

export function isValidSolanaAddress(address: string): boolean {
  try {
    const bytes = b58decode(address);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

export function pubkeyToAddress(pubkey: Uint8Array): string {
  return b58encode(pubkey);
}

export function getExplorerUrl(
  signature: string,
  network: Network
): string {
  const cluster = network === "devnet" ? "?cluster=devnet" : "";
  return `https://solscan.io/tx/${signature}${cluster}`;
}

export function formatSol(lamports: bigint): string {
  const sol = Number(lamports) / 1e9;
  return sol.toFixed(6);
}

export function formatTokenAmount(amount: bigint, decimals: number): string {
  const divisor = 10 ** decimals;
  const value = Number(amount) / divisor;
  return decimals <= 2 ? value.toFixed(2) : value.toFixed(Math.min(decimals, 6));
}

export function shortenAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

export { b58decode, getRpcUrl };
