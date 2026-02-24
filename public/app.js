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
      showBrand: true,
      showNotice: true,
      showContact: true,
      showTotalCount: true,
      showTotalAmount: true,
      showTodayCount: true,
      showTodayAmount: true,
      showPaymentQrcodes: true,
      showWechatQrcode: true,
      showAlipayQrcode: true,
      showRecordsTable: true,
      showFooterActions: true
    }
  }
};

state.pairing = {
  enabled: false,
  session: null,
  lastFetchedAt: 0
};

const PAIR_TEXT = {
  title: "手机扫码绑定",
  tip: "检测到当前大屏未绑定手机，请使用手机扫码完成绑定。",
  pending: "等待扫码确认",
  approved: "已确认，等待手机端领取",
  used: "已绑定完成",
  expired: "会话已过期，正在刷新二维码"
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
  $("pair-title").textContent = PAIR_TEXT.title;
  $("pair-tip").textContent = PAIR_TEXT.tip;
  renderAllButtonText();
}

function renderAllButtonText() {
  $("btn-all").innerHTML = `${I18N.btnAll} <span id="page-indicator">${state.page}/1</span>`;
}

async function boot() {
  updatePageSizeByViewport();
  setStaticTexts();
  bindActions();
  startClock();
  await Promise.all([loadSettings(), loadRecords(), loadConnectionStatus()]);
  await syncPublicPairingUi(true);
  connectStream();
  tryAutoFullscreen();
  setInterval(loadConnectionStatus, 15000);
  setInterval(() => { syncPublicPairingUi(false); }, 6000);
  window.addEventListener("resize", onViewportChange, { passive: true });
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

function updatePageSizeByViewport() {
  const h = Math.max(320, window.innerHeight || 0);
  if (h < 700) {
    state.pageSize = 6;
  } else if (h < 860) {
    state.pageSize = 8;
  } else {
    state.pageSize = 10;
  }
}

function onViewportChange() {
  updatePageSizeByViewport();
  renderTable();
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
      syncPublicPairingUi(false);
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
      state.records.push(record);
      state.records.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
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
      syncPublicPairingUi(false);
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

  const wechatSrc = String(s.wechatQrCodeUrl || "");
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

function isEnabled(feature, key) {
  return feature[key] !== false;
}

function setVisible(el, visible, displayValue) {
  if (!el) return false;
  el.style.display = visible ? (displayValue || "") : "none";
  return visible;
}

function countVisible(list) {
  return list.filter((el) => !!(el && el.style.display !== "none")).length;
}

function applyFeature(feature) {
  const f = feature || {};
  const showBrand = isEnabled(f, "showBrand");
  const showNotice = isEnabled(f, "showNotice");
  const showContact = isEnabled(f, "showContact");
  const showTotalCount = isEnabled(f, "showTotalCount");
  const showTotalAmount = isEnabled(f, "showTotalAmount");
  const showTodayCount = isEnabled(f, "showTodayCount");
  const showTodayAmount = isEnabled(f, "showTodayAmount");
  const showPaymentQrcodes = isEnabled(f, "showPaymentQrcodes");
  const showWechatQrcode = isEnabled(f, "showWechatQrcode");
  const showAlipayQrcode = isEnabled(f, "showAlipayQrcode");
  const showRecordsTable = isEnabled(f, "showRecordsTable");
  const showFooterActions = isEnabled(f, "showFooterActions");

  const topbar = $("module-topbar");
  const brandCard = $("module-brand");
  const noticeCard = $("module-notice");
  const contactCard = $("module-contact");
  setVisible(brandCard, showBrand);
  setVisible(noticeCard, showNotice);
  setVisible(contactCard, showContact);
  if (topbar) {
    const topCount = countVisible([brandCard, noticeCard, contactCard]);
    if (topCount > 0) {
      topbar.style.display = "grid";
      topbar.style.gridTemplateColumns = `repeat(${topCount}, minmax(0, 1fr))`;
    } else {
      topbar.style.display = "none";
      topbar.style.gridTemplateColumns = "";
    }
  }

  const statsWrap = $("stats-wrap");
  const totalCountCard = $("stat-card-total-count");
  const totalAmountCard = $("stat-card-total-amount");
  const todayCountCard = $("stat-card-today-count");
  const todayAmountCard = $("stat-card-today-amount");
  setVisible(totalCountCard, showTotalCount);
  setVisible(totalAmountCard, showTotalAmount);
  setVisible(todayCountCard, showTodayCount);
  setVisible(todayAmountCard, showTodayAmount);
  if (statsWrap) {
    const statCount = countVisible([totalCountCard, totalAmountCard, todayCountCard, todayAmountCard]);
    if (statCount > 0) {
      statsWrap.style.display = "grid";
      statsWrap.style.gridTemplateColumns = `repeat(${statCount}, minmax(0, 1fr))`;
    } else {
      statsWrap.style.display = "none";
      statsWrap.style.gridTemplateColumns = "";
    }
  }

  const board = $("module-board");
  setVisible(board, showRecordsTable);
  const left = $("module-left");
  if (left) {
    const hasStats = !!(statsWrap && statsWrap.style.display !== "none");
    const hasBoard = !!(board && board.style.display !== "none");
    if (hasStats || hasBoard) {
      left.style.display = "grid";
      if (hasStats && hasBoard) left.style.gridTemplateRows = "auto 1fr";
      else if (hasStats) left.style.gridTemplateRows = "auto";
      else left.style.gridTemplateRows = "1fr";
    } else {
      left.style.display = "none";
      left.style.gridTemplateRows = "";
    }
  }

  const qrGrid = $("qr-grid");
  const qrHidden = $("qr-hidden-text");
  const qrPanel = $("qr-panel");
  const qrWechat = $("qr-item-wechat");
  const qrAlipay = $("qr-item-alipay");
  const screen = document.querySelector(".screen");
  setVisible(qrWechat, showWechatQrcode, "grid");
  setVisible(qrAlipay, showAlipayQrcode, "grid");
  const showAnyQrCard = showWechatQrcode || showAlipayQrcode;
  const showQrPanel = showPaymentQrcodes && showAnyQrCard;
  if (qrGrid) qrGrid.style.display = showQrPanel ? "grid" : "none";
  if (qrHidden) qrHidden.style.display = showPaymentQrcodes && !showAnyQrCard ? "grid" : "none";
  if (qrPanel) qrPanel.style.display = showQrPanel ? "grid" : "none";
  if (screen) screen.classList.toggle("no-qr", !showQrPanel);

  const footer = $("module-footer-actions");
  setVisible(footer, showFooterActions, "grid");

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
    meta.textContent = `${I18N.connSeen} ${seen}${who}`;
  } else {
    meta.textContent = I18N.connNoDevice;
  }
}

function shouldShowPublicPairing() {
  const c = state.connection || {};
  return Number(c.deviceCount || 0) <= 0;
}

function pairingStatusLabel(session) {
  const status = String((session && session.status) || "").toLowerCase();
  if (status === "pending") return PAIR_TEXT.pending;
  if (status === "approved") return PAIR_TEXT.approved;
  if (status === "used") return PAIR_TEXT.used;
  return PAIR_TEXT.expired;
}

function hidePublicPairingUi() {
  state.pairing.enabled = false;
  state.pairing.session = null;
  const wrap = $("pair-overlay");
  if (wrap) wrap.style.display = "none";
}

function renderPublicPairingUi(session) {
  const wrap = $("pair-overlay");
  const img = $("pair-qr-image");
  const link = $("pair-bind-url");
  const statusText = $("pair-state");
  if (!wrap || !img || !link || !statusText || !session || !session.qrDataUrl) {
    hidePublicPairingUi();
    return;
  }

  state.pairing.enabled = true;
  state.pairing.session = session;
  img.src = session.qrDataUrl;
  link.textContent = String(session.bindUrl || "");
  statusText.textContent = pairingStatusLabel(session);
  wrap.style.display = "grid";
}

async function loadPublicPairingSession() {
  try {
    const r = await fetch("/api/pairing/public-session");
    const j = await r.json();
    state.pairing.lastFetchedAt = Date.now();
    if (!j || !j.ok || !j.eligible || !j.session) {
      hidePublicPairingUi();
      return;
    }
    renderPublicPairingUi(j.session);
  } catch (_) {
    hidePublicPairingUi();
  }
}

async function syncPublicPairingUi(force) {
  if (!shouldShowPublicPairing()) {
    hidePublicPairingUi();
    return;
  }
  const now = Date.now();
  if (!force && now - Number(state.pairing.lastFetchedAt || 0) < 5000) return;
  await loadPublicPairingSession();
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
