/* eslint-disable no-console */

// -----------------------------
// wallet.js (Modular)
// -----------------------------
// Why this file exists:
// - Connects to TronLink (window.tronWeb)
// - Reads USDT TRC20 balance
// - Updates global header balance component + SELL-only balance box
//
// NOTE: We use a shared namespace to avoid memory crashes/circular deps.

window.P2P = window.P2P || {};
window.P2P.utils = window.P2P.utils || {};

// Formats numbers to 2 decimals consistently across modules.
window.P2P.utils.format2 = window.P2P.utils.format2 || function format2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0.00";
  return x.toFixed(2);
};

// Lightweight toast helper (ads.js can override style; same API everywhere).
window.P2P.toast =
  window.P2P.toast ||
  function toast(message) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = message;
    el.style.display = "block";
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(() => {
      el.style.display = "none";
    }, 2600);
  };

// ---- Tron / USDT ----
const USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

window.P2P.state = window.P2P.state || {};
window.P2P.state.tronWeb = window.P2P.state.tronWeb || null;
window.P2P.state.connectedAddress = window.P2P.state.connectedAddress || null;
window.P2P.state.headerBalanceInterval = window.P2P.state.headerBalanceInterval || null;

// Reads TRC20 USDT balance from TronLink.
window.P2P.getUSDTBalance =
  window.P2P.getUSDTBalance ||
  async function getUSDTBalance(address) {
    try {
      const tronWeb = window.P2P.state.tronWeb;
      if (!tronWeb || !address) return 0;
      const contract = await tronWeb.contract().at(USDT_CONTRACT);
      const raw = await contract.balanceOf(address).call();
      return Number(raw) / 1e6;
    } catch (e) {
      console.error("balance error", e);
      return 0;
    }
  };

// Updates the SELL-only box "available" text on Create Ad.
window.P2P.refreshWalletBalanceUI =
  window.P2P.refreshWalletBalanceUI ||
  async function refreshWalletBalanceUI() {
    const balanceEl = document.getElementById("walletBalance");
    if (!balanceEl) return;

    const addr = window.P2P.state.connectedAddress;
    if (!addr) {
      balanceEl.textContent = "0.00";
      return;
    }
    const bal = await window.P2P.getUSDTBalance(addr);
    balanceEl.textContent = window.P2P.utils.format2(bal);
  };

// Updates the global header balance component.
window.P2P.refreshHeaderBalanceUI =
  window.P2P.refreshHeaderBalanceUI ||
  async function refreshHeaderBalanceUI() {
    const wrap = document.getElementById("headerBalance");
    const textEl = document.getElementById("headerBalanceText");
    if (!wrap || !textEl) return;

    const addr = window.P2P.state.connectedAddress;
    const bal = addr ? await window.P2P.getUSDTBalance(addr) : 0;

    textEl.textContent = `رصيدك: ${window.P2P.utils.format2(bal)} USDT`;
    wrap.classList.remove("balanceChip--ok", "balanceChip--zero");
    wrap.classList.add(bal > 0 ? "balanceChip--ok" : "balanceChip--zero");
  };

// Connects to TronLink so we can read balances and attach merchantAddress.
window.P2P.connectWallet =
  window.P2P.connectWallet ||
  async function connectWallet() {
    try {
      if (window.tronLink && typeof window.tronLink.request === "function") {
        await window.tronLink.request({ method: "tron_requestAccounts" });
      }

      if (!window.tronWeb) {
        window.P2P.toast("يرجى تثبيت/فتح TronLink");
        return;
      }

      window.P2P.state.tronWeb = window.tronWeb;
      const addr = window.tronWeb?.defaultAddress?.base58 || null;
      window.P2P.state.connectedAddress = addr;

      if (!addr) {
        window.P2P.toast("فشل ربط المحفظة");
        return;
      }

      const btn = document.getElementById("connectBtn");
      if (btn) {
        btn.classList.remove("chip--danger");
        btn.classList.add("chip--ok");
        btn.innerHTML = `<i class="fa-solid fa-circle-check"></i><span>${addr.slice(0, 4)}...${addr.slice(-4)}</span>`;
      }

      await window.P2P.refreshWalletBalanceUI();
      await window.P2P.refreshHeaderBalanceUI();

      // Let other modules refresh when wallet connects.
      document.dispatchEvent(new CustomEvent("p2p:walletConnected", { detail: { address: addr } }));

      // Periodic refresh (prevents stale header).
      if (window.P2P.state.headerBalanceInterval) clearInterval(window.P2P.state.headerBalanceInterval);
      window.P2P.state.headerBalanceInterval = setInterval(() => {
        if (window.P2P.state.connectedAddress) window.P2P.refreshHeaderBalanceUI();
      }, 15000);
    } catch (e) {
      console.error(e);
      window.P2P.toast("فشل ربط المحفظة");
    }
  };

// Backwards-compatible global hook used by existing HTML.
window.connectWallet = () => window.P2P.connectWallet();

