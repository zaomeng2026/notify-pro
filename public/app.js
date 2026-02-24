const I18N = {
  shopDefault: "\u6211\u7684\u5e97\u94fa",
  notice: "\u516c\u544a",
  contact: "\u8054\u7cfb\u65b9\u5f0f",
  totalCount: "\u603b\u7b14\u6570",
  totalAmount: "\u603b\u91d1\u989d(\u5143)",
  todayCount: "\u4eca\u65e5\u7b14\u6570",
  todayAmount: "\u4eca\u65e5\u91d1\u989d(\u5143)",
  thNo: "\u5e8f\u53f7",
  thChannel: "\u6536\u6b3e\u7c7b\u578b",
  thAmount: "\u6536\u6b3e\u91d1\u989d(\u5143)",
  thTime: "\u6536\u6b3e\u65f6\u95f4",
  emptyRecords: "\u6682\u65e0\u6536\u6b3e\u8bb0\u5f55",
  qrEmpty: "\u672a\u8bbe\u7f6e\u4e2a\u4eba\u4e8c\u7ef4\u7801",
  btnFs: "\u5168\u5c4f",
  btnPrev: "\u4e0a\u4e00\u9875",
  btnNext: "\u4e0b\u4e00\u9875",
  btnToday: "\u4eca\u65e5\u6570\u636e",
  btnAll: "\u5386\u53f2\u6570\u636e",
  enterFullscreen: "\u70b9\u51fb\u8fdb\u5165\u5168\u5c4f",
  connOnline: "\u5728\u7ebf",
  connOffline: "\u79bb\u7ebf",
  connNoDevice: "\u6682\u65e0\u8bbe\u5907",
  connSeen: "\u6700\u8fd1",
  wechat: "\u5fae\u4fe1",
  alipay: "\u652f\u4ed8\u5b9d",
  other: "\u5176\u4ed6"
};

const state = {
  page: 1,
  pageSize: 10,
  records: [],
  snapshot: {
    totalCount: 0,
    totalAmount: 0,
    todayCount: 0,
    todayAmount: 0,
    channels: { wechat: 0, alipay: 0, other: 0 }
  },
  connection: {
    online: false,
    lastSeenAt: 0,
    lastDeviceName: "",
    lastIp: ""
  },
  settings: {
    shopName: I18N.shopDefault,
    notice: "",
    qrCodeUrl: "",
    contact: "",
    feature: {
      voiceBroadcastEnabled: false,
      showTotalAmount: true,
      showTodayAmount: true
    }
  }
};

const speechState = {
  speaking: false,
  queue: []
};

function $(id) {
  return document.getElementById(id);
}

function setStaticTexts() {
  document.title = "\u6536\u6b3e\u6570\u636e\u540c\u6b65\u5927\u5c4f";
  $("lbl-notice").textContent = I18N.notice;
  $("lbl-contact").textContent = I18N.contact;
  $("lbl-total-count").textContent = I18N.totalCount;
  $("lbl-total-amount").textContent = I18N.totalAmount;
  $("lbl-today-count").textContent = I18N.todayCount;
  $("lbl-today-amount").textContent = I18N.todayAmount;
  $("th-no").textContent = I18N.thNo;
  $("th-channel").textContent = I18N.thChannel;
  $("th-amount").textContent = I18N.thAmount;
  $("th-time").textContent = I18N.thTime;
  $("qr-empty").textContent = I18N.qrEmpty;
  $("btn-fs").textContent = I18N.btnFs;
  $("btn-prev").textContent = I18N.btnPrev;
  $("btn-next").textContent = I18N.btnNext;
  $("btn-today").textContent = I18N.btnToday;
  $("fs-overlay-btn").textContent = I18N.enterFullscreen;
  renderAllButtonText();
}

function renderAllButtonText() {
  $("btn-all").innerHTML = `${I18N.btnAll} <span id="page-indicator">${state.page}/1</span>`;
}

async function boot() {
  setStaticTexts();
  bindActions();
  startClock();
  await Promise.all([loadSettings(), loadRecords(), loadConnectionStatus()]);
  connectStream();
  tryAutoFullscreen();
  setInterval(loadConnectionStatus, 15000);
}

function bindActions() {
  $("btn-prev").addEventListener("click", () => {
    state.page = Math.max(1, state.page - 1);
    renderTable();
  });

  $("btn-next").addEventListener("click", () => {
    const maxPage = Math.max(1, Math.ceil(state.records.length / state.pageSize));
    state.page = Math.min(maxPage, state.page + 1);
    renderTable();
  });

  $("btn-today").addEventListener("click", () => {
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth() + 1;
    const d = today.getDate();
    const filtered = state.records.filter((r) => {
      const t = new Date(r.createdAt || Date.now());
      return t.getFullYear() === y && t.getMonth() + 1 === m && t.getDate() === d;
    });
    renderTable(filtered);
  });

  $("btn-all").addEventListener("click", () => {
    renderTable(state.records);
  });

  $("btn-fs").addEventListener("click", async () => {
    await requestFullscreen();
  });

  $("fs-overlay-btn").addEventListener("click", async () => {
    await requestFullscreen();
    $("fs-overlay").style.display = "none";
  });
}

async function loadSettings() {
  const r = await fetch("/api/settings");
  const j = await r.json();
  if (j && j.ok && j.settings) {
    state.settings = j.settings;
  }
  renderSettings();
}

async function loadRecords() {
  const r = await fetch("/api/records?limit=500");
  const j = await r.json();
  if (j && j.ok) {
    state.records = Array.isArray(j.records) ? j.records : [];
    if (j.snapshot) state.snapshot = j.snapshot;
  }
  renderSnapshot();
  renderTable();
}

async function loadConnectionStatus() {
  try {
    const r = await fetch("/api/connection/status");
    const j = await r.json();
    if (j && j.ok && j.status) {
      state.connection = j.status;
      renderConnection();
    }
  } catch (_) {}
}

function connectStream() {
  const es = new EventSource("/api/stream");

  es.addEventListener("settings", (e) => {
    try {
      state.settings = JSON.parse(e.data);
      renderSettings();
    } catch (_) {}
  });

  es.addEventListener("payment", (e) => {
    try {
      const record = JSON.parse(e.data);
      state.records.unshift(record);
      if (state.records.length > 500) state.records.length = 500;
      announcePayment(record);
      renderTable();
    } catch (_) {}
  });

  es.addEventListener("snapshot", (e) => {
    try {
      state.snapshot = JSON.parse(e.data);
      renderSnapshot();
    } catch (_) {}
  });

  es.addEventListener("connection", (e) => {
    try {
      state.connection = JSON.parse(e.data);
      renderConnection();
    } catch (_) {}
  });

  es.onerror = () => {
    es.close();
    setTimeout(connectStream, 3000);
  };
}

function renderSettings() {
  const s = state.settings || {};
  $("shop-name").textContent = s.shopName || I18N.shopDefault;
  $("notice-text").textContent = s.notice || "";
  $("contact-text").textContent = s.contact || "";
  applyFeature(s.feature || {});

  const color = s.theme && s.theme.accent ? s.theme.accent : "#39b9ff";
  document.documentElement.style.setProperty("--accent", color);

  const qr = $("qr-image");
  const empty = $("qr-empty");
  if (s.qrCodeUrl) {
    qr.src = s.qrCodeUrl;
    qr.style.display = "block";
    empty.style.display = "none";
  } else {
    qr.removeAttribute("src");
    qr.style.display = "none";
    empty.style.display = "block";
  }
}

function applyFeature(feature) {
  const f = feature || {};
  const showTotalAmount = f.showTotalAmount !== false;
  const showTodayAmount = f.showTodayAmount !== false;

  const totalCard = $("stat-card-total-amount");
  const todayCard = $("stat-card-today-amount");
  if (totalCard) totalCard.style.display = showTotalAmount ? "" : "none";
  if (todayCard) todayCard.style.display = showTodayAmount ? "" : "none";

  if (!f.voiceBroadcastEnabled) {
    clearSpeechQueue();
  }
}

function announcePayment(record) {
  const feature = (state.settings && state.settings.feature) || {};
  if (!feature.voiceBroadcastEnabled) return;
  if (!record) return;

  const amount = formatVoiceAmount(record.amount);
  const channel = channelName(record.channel);
  const text = `${channel}收款${amount}元`;
  enqueueSpeech(text);
}

function formatVoiceAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  return s;
}

function enqueueSpeech(text) {
  if (!text) return;
  if (!("speechSynthesis" in window) || typeof window.SpeechSynthesisUtterance !== "function") return;
  speechState.queue.push(String(text));
  processSpeechQueue();
}

function processSpeechQueue() {
  if (speechState.speaking) return;
  if (!speechState.queue.length) return;

  const text = speechState.queue.shift();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "zh-CN";
  u.rate = 1.0;
  u.pitch = 1.0;
  u.volume = 1.0;

  speechState.speaking = true;
  u.onend = u.onerror = () => {
    speechState.speaking = false;
    processSpeechQueue();
  };

  try {
    window.speechSynthesis.speak(u);
  } catch (_) {
    speechState.speaking = false;
  }
}

function clearSpeechQueue() {
  speechState.queue = [];
  speechState.speaking = false;
  try {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  } catch (_) {}
}

function renderSnapshot() {
  const s = state.snapshot;
  $("stat-total-count").textContent = s.totalCount || 0;
  $("stat-total-amount").textContent = formatMoney(s.totalAmount || 0);
  $("stat-today-count").textContent = s.todayCount || 0;
  $("stat-today-amount").textContent = formatMoney(s.todayAmount || 0);
}

function renderConnection() {
  const c = state.connection || {};
  const dot = $("conn-dot");
  const text = $("conn-text");
  const meta = $("conn-meta");
  const online = !!c.online;

  dot.className = "conn-dot " + (online ? "online" : "offline");
  text.textContent = online ? I18N.connOnline : I18N.connOffline;

  if (c.lastSeenAt) {
    const seen = formatRelative(c.lastSeenAt);
    const who = c.lastDeviceName ? ` ${c.lastDeviceName}` : "";
    const ip = c.lastIp ? ` ${c.lastIp}` : "";
    meta.textContent = `${I18N.connSeen} ${seen}${who}${ip}`;
  } else {
    meta.textContent = I18N.connNoDevice;
  }
}

function renderTable(list) {
  const source = Array.isArray(list) ? list : state.records;
  const maxPage = Math.max(1, Math.ceil(source.length / state.pageSize));
  if (state.page > maxPage) state.page = maxPage;

  const start = (state.page - 1) * state.pageSize;
  const rows = source.slice(start, start + state.pageSize);

  const html = rows
    .map((r, idx) => {
      const no = source.length - start - idx;
      const amount = r.amount == null ? "--" : formatMoney(r.amount);
      return `
        <tr>
          <td>${no}</td>
          <td>${channelName(r.channel)}</td>
          <td class="amount">${amount}</td>
          <td class="time">${escapeHtml(r.time || "")}</td>
        </tr>
      `;
    })
    .join("");

  $("tbody").innerHTML = html || `<tr><td colspan="4">${I18N.emptyRecords}</td></tr>`;
  const indicator = $("page-indicator");
  if (indicator) indicator.textContent = `${state.page}/${maxPage}`;
}

function channelName(c) {
  if (c === "wechat") return I18N.wechat;
  if (c === "alipay") return I18N.alipay;
  return I18N.other;
}

function formatMoney(n) {
  const v = Number(n || 0);
  return Number.isFinite(v) ? v.toFixed(2).replace(/\.00$/, "") : "--";
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function startClock() {
  const draw = () => {
    const d = new Date();
    const p = (n) => (n < 10 ? `0${n}` : `${n}`);
    $("clock").textContent =
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  draw();
  setInterval(draw, 1000);
}

function formatRelative(ts) {
  const sec = Math.max(0, Math.floor((Date.now() - Number(ts || 0)) / 1000));
  if (sec < 60) return `${sec}\u79d2\u524d`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}\u5206\u949f\u524d`;
  const hr = Math.floor(min / 60);
  return `${hr}\u5c0f\u65f6\u524d`;
}

async function requestFullscreen() {
  const el = document.documentElement;
  try {
    if (!document.fullscreenElement) {
      await el.requestFullscreen();
    }
  } catch (_) {}
}

function tryAutoFullscreen() {
  requestFullscreen().catch(() => {});
  if (!document.fullscreenElement) {
    $("fs-overlay").style.display = "grid";
  }
}

boot().catch((err) => {
  console.error(err);
});
