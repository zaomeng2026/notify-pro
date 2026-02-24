const I18N = {
  shopDefault: "我的店铺",
  notice: "公告",
  contact: "联系方式",
  totalCount: "总笔数",
  totalAmount: "总金额(元)",
  todayCount: "今日笔数",
  todayAmount: "今日金额(元)",
  thNo: "序号",
  thChannel: "收款类型",
  thAmount: "收款金额(元)",
  thTime: "收款时间",
  emptyRecords: "暂无收款记录",
  qrWechatTitle: "微信收款码",
  qrAlipayTitle: "支付宝收款码",
  qrWechatEmpty: "未设置微信收款码",
  qrAlipayEmpty: "未设置支付宝收款码",
  qrHidden: "支付码展示已关闭",
  btnFs: "全屏",
  btnPrev: "上一页",
  btnNext: "下一页",
  btnToday: "今日数据",
  btnAll: "历史数据",
  enterFullscreen: "点击进入全屏",
  connOnline: "在线",
  connOffline: "离线",
  connNoDevice: "暂无设备",
  connSeen: "最近",
  wechat: "微信",
  alipay: "支付宝",
  other: "其他"
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
    contact: "",
    wechatQrCodeUrl: "",
    alipayQrCodeUrl: "",
    feature: {
      voiceBroadcastEnabled: false,
      showTotalAmount: true,
      showTodayAmount: true,
      showPaymentQrcodes: true
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
  document.title = "收款数据同步大屏";
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
  $("qr-wechat-title").textContent = I18N.qrWechatTitle;
  $("qr-alipay-title").textContent = I18N.qrAlipayTitle;
  $("qr-wechat-empty").textContent = I18N.qrWechatEmpty;
  $("qr-alipay-empty").textContent = I18N.qrAlipayEmpty;
  $("qr-hidden-text").textContent = I18N.qrHidden;
  $("btn-prev").textContent = I18N.btnPrev;
  $("btn-next").textContent = I18N.btnNext;
  $("btn-today").textContent = I18N.btnToday;
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

  const wechatSrc = String(s.wechatQrCodeUrl || s.qrCodeUrl || "");
  const alipaySrc = String(s.alipayQrCodeUrl || "");
  renderQr("qr-wechat-image", "qr-wechat-empty", wechatSrc);
  renderQr("qr-alipay-image", "qr-alipay-empty", alipaySrc);
}

function renderQr(imageId, emptyId, src) {
  const img = $(imageId);
  const empty = $(emptyId);
  if (src) {
    img.src = src;
    img.style.display = "block";
    empty.style.display = "none";
  } else {
    img.removeAttribute("src");
    img.style.display = "none";
    empty.style.display = "block";
  }
}

function applyFeature(feature) {
  const f = feature || {};
  const showTotalAmount = f.showTotalAmount !== false;
  const showTodayAmount = f.showTodayAmount !== false;
  const showPaymentQrcodes = f.showPaymentQrcodes !== false;

  const totalCard = $("stat-card-total-amount");
  const todayCard = $("stat-card-today-amount");
  if (totalCard) totalCard.style.display = showTotalAmount ? "" : "none";
  if (todayCard) todayCard.style.display = showTodayAmount ? "" : "none";

  const qrGrid = $("qr-grid");
  const qrHidden = $("qr-hidden-text");
  if (qrGrid) qrGrid.style.display = showPaymentQrcodes ? "grid" : "none";
  if (qrHidden) qrHidden.style.display = showPaymentQrcodes ? "none" : "grid";

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
  if (sec < 60) return `${sec}秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  return `${hr}小时前`;
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
}

boot().catch((err) => {
  console.error(err);
});
