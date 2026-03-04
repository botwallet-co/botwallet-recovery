// =============================================================================
// BotWallet Recovery Tool — Main Application
// =============================================================================
//
// Orchestrates the multi-step recovery flow:
//   Step 1: Enter S1 mnemonic (12 words — agent key share)
//   Step 2: Enter S2 mnemonic (12 words — server key share)
//   Step 3: Verify derived wallet address
//   Step 4: Enter destination Solana address
//   Step 5: Review balances and confirm sweep
//   Step 6: Transaction result
//
// All secret material is handled in-memory only and zeroed after use.
// No data is sent anywhere except Solana's public RPC for balance checks
// and transaction submission.
//
// =============================================================================

import "./styles.css";
import { validateShareMnemonic, derivePublicKey, signWithCombinedKey } from "./crypto";
import {
  getSolBalance,
  getAllTokenBalances,
  estimateRequiredSol,
  buildSweepTransaction,
  submitSignedTransaction,
  pubkeyToAddress,
  isValidSolanaAddress,
  getExplorerUrl,
  formatSol,
  formatTokenAmount,
  shortenAddress,
  setCustomRpcUrl,
  getCustomRpcUrl,
  type Network,
  type TokenBalance,
} from "./solana";

// -- State --------------------------------------------------------------------

let currentStep = 1;
let mnemonic1 = "";
let mnemonic2 = "";
let walletAddress = "";
let walletPubkey: Uint8Array = new Uint8Array(0);
let destinationAddress = "";
let network: Network = "mainnet-beta";
let solBalance = 0n;
let tokenBalances: TokenBalance[] = [];
let requiredSolForFees = 0n;
let ataCreationsNeeded = 0;

// -- DOM helpers --------------------------------------------------------------

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function showStep(step: number) {
  for (let i = 1; i <= 6; i++) {
    const el = document.getElementById(`step-${i}`);
    if (el) el.classList.toggle("hidden", i !== step);
  }
  currentStep = step;
  updateProgress();
}

function updateProgress() {
  for (let i = 1; i <= 6; i++) {
    const dot = document.getElementById(`prog-${i}`);
    if (!dot) continue;
    dot.className = i < currentStep
      ? "w-2.5 h-2.5 rounded-full bg-white"
      : i === currentStep
        ? "w-2.5 h-2.5 rounded-full bg-white ring-2 ring-white/30 ring-offset-2 ring-offset-black"
        : "w-2.5 h-2.5 rounded-full bg-white/20";
  }
}

function setError(id: string, message: string) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = message;
    el.classList.remove("hidden");
  }
}

function clearError(id: string) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = "";
    el.classList.add("hidden");
  }
}

function setLoading(buttonId: string, loading: boolean) {
  const btn = document.getElementById(buttonId) as HTMLButtonElement;
  if (!btn) return;
  btn.disabled = loading;
  const spinner = btn.querySelector(".spinner");
  const label = btn.querySelector(".label");
  if (spinner) spinner.classList.toggle("hidden", !loading);
  if (label) label.classList.toggle("hidden", loading);
}

// -- Step handlers ------------------------------------------------------------

function handleStep1() {
  clearError("error-1");
  const input = (document.getElementById("mnemonic-1") as HTMLTextAreaElement).value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  const wordCount = input.split(" ").length;
  if (wordCount !== 12) {
    setError("error-1", `Expected 12 words, got ${wordCount}.`);
    return;
  }

  if (!validateShareMnemonic(input)) {
    setError("error-1", "Invalid mnemonic — check spelling and word order.");
    return;
  }

  mnemonic1 = input;
  showStep(2);
}

function handleStep2() {
  clearError("error-2");
  const input = (document.getElementById("mnemonic-2") as HTMLTextAreaElement).value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  const wordCount = input.split(" ").length;
  if (wordCount !== 12) {
    setError("error-2", `Expected 12 words, got ${wordCount}.`);
    return;
  }

  if (!validateShareMnemonic(input)) {
    setError("error-2", "Invalid mnemonic — check spelling and word order.");
    return;
  }

  if (input === mnemonic1) {
    setError("error-2", "S2 mnemonic is identical to S1. These must be different key shares.");
    return;
  }

  mnemonic2 = input;

  try {
    walletPubkey = derivePublicKey(mnemonic1, mnemonic2);
    walletAddress = pubkeyToAddress(walletPubkey);
  } catch (e) {
    setError("error-2", `Key derivation failed: ${(e as Error).message}`);
    return;
  }

  $("derived-address").textContent = walletAddress;
  $("explorer-link").setAttribute(
    "href",
    `https://solscan.io/account/${walletAddress}${network === "devnet" ? "?cluster=devnet" : ""}`
  );
  showStep(3);
}

function handleStep3Confirm() {
  showStep(4);
}

function handleStep3Back() {
  showStep(2);
}

async function handleStep4() {
  clearError("error-4");
  const rpcHelp = document.getElementById("rpc-help");
  if (rpcHelp) rpcHelp.classList.add("hidden");
  const input = (document.getElementById("dest-address") as HTMLInputElement).value.trim();

  if (!isValidSolanaAddress(input)) {
    setError("error-4", "Invalid Solana address.");
    return;
  }

  if (input === walletAddress) {
    setError("error-4", "Destination cannot be the same as the source wallet.");
    return;
  }

  destinationAddress = input;
  setLoading("btn-step-4", true);

  try {
    const [sol, tokens] = await Promise.all([
      getSolBalance(walletAddress, network),
      getAllTokenBalances(walletAddress, network),
    ]);

    solBalance = BigInt(sol);
    tokenBalances = tokens;

    if (solBalance === 0n && tokenBalances.length === 0) {
      const net = network === "mainnet-beta" ? "Mainnet" : "Devnet";
      const short = shortenAddress(walletAddress);
      setError(
        "error-4",
        `Your source wallet (${short}) has no SOL or tokens on ${net}. ` +
        `Make sure you're on the correct network — use the toggle in the top-right to switch between Mainnet and Devnet. ` +
        `If this is the right network, the wallet may need at least ~0.005 SOL to cover transaction fees.`
      );
      setLoading("btn-step-4", false);
      return;
    }

    // Estimate fees for ATA creation
    const feeEstimate = await estimateRequiredSol(destinationAddress, tokenBalances, network);
    requiredSolForFees = feeEstimate.totalLamports;
    ataCreationsNeeded = feeEstimate.ataCreations;

    // Check if there's enough SOL for fees
    if (tokenBalances.length > 0 && solBalance < requiredSolForFees) {
      const needed = formatSol(requiredSolForFees);
      const have = formatSol(solBalance);
      setError(
        "error-4",
        `Insufficient SOL for transaction fees. Need ~${needed} SOL (have ${have} SOL). ` +
        `Send at least ${needed} SOL to ${walletAddress} and try again.`
      );
      setLoading("btn-step-4", false);

      // Show the deposit address prominently
      const depositInfo = document.getElementById("deposit-info");
      if (depositInfo) {
        depositInfo.classList.remove("hidden");
        const addrEl = document.getElementById("deposit-address");
        if (addrEl) addrEl.textContent = walletAddress;
      }
      return;
    }

    // Hide deposit info if previously shown
    const depositInfo = document.getElementById("deposit-info");
    if (depositInfo) depositInfo.classList.add("hidden");

    // Render review UI
    renderReview();
    showStep(5);
  } catch (e) {
    const msg = (e as Error).message;
    setError("error-4", `Failed to fetch balances: ${msg}`);
    showRpcHelpIfNeeded(msg);
  } finally {
    setLoading("btn-step-4", false);
  }
}

function renderReview() {
  // Reset confirmation checkbox each time review is shown
  const cb = document.getElementById("confirm-checkbox") as HTMLInputElement;
  const signBtn = document.getElementById("btn-step-5") as HTMLButtonElement;
  if (cb) cb.checked = false;
  if (signBtn) signBtn.disabled = true;

  $("review-from").textContent = walletAddress;
  $("review-to").textContent = destinationAddress;

  // SOL balance
  const solAfterFees = solBalance > requiredSolForFees ? solBalance - requiredSolForFees - 5000n : 0n;
  $("review-sol").textContent = `${formatSol(solAfterFees)} SOL`;

  // Token list
  const tokenListEl = $("review-tokens");
  tokenListEl.innerHTML = "";

  if (tokenBalances.length === 0) {
    tokenListEl.innerHTML = `<p class="text-sm" style="color: #9A958F;">No SPL tokens found</p>`;
  } else {
    for (const token of tokenBalances) {
      const badge = token.symbol?.slice(0, 4) ?? token.mint.slice(0, 3);
      const displayName = token.name ?? "SPL Token";
      const subtitle = token.symbol
        ? `<span>${token.symbol}</span>`
        : `<span class="font-mono" title="${token.mint}">${shortenAddress(token.mint)}</span>`;

      const card = document.createElement("div");
      card.className = "card flex items-center justify-between";
      card.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-full flex items-center justify-center" style="background: linear-gradient(135deg, #22c55e15, #14b8a615); border: 1px solid #E0DBD6;">
            <span class="text-[10px] font-bold uppercase" style="color: #6B6560;">${badge}</span>
          </div>
          <div>
            <p class="text-sm font-semibold" style="color: #1A1817;">${displayName}</p>
            <p class="text-xs" style="color: #9A958F;">${subtitle}</p>
          </div>
        </div>
        <p class="font-mono text-base font-semibold" style="color: #1A1817;">${formatTokenAmount(token.amount, token.decimals)}</p>
      `;
      tokenListEl.appendChild(card);
    }
  }

  // Fee info
  if (ataCreationsNeeded > 0) {
    $("review-fees").textContent =
      `~${formatSol(requiredSolForFees)} SOL (tx fee + ${ataCreationsNeeded} token account${ataCreationsNeeded > 1 ? "s" : ""} to create)`;
  } else {
    $("review-fees").textContent = `~${formatSol(requiredSolForFees)} SOL (tx fee)`;
  }
}

function handleStep5Confirm() {
  clearError("error-5");

  // Populate and show the confirmation modal
  const modal = $("confirm-modal");
  const destEl = document.getElementById("modal-dest");
  const input = document.getElementById("confirm-input") as HTMLInputElement;
  const confirmBtn = document.getElementById("btn-modal-confirm") as HTMLButtonElement;

  if (destEl) destEl.textContent = destinationAddress;
  if (input) input.value = "";
  if (confirmBtn) confirmBtn.disabled = true;

  modal.classList.remove("hidden");
  if (input) input.focus();
}

async function executeTransaction() {
  const modal = $("confirm-modal");
  const confirmBtn = document.getElementById("btn-modal-confirm") as HTMLButtonElement;
  const spinner = confirmBtn?.querySelector(".spinner");
  const label = confirmBtn?.querySelector(".label");

  if (confirmBtn) confirmBtn.disabled = true;
  if (spinner) spinner.classList.remove("hidden");
  if (label) label.classList.add("hidden");

  try {
    const { message } = await buildSweepTransaction({
      fromPubkey: walletPubkey,
      toAddress: destinationAddress,
      solLamports: solBalance,
      tokens: tokenBalances,
      network,
    });

    const { signature } = signWithCombinedKey(mnemonic1, mnemonic2, message);
    const txSignature = await submitSignedTransaction(message, signature, network);

    $("tx-signature").textContent = txSignature;
    $("tx-explorer-link").setAttribute("href", getExplorerUrl(txSignature, network));

    mnemonic1 = "";
    mnemonic2 = "";
    (document.getElementById("mnemonic-1") as HTMLTextAreaElement).value = "";
    (document.getElementById("mnemonic-2") as HTMLTextAreaElement).value = "";

    modal.classList.add("hidden");
    showStep(6);
  } catch (e) {
    const msg = (e as Error).message;
    modal.classList.add("hidden");
    setError("error-5", `Transaction failed: ${msg}`);
    showRpcHelpIfNeeded(msg);
  } finally {
    if (spinner) spinner.classList.add("hidden");
    if (label) label.classList.remove("hidden");
    if (confirmBtn) confirmBtn.disabled = true;
    const input = document.getElementById("confirm-input") as HTMLInputElement;
    if (input) input.value = "";
  }
}

function handleStep5Back() {
  showStep(4);
}

function handleReset() {
  mnemonic1 = "";
  mnemonic2 = "";
  walletAddress = "";
  destinationAddress = "";
  solBalance = 0n;
  tokenBalances = [];
  (document.getElementById("mnemonic-1") as HTMLTextAreaElement).value = "";
  (document.getElementById("mnemonic-2") as HTMLTextAreaElement).value = "";
  (document.getElementById("dest-address") as HTMLInputElement).value = "";
  const depositInfo = document.getElementById("deposit-info");
  if (depositInfo) depositInfo.classList.add("hidden");
  showStep(1);
}

function showRpcHelpIfNeeded(errorMsg: string) {
  const isRpcError = errorMsg.includes("All RPC endpoints failed") ||
    errorMsg.includes("403") ||
    errorMsg.includes("429") ||
    errorMsg.includes("Failed to fetch");

  const helpEl = document.getElementById("rpc-help");
  if (helpEl) {
    helpEl.classList.toggle("hidden", !isRpcError);
  }
}

function handleNetworkToggle() {
  network = network === "mainnet-beta" ? "devnet" : "mainnet-beta";
  const label = $("network-label");
  label.textContent = network === "mainnet-beta" ? "Mainnet" : "Devnet";
  label.className = network === "mainnet-beta"
    ? "text-xs font-mono px-2 py-0.5 rounded bg-emerald-900/50 text-emerald-400 border border-emerald-800/50"
    : "text-xs font-mono px-2 py-0.5 rounded bg-amber-900/50 text-amber-400 border border-amber-800/50";
}

function handleRpcToggle() {
  $("rpc-panel").classList.toggle("hidden");
}

function updateRpcStatus() {
  const status = $("rpc-status");
  const current = getCustomRpcUrl();
  if (current) {
    status.textContent = `Using custom RPC: ${current.length > 40 ? current.slice(0, 40) + "..." : current}`;
    status.className = "text-xs mt-2 text-emerald-400/60";
  } else {
    status.textContent = "Using public RPC endpoints with automatic fallback.";
    status.className = "text-xs mt-2 text-white/30";
  }
}

function handleRpcSave() {
  const input = (document.getElementById("rpc-url-input") as HTMLInputElement).value.trim();
  if (!input) return;
  try {
    new URL(input);
  } catch {
    const status = $("rpc-status");
    status.textContent = "Invalid URL. Please enter a valid RPC endpoint.";
    status.className = "text-xs mt-2 text-red-400/80";
    return;
  }
  setCustomRpcUrl(input);
  updateRpcStatus();
}

function handleRpcClear() {
  setCustomRpcUrl(null);
  (document.getElementById("rpc-url-input") as HTMLInputElement).value = "";
  updateRpcStatus();
}

// -- Initialize ---------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  $("btn-step-1").addEventListener("click", handleStep1);
  $("btn-step-2").addEventListener("click", handleStep2);
  $("btn-step-3-confirm").addEventListener("click", handleStep3Confirm);
  $("btn-step-3-back").addEventListener("click", handleStep3Back);
  $("btn-step-4").addEventListener("click", handleStep4);
  $("btn-step-5").addEventListener("click", handleStep5Confirm);
  $("btn-step-5-back").addEventListener("click", handleStep5Back);
  $("btn-reset").addEventListener("click", handleReset);
  $("btn-network").addEventListener("click", handleNetworkToggle);

  $("btn-rpc-toggle").addEventListener("click", handleRpcToggle);
  $("btn-rpc-save").addEventListener("click", handleRpcSave);
  $("btn-rpc-clear").addEventListener("click", handleRpcClear);

  const dismissBtn = document.getElementById("btn-dismiss-banner");
  if (dismissBtn) {
    dismissBtn.addEventListener("click", () => {
      const banner = document.getElementById("security-banner");
      if (banner) banner.remove();
    });
  }

  const confirmCheckbox = document.getElementById("confirm-checkbox") as HTMLInputElement;
  const signBtn = document.getElementById("btn-step-5") as HTMLButtonElement;
  if (confirmCheckbox && signBtn) {
    confirmCheckbox.addEventListener("change", () => {
      signBtn.disabled = !confirmCheckbox.checked;
    });
  }

  const refreshBtn = document.getElementById("btn-refresh-balance");
  if (refreshBtn) refreshBtn.addEventListener("click", handleStep4);

  const rpcHelpBtn = document.getElementById("btn-open-rpc-from-help");
  if (rpcHelpBtn) {
    rpcHelpBtn.addEventListener("click", () => {
      $("rpc-panel").classList.remove("hidden");
      ($("rpc-url-input") as HTMLInputElement).focus();
    });
  }

  // Confirmation modal
  const modalInput = document.getElementById("confirm-input") as HTMLInputElement;
  const modalConfirmBtn = document.getElementById("btn-modal-confirm") as HTMLButtonElement;
  const modalCancelBtn = document.getElementById("btn-modal-cancel");

  if (modalInput && modalConfirmBtn) {
    modalInput.addEventListener("input", () => {
      modalConfirmBtn.disabled = modalInput.value.trim().toUpperCase() !== "CONFIRM";
    });
    modalConfirmBtn.addEventListener("click", executeTransaction);
  }

  if (modalCancelBtn) {
    modalCancelBtn.addEventListener("click", () => {
      $("confirm-modal").classList.add("hidden");
      const input = document.getElementById("confirm-input") as HTMLInputElement;
      if (input) input.value = "";
    });
  }

  // Close modal on backdrop click
  const modalOverlay = document.getElementById("confirm-modal");
  if (modalOverlay) {
    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) {
        modalOverlay.classList.add("hidden");
        const input = document.getElementById("confirm-input") as HTMLInputElement;
        if (input) input.value = "";
      }
    });
  }

  showStep(1);
});
