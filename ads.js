/* eslint-disable no-console */

// ------------------------------------------------------------
// ads.js (FULL REWRITE)
// ------------------------------------------------------------
// Responsibilities:
// - Market Ads feed (P2P page)
// - Create/Edit Ad form (Firestore)
// - My Ads page (empty state + active ad card + edit/cancel)
// - Page navigation/header (+) visibility

(function () {
  const P2P = (window.P2P = window.P2P || {});
  P2P.state = P2P.state || {};

  const state = P2P.state;
  state.marketTab = state.marketTab || "sell"; // buy|sell (user-facing)
  state.createMode = state.createMode || "buy"; // buy|sell (merchant intent)
  state.currentPageKey = state.currentPageKey || "p2p";

  const getDb = () => window.db;
  const getFieldValue = () => window.firebase?.firestore?.FieldValue;
  const ADS_COLLECTION = "ads";

  let unsubMarketAds = null;
  let unsubMyAds = null;

  /** Clears in-memory / session hints from a failed publish so the next tap starts clean. */
  function clearPublishErrorState() {
    state.lastPublishError = null;
    state.lastPublishErrorCode = null;
    try {
      sessionStorage.removeItem("ads_publish_error");
      sessionStorage.removeItem("ads_publish_error_code");
    } catch (_) {
      /* ignore */
    }
  }

  async function ensureFirestoreOnline(db) {
    if (!db || typeof db.enableNetwork !== "function") return;
    try {
      await db.enableNetwork();
    } catch (e) {
      console.warn("[ads] enableNetwork", e);
    }
  }

  function toast(msg) {
    if (typeof P2P.toast === "function") return P2P.toast(msg);
    console.log(msg);
  }

  function fmt2(n) {
    if (P2P.utils?.format2) return P2P.utils.format2(n);
    const v = Number(n);
    if (!Number.isFinite(v)) return "0.00";
    return v.toFixed(2);
  }

  // Minimal "addDoc" adapter for Firebase compat (Firestore v8-style).
  // Keeps code aligned with the addDoc mental model without changing SDK loading.
  async function addDoc(collectionRef, data) {
    if (!collectionRef || typeof collectionRef.add !== "function") throw new Error("Invalid collection reference");
    return await collectionRef.add(data);
  }

  function setPage(pageId) {
    const pages = ["marketPage", "createAdPage", "ordersPage", "adsPage", "chatPage", "profilePage"];
    for (const id of pages) {
      const el = document.getElementById(id);
      if (el) el.classList.toggle("page--active", id === pageId);
    }

    const bottomNav = document.getElementById("bottomNav");
    if (bottomNav) bottomNav.style.display = pageId === "createAdPage" ? "none" : "flex";

    updateHeaderForPageId(pageId);
  }

  function updateHeaderForPageId(pageId) {
    const map = {
      marketPage: "p2p",
      ordersPage: "orders",
      adsPage: "ads",
      chatPage: "chat",
      profilePage: "profile",
      createAdPage: "createAd",
    };
    updateHeaderForPageKey(map[pageId] || "p2p");
  }

  function updateHeaderForPageKey(pageKey) {
    state.currentPageKey = pageKey;

    const plusBtn = document.getElementById("headerPlusBtn");
    const bal = document.getElementById("headerBalance");
    if (plusBtn) plusBtn.style.display = pageKey === "ads" ? "inline-flex" : "none";
    if (bal) bal.style.display = ["p2p", "orders", "chat", "profile"].includes(pageKey) ? "inline-flex" : "none";

    if (["p2p", "orders", "chat", "profile"].includes(pageKey) && typeof P2P.refreshHeaderBalanceUI === "function") {
      P2P.refreshHeaderBalanceUI();
    }
  }

  function navTo(pageKey) {
    state.currentPageKey = pageKey;
    const map = { p2p: "marketPage", orders: "ordersPage", ads: "adsPage", chat: "chatPage", profile: "profilePage" };
    setPage(map[pageKey] || "marketPage");

    const items = document.querySelectorAll(".bottomNav__item");
    items.forEach((el) => el.classList.remove("bottomNav__item--active"));
    const idx = { p2p: 0, orders: 1, ads: 2, chat: 3, profile: 4 }[pageKey] ?? 0;
    if (items[idx]) items[idx].classList.add("bottomNav__item--active");

    updateHeaderForPageKey(pageKey);

    if (pageKey === "ads") subscribeMyAds();
    if (pageKey === "p2p") subscribeMarketAds();
  }

  function firestoreTypeForMarketTab(tab) {
    return tab === "sell" ? "buy" : "sell";
  }

  function userActionForMarketTab(tab) {
    return tab === "sell" ? "sell" : "buy";
  }

  function setMarketTab(tab) {
    state.marketTab = tab;
    const buyBtn = document.getElementById("tabBuy");
    const sellBtn = document.getElementById("tabSell");
    const toggle = document.getElementById("marketToggle");

    buyBtn?.classList.toggle("marketToggle__btn--active", tab === "buy");
    sellBtn?.classList.toggle("marketToggle__btn--active", tab === "sell");
    buyBtn?.setAttribute("aria-selected", tab === "buy" ? "true" : "false");
    sellBtn?.setAttribute("aria-selected", tab === "sell" ? "true" : "false");

    if (toggle) {
      toggle.classList.toggle("marketToggle--buy", tab === "buy");
      toggle.classList.toggle("marketToggle--sell", tab === "sell");
    }
    subscribeMarketAds();
  }

  function renderMarketEmpty(el) {
    el.innerHTML = `
      <div class="emptyState emptyState--compact">
        <div class="emptyState__title">لم يتم العثور على إعلانات</div>
        <div class="emptyState__sub">أنشئ إعلانًا لشراء العملات الرقمية أو بيعها.</div>
      </div>
    `;
  }

  function subscribeMarketAds() {
    const db = getDb();
    const adsList = document.getElementById("adsList");
    if (!adsList) return;

    if (!db) {
      renderMarketEmpty(adsList);
      console.error("[ads] Firestore not initialized. Ensure firebase-config.js loads before ads.js and window.db exists.");
      return;
    }

    if (typeof unsubMarketAds === "function") unsubMarketAds();
    adsList.innerHTML = "";

    const wantedType = firestoreTypeForMarketTab(state.marketTab);

    unsubMarketAds = db
      // Avoid composite-index requirements during testing:
      // fetch active ads then filter by type client-side.
      .collection(ADS_COLLECTION)
      .where("status", "==", "active")
      .onSnapshot(
        (snap) => {
          if (snap.empty) return renderMarketEmpty(adsList);

          const action = userActionForMarketTab(state.marketTab);
          const docs = snap.docs
            .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
            .filter((d) => String(d.type || "") === wantedType);

          if (docs.length === 0) return renderMarketEmpty(adsList);

          function paymentBadgeClass(method) {
            const raw = String(method || "").toLowerCase().trim();
            const slug = raw.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
            return slug ? `payBadge--${slug}` : "";
          }

          adsList.innerHTML = docs
            .map((doc) => {
              const d = doc || {};
              const price = Number(d.price) || 0;
              const available = Number(d.availableQuantity ?? d.quantity) || 0;
              const merchantAddress = String(d.merchantAddress || "");
              const paymentMethod = String(d.paymentMethod || "").trim();
              const payClass = paymentBadgeClass(paymentMethod);

              const btnClass = action === "buy" ? "actionBtn actionBtn--green" : "actionBtn actionBtn--red";
              const btnText = action === "buy" ? "شراء" : "بيع";

              return `
                <article class="adCard">
                  <div class="adCard__top">
                    <div class="merchant">
                      <span class="avatar">M</span>
                      <span>Merchant_${merchantAddress.slice(-4) || "----"}</span>
                    </div>
                  </div>
                  <div class="priceRow priceRow--market">
                    <div class="marketInfo">
                      <div class="price">${fmt2(price)} <span class="unit">EGP</span></div>
                      <div class="meta">المتاح: <b>${fmt2(available)}</b> USDT</div>
                      <div class="meta">الحدود: <b>${fmt2(d.minLimit)} - ${fmt2(d.maxLimit)}</b> EGP</div>
                      ${
                        paymentMethod
                          ? `<div class="payBadges" aria-label="Payment method">
                               <span class="payBadge ${payClass}" title="${paymentMethod}">${paymentMethod}</span>
                             </div>`
                          : ``
                      }
                    </div>
                    <div class="marketAction">
                      <button class="${btnClass}" type="button" onclick="openOrder('${d.id}')">${btnText}</button>
                    </div>
                  </div>
                </article>
              `;
            })
            .join("");
        },
        (err) => {
          console.error("[ads] Market snapshot error", err);
          renderMarketEmpty(adsList);
          toast("تعذر تحميل الإعلانات");
        }
      );
  }

  function openCreateAd() {
    setPage("createAdPage");
  }

  function showAdForm() {
    openCreateAd();
  }

  function backToMarket() {
    navTo("p2p");
  }

  async function setCreateMode(mode) {
    state.createMode = mode;

    document.getElementById("createModeBuy")?.classList.toggle("segmented__btn--active", mode === "buy");
    document.getElementById("createModeSell")?.classList.toggle("segmented__btn--active", mode === "sell");

    const sellOnly = document.getElementById("sellOnlyBox");
    if (sellOnly) sellOnly.style.display = mode === "sell" ? "flex" : "none";

    // Conditional Max button inside quantity input:
    // - BUY mode: remove Max completely
    // - SELL mode: show Max (and available balance row)
    const maxBtn = document.getElementById("maxBtn");
    if (maxBtn) maxBtn.style.display = mode === "sell" ? "inline-flex" : "none";

    const publishBtn = document.getElementById("publishBtn");
    if (publishBtn) publishBtn.classList.toggle("primaryBtn--red", mode === "sell");

    if (mode === "sell" && typeof P2P.refreshWalletBalanceUI === "function") await P2P.refreshWalletBalanceUI();
    validatePublish();
  }

  function togglePaymentDropdown() {
    const dd = document.getElementById("paymentDropdown");
    if (!dd) return;
    dd.style.display = dd.style.display === "none" || !dd.style.display ? "block" : "none";
  }

  function selectPayment(v) {
    const t = document.getElementById("selectedPaymentText");
    if (t) t.textContent = v;
    const dd = document.getElementById("paymentDropdown");
    if (dd) dd.style.display = "none";
    validatePublish();
  }

  function updateTotal() {
    const price = Number(document.getElementById("priceIn")?.value || 0);
    const qty = Number(document.getElementById("quantityIn")?.value || 0);
    const totalEl = document.getElementById("totalAmount");
    if (!totalEl) return;
    totalEl.textContent = fmt2(price > 0 && qty > 0 ? price * qty : 0);
  }

  function validatePublish() {
    updateTotal();

    const price = Number(document.getElementById("priceIn")?.value || 0);
    const qty = Number(document.getElementById("quantityIn")?.value || 0);
    const minL = Number(document.getElementById("minLimitIn")?.value || 0);
    const maxL = Number(document.getElementById("maxLimitIn")?.value || 0);
    const payment = (document.getElementById("selectedPaymentText")?.textContent || "").trim();

    const publishBtn = document.getElementById("publishBtn");
    if (!publishBtn) return;

    const baseValid = price > 0 && qty > 0 && minL > 0 && maxL > 0 && minL <= maxL;
    const maxNotBeyondTotal = baseValid ? maxL <= price * qty : false;
    const paymentOk = payment && payment !== "اختر طريقة الدفع";

    const sellRequiresWallet = state.createMode === "sell";
    const walletOk = !sellRequiresWallet || !!state.connectedAddress;

    publishBtn.disabled = !(baseValid && maxNotBeyondTotal && paymentOk && walletOk);
  }

  async function fillMaxFromWallet() {
    if (state.createMode !== "sell") return;
    const addr = state.connectedAddress;
    if (!addr) return toast("اربط المحفظة أولاً");
    if (typeof P2P.getUSDTBalance !== "function") return toast("تعذر قراءة رصيد المحفظة");
    const bal = await P2P.getUSDTBalance(addr);
    const qtyIn = document.getElementById("quantityIn");
    if (qtyIn) qtyIn.value = fmt2(bal);
    if (typeof P2P.refreshWalletBalanceUI === "function") await P2P.refreshWalletBalanceUI();
    validatePublish();
  }

  function getCreateFormValues() {
    const price = Number(document.getElementById("priceIn")?.value || 0);
    const qty = Number(document.getElementById("quantityIn")?.value || 0);
    const minLimit = Number(document.getElementById("minLimitIn")?.value || 0);
    const maxLimit = Number(document.getElementById("maxLimitIn")?.value || 0);
    const paymentMethod = (document.getElementById("selectedPaymentText")?.textContent || "").trim();
    return { price, qty, minLimit, maxLimit, paymentMethod };
  }

  function resetCreateForm() {
    ["priceIn", "quantityIn", "minLimitIn", "maxLimitIn"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    const payment = document.getElementById("selectedPaymentText");
    if (payment) payment.textContent = "اختر طريقة الدفع";
    const publishBtn = document.getElementById("publishBtn");
    if (publishBtn) delete publishBtn.dataset.editingId;
    updateTotal();
    validatePublish();
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Writes ad to Firestore `ads`, verifies the document, clears stale error state on success.
   * Retries once on permission-denied (e.g. rules just finished deploying).
   */
  async function publishAd() {
    clearPublishErrorState();

    const db = getDb();
    const FieldValue = getFieldValue();
    const btn = document.getElementById("publishBtn");

    if (!btn) return;
    if (!db || !FieldValue) {
      console.error("[ads] Firebase not ready", { db: !!db, FieldValue: !!FieldValue });
      return toast("تعذر الاتصال بقاعدة البيانات");
    }

    if (!state.connectedAddress) {
      return toast("اربط المحفظة أولاً");
    }

    const { price, qty, minLimit, maxLimit, paymentMethod } = getCreateFormValues();

    if (!(price > 0 && qty > 0 && minLimit > 0 && maxLimit > 0 && minLimit <= maxLimit)) {
      return toast("يرجى تعبئة السعر والكمية والحدود بشكل صحيح");
    }
    if (!paymentMethod || paymentMethod === "اختر طريقة الدفع") return toast("يرجى اختيار طريقة الدفع");
    if (maxLimit > price * qty) return toast("الحد الأقصى لا يمكن أن يتجاوز إجمالي قيمة الإعلان");

    await ensureFirestoreOnline(db);

    btn.disabled = true;
    btn.classList.add("is-loading");
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>جاري الحفظ...</span>`;

    const editingId = btn.dataset.editingId || "";
    const payload = {
      type: state.createMode,
      price,
      amount: qty,
      quantity: qty,
      availableQuantity: qty,
      minLimit,
      maxLimit,
      paymentMethod,
      currency: "EGP",
      asset: "USDT",
      merchantAddress: state.connectedAddress,
      status: "active",
    };

    const commitOnce = async (isRetry) => {
      if (editingId) {
        await db.collection(ADS_COLLECTION).doc(editingId).update({
          ...payload,
          updatedAt: FieldValue.serverTimestamp(),
        });
        const snap = await db.collection(ADS_COLLECTION).doc(editingId).get();
        if (!snap.exists) throw new Error("verify_failed_update");
        return editingId;
      }
      const docRef = await addDoc(db.collection(ADS_COLLECTION), {
        ...payload,
        timestamp: FieldValue.serverTimestamp(),
      });
      const id = docRef.id;
      const created = await db.collection(ADS_COLLECTION).doc(id).get();
      if (!created.exists) throw new Error("verify_failed_create");
      return id;
    };

    try {
      let newId;
      try {
        newId = await commitOnce(false);
      } catch (first) {
        if (first?.code === "permission-denied") {
          console.warn("[ads] permission-denied on first try; waiting for rules propagation, retry once");
          await sleep(1600);
          await ensureFirestoreOnline(db);
          newId = await commitOnce(true);
        } else {
          throw first;
        }
      }

      if (editingId) delete btn.dataset.editingId;

      clearPublishErrorState();
      state.lastPublishDocId = newId;

      toast("تم نشر الإعلان بنجاح");
      resetCreateForm();
      navTo("ads");
      // Refresh both panels quickly on success
      subscribeMyAds();
      subscribeMarketAds();
    } catch (e) {
      state.lastPublishError = e?.message || String(e);
      state.lastPublishErrorCode = e?.code || null;
      try {
        sessionStorage.setItem("ads_publish_error", state.lastPublishError);
        if (state.lastPublishErrorCode) sessionStorage.setItem("ads_publish_error_code", state.lastPublishErrorCode);
      } catch (_) {
        /* ignore */
      }

      const details = {
        name: e?.name,
        code: e?.code,
        message: e?.message,
        collection: ADS_COLLECTION,
      };
      console.error("[ads] publishAd failed", details, e);

      const code = e?.code ? ` (${e.code})` : "";
      toast(`فشل نشر الإعلان${code}. تحقق من نشر قواعد Firestore ثم أعد المحاولة.`);
    } finally {
      btn.classList.remove("is-loading");
      btn.innerHTML = originalHTML;
      validatePublish();
    }
  }

  function applyMyAdsEmptyStateCopy() {
    const empty = document.getElementById("myAdsEmpty");
    if (!empty) return;

    empty.querySelector(".emptyState__title")?.replaceChildren(document.createTextNode("لم يتم العثور على إعلانات"));
    empty.querySelector(".emptyState__sub")?.replaceChildren(document.createTextNode("أنشئ إعلانًا لشراء العملات الرقمية أو بيعها."));
    const btn = empty.querySelector("button");
    if (btn) {
      btn.textContent = "إنشاء إعلان";
      btn.onclick = showAdForm;
    }
  }

  function renderMyAdsEmpty(isVisible) {
    const empty = document.getElementById("myAdsEmpty");
    if (empty) empty.style.display = isVisible ? "block" : "none";
  }

  function renderMyAdsList(ads) {
    const list = document.getElementById("myAdsList");
    if (!list) return;

    list.innerHTML = ads
      .map((a, idx) => {
        const price = Number(a.price) || 0;
        const amount = Number(a.quantity) || 0;
        const currency = "EGP";

        return `
          <article class="myAdCard">
            <div class="myAdCard__top">
              <div class="myAdCard__title">إعلان</div>
              <span class="badge">نشط (${idx + 1})</span>
            </div>

            <div class="myAdStats">
              <div class="myAdStat">
                <div class="myAdStat__label">السعر</div>
                <div class="myAdStat__value">${fmt2(price)} <span class="unit">${currency}</span></div>
              </div>
              <div class="myAdStat">
                <div class="myAdStat__label">العملة</div>
                <div class="myAdStat__value">USDT</div>
              </div>
              <div class="myAdStat">
                <div class="myAdStat__label">الكمية</div>
                <div class="myAdStat__value">${fmt2(amount)} <span class="unit">USDT</span></div>
              </div>
            </div>

            <div class="myAdActions">
              <button class="btn btn--neutral" type="button" onclick="editMyAd('${a.id}')">تعديل الإعلان</button>
              <button class="btn btn--danger" type="button" onclick="cancelMyAd('${a.id}')">إلغاء الإعلان</button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function subscribeMyAds() {
    const db = getDb();
    const addr = state.connectedAddress;

    applyMyAdsEmptyStateCopy();

    const activeCount = document.getElementById("myAdsActiveCount");
    const list = document.getElementById("myAdsList");
    if (!list) return;

    if (!addr) {
      list.innerHTML = "";
      if (activeCount) activeCount.textContent = "0";
      renderMyAdsEmpty(true);
      return;
    }

    if (!db) {
      console.error("[ads] Firestore not initialized for My Ads.");
      list.innerHTML = "";
      if (activeCount) activeCount.textContent = "0";
      renderMyAdsEmpty(true);
      return;
    }

    if (typeof unsubMyAds === "function") unsubMyAds();

    unsubMyAds = db
      .collection(ADS_COLLECTION)
      .where("merchantAddress", "==", addr)
      .onSnapshot(
        (snap) => {
          const ads = snap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
          const activeAds = ads.filter((a) => a.status === "active");
          if (activeCount) activeCount.textContent = String(activeAds.length);

          if (activeAds.length === 0) {
            list.innerHTML = "";
            renderMyAdsEmpty(true);
            return;
          }

          renderMyAdsEmpty(false);
          renderMyAdsList(activeAds);
        },
        (err) => {
          console.error("[ads] My Ads snapshot error", err);
          list.innerHTML = "";
          if (activeCount) activeCount.textContent = "0";
          renderMyAdsEmpty(true);
          toast("تعذر تحميل الإعلانات");
        }
      );
  }

  async function editMyAd(adId) {
    const db = getDb();
    if (!db) return toast("تعذر الاتصال بقاعدة البيانات");

    try {
      const doc = await db.collection(ADS_COLLECTION).doc(adId).get();
      if (!doc.exists) return toast("الإعلان غير موجود");
      const a = doc.data() || {};

      const priceIn = document.getElementById("priceIn");
      const qtyIn = document.getElementById("quantityIn");
      const minIn = document.getElementById("minLimitIn");
      const maxIn = document.getElementById("maxLimitIn");
      const pay = document.getElementById("selectedPaymentText");

      if (priceIn) priceIn.value = a.price ?? "";
      if (qtyIn) qtyIn.value = a.quantity ?? "";
      if (minIn) minIn.value = a.minLimit ?? "";
      if (maxIn) maxIn.value = a.maxLimit ?? "";
      if (pay) pay.textContent = a.paymentMethod || "اختر طريقة الدفع";

      await setCreateMode(a.type === "sell" ? "sell" : "buy");

      const publishBtn = document.getElementById("publishBtn");
      if (publishBtn) publishBtn.dataset.editingId = adId;

      showAdForm();
      validatePublish();
    } catch (e) {
      console.error("[ads] editMyAd error", e);
      toast("حدث خطأ أثناء تحميل الإعلان");
    }
  }

  async function cancelMyAd(adId) {
    const db = getDb();
    if (!db) return toast("تعذر الاتصال بقاعدة البيانات");

    const ok = confirm("هل أنت متأكد من إلغاء هذا الإعلان؟");
    if (!ok) return;

    try {
      await db.collection(ADS_COLLECTION).doc(adId).delete();
      toast("تم إلغاء الإعلان");
    } catch (e) {
      console.error("[ads] cancelMyAd error", e);
      toast("حدث خطأ أثناء إلغاء الإعلان");
    }
  }

  function bindCreateInputs() {
    ["priceIn", "quantityIn", "minLimitIn", "maxLimitIn"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("input", validatePublish);
    });
  }

  function sanityCheckFirebase() {
    const db = getDb();
    const FieldValue = getFieldValue();
    if (!db || !FieldValue) {
      console.error("[ads] Firebase sanity check failed.", {
        hasDb: !!db,
        hasFieldValue: !!FieldValue,
      });
    }
  }

  // Expose globals for inline HTML handlers.
  window.navTo = navTo;
  window.setMarketTab = setMarketTab;
  window.openCreateAd = openCreateAd;
  window.showAdForm = showAdForm;
  window.showCreateAdForm = showAdForm; // backwards-compatible with existing HTML
  window.backToMarket = backToMarket;
  window.setCreateMode = setCreateMode;
  window.fillMaxFromWallet = fillMaxFromWallet;
  window.togglePaymentDropdown = togglePaymentDropdown;
  window.selectPayment = selectPayment;
  window.publishAd = publishAd;
  window.editMyAd = editMyAd;
  window.cancelMyAd = cancelMyAd;

  document.addEventListener("DOMContentLoaded", async () => {
    sanityCheckFirebase();
    bindCreateInputs();
    applyMyAdsEmptyStateCopy();

    await setCreateMode("buy");
    setMarketTab("sell");
    navTo("p2p");
    subscribeMarketAds();
  });

  document.addEventListener("p2p:walletConnected", () => {
    subscribeMyAds();
    if (typeof P2P.refreshWalletBalanceUI === "function") P2P.refreshWalletBalanceUI();
    validatePublish();
  });
})();

