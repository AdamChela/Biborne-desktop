// ===== Config & Etat =====
const SERVER_URL = (typeof BIBORNE_CONFIG !== "undefined" ? BIBORNE_CONFIG.SERVER_URL : "http://localhost:4000");

const state = {
  token: localStorage.getItem("token") || "",
  employee: JSON.parse(localStorage.getItem("employee") || "null"),
  conversations: [],
  filtered: [],
  currentConvId: null,
  filter: "all",
  search: "",
  socket: null,
  isRecording: false,
  mediaRecorder: null,
  recordedChunks: [],
  activeCall: null,
  callTimer: null,
  callSeconds: 0,
  presence: localStorage.getItem("presence") || "online",
  settings: JSON.parse(localStorage.getItem("settings") || JSON.stringify({
    notifSound: true, notifDesktop: true, notifPreview: true,
    confirmClose: true, readReceipts: true, fontSize: 1, showTime: true, theme: "dark"
  })),
  // Réponses rapides : partagées entre tous les employés, stockées sur le serveur (plus de localStorage)
  quickReplies: [],
  // Note interne de la conversation actuellement ouverte : partagée entre tous les employés
  currentNote: { content: "", updatedByName: null },
  noteSaveTimeout: null,
  // Numéro du client de la conversation ouverte (affiché uniquement via le popup d'appel sur la bulle)
  currentClientPhone: "",
  currentClientName: "",
  // Mentions @ : collègues + invités de la conversation ouverte, et mentions en attente d'envoi
  allEmployees: null,
  mentionCandidates: [],
  pendingMentions: [],
  // Messages de la conversation ouverte, indexés par id (pour éditer/supprimer/marquer lu sans tout recharger)
  messagesById: {},
};

// Palette de couleurs stables par expéditeur (comme les noms colorés dans les groupes WhatsApp)
const SENDER_COLORS = ["#E8973A","#4FA3E3","#57C785","#E35D6A","#B98CE0","#4DD0C4","#E0B84D","#EE7EA6","#7C93E8","#59C2E0"];
function colorForSender(id) {
  const s = String(id || "");
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
  return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length];
}

function saveSettings() { localStorage.setItem("settings", JSON.stringify(state.settings)); }

// Titre affiché d'une conversation : le renommage (displayName) est prioritaire sur le nom du restaurant.
function titleFor(conv) {
  if (!conv) return "Client";
  if (conv.displayName) return conv.displayName;
  return conv.Client?.restaurantName && conv.Client?.city
    ? `${conv.Client.restaurantName.toUpperCase()} — ${conv.Client.city.toUpperCase()}`
    : conv.Client?.name || "Client";
}

// ===== Elements =====
const $ = id => document.getElementById(id);
const loginView = $("login-view"), appView = $("app-view");
const loginForm = $("login-form"), loginError = $("login-error");
const conversationListEl = $("conversation-list");
const messagesEl = $("messages"), typingIndicator = $("typing-indicator");
const composer = $("composer"), messageInput = $("message-input");
const fileInput = $("file-input"), micBtn = $("mic-btn");
const callBtn = $("call-btn"), videoCallBtn = $("video-call-btn"), callOverlay = $("call-overlay");
const deleteConvBtn = $("delete-conv-btn");
const callStatus = $("call-status-text"), callHangup = $("call-hangup");
const callRemoteVideo = $("call-remote-video"), callLocalVideo = $("call-local-video");
const callToggleMic = $("call-toggle-mic"), callToggleCam = $("call-toggle-cam");
const settingsPanel = $("settings-panel"), settingsOverlay = $("settings-overlay");
const quickRepliesEl = $("quick-replies");
const notesBtn = $("notes-btn"), notesPanel = $("notes-panel");
const notesTextarea = $("notes-textarea"), notesUpdatedByEl = $("notes-updated-by");

// ===== API =====
async function apiFetch(path, options = {}) {
  const res = await fetch(SERVER_URL + path, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      Authorization: "Bearer " + state.token,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Erreur " + res.status);
  return data;
}

// ===== Son notification =====
function playNotifSound() {
  if (!state.settings.notifSound) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;
    [880, 1100].forEach((freq, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = "sine"; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t + i * .12);
      gain.gain.linearRampToValueAtTime(.25, t + i * .12 + .02);
      gain.gain.exponentialRampToValueAtTime(.001, t + i * .12 + .2);
      osc.start(t + i * .12); osc.stop(t + i * .12 + .25);
    });
  } catch(e) {}
}

// ===== Connexion =====
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.hidden = true;
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  if (!email || !password) { loginError.textContent = "Merci de remplir tous les champs."; loginError.hidden = false; return; }
  try {
    const res = await fetch(SERVER_URL + "/api/auth/employee/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Connexion impossible");
    state.token = data.token; state.employee = data.employee;
    localStorage.setItem("token", data.token);
    localStorage.setItem("employee", JSON.stringify(data.employee));
    startApp();
  } catch (err) {
    loginError.textContent = err.message.includes("fetch") ? "Impossible de joindre le serveur." : err.message;
    loginError.hidden = false;
  }
});

// ===== Déconnexion =====
function doLogout() {
  localStorage.removeItem("token"); localStorage.removeItem("employee");
  if (state.socket) state.socket.disconnect();
  state.token = ""; state.employee = null; state.currentConvId = null;
  loginView.hidden = false; appView.hidden = true;
  closeSettings();
}
$("logout-btn").addEventListener("click", doLogout);
$("settings-logout").addEventListener("click", doLogout);

// ===== Démarrage =====
function startApp() {
  loginView.hidden = true; appView.hidden = false;
  const emp = state.employee;
  const initials = emp.name.split(" ").map(p => p[0]).join("").slice(0,2).toUpperCase();
  $("employee-name").textContent = emp.name;
  $("employee-avatar").textContent = initials;
  $("settings-avatar").textContent = initials;
  $("settings-name").textContent = emp.name;
  $("settings-email").textContent = emp.email;
  $("settings-role-badge").textContent = emp.role;
  updatePresenceUI(state.presence);
  applyTheme();
  loadQuickReplies();
  connectSocket();
  loadConversations();
}

// ===== Bandeau de connexion (utile car le serveur gratuit peut mettre du temps à se réveiller) =====
function showConnBanner(text) {
  let el = document.getElementById("conn-banner");
  if (!el) { el = document.createElement("div"); el.id = "conn-banner"; el.className = "conn-banner"; document.body.appendChild(el); }
  el.textContent = text;
  el.style.display = "flex";
}
function hideConnBanner() {
  const el = document.getElementById("conn-banner");
  if (el) el.style.display = "none";
}

// ===== Socket =====
function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io(SERVER_URL, { auth: { token: state.token } });
  state.socket.on("connect", () => hideConnBanner());
  state.socket.on("disconnect", () => showConnBanner("Connexion au serveur perdue, reconnexion en cours…"));
  state.socket.on("new_message", (msg) => {
    if (msg.conversationId === state.currentConvId) { appendMessage(msg); scrollBottom(); }
    else { playNotifSound(); showDesktopNotif(msg); }
    loadConversations();
  });
  state.socket.on("typing", ({ conversationId, userType, isTyping }) => {
    if (conversationId === state.currentConvId && userType === "client")
      typingIndicator.hidden = !isTyping;
  });
  state.socket.on("ticket_updated", ({ conversationId, ticketStatus, ticketOwner }) => {
    const c = state.conversations.find(c => c.id === conversationId);
    if (c) { c.ticketStatus = ticketStatus; c.ticketOwner = ticketOwner; renderConversationList(); updateStats(); }
    if (conversationId === state.currentConvId) updateTicketUI(ticketStatus, ticketOwner);
  });
  state.socket.on("call:answer", ({ sessionId, answer }) => {
    if (state.activeCall?.peerConnection) {
      state.activeCall.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      markCallConnected(); // dès que le client décroche, le chrono démarre côté employé
    }
  });
  state.socket.on("call:ice", ({ candidate }) => {
    if (state.activeCall?.peerConnection) state.activeCall.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  });
  state.socket.on("call:end", ({ reason }) => endCall(reason));
  state.socket.on("note_updated", ({ conversationId, content, updatedByName }) => {
    if (conversationId !== state.currentConvId) return;
    state.currentNote = { content, updatedByName };
    // On ne touche pas au textarea si l'employé est en train d'y taper
    if (document.activeElement !== notesTextarea) {
      notesTextarea.value = content || "";
    }
    notesUpdatedByEl.textContent = updatedByName ? `Modifiée par ${updatedByName}` : "";
  });
  state.socket.on("conversation_deleted", ({ conversationId }) => {
    removeConversationFromUI(conversationId);
  });
  state.socket.on("client_approved_broadcast", ({ conversationId }) => {
    const c = state.conversations.find(x => x.id === conversationId);
    if (c && c.Client) { c.Client.approved = true; renderConversationList(); }
    if (conversationId === state.currentConvId) updateApproveBtn(c);
  });
  state.socket.on("conversation_renamed", ({ conversationId, displayName }) => {
    const c = state.conversations.find(x => x.id === conversationId);
    if (c) { c.displayName = displayName; renderConversationList(); }
    if (conversationId === state.currentConvId) {
      $("chat-client-name").textContent = titleFor(c);
      $("call-client-name").textContent = titleFor(c);
    }
  });
  state.socket.on("message_edited", (payload) => applyMessageEdit(payload));
  state.socket.on("message_deleted", ({ id }) => applyMessageDelete(id));
  state.socket.on("messages_read", ({ conversationId, readerType }) => {
    if (conversationId !== state.currentConvId) return;
    if (readerType === "client" || readerType === "guest") {
      Object.values(state.messagesById).forEach(m => {
        if (m.senderType === "employee" && m.status !== "read") updateCheckmark(m.id, "read");
      });
    }
  });
  state.socket.on("conversation_unread_changed", ({ conversationId, unread }) => {
    const c = state.conversations.find(x => x.id === conversationId);
    if (c) { c.unreadForEmployees = unread; renderConversationList(); }
  });
  state.socket.on("quick_reply_added", (reply) => {
    if (!state.quickReplies.find(r => r.id === reply.id)) state.quickReplies.push(reply);
    renderQuickRepliesSettings(); renderQuickReplies();
  });
  state.socket.on("quick_reply_deleted", ({ id }) => {
    state.quickReplies = state.quickReplies.filter(r => r.id !== id);
    renderQuickRepliesSettings(); renderQuickReplies();
  });
}

// ===== Desktop notifications =====
function showDesktopNotif(msg) {
  if (!state.settings.notifDesktop) return;
  if (Notification.permission === "default") Notification.requestPermission();
  if (Notification.permission !== "granted") return;
  const body = state.settings.notifPreview
    ? (msg.type === "text" ? msg.content : "Fichier reçu")
    : "Nouveau message";
  new Notification("Biborne Messagerie", { body, icon: "../build/icon.png" });
}

// ===== Conversations =====
async function loadConversations() {
  try {
    state.conversations = await apiFetch("/api/conversations");
    updateStats();
    renderConversationList();
  } catch (err) { console.error(err); }
}

// Compte les conversations par statut de TICKET (todo/in_progress/urgent/waiting/done) — c'est le
// vrai workflow utilisé partout ailleurs dans l'app (labels, filtres). Avant, ce widget comptait
// Conversation.status, un champ qui reste toujours à "open" par défaut et n'est jamais changé nulle
// part : les stats affichaient donc systématiquement 1/0/0 (ou équivalent), sans rapport avec la réalité.
function updateStats() {
  const open    = state.conversations.filter(c => ["todo","in_progress","urgent"].includes(c.ticketStatus || "todo")).length;
  const pending = state.conversations.filter(c => c.ticketStatus === "waiting").length;
  const closed  = state.conversations.filter(c => c.ticketStatus === "done").length;
  $("stat-open").textContent = open;
  $("stat-pending").textContent = pending;
  $("stat-closed").textContent = closed;
}

const STATUS_COLOR = { open: "status-open", pending: "status-pending", closed: "status-closed" };
const STATUS_LABEL = { open: "Ouverte", pending: "En attente", closed: "Clôturée" };
const TICKET = {
  todo:        { label: "À faire",   color: "#E74C3C", cls: "ticket-todo" },
  in_progress: { label: "En cours",  color: "#F1C40F", cls: "ticket-progress" },
  done:        { label: "Fait",      color: "#2ECC71", cls: "ticket-done" },
};
// Petit point coloré (remplace les emoji 🔴🟡✅ dans les badges de statut)
function ticketDot(color) { return `<span class="ticket-dot" style="background:${color}"></span>`; }

function renderConversationList() {
  const q = state.search.toLowerCase();
  let list = state.conversations.filter(c => {
    const ts = c.ticketStatus || "todo";
    if (state.filter === "not_done") return ts !== "done";
    if (state.filter === "done") return ts === "done";
    if (state.filter === "stat_open") return ["todo","in_progress","urgent"].includes(ts);
    if (state.filter === "stat_pending") return ts === "waiting";
    return true;
  }).filter(c => {
    if (!q) return true;
    const name = (c.Client?.name || "").toLowerCase();
    const rest = (c.Client?.restaurantName || "").toLowerCase();
    const city = (c.Client?.city || "").toLowerCase();
    const preview = (c.Messages?.[0]?.content || "").toLowerCase();
    return name.includes(q) || rest.includes(q) || city.includes(q) || preview.includes(q);
  });

  // Complète avec les résultats de recherche serveur (contenu des messages, voir searchInput ci-dessous)
  if (q && state.searchContentResults) {
    const ids = new Set(list.map(c => c.id));
    state.searchContentResults.forEach(r => {
      if (ids.has(r.id)) {
        const idx = list.findIndex(c => c.id === r.id);
        if (r.matchSnippet) list[idx] = { ...list[idx], matchSnippet: r.matchSnippet };
      } else {
        list.push({ ...(state.conversations.find(c => c.id === r.id) || r), matchSnippet: r.matchSnippet });
        ids.add(r.id);
      }
    });
  }

  if (!list.length) {
    conversationListEl.innerHTML = '<div class="empty-state">Aucune conversation.</div>';
    return;
  }
  conversationListEl.innerHTML = "";
  list.forEach(conv => {
    const lastMsg = conv.Messages?.[0];
    const t = TICKET[conv.ticketStatus || "todo"];
    const ownerTxt = conv.ticketOwner ? ` · ${conv.ticketOwner}` : "";
    // Titre : nom personnalisé si renommé, sinon RESTAURANT - VILLE
    const convTitle = titleFor(conv);
    const initials = convTitle.split(" ").map(p => p[0]).filter(Boolean).join("").slice(0,2).toUpperCase();
    const preview = conv.matchSnippet
      ? `🔎 "${escHtml(conv.matchSnippet.slice(0, 70))}"`
      : (lastMsg ? (lastMsg.type === "text" ? escHtml(lastMsg.content || "") : {image:"Photo",video:"Vidéo",audio:"Vocal",file:"Fichier"}[lastMsg.type]) : "Aucun message");
    const time = lastMsg ? formatTime(lastMsg.createdAt) : "";
    const waitBadge = conv.Client && !conv.Client.approved ? `<span class="ticket-badge" style="background:#fff3cd;color:#a35c00">${ticketDot("#e0a800")}Non validé</span>` : "";
    const unreadDot = conv.unreadForEmployees ? `<span class="unread-badge" style="width:9px;height:9px;min-width:9px;padding:0;border-radius:50%"></span>` : "";

    const item = document.createElement("div");
    item.className = "conversation-item" + (conv.id === state.currentConvId ? " active" : "") + (conv.unreadForEmployees ? " has-unread" : "");
    item.innerHTML = `
      <div class="conv-avatar">${initials}</div>
      <div class="conv-main">
        <div class="conv-top">
          <span class="conv-name">${escHtml(convTitle)}</span>
          <div style="display:flex;align-items:center;gap:6px">${unreadDot}<span class="conv-time">${time}</span></div>
        </div>
        <div class="conv-preview">${escHtml(conv.Client?.name || "")} ${preview}</div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:3px">
          <span class="ticket-badge ${t.cls}">${ticketDot(t.color)}${t.label}${ownerTxt}</span>${waitBadge}
        </div>
      </div>`;
    item.addEventListener("click", () => selectConversation(conv.id));
    conversationListEl.appendChild(item);
  });
}

// Recherche : filtre local instantané (nom/restaurant/ville) + recherche serveur dans le contenu
// des messages (avec un léger délai pour ne pas spammer l'API à chaque frappe).
let searchDebounce = null;
$("search-input").addEventListener("input", (e) => {
  state.search = e.target.value;
  state.searchContentResults = null;
  renderConversationList();
  clearTimeout(searchDebounce);
  const q = state.search.trim();
  if (!q) return;
  searchDebounce = setTimeout(async () => {
    try {
      const results = await apiFetch("/api/conversations/search?q=" + encodeURIComponent(q));
      if (state.search.trim() !== q) return; // le texte a changé entre-temps
      state.searchContentResults = results;
      renderConversationList();
    } catch (err) { console.error(err); }
  }, 350);
});

// Filtres (chips "Toutes/Pas fait/Fait" et cartes de stats "Ouvertes/En attente/Clôturées" partagent
// le même axe de filtrage — un clic sur l'un désactive l'autre).
function clearActiveFilterUI() {
  document.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("active"));
  document.querySelectorAll(".stat-item").forEach(c => c.classList.remove("active"));
}
document.querySelectorAll(".filter-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    clearActiveFilterUI();
    chip.classList.add("active");
    state.filter = chip.dataset.filter;
    renderConversationList();
  });
});
function bindStatFilter(itemId, filterValue) {
  $(itemId).addEventListener("click", () => {
    clearActiveFilterUI();
    $(itemId).classList.add("active");
    state.filter = filterValue;
    renderConversationList();
  });
}
bindStatFilter("stat-item-open", "stat_open");
bindStatFilter("stat-item-pending", "stat_pending");
bindStatFilter("stat-item-closed", "done"); // réutilise le même filtre que la puce "Fait"

// ===== Sélection conversation =====
async function selectConversation(id) {
  state.currentConvId = id;
  renderConversationList();
  const conv = state.conversations.find(c => c.id === id);
  const convTitle = titleFor(conv);
  const initials = convTitle.split(" ").map(p=>p[0]).filter(Boolean).join("").slice(0,2).toUpperCase();
  $("chat-client-name").textContent = convTitle;
  $("chat-client-meta").textContent = conv.Client?.name || "";
  $("chat-avatar").textContent = initials;
  $("call-avatar").textContent = initials;
  $("call-client-name").textContent = convTitle;
  callBtn.dataset.clientId = conv.Client?.id || "";
  videoCallBtn.dataset.clientId = conv.Client?.id || "";
  state.currentClientPhone = conv.Client?.phone || "";
  state.currentClientName = conv.Client?.name || "Client";
  refreshMentionCandidates(id);
  deleteConvBtn.hidden = !state.employee?.canDelete;
  updateApproveBtn(conv);

  const badge = $("chat-status-badge");
  const tkt = TICKET[conv.ticketStatus || "todo"];
  badge.className = "status-badge";
  badge.innerHTML = `${ticketDot(tkt.color)}${tkt.label}`;

  typingIndicator.hidden = true;
  updateTicketUI(conv.ticketStatus || "todo", conv.ticketOwner);

  $("chat-empty").hidden = true;
  $("chat-active").hidden = false;
  notesPanel.hidden = true;
  quickRepliesEl.hidden = true;
  state.currentNote = { content: "", updatedByName: null };
  notesTextarea.value = "";
  notesUpdatedByEl.textContent = "";
  state.socket?.emit("join_conversation", id);

  state.msgLimit = 50;
  await fetchAndRenderMessages(id, false);
  // Marque les messages du client/invité comme lus (coches doubles côté expéditeur) + retire le badge non-lu.
  apiFetch("/api/messages/" + id + "/read", { method: "POST" }).catch(() => {});
  if (conv) { conv.unreadForEmployees = false; renderConversationList(); }

  loadNote(id);
}

// Historique paginé : 50 derniers messages au départ (voir GET /api/messages/:convId côté backend),
// puis "Charger les messages précédents" élargit la fenêtre par pas de 50.
async function fetchAndRenderMessages(convId, preserveScroll) {
  try {
    state.messagesById = {};
    const prevScrollHeight = preserveScroll ? messagesEl.scrollHeight : 0;
    const prevScrollTop = preserveScroll ? messagesEl.scrollTop : 0;
    const data = await apiFetch("/api/messages/" + convId + "?limit=" + state.msgLimit);
    if (convId !== state.currentConvId) return; // conversation changée entre-temps
    state.hasMoreMsgs = !!data.hasMore;
    messagesEl.innerHTML = "";
    (data.messages || []).forEach(appendMessage);
    renderLoadMoreBtn();
    if (preserveScroll) messagesEl.scrollTop = prevScrollTop + (messagesEl.scrollHeight - prevScrollHeight);
    else scrollBottom();
  } catch (err) { console.error(err); }
}
function renderLoadMoreBtn() {
  document.getElementById("load-more-btn")?.remove();
  if (!state.hasMoreMsgs) return;
  const btn = document.createElement("div");
  btn.id = "load-more-btn";
  btn.className = "load-more-btn";
  btn.textContent = "Charger les messages précédents";
  btn.onclick = loadOlderMessages;
  messagesEl.prepend(btn);
}
async function loadOlderMessages() {
  if (state.loadingOlderMsgs || !state.hasMoreMsgs) return;
  state.loadingOlderMsgs = true;
  const btn = document.getElementById("load-more-btn");
  if (btn) btn.textContent = "Chargement…";
  state.msgLimit += 50;
  await fetchAndRenderMessages(state.currentConvId, true);
  state.loadingOlderMsgs = false;
}

function findBubbleRow(id) { return messagesEl.querySelector(`[data-msg-id="${id}"]`); }

// ===== Note interne partagée =====
async function loadNote(convId) {
  try {
    const note = await apiFetch("/api/conversations/" + convId + "/note");
    if (convId !== state.currentConvId) return; // conversation changée entre-temps
    state.currentNote = { content: note.content || "", updatedByName: note.updatedByName || null };
    notesTextarea.value = state.currentNote.content;
    notesUpdatedByEl.textContent = state.currentNote.updatedByName ? `Modifiée par ${state.currentNote.updatedByName}` : "";
  } catch (err) { console.error(err); }
}

notesBtn.addEventListener("click", () => {
  if (!state.currentConvId) return;
  notesPanel.hidden = !notesPanel.hidden;
  if (!notesPanel.hidden) notesTextarea.focus();
});

notesTextarea.addEventListener("input", () => {
  if (!state.currentConvId) return;
  clearTimeout(state.noteSaveTimeout);
  state.noteSaveTimeout = setTimeout(async () => {
    try {
      const convId = state.currentConvId;
      const note = await apiFetch("/api/conversations/" + convId + "/note", {
        method: "PUT", body: JSON.stringify({ content: notesTextarea.value }),
      });
      if (convId === state.currentConvId) {
        notesUpdatedByEl.textContent = note.updatedByName ? `Modifiée par ${note.updatedByName}` : "";
      }
    } catch (err) { console.error(err); }
  }, 600);
});

// Ticket
function updateTicketUI(ticketStatus, ticketOwner) {
  const t = TICKET[ticketStatus || "todo"];
  const ownerTxt = ticketOwner ? ` · ${ticketOwner}` : "";
  $("ticket-display").innerHTML = `${ticketDot(t.color)}${t.label}${ownerTxt}`;
  $("ticket-display").className = `ticket-display ${t.cls}`;
  const radio = document.querySelector(`input[name="ticket"][value="${ticketStatus || "todo"}"]`);
  if (radio) radio.checked = true;
}

document.querySelectorAll("input[name='ticket']").forEach(radio => {
  radio.addEventListener("change", async () => {
    if (!state.currentConvId) return;
    try {
      const conv = await apiFetch(`/api/conversations/${state.currentConvId}/ticket`, {
        method: "PATCH", body: JSON.stringify({ ticketStatus: radio.value }),
      });
      updateTicketUI(conv.ticketStatus, conv.ticketOwner);
      const local = state.conversations.find(c => c.id === state.currentConvId);
      if (local) { local.ticketStatus = conv.ticketStatus; local.ticketOwner = conv.ticketOwner; }
      renderConversationList();
    } catch (err) { alert(err.message); }
  });
});

// ===== Messages =====
const CHECK_SVG = `<svg viewBox="0 0 16 11" width="14" height="10" fill="none"><path class="c1" d="M1 5.5L4.5 9L11 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path class="c2" d="M5.5 5.5L9 9L15.5 1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function canEditMsg(msg) { return msg.senderType === "employee" && msg.employeeId === state.employee?.id && msg.type === "text" && !msg.deletedAt; }
function canDeleteMsg(msg) { return !msg.deletedAt && ((msg.senderType === "employee" && msg.employeeId === state.employee?.id) || !!state.employee?.canDelete); }

function appendMessage(msg) {
  state.messagesById[msg.id] = msg;
  const row = document.createElement("div");
  row.className = "bubble-row " + msg.senderType;
  row.dataset.msgId = msg.id;
  const bub = document.createElement("div");
  bub.className = "bubble";

  if (msg.deletedAt) {
    bub.innerHTML = `<span class="msg-deleted">Message supprimé</span>`;
    row.appendChild(bub);
    messagesEl.appendChild(row);
    return;
  }

  // Actions (modifier/supprimer), visibles au survol pour les messages de l'employé courant
  if (canEditMsg(msg) || canDeleteMsg(msg)) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    if (canEditMsg(msg)) actions.innerHTML += `<button type="button" class="msg-act-btn" title="Modifier" onclick="startEditMessage('${msg.id}')"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`;
    if (canDeleteMsg(msg)) actions.innerHTML += `<button type="button" class="msg-act-btn danger" title="Supprimer" onclick="deleteMessageConfirm('${msg.id}')"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>`;
    row.appendChild(actions);
  }

  // Les fichiers récents sont hébergés sur Cloudinary (URL absolue) ; on ne préfixe
  // avec SERVER_URL que pour d'anciens fichiers locaux (chemin relatif /uploads/...).
  const fileUrl = msg.fileUrl ? (msg.fileUrl.startsWith("http") ? msg.fileUrl : SERVER_URL + msg.fileUrl) : null;
  let content = "";
  const isImageFile = msg.type === "image" || (msg.mimeType && msg.mimeType.startsWith("image/"));
  if (isImageFile) {
    content = `<img src="${fileUrl}" style="max-width:240px;border-radius:8px;display:block;cursor:pointer" onclick="window.open('${fileUrl}','_blank')"/>`;
  } else switch(msg.type) {
    case "video": content = `<video src="${fileUrl}" controls style="max-width:240px;border-radius:8px;display:block"></video>`; break;
    case "audio": content = `<span class="voice-row"><audio src="${fileUrl}" controls style="width:220px"></audio>${msg.duration ? `<span class="voice-dur">${formatDuration(msg.duration)}</span>` : ""}</span>`; break;
    case "file":  content = `<a class="file-chip" href="${fileUrl}" target="_blank"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg> ${escHtml(msg.fileName||"Fichier")}</a>`; break;
    case "call":  content = `<span class="call-msg"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.07 10.9 19.79 19.79 0 0 1 1 2.18 2 2 0 0 1 3 0h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.09 7.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21 14.92z"/></svg> Appel ${msg.callStatus||""} ${msg.duration?formatDuration(msg.duration):""}</span>`; break;
    default: {
      let escaped = escHtml(msg.content || "");
      if (msg.mentions) {
        try {
          JSON.parse(msg.mentions).forEach(m => {
            const nameEsc = escHtml(m.name || "");
            if (!nameEsc) return;
            const re = new RegExp("@" + nameEsc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
            escaped = escaped.replace(re, `<span class="mention-chip">@${nameEsc}</span>`);
          });
        } catch (e) {}
      }
      content = `<span class="msg-text">${escaped}</span>`;
    }
  }
  // Légende (comme WhatsApp) : uniquement pour les médias, le texte simple est déjà géré dans le switch ci-dessus.
  if (msg.content && msg.type !== "text") content += `<div class="msg-caption">${escHtml(msg.content)}</div>`;
  if (msg.edited) content += `<span class="msg-edited-tag"> (modifié)</span>`;
  if (state.settings.showTime) content += `<span class="bubble-meta">${formatTime(msg.createdAt)}</span>`;
  if (msg.senderType === "employee") content += `<span class="msg-check ${msg.status === "read" ? "read" : ""}">${CHECK_SVG}</span>`;
  // Nom de l'expéditeur au-dessus du contenu, coloré différemment par personne (comme les groupes WhatsApp)
  const senderName = msg.senderType === "employee" ? (msg.Employee?.name || "Employé")
    : msg.senderType === "client" ? (state.currentClientName || "Client")
    : msg.senderType === "guest" ? (msg.guestName || "Invité") : "";
  let senderLabel = "";
  if (senderName) {
    const color = colorForSender(msg.employeeId || msg.clientId || msg.guestName || msg.senderType);
    senderLabel = `<div class="bubble-sender" style="color:${color}">${escHtml(senderName)}</div>`;
  }
  bub.innerHTML = senderLabel + content;
  bub.style.fontSize = ["12px","14px","16px"][state.settings.fontSize] || "14px";
  // Bulle des invités : teinte de fond propre à chaque personne (comme le nom coloré au-dessus)
  if (msg.senderType === "guest") {
    const guestColor = colorForSender(msg.guestId || msg.guestName || "guest");
    bub.style.background = guestColor + "26"; // ~15% opacité
  }
  // Sur les bulles envoyées par le client OU un invité : un clic ouvre un petit popup avec son numéro + appel
  if (msg.senderType === "client" || msg.senderType === "guest") {
    bub.classList.add("bubble-clickable");
    bub.addEventListener("click", (e) => { e.stopPropagation(); showClientCallPopup(bub, msg); });
  }
  row.appendChild(bub);
  messagesEl.appendChild(row);
}

// ===== Modifier / supprimer un message =====
async function startEditMessage(id) {
  const msg = state.messagesById[id];
  if (!msg) return;
  const val = prompt("Modifier le message :", msg.content || "");
  if (val === null || !val.trim() || val.trim() === msg.content) return;
  try {
    const updated = await apiFetch("/api/messages/single/" + id, { method: "PATCH", body: JSON.stringify({ content: val.trim() }) });
    applyMessageEdit(updated);
  } catch (err) { alert("Modification impossible : " + err.message); }
}
async function deleteMessageConfirm(id) {
  if (!confirm("Supprimer ce message pour tout le monde ? Cette action est irréversible.")) return;
  try {
    await apiFetch("/api/messages/single/" + id, { method: "DELETE" });
    applyMessageDelete(id);
  } catch (err) { alert("Suppression impossible : " + err.message); }
}
function applyMessageEdit({ id, content }) {
  const msg = state.messagesById[id];
  if (msg) { msg.content = content; msg.edited = true; }
  const row = findBubbleRow(id);
  if (!row) return;
  const textEl = row.querySelector(".msg-text");
  if (textEl) textEl.textContent = content; // textContent : jamais interprété comme HTML, pas de risque XSS
  if (!row.querySelector(".msg-edited-tag")) {
    const tag = document.createElement("span");
    tag.className = "msg-edited-tag";
    tag.textContent = " (modifié)";
    textEl?.after(tag);
  }
}
function applyMessageDelete(id) {
  const msg = state.messagesById[id];
  if (msg) msg.deletedAt = new Date().toISOString();
  const row = findBubbleRow(id);
  if (!row) return;
  row.querySelector(".msg-actions")?.remove();
  const bub = row.querySelector(".bubble");
  if (bub) bub.innerHTML = `<span class="msg-deleted">Message supprimé</span>`;
}
function updateCheckmark(id, status) {
  const msg = state.messagesById[id];
  if (msg) msg.status = status;
  const row = findBubbleRow(id);
  row?.querySelector(".msg-check")?.classList.toggle("read", status === "read");
}

// ===== Popup "appeler le client" (ouvert au clic sur une bulle client) =====
function closeClientCallPopup() {
  const existing = document.getElementById("bubble-call-popup");
  if (existing) existing.remove();
  document.removeEventListener("click", onDocClickCloseCallPopup);
}
function onDocClickCloseCallPopup(e) {
  const popup = document.getElementById("bubble-call-popup");
  if (popup && !popup.contains(e.target)) closeClientCallPopup();
}
function showClientCallPopup(anchorEl, msg) {
  closeClientCallPopup();
  const isGuest = msg && msg.senderType === "guest";
  const target = isGuest
    ? { type: "guest", id: msg.guestId, name: msg.guestName || "Invité", phone: msg.guestPhone }
    : { type: "client", id: callBtn.dataset.clientId, name: state.currentClientName || "Client", phone: state.currentClientPhone };
  const phone = target.phone || "Numéro non renseigné";
  const roleLabel = isGuest ? (msg.guestRole === "manager" ? "Manager (invité)" : "Employé (invité)") : "Client";
  const popup = document.createElement("div");
  popup.id = "bubble-call-popup";
  popup.className = "bubble-call-popup";
  popup.innerHTML = `
    <div class="bcp-name">${escHtml(target.name)}</div>
    <div class="bcp-role">${escHtml(roleLabel)}</div>
    <div class="bcp-phone">${escHtml(phone)}</div>
    <div class="bcp-actions">
      <button type="button" class="bcp-btn bcp-audio"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.07 10.9 19.79 19.79 0 0 1 1 2.18 2 2 0 0 1 3 0h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.09 7.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21 14.92z"/></svg>Appeler</button>
      <button type="button" class="bcp-btn bcp-video"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>Visio</button>
    </div>`;
  document.body.appendChild(popup);
  const rect = anchorEl.getBoundingClientRect();
  const popupWidth = 210;
  popup.style.top = (rect.bottom + window.scrollY + 6) + "px";
  popup.style.left = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - popupWidth - 8)) + "px";
  popup.querySelector(".bcp-audio").addEventListener("click", (e) => { e.stopPropagation(); closeClientCallPopup(); startCallFlow(false, target); });
  popup.querySelector(".bcp-video").addEventListener("click", (e) => { e.stopPropagation(); closeClientCallPopup(); startCallFlow(true, target); });
  setTimeout(() => document.addEventListener("click", onDocClickCloseCallPopup), 0);
}

// Bandeau d'échec d'envoi (texte ou fichier), avec bouton Réessayer : évite de perdre le message
// tapé (contrairement à un simple alert()) et permet de renvoyer sans tout retaper.
function showSendError(msg, retryFn) {
  let el = document.getElementById("send-error-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "send-error-banner";
    el.className = "send-error-banner";
    composer.parentElement.insertBefore(el, composer);
  }
  el.innerHTML = `<span>${escHtml(msg)}</span>` + (retryFn ? `<button type="button" class="send-error-retry">Réessayer</button>` : "");
  el.style.display = "flex";
  if (retryFn) el.querySelector(".send-error-retry").onclick = () => { hideSendError(); retryFn(); };
}
function hideSendError() {
  const el = document.getElementById("send-error-banner");
  if (el) el.style.display = "none";
}

async function sendTextMessage(content) {
  if (!content || !state.currentConvId) return;
  const seen = new Set(); const mentions = [];
  (state.pendingMentions || []).forEach(m => {
    if (!content.includes("@" + m.name)) return;
    const k = m.type + ":" + m.id;
    if (seen.has(k)) return;
    seen.add(k); mentions.push({ type: m.type, id: m.id, name: m.name });
  });
  state.pendingMentions = [];
  try {
    await apiFetch("/api/messages/" + state.currentConvId + "/text", { method: "POST", body: JSON.stringify({ content, mentions }) });
    hideSendError();
  } catch (err) {
    messageInput.value = content;
    showSendError("Message non envoyé.", () => sendTextMessage(content));
  }
}

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  // Une photo/vidéo est en attente (aperçu affiché au-dessus du composer, comme WhatsApp) :
  // le texte tapé devient sa légende plutôt qu'un message séparé.
  if (state.pendingMedia) { await sendPendingMedia(); return; }
  const content = messageInput.value.trim();
  if (!content) return;
  messageInput.value = "";
  hideMentionDropdown();
  await sendTextMessage(content);
});

let typingTimeout;
messageInput.addEventListener("input", () => {
  if (!state.currentConvId) return;
  state.socket?.emit("typing", { conversationId: state.currentConvId, isTyping: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => state.socket?.emit("typing", { conversationId: state.currentConvId, isTyping: false }), 1500);
  updateMentionDropdown();
});

// ===== Mentions @ (collègues + invités de la conversation ouverte) =====
async function refreshMentionCandidates(convId) {
  try {
    if (!state.allEmployees) state.allEmployees = await apiFetch("/api/auth/employees");
    const data = await apiFetch(`/api/conversations/${convId}/participants`);
    const empCands = (state.allEmployees || []).map(e => ({ type: "employee", id: e.id, name: e.name }));
    const guestCands = (data.guests || []).map(g => ({ type: "guest", id: g.id, name: g.displayName }));
    state.mentionCandidates = [...empCands, ...guestCands];
  } catch (e) { state.mentionCandidates = []; }
}

let mentionActive = false, mentionQuery = "";
function mentionMatches() {
  const q = mentionQuery.toLowerCase();
  return (state.mentionCandidates || []).filter(c => c.name.toLowerCase().includes(q)).slice(0, 6);
}
function updateMentionDropdown() {
  const val = messageInput.value;
  const pos = messageInput.selectionStart;
  const before = val.slice(0, pos);
  const m = before.match(/(^|\s)@([^\s@]{0,20})$/);
  if (!m) { hideMentionDropdown(); return; }
  mentionQuery = m[2];
  const matches = mentionMatches();
  const dd = $("mention-dropdown");
  if (!matches.length) { hideMentionDropdown(); return; }
  mentionActive = true;
  dd.innerHTML = matches.map((c, i) => `<div class="mention-item${i===0?" active":""}" data-idx="${i}"><span class="mention-tag">${c.type==="guest"?"Invité":"Employé"}</span><span>${escHtml(c.name)}</span></div>`).join("");
  dd.classList.remove("hidden");
  dd.querySelectorAll(".mention-item").forEach((el, i) => el.addEventListener("click", () => selectMention(matches[i])));
}
function hideMentionDropdown() {
  mentionActive = false;
  const dd = $("mention-dropdown");
  dd.classList.add("hidden");
  dd.innerHTML = "";
}
function selectMention(cand) {
  const val = messageInput.value;
  const pos = messageInput.selectionStart;
  const before = val.slice(0, pos);
  const idx = before.lastIndexOf("@");
  if (idx === -1) return;
  const after = val.slice(pos);
  messageInput.value = val.slice(0, idx) + "@" + cand.name + " " + after;
  const newPos = idx + cand.name.length + 2;
  messageInput.focus();
  messageInput.setSelectionRange(newPos, newPos);
  state.pendingMentions.push(cand);
  hideMentionDropdown();
}
messageInput.addEventListener("keydown", (e) => {
  if (!mentionActive) return;
  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    const matches = mentionMatches();
    if (matches[0]) selectMention(matches[0]);
  } else if (e.key === "Escape") { hideMentionDropdown(); }
});

// ===== Fichiers =====
// Redimensionne/compresse une photo avant l'envoi (économise de la bande passante). Ignore les GIF
// (perte de l'animation) et les fichiers déjà légers. Retombe silencieusement sur l'original en cas de souci.
function compressImageIfNeeded(file) {
  return new Promise(resolve => {
    if (!file.type.startsWith("image/") || file.type === "image/gif") { resolve(file); return; }
    if (file.size < 600 * 1024) { resolve(file); return; }
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const maxSide = 1600;
      const { width, height } = img;
      if (width <= maxSide && height <= maxSide) { resolve(file); return; }
      const scale = maxSide / Math.max(width, height);
      const w = Math.round(width * scale), h = Math.round(height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        if (!blob) { resolve(file); return; }
        resolve(new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" }));
      }, "image/jpeg", 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

async function sendMediaFile(file, type, fileName, caption, duration) {
  const fd = new FormData(); fd.append("file", file, fileName || file.name); fd.append("type", type);
  if (caption) fd.append("content", caption);
  if (duration) fd.append("duration", String(duration));
  try {
    await apiFetch("/api/messages/" + state.currentConvId + "/media", { method: "POST", body: fd });
    hideSendError();
  } catch (err) {
    showSendError("Échec de l'envoi" + (fileName || file.name ? ` de « ${fileName || file.name} »` : "") + ".", () => sendMediaFile(file, type, fileName, caption, duration));
  }
}

// Photo/vidéo : au lieu d'envoyer tout de suite, on affiche un aperçu au-dessus du composer
// (comme WhatsApp) pour permettre de taper une légende avant d'envoyer. Les autres types de
// fichiers (documents, audio) partent directement, une légende y étant moins pertinente.
function renderMediaPreview() {
  const bar = $("media-preview-bar");
  if (!state.pendingMedia) { bar.hidden = true; bar.innerHTML = ""; return; }
  const { file, type } = state.pendingMedia;
  const thumb = type === "image"
    ? `<img class="mp-thumb" src="${URL.createObjectURL(file)}"/>`
    : `<div class="mp-thumb mp-file"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg></div>`;
  bar.innerHTML = `${thumb}<div class="mp-info"><div class="mp-name">${escHtml(file.name || (type === "image" ? "Photo" : "Vidéo"))}</div><div class="mp-hint">Ajoute une légende puis envoie</div></div><div class="mp-close" title="Annuler">✕</div>`;
  bar.querySelector(".mp-close").onclick = cancelPendingMedia;
  bar.hidden = false;
}
function cancelPendingMedia() { state.pendingMedia = null; renderMediaPreview(); }
async function sendPendingMedia() {
  const pending = state.pendingMedia;
  if (!pending) return;
  state.pendingMedia = null; renderMediaPreview();
  const caption = messageInput.value.trim();
  messageInput.value = "";
  const file = pending.type === "image" ? await compressImageIfNeeded(pending.file) : pending.file;
  await sendMediaFile(file, pending.type, file.name, caption);
}

$("attach-btn").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file0 = fileInput.files[0]; fileInput.value = "";
  if (!file0 || !state.currentConvId) return;
  const type = file0.type.startsWith("image/") ? "image" : file0.type.startsWith("video/") ? "video" : file0.type.startsWith("audio/") ? "audio" : "file";
  if (type === "image" || type === "video") {
    state.pendingMedia = { file: file0, type };
    renderMediaPreview();
    messageInput.focus();
    return;
  }
  await sendMediaFile(file0, type, file0.name);
});

// ===== Vocal =====
function stopRecordingUI() {
  state.isRecording = false; micBtn.classList.remove("recording");
  clearInterval(state.recTimerInt);
  $("rec-bar").hidden = true;
}
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.recordedChunks = [];
    state.recCancelled = false;
    state.mediaRecorder = new MediaRecorder(stream);
    state.mediaRecorder.ondataavailable = e => state.recordedChunks.push(e.data);
    state.mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      if (state.recCancelled) { state.recCancelled = false; return; } // annulé via le X : rien à envoyer
      const durationSecs = Math.round((Date.now() - state.recStart) / 1000);
      const blob = new Blob(state.recordedChunks, { type: "audio/webm" });
      await sendMediaFile(blob, "audio", "vocal.webm", null, durationSecs);
    };
    state.mediaRecorder.start();
    state.isRecording = true; micBtn.classList.add("recording");
    state.recStart = Date.now();
    $("rec-timer").textContent = "0:00";
    $("rec-bar").hidden = false;
    clearInterval(state.recTimerInt);
    state.recTimerInt = setInterval(() => {
      $("rec-timer").textContent = formatDuration(Math.floor((Date.now() - state.recStart) / 1000));
    }, 250);
  } catch (err) { alert("Micro inaccessible : " + err.message); }
}
micBtn.addEventListener("click", async () => {
  if (!state.currentConvId) return;
  if (!state.isRecording) { await startRecording(); }
  else { state.mediaRecorder.stop(); stopRecordingUI(); }
});
$("rec-send-btn").addEventListener("click", () => {
  if (!state.isRecording) return;
  state.mediaRecorder.stop(); stopRecordingUI();
});
// Annule l'enregistrement en cours : le vocal n'est jamais envoyé (comme WhatsApp, glisser pour annuler).
$("rec-cancel-btn").addEventListener("click", () => {
  if (!state.isRecording) return;
  state.recCancelled = true;
  state.mediaRecorder.stop(); stopRecordingUI();
});

// ===== Réponses rapides =====
$("quick-reply-btn").addEventListener("click", () => {
  if (!state.currentConvId) return;
  const isVisible = !quickRepliesEl.hidden;
  quickRepliesEl.hidden = isVisible;
  if (!isVisible) renderQuickReplies();
});

async function loadQuickReplies() {
  try {
    state.quickReplies = await apiFetch("/api/quick-replies");
    renderQuickRepliesSettings();
    if (!quickRepliesEl.hidden) renderQuickReplies();
  } catch (err) { console.error(err); }
}

function renderQuickReplies() {
  // On évite onclick="...${JSON.stringify(...)}..." : le texte contient des guillemets
  // qui cassent l'attribut HTML (double-quoté) et empêchent le clic de fonctionner.
  // On utilise data-id + un vrai listener JS à la place.
  quickRepliesEl.innerHTML = state.quickReplies.map(r =>
    `<div class="quick-reply-chip" data-id="${r.id}">${escHtml(r.text)}</div>`
  ).join("");
  quickRepliesEl.querySelectorAll(".quick-reply-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const reply = state.quickReplies.find(r => r.id === chip.dataset.id);
      quickRepliesEl.hidden = true;
      if (reply) sendTextMessage(reply.text);
    });
  });
}

// ===== Appels WebRTC (audio + visio) =====
// Passe l'appel en "connecté" + démarre le chrono, une seule fois (appelé dès la réception
// de la réponse côté employé, ou dès que la connexion WebRTC est établie).
function markCallConnected() {
  if (!state.activeCall || state.activeCall.timerStarted) return;
  state.activeCall.timerStarted = true;
  callStatus.textContent = "En communication";
  startCallTimer();
}

// target={type:"client"|"guest", id, name} — par défaut, le client de la conversation courante.
async function startCallFlow(isVideo, target) {
  const t = target || { type: "client", id: callBtn.dataset.clientId, name: state.currentClientName };
  if (!t.id || state.activeCall) { if (t && !t.id) alert((t.type === "guest" ? "Invité" : "Client") + " introuvable (numéro/identifiant manquant)."); return; }
  try {
    const session = await apiFetch("/api/calls", { method: "POST", body: JSON.stringify({ targetType: t.type, targetId: t.id, type: isVideo ? "video" : "audio" }) });
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    state.activeCall = { sessionId: session.id, clientId: t.id, peerType: t.type, peerConnection: pc, isVideo, timerStarted: false };
    pc.onicecandidate = ({ candidate }) => { if (candidate) state.socket?.emit("call:ice", { targetType: t.type, targetId: t.id, sessionId: session.id, candidate }); };
    pc.ontrack = (e) => {
      if (isVideo) { if (callRemoteVideo) callRemoteVideo.srcObject = e.streams[0]; }
      else { const audio = $("call-audio"); if (audio) audio.srcObject = e.streams[0]; }
    };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "connected") markCallConnected(); if (["failed","disconnected","closed"].includes(pc.connectionState)) endCall(); };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo });
    state.activeCall.localStream = stream;
    stream.getTracks().forEach(t2 => pc.addTrack(t2, stream));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    state.socket?.emit("call:offer", { targetType: t.type, targetId: t.id, sessionId: session.id, offer: pc.localDescription, video: isVideo });
    const displayName = t.name || state.currentClientName;
    $("call-client-name").textContent = displayName;
    $("call-avatar").textContent = (displayName || "?").split(" ").map(p=>p[0]).filter(Boolean).join("").slice(0,2).toUpperCase();
    callStatus.textContent = "Ça sonne…";
    $("call-timer").textContent = "00:00";
    setupCallOverlayUI(isVideo, stream);
    callOverlay.hidden = false;
  } catch (err) { alert("Appel impossible : " + err.message); state.activeCall = null; }
}
callBtn.addEventListener("click", () => startCallFlow(false));
videoCallBtn.addEventListener("click", () => startCallFlow(true));

// ===== Validation manuelle d'un client + renommage du groupe =====
const approveClientBtn = $("approve-client-btn");
const renameConvBtn = $("rename-conv-btn");
function updateApproveBtn(conv) {
  approveClientBtn.style.display = (conv?.Client && !conv.Client.approved) ? "inline-flex" : "none";
}
approveClientBtn.addEventListener("click", async () => {
  if (!state.currentConvId) return;
  try {
    await apiFetch("/api/conversations/" + state.currentConvId + "/approve-client", { method: "PATCH" });
    const c = state.conversations.find(x => x.id === state.currentConvId);
    if (c?.Client) { c.Client.approved = true; renderConversationList(); }
    updateApproveBtn(c);
  } catch (err) { alert("Validation impossible : " + err.message); }
});
renameConvBtn.addEventListener("click", async () => {
  if (!state.currentConvId) return;
  const conv = state.conversations.find(c => c.id === state.currentConvId);
  const name = prompt("Nom du groupe :", conv?.displayName || "");
  if (name === null) return;
  try {
    const updated = await apiFetch("/api/conversations/" + state.currentConvId + "/name", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayName: name }),
    });
    if (conv) conv.displayName = updated.displayName;
    renderConversationList();
    $("chat-client-name").textContent = titleFor(conv);
    $("call-client-name").textContent = titleFor(conv);
  } catch (err) { alert("Renommage impossible : " + err.message); }
});

// ===== Suppression définitive d'une conversation (réservé aux employés autorisés) =====
deleteConvBtn.addEventListener("click", async () => {
  if (!state.currentConvId) return;
  const conv = state.conversations.find(c => c.id === state.currentConvId);
  const label = conv?.Client?.restaurantName || conv?.Client?.name || "cette conversation";
  if (!confirm(`Supprimer définitivement "${label}" ? Tous les messages, notes et l'historique seront perdus. Cette action est irréversible.`)) return;
  try {
    await apiFetch("/api/conversations/" + state.currentConvId, { method: "DELETE" });
    removeConversationFromUI(state.currentConvId);
  } catch (err) { alert("Suppression impossible : " + err.message); }
});
function removeConversationFromUI(convId) {
  state.conversations = state.conversations.filter(c => c.id !== convId);
  state.filtered = state.filtered.filter(c => c.id !== convId);
  renderConversationList();
  updateStats();
  if (state.currentConvId === convId) {
    state.currentConvId = null;
    $("chat-active").hidden = true;
    $("chat-empty").hidden = false;
  }
}

function setupCallOverlayUI(isVideo, localStream) {
  callOverlay.classList.toggle("video-mode", isVideo);
  if (isVideo && callLocalVideo) { callLocalVideo.srcObject = localStream; callLocalVideo.hidden = false; }
  else if (callLocalVideo) { callLocalVideo.hidden = true; callLocalVideo.srcObject = null; }
  if (callRemoteVideo) callRemoteVideo.hidden = !isVideo;
  callToggleCam.hidden = !isVideo;
  callToggleMic.classList.remove("off");
  callToggleCam.classList.remove("off");
}

callToggleMic.addEventListener("click", () => {
  const stream = state.activeCall?.localStream;
  if (!stream) return;
  const track = stream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  callToggleMic.classList.toggle("off", !track.enabled);
});
callToggleCam.addEventListener("click", () => {
  const stream = state.activeCall?.localStream;
  if (!stream) return;
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  callToggleCam.classList.toggle("off", !track.enabled);
});

callHangup.addEventListener("click", () => {
  if (!state.activeCall) return;
  state.socket?.emit("call:end", { targetType: state.activeCall.peerType || "client", targetId: state.activeCall.clientId, sessionId: state.activeCall.sessionId, reason: "ended" });
  endCall("ended");
});

function startCallTimer() {
  state.callSeconds = 0;
  state.callTimer = setInterval(() => {
    state.callSeconds++;
    $("call-timer").textContent = formatDuration(state.callSeconds);
  }, 1000);
}

function endCall(reason) {
  if (!state.activeCall) return;
  clearInterval(state.callTimer);
  try { state.activeCall.localStream?.getTracks().forEach(t => t.stop()); } catch {}
  try { state.activeCall.peerConnection?.close(); } catch {}
  apiFetch("/api/calls/" + state.activeCall.sessionId, { method: "PATCH", body: JSON.stringify({ status: reason || "ended" }) }).catch(() => {});
  state.activeCall = null;
  callOverlay.hidden = true;
  callOverlay.classList.remove("video-mode");
  if (callRemoteVideo) { callRemoteVideo.hidden = true; callRemoteVideo.srcObject = null; }
  if (callLocalVideo) { callLocalVideo.hidden = true; callLocalVideo.srcObject = null; }
}

// ===== PARTICIPANTS (liste des personnes présentes dans la conversation) =====
const participantsPanel = $("participants-panel"), participantsOverlay = $("participants-overlay");
$("chat-header-left").addEventListener("click", openParticipants);
$("participants-close").addEventListener("click", closeParticipants);
participantsOverlay.addEventListener("click", closeParticipants);

async function openParticipants() {
  if (!state.currentConvId) return;
  participantsPanel.classList.remove("hidden");
  participantsOverlay.classList.remove("hidden");
  requestAnimationFrame(() => participantsPanel.classList.add("open"));
  const body = $("participants-body");
  body.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-secondary,#888)">Chargement…</div>`;
  try {
    const data = await apiFetch(`/api/conversations/${state.currentConvId}/participants`);
    const rows = [];
    if (data.client) {
      rows.push(participantRow({ type: "client", id: data.client.id, name: data.client.name, phone: data.client.phone, roleLabel: "Client" }));
    }
    (data.guests || []).forEach(g => {
      rows.push(participantRow({ type: "guest", id: g.id, name: g.displayName, phone: g.phone, roleLabel: g.role === "manager" ? "Manager (invité)" : "Employé (invité)" }));
    });
    body.innerHTML = rows.join("") || `<div style="padding:20px;text-align:center;color:var(--text-secondary,#888)">Personne d'autre pour l'instant.</div>`;
    body.querySelectorAll("[data-call-audio]").forEach(btn => btn.addEventListener("click", () => {
      const t = { type: btn.dataset.type, id: btn.dataset.id, name: btn.dataset.name };
      closeParticipants(); startCallFlow(false, t);
    }));
    body.querySelectorAll("[data-call-video]").forEach(btn => btn.addEventListener("click", () => {
      const t = { type: btn.dataset.type, id: btn.dataset.id, name: btn.dataset.name };
      closeParticipants(); startCallFlow(true, t);
    }));
  } catch (e) {
    body.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-secondary,#888)">Erreur de chargement.</div>`;
  }
}
function participantRow(p) {
  const phone = p.phone ? escHtml(p.phone) : "Numéro non renseigné";
  const canCall = !!p.id;
  return `<div class="participant-row">
    <div class="participant-info">
      <div class="participant-name">${escHtml(p.name || "?")}</div>
      <div class="participant-meta">${escHtml(p.roleLabel)} · ${phone}</div>
    </div>
    ${canCall ? `
    <div class="participant-actions">
      <button type="button" class="icon-btn" data-call-audio data-type="${p.type}" data-id="${p.id}" data-name="${escHtml(p.name||"")}" title="Appeler">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.07 10.9 19.79 19.79 0 0 1 1 2.18 2 2 0 0 1 3 0h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.09 7.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 21 14.92z"/></svg>
      </button>
      <button type="button" class="icon-btn" data-call-video data-type="${p.type}" data-id="${p.id}" data-name="${escHtml(p.name||"")}" title="Appeler en visio">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
      </button>
    </div>` : ""}
  </div>`;
}
function closeParticipants() {
  participantsPanel.classList.remove("open");
  setTimeout(() => { participantsPanel.classList.add("hidden"); participantsOverlay.classList.add("hidden"); }, 300);
}

// ===== PARAMETRES =====
$("settings-btn").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", closeSettings);
$("settings-overlay").addEventListener("click", closeSettings);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSettings(); });

function openSettings() {
  settingsPanel.classList.remove("hidden");
  settingsOverlay.classList.remove("hidden");
  requestAnimationFrame(() => settingsPanel.classList.add("open"));
}
function closeSettings() {
  settingsPanel.classList.remove("open");
  setTimeout(() => { settingsPanel.classList.add("hidden"); settingsOverlay.classList.add("hidden"); }, 300);
}

// Présence
document.querySelectorAll(".presence-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".presence-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    state.presence = btn.dataset.presence;
    localStorage.setItem("presence", state.presence);
    updatePresenceUI(state.presence);
  });
});

function updatePresenceUI(presence) {
  const dot = $("status-dot");
  const label = $("employee-status-label");
  const labels = { online: "En ligne", away: "Absent", busy: "Occupé", invisible: "Invisible" };
  dot.className = "status-dot " + presence;
  label.textContent = labels[presence] || "En ligne";
  document.querySelectorAll(".presence-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.presence === presence);
  });
}

// Toggles notifications
$("notif-sound").checked = state.settings.notifSound;
$("notif-desktop").checked = state.settings.notifDesktop;
$("notif-preview").checked = state.settings.notifPreview;
$("confirm-close").checked = state.settings.confirmClose;
$("read-receipts").checked = state.settings.readReceipts;
$("show-time").checked = state.settings.showTime;

["notif-sound","notif-desktop","notif-preview","confirm-close","read-receipts","show-time"].forEach(id => {
  $(id).addEventListener("change", (e) => {
    const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    state.settings[key] = e.target.checked; saveSettings();
  });
});

// Taille police
const fontLabels = ["Petit","Moyen","Grand"];
$("font-size-label").textContent = fontLabels[state.settings.fontSize];
$("font-inc").addEventListener("click", () => {
  if (state.settings.fontSize < 2) { state.settings.fontSize++; $("font-size-label").textContent = fontLabels[state.settings.fontSize]; saveSettings(); }
});
$("font-dec").addEventListener("click", () => {
  if (state.settings.fontSize > 0) { state.settings.fontSize--; $("font-size-label").textContent = fontLabels[state.settings.fontSize]; saveSettings(); }
});

// Thème
$("theme-toggle").checked = state.settings.theme === "dark";
$("theme-toggle").addEventListener("change", (e) => {
  state.settings.theme = e.target.checked ? "dark" : "light";
  saveSettings(); applyTheme();
});

function applyTheme() {
  document.body.classList.toggle("light", state.settings.theme === "light");
}

// Réponses rapides settings (partagées entre employés, via serveur)
function renderQuickRepliesSettings() {
  const list = $("quick-replies-list");
  list.innerHTML = state.quickReplies.map((r) =>
    `<div class="qr-item"><span>${escHtml(r.text)}</span><button class="qr-delete" onclick="deleteQuickReply('${r.id}')">✕</button></div>`
  ).join("") || '<div style="font-size:13px;color:var(--text-faint)">Aucune réponse rapide.</div>';
}
window.deleteQuickReply = async function(id) {
  try {
    await apiFetch("/api/quick-replies/" + id, { method: "DELETE" });
    state.quickReplies = state.quickReplies.filter(r => r.id !== id);
    renderQuickRepliesSettings();
  } catch (err) { alert(err.message); }
};
$("qr-add-btn").addEventListener("click", async () => {
  const val = $("qr-input").value.trim();
  if (!val) return;
  try {
    const reply = await apiFetch("/api/quick-replies", { method: "POST", body: JSON.stringify({ text: val }) });
    if (!state.quickReplies.find(r => r.id === reply.id)) state.quickReplies.push(reply);
    renderQuickRepliesSettings();
    $("qr-input").value = "";
  } catch (err) { alert(err.message); }
});
$("qr-input").addEventListener("keydown", e => { if (e.key === "Enter") $("qr-add-btn").click(); });

// ===== Utilitaires =====
function escHtml(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function formatTime(iso) { return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); }
function formatDuration(s) { return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`; }
function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

// ===== Auto-démarrage =====
if (state.token && state.employee) startApp();
