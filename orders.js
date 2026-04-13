/* eslint-disable no-console */

// ------------------------------------------------------------
// orders.js (FULL REWRITE for OKX-style Order Creation)
// ------------------------------------------------------------
// Responsibilities:
// - Open order creation sheet (Buy/Sell) from an adId
// - Dual inputs Amount/Quantity with live calculation
// - 15 min payment window timer
// - Create an order via Firestore transaction
// - Orders list (tabs + actions) remains compatible

(function () {
  window.P2P = window.P2P || {};
  window.P2P.orders = window.P2P.orders || {};
  window.P2P.state = window.P2P.state || {};

  const db = window.db;
  const ORDER_WINDOW_MS = 15 * 60 * 1000;
  const ADS_COLLECTION = "ads";
  const ORDERS_COLLECTION = "Orders";

  window.P2P.state.ordersTab = window.P2P.state.ordersTab || "active";

  /** @type {null | {id: string, type: 'buy'|'sell', price: number, availableQuantity: number, merchantAddress: string, minLimit: number, maxLimit: number, paymentMethod: string}} */
  let selectedAd = null;
  /** @type {null | 'buy' | 'sell'} */
  let selectedAction = null; // user action: buy (pay EGP receive USDT) | sell (give USDT receive EGP)
  let unsubOrders = null;
  let orderTimerInterval = null;
  let orderExpiresAt = 0;

  function userActionForMarketTab(tab) {
    // Must match ads.js business logic.
    return tab === "sell" ? "sell" : "buy";
  }

  function userActionForAdType(adType) {
    // Must match ads.js business logic:
    // - merchant creates SELL ad => stored type 'sell' => user action is BUY
    // - merchant creates BUY ad  => stored type 'buy'  => user action is SELL
    return String(adType || "") === "sell" ? "buy" : "sell";
  }

  function isSelfTrade() {
    const me = String(window.P2P.state.connectedAddress || "");
    const owner = String(selectedAd?.merchantAddress || "");
    return !!me && !!owner && me === owner;
  }

  function setOrderHint(msg) {
    const hint = document.getElementById("orderHint");
    if (!hint) return;
    if (!msg) {
      hint.style.display = "none";
      hint.textContent = "";
      return;
    }
    hint.style.display = "block";
    hint.textContent = msg;
  }

  function paymentIconFor(method) {
    const m = String(method || "").toLowerCase();
    if (m.includes("vodafone")) return "fa-mobile-screen";
    if (m.includes("insta")) return "fa-building-columns";
    if (m.includes("etisalat")) return "fa-sim-card";
    if (m.includes("bank")) return "fa-building-columns";
    return "fa-credit-card";
  }

  function setOrderTimerUI() {
    const el = document.getElementById("orderTimer");
    if (!el) return;
    // UI requirement: keep this informational and non-prominent.
    el.textContent = "(15 min payment window)";
  }

  function stopOrderTimer() {
    if (orderTimerInterval) clearInterval(orderTimerInterval);
    orderTimerInterval = null;
    orderExpiresAt = 0;
  }

  function startOrderTimer() {
    stopOrderTimer();
    orderExpiresAt = Date.now() + ORDER_WINDOW_MS;
    setOrderTimerUI();
    orderTimerInterval = setInterval(() => {
      setOrderTimerUI();
      const btn = document.getElementById("orderActionBtn");
      if (btn && orderExpiresAt && Date.now() >= orderExpiresAt) btn.disabled = true;
      if (orderExpiresAt && Date.now() >= orderExpiresAt) stopOrderTimer();
    }, 500);
  }

  function setOrderActionUI(action) {
    const title = document.getElementById("orderTitle");
    const btn = document.getElementById("orderActionBtn");
    if (title) title.textContent = action === "sell" ? "Sell USDT" : "Buy USDT";
    if (btn) {
      btn.textContent = action === "sell" ? "Sell USDT with 0 Fees" : "Buy USDT with 0 Fees";
      btn.classList.toggle("primaryBtn--red", action === "sell");
    }
  }

  function setOrderPaymentUI(method) {
    const el = document.getElementById("orderPaymentMethod");
    const iconEl = document.getElementById("orderPaymentIcon");
    if (el) el.textContent = method || "—";
    if (iconEl) iconEl.className = `fa-solid ${paymentIconFor(method)}`;
  }

  function calcQtyFromAmount(amount, price) {
    const a = Number(amount) || 0;
    const p = Number(price) || 0;
    if (!(a > 0) || !(p > 0)) return 0;
    return a / p;
  }

  function calcAmountFromQty(qty, price) {
    const q = Number(qty) || 0;
    const p = Number(price) || 0;
    if (!(q > 0) || !(p > 0)) return 0;
    return q * p;
  }

  async function openOrder(adId) {
    if (!db) return window.P2P.toast("Firebase غير جاهز");
    if (!adId) return window.P2P.toast("الإعلان غير موجود");

    const doc = await db.collection(ADS_COLLECTION).doc(adId).get();
    if (!doc.exists) return window.P2P.toast("الإعلان غير موجود");

    const d = doc.data() || {};
    selectedAd = {
      id: doc.id,
      type: d.type,
      price: Number(d.price) || 0,
      availableQuantity: Number(d.availableQuantity ?? d.quantity) || 0,
      merchantAddress: String(d.merchantAddress || ""),
      minLimit: Number(d.minLimit) || 0,
      maxLimit: Number(d.maxLimit) || 0,
      paymentMethod: String(d.paymentMethod || ""),
    };
    selectedAction = userActionForAdType(selectedAd.type);

    document.getElementById("orderOverlay").style.display = "flex";
    document.getElementById("orderPrice").textContent = window.P2P.utils.format2(selectedAd.price);
    document.getElementById("orderAvailable").textContent = window.P2P.utils.format2(selectedAd.availableQuantity);
    document.getElementById("orderMinLimit").textContent = window.P2P.utils.format2(selectedAd.minLimit);
    document.getElementById("orderMaxLimit").textContent = window.P2P.utils.format2(selectedAd.maxLimit);
    setOrderPaymentUI(selectedAd.paymentMethod);

    setOrderActionUI(selectedAction);

    const amountIn = document.getElementById("orderAmountIn");
    const qtyIn = document.getElementById("orderQtyIn");
    if (amountIn) amountIn.value = "";
    if (qtyIn) qtyIn.value = "";

    startOrderTimer();
    await validateOrder();
  }

  function closeOrder() {
    document.getElementById("orderOverlay").style.display = "none";
    selectedAd = null;
    selectedAction = null;
    stopOrderTimer();
  }

  function onOrderAmountInput() {
    if (!selectedAd) return validateOrder();
    const amountIn = document.getElementById("orderAmountIn");
    const qtyIn = document.getElementById("orderQtyIn");
    const amount = Number(amountIn?.value || 0);
    const qty = calcQtyFromAmount(amount, selectedAd.price);
    if (qtyIn) qtyIn.value = qty > 0 ? window.P2P.utils.format2(qty) : "";
    validateOrder();
  }

  function onOrderQtyInput() {
    if (!selectedAd) return validateOrder();
    const amountIn = document.getElementById("orderAmountIn");
    const qtyIn = document.getElementById("orderQtyIn");
    const qty = Number(qtyIn?.value || 0);
    const amount = calcAmountFromQty(qty, selectedAd.price);
    if (amountIn) amountIn.value = amount > 0 ? window.P2P.utils.format2(amount) : "";
    validateOrder();
  }

  async function orderAllQty() {
    if (!selectedAd) return;
    const action = selectedAction || userActionForAdType(selectedAd.type);

    let maxQty = selectedAd.availableQuantity;
    // If SELL flow (user gives USDT), cap by wallet balance too.
    if (action === "sell") {
      const addr = window.P2P.state.connectedAddress;
      if (!addr) {
        window.P2P.toast("اربط المحفظة أولاً");
        return;
      }
      try {
        const bal = await window.P2P.getUSDTBalance(addr);
        maxQty = Math.min(maxQty, Number(bal) || 0);
      } catch (e) {
        console.error("[orders] getUSDTBalance failed", e);
      }
    }

    const qtyIn = document.getElementById("orderQtyIn");
    if (qtyIn) qtyIn.value = window.P2P.utils.format2(maxQty);
    onOrderQtyInput();
  }

  async function orderAllAmount() {
    if (!selectedAd) return;
    const action = selectedAction || userActionForAdType(selectedAd.type);

    let maxQty = selectedAd.availableQuantity;
    if (action === "sell") {
      const addr = window.P2P.state.connectedAddress;
      if (!addr) {
        window.P2P.toast("اربط المحفظة أولاً");
        return;
      }
      try {
        const bal = await window.P2P.getUSDTBalance(addr);
        maxQty = Math.min(maxQty, Number(bal) || 0);
      } catch (e) {
        console.error("[orders] getUSDTBalance failed", e);
      }
    }

    const amountIn = document.getElementById("orderAmountIn");
    const amount = calcAmountFromQty(maxQty, selectedAd.price);
    if (amountIn) amountIn.value = window.P2P.utils.format2(amount);
    onOrderAmountInput();
  }

  async function validateOrder() {
    const btn = document.getElementById("orderActionBtn");
    const hint = document.getElementById("orderHint");
    const qtyVal = Number(document.getElementById("orderQtyIn")?.value || 0);
    const amountVal = Number(document.getElementById("orderAmountIn")?.value || 0);
    if (!btn || !hint) return;

    setOrderHint("");

    if (!selectedAd) {
      btn.disabled = true;
      return;
    }

    // Allow viewing for the ad owner, but block execution.
    if (isSelfTrade()) {
      btn.disabled = true;
      setOrderHint("You cannot place an order on your own ad.");
      return;
    }

    if (orderExpiresAt && Date.now() >= orderExpiresAt) {
      btn.disabled = true;
      setOrderHint("انتهت مدة الدفع (15 دقيقة)");
      return;
    }

    if (!(selectedAd.price > 0)) {
      btn.disabled = true;
      setOrderHint("سعر الإعلان غير صالح");
      return;
    }

    if (!(qtyVal > 0) || qtyVal > selectedAd.availableQuantity) {
      btn.disabled = true;
      if (qtyVal > selectedAd.availableQuantity) {
        setOrderHint("لا يمكنك إدخال كمية أكبر من المتاح في الإعلان");
      }
      return;
    }

    const amount = amountVal > 0 ? amountVal : calcAmountFromQty(qtyVal, selectedAd.price);
    if (selectedAd.minLimit > 0 && amount < selectedAd.minLimit) {
      btn.disabled = true;
      setOrderHint(`الحد الأدنى هو ${window.P2P.utils.format2(selectedAd.minLimit)} EGP`);
      return;
    }
    if (selectedAd.maxLimit > 0 && amount > selectedAd.maxLimit) {
      btn.disabled = true;
      setOrderHint(`الحد الأقصى هو ${window.P2P.utils.format2(selectedAd.maxLimit)} EGP`);
      return;
    }

    const action = selectedAction || userActionForAdType(selectedAd.type);

    // Balance verification: user cannot SELL unless balance is sufficient.
    if (action === "sell") {
      const addr = window.P2P.state.connectedAddress;
      if (!addr) {
        btn.disabled = true;
        hint.style.display = "block";
        hint.textContent = "اربط محفظتك للتحقق من الرصيد قبل البيع";
        return;
      }
      const bal = await window.P2P.getUSDTBalance(addr);
      if (bal < qtyVal) {
        btn.disabled = true;
        hint.style.display = "block";
        hint.textContent = `رصيدك غير كافٍ. المتاح: ${window.P2P.utils.format2(bal)} USDT`;
        return;
      }
    }

    btn.disabled = false;
  }

  async function confirmOrder() {
    if (!selectedAd) return;
    if (!db) return window.P2P.toast("Firebase غير جاهز");

    const qty = Number(document.getElementById("orderQtyIn")?.value || 0);
    if (!(qty > 0)) return;

    const addr = window.P2P.state.connectedAddress;
    if (!addr) return window.P2P.toast("اربط المحفظة أولاً");

    if (String(addr) === String(selectedAd.merchantAddress || "")) {
      window.P2P.toast("You cannot place an order on your own ad.");
      return;
    }

    const action = selectedAction || userActionForAdType(selectedAd.type);
    const now = Date.now();
    const expiresAt = now + ORDER_WINDOW_MS;
    let createdOrderId = null;

    try {
      const adRef = db.collection(ADS_COLLECTION).doc(selectedAd.id);
      const sellerAddress = action === "buy" ? selectedAd.merchantAddress : addr;
      const buyerAddress = action === "buy" ? addr : selectedAd.merchantAddress;

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(adRef);
        if (!snap.exists) throw new Error("Ad missing");

        const ad = snap.data() || {};
        const owner = String(ad.merchantAddress || selectedAd.merchantAddress || "");
        const me = String(addr || "");
        if (me && owner && me === owner) throw new Error("self_trade");

        const available = Number(ad.availableQuantity ?? ad.quantity) || 0;
        if (qty > available) throw new Error("Not enough available");

        if (action === "sell") {
          const bal = await window.P2P.getUSDTBalance(addr);
          if (bal < qty) throw new Error("Insufficient balance");
        }

        if (!buyerAddress || !sellerAddress || buyerAddress === sellerAddress) throw new Error("buyer_seller_invalid");

        tx.update(adRef, { availableQuantity: available - qty });

        const orderRef = db.collection(ORDERS_COLLECTION).doc();
        createdOrderId = orderRef.id;
        tx.set(orderRef, {
          adId: selectedAd.id,
          adType: ad.type,
          merchantAddress: selectedAd.merchantAddress,
          userAddress: addr,
          userAction: action,
          buyerAddress,
          sellerAddress,
          price: selectedAd.price,
          quantity: qty,
          amount: calcAmountFromQty(qty, selectedAd.price),
          paymentMethod: selectedAd.paymentMethod,
          status: "active",
          paymentConfirmed: false,
          released: false,
          expiresAt,
          timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        });
      });

      window.P2P.toast("تم إنشاء الطلب");
      closeOrder();

      if (createdOrderId) {
        await db.collection("Notifications").add({
          to: selectedAd.merchantAddress,
          from: addr,
          orderId: createdOrderId,
          type: "new_order",
          timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        });
        if (window.P2P.chat?.openChat) window.P2P.chat.openChat(createdOrderId);
      }
    } catch (e) {
      console.error(e);
      if (String(e?.message || "") === "self_trade") {
        window.P2P.toast("You cannot place an order on your own ad.");
        return;
      }
      window.P2P.toast("تعذر إنشاء الطلب");
    }
  }

  function setOrdersTab(tab) {
    window.P2P.state.ordersTab = tab;
    document.getElementById("ordersTabActive")?.classList.toggle("tab--active", tab === "active");
    document.getElementById("ordersTabCompleted")?.classList.toggle("tab--active", tab === "completed");
    document.getElementById("ordersTabCanceled")?.classList.toggle("tab--active", tab === "canceled");
    subscribeOrders();
  }

  function canCancelOrder(order, myAddr) {
    if (order.userAction === "buy") return order.userAddress === myAddr;
    return order.merchantAddress === myAddr;
  }

  function subscribeOrders() {
    if (!db) return;
    const addr = window.P2P.state.connectedAddress;
    if (!addr) return;
    if (typeof unsubOrders === "function") unsubOrders();

    const list = document.getElementById("ordersList");
    if (!list) return;

    unsubOrders = db
      .collection(ORDERS_COLLECTION)
      .where("status", "==", window.P2P.state.ordersTab)
      .onSnapshot((snap) => {
        const mine = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((o) => o.userAddress === addr || o.merchantAddress === addr);

        if (mine.length === 0) {
          list.innerHTML = `<div class="meta" style="text-align:center; padding: 30px 0;">لا توجد طلبات</div>`;
          return;
        }

        list.innerHTML = mine
          .sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0))
          .map((o) => {
            const isMerchant = o.merchantAddress === addr;
            const actionLabel = o.userAction === "buy" ? "شراء" : "بيع";

            const showRelease = isMerchant && o.userAction === "buy" && o.paymentConfirmed && !o.released && o.status === "active";
            const showPayConfirm = !isMerchant && o.userAction === "buy" && !o.paymentConfirmed && o.status === "active";
            const showCancel = o.status === "active" && canCancelOrder(o, addr);

            return `
              <article class="adCard">
                <div class="adCard__top">
                  <div class="merchant">
                    <span class="avatar">#</span>
                    <span>${o.id}</span>
                  </div>
                  <button class="icon-btn" type="button" onclick="openChat('${o.id}')" aria-label="Chat"><i class="fa-solid fa-comments"></i></button>
                </div>
                <div class="meta">نوع: <b>${actionLabel}</b> • الكمية: <b>${window.P2P.utils.format2(o.quantity)}</b> USDT • السعر: <b>${window.P2P.utils.format2(o.price)}</b> EGP</div>
                <div class="priceRow" style="margin-top:12px;">
                  <div class="meta">الحالة: <b>${o.status}</b></div>
                  <div style="display:flex; gap:10px;">
                    ${showPayConfirm ? `<button class="actionBtn actionBtn--green" type="button" onclick="confirmPayment('${o.id}')">تم الدفع</button>` : ""}
                    ${showRelease ? `<button class="actionBtn actionBtn--green" type="button" onclick="releaseOrder('${o.id}')">تحرير</button>` : ""}
                    ${showCancel ? `<button class="actionBtn actionBtn--red" type="button" onclick="cancelOrder('${o.id}')">إلغاء</button>` : ""}
                  </div>
                </div>
              </article>
            `;
          })
          .join("");
      });
  }

  async function confirmPayment(orderId) {
    await db.collection(ORDERS_COLLECTION).doc(orderId).update({
      paymentConfirmed: true,
      paymentConfirmedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    window.P2P.toast("تم تأكيد الدفع");
  }

  async function cancelOrder(orderId) {
    await db.collection(ORDERS_COLLECTION).doc(orderId).update({
      status: "canceled",
      canceledAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    window.P2P.toast("تم إلغاء الطلب");
  }

  async function releaseOrder(orderId) {
    await db.collection(ORDERS_COLLECTION).doc(orderId).update({
      released: true,
      status: "completed",
      releasedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    window.P2P.toast("تم التحرير");
  }

  // Expose globals used by HTML handlers.
  window.openOrder = openOrder;
  window.closeOrder = closeOrder;
  window.validateOrder = validateOrder;
  window.confirmOrder = confirmOrder;
  window.onOrderAmountInput = onOrderAmountInput;
  window.onOrderQtyInput = onOrderQtyInput;
  window.orderAllQty = orderAllQty;
  window.orderAllAmount = orderAllAmount;
  window.setOrdersTab = setOrdersTab;
  window.confirmPayment = confirmPayment;
  window.cancelOrder = cancelOrder;
  window.releaseOrder = releaseOrder;

  document.addEventListener("p2p:walletConnected", () => {
    subscribeOrders();
  });
})();

