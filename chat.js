/* eslint-disable no-console */

// -----------------------------
// chat.js (Modular)
// -----------------------------
// Why this file exists:
// - Real-time chat (Firebase RTDB)
// - Image upload support (Firebase Storage)
// - Chat overlay + chat list page

window.P2P = window.P2P || {};
window.P2P.chat = window.P2P.chat || {};
window.P2P.state = window.P2P.state || {};

const db = window.db;
const rtdb = window.rtdb;
const storage = window.storage;

const ORDER_WINDOW_MS = 15 * 60 * 1000;

let activeChat = null;
let chatUnsub = null;
let chatTimerInt = null;
let unsubChatList = null;

function startChatTimer(expiresAt) {
  const timerEl = document.getElementById("chatTimer");
  if (chatTimerInt) clearInterval(chatTimerInt);
  chatTimerInt = setInterval(() => {
    const remain = Math.max(0, expiresAt - Date.now());
    const s = Math.floor(remain / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    if (timerEl) timerEl.textContent = `${mm}:${ss}`;
    if (remain <= 0) {
      clearInterval(chatTimerInt);
      chatTimerInt = null;
    }
  }, 1000);
}

function subscribeChatMessages(orderId) {
  if (!rtdb) return;
  const body = document.getElementById("chatBody");
  if (!body) return;

  const ref = rtdb.ref(`chats/${orderId}`);
  ref.off();
  ref.on("value", (snap) => {
    const raw = snap.val();
    const msgs = raw ? Object.values(raw) : [];
    body.innerHTML = msgs
      .sort((a, b) => (a.time || 0) - (b.time || 0))
      .map((m) => {
        const mine = m.sender === window.P2P.state.connectedAddress;
        const img = m.imageUrl ? `<img class="msg__img" src="${m.imageUrl}" alt="image" />` : "";
        return `
          <div class="msg ${mine ? "msg--me" : "msg--them"}">
            <div>${m.text ? String(m.text).replace(/</g, "&lt;") : ""}</div>
            ${img}
            <div class="msg__time">${new Date(m.time || Date.now()).toLocaleTimeString("ar-EG")}</div>
          </div>
        `;
      })
      .join("");
    body.scrollTop = body.scrollHeight;
  });

  chatUnsub = () => ref.off();
}

async function openChat(orderId) {
  if (!db) return;
  const addr = window.P2P.state.connectedAddress;
  if (!addr) return window.P2P.toast("اربط المحفظة أولاً");

  const doc = await db.collection("Orders").doc(orderId).get();
  if (!doc.exists) return window.P2P.toast("الطلب غير موجود");

  const o = doc.data() || {};
  activeChat = { id: orderId, expiresAt: Number(o.expiresAt || (Date.now() + ORDER_WINDOW_MS)) };

  const overlay = document.getElementById("chatOverlay");
  if (overlay) overlay.style.display = "flex";
  const idEl = document.getElementById("chatOrderId");
  if (idEl) idEl.textContent = `طلب: ${orderId}`;

  startChatTimer(activeChat.expiresAt);
  subscribeChatMessages(orderId);
}

function closeChat() {
  const overlay = document.getElementById("chatOverlay");
  if (overlay) overlay.style.display = "none";
  if (typeof chatUnsub === "function") chatUnsub();
  chatUnsub = null;
  activeChat = null;
  if (chatTimerInt) clearInterval(chatTimerInt);
  chatTimerInt = null;
}

async function sendChatMessage() {
  if (!activeChat || !rtdb) return;
  const addr = window.P2P.state.connectedAddress;
  if (!addr) return;

  const textEl = document.getElementById("chatText");
  const fileEl = document.getElementById("chatImage");
  const text = (textEl?.value || "").trim();
  const file = fileEl?.files?.[0] || null;
  if (!text && !file) return;

  let imageUrl = "";
  if (file && storage) {
    try {
      const path = `chat-images/${activeChat.id}/${Date.now()}_${file.name}`;
      const ref = storage.ref().child(path);
      await ref.put(file);
      imageUrl = await ref.getDownloadURL();
    } catch (e) {
      console.error(e);
      window.P2P.toast("تعذر رفع الصورة");
    }
  }

  await rtdb.ref(`chats/${activeChat.id}`).push({
    sender: addr,
    text,
    imageUrl: imageUrl || null,
    time: Date.now(),
  });

  if (textEl) textEl.value = "";
  if (fileEl) fileEl.value = "";
}

function subscribeChatList() {
  if (!db) return;
  const addr = window.P2P.state.connectedAddress;
  if (!addr) return;
  if (typeof unsubChatList === "function") unsubChatList();

  const list = document.getElementById("chatList");
  if (!list) return;

  unsubChatList = db
    .collection("Orders")
    .where("status", "==", "active")
    .onSnapshot((snap) => {
      const mine = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((o) => o.userAddress === addr || o.merchantAddress === addr);

      if (mine.length === 0) {
        list.innerHTML = `<div class="meta" style="text-align:center; padding: 30px 0;">لا توجد محادثات</div>`;
        return;
      }

      list.innerHTML = mine
        .map((o) => {
          const peer = o.userAddress === addr ? o.merchantAddress : o.userAddress;
          return `
            <article class="adCard">
              <div class="adCard__top">
                <div class="merchant">
                  <span class="avatar"><i class="fa-solid fa-comments"></i></span>
                  <span>Order ${o.id}</span>
                </div>
                <button class="actionBtn actionBtn--green" type="button" onclick="openChat('${o.id}')">فتح</button>
              </div>
              <div class="meta">الطرف الآخر: <b>${String(peer).slice(0,4)}...${String(peer).slice(-4)}</b></div>
            </article>
          `;
        })
        .join("");
    });
}

// Expose globals used by HTML handlers.
window.openChat = openChat;
window.closeChat = closeChat;
window.sendChatMessage = sendChatMessage;

window.P2P.chat.openChat = openChat;
window.P2P.chat.closeChat = closeChat;
window.P2P.chat.sendChatMessage = sendChatMessage;
window.P2P.chat.subscribeChatList = subscribeChatList;

document.addEventListener("p2p:walletConnected", () => {
  subscribeChatList();
});

