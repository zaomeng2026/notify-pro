"auto";

// Notify Pro mobile script (auto pairing edition)
// Flow: detect base url -> auto claim after QR approval -> send payment notifications

var STORE = storages.create("notify_pro");
var SCRIPT_VER = "2026-02-24-v3";
var PKG_WECHAT = "com.tencent.mm";
var PKG_ALIPAY = "com.eg.android.AlipayGphone";

var HINTS = [
  "收款", "到账", "成功收款", "微信支付", "支付宝", "个人收款码"
];

var DEDUPE_MS = 5000;
var DEDUPE_TTL_MS = 45000;
var MAX_DEDUPE_KEYS = 1200;
var RETRY_MS = 8000;
var HEALTH_MS = 60000;
var CLAIM_RETRY_MS = 6000;
var INIT_RETRY_MS = 10000;
var DEVICE_ID = getDeviceId();
var DEVICE_NAME = "phone-" + android.os.Build.MODEL;
// Strongly recommended: set fixed server base URL for production to avoid LAN scan instability.
// Example: "http://192.168.45.103:3180"
var FIXED_BASE_URL = "";
var ENABLE_TOAST = true;

var dedupe = {};
var cfg = STORE.get("cfg", null);
var observerReady = false;
var lastPermToastAt = 0;
var lastInitLogAt = 0;
var lastDedupeCleanupAt = 0;
var didFirstPing = false;

log("notify-pro auto edition started");
log("ver=" + SCRIPT_VER);
log("deviceId=" + DEVICE_ID);
ensureSingleInstance();
if (cfg && cfg.apiUrl) {
  if (isConfigAlive(cfg)) {
    log("apiUrl=" + cfg.apiUrl);
  } else {
    STORE.remove("cfg");
    cfg = null;
  }
} else {
  log("apiUrl=not-ready");
}

observerReady = ensureNotificationObserver();
tryPrepareConfig();

events.onNotification(function (n) {
  try {
    var pkg = String(n.getPackageName() || "");
    if (pkg !== PKG_WECHAT && pkg.toLowerCase() !== PKG_ALIPAY.toLowerCase()) return;

    var title = String(n.getTitle() || "").trim();
    var text = String(n.getText() || "").trim();
    var merged = (title + " " + text).trim();
    if (!merged) return;
    if (!containsAny(merged, HINTS)) return;

    var meta = getNotifyMeta(n);
    var key = buildDedupeKey(pkg, title, text, meta);
    var now = Date.now();
    if (dedupe[key] && now - dedupe[key] <= DEDUPE_MS) return;
    dedupe[key] = now;
    cleanupDedupe(now);

    var payload = {
      title: title,
      content: text,
      "package": pkg,
      amount: parseAmount(merged),
      channel: pkg === PKG_WECHAT ? "wechat" : "alipay",
      time: formatTime(now),
      device: DEVICE_ID,
      deviceName: DEVICE_NAME,
      platform: "android",
      clientMsgId: createClientMsgId(meta, now)
    };

    sendOrQueue(payload);
  } catch (e) {
    log("[ERR] " + e);
  }
});

setInterval(function () { flushQueue(); }, RETRY_MS);
setInterval(function () { healthPing(); }, HEALTH_MS);
setInterval(function () { ensureRuntimeReady(); }, INIT_RETRY_MS);
setInterval(function () {}, 1000);
ensureRuntimeReady();

function ensureSingleInstance() {
  try {
    var me = engines.myEngine();
    var myId = engineIdOf(me);
    var mySource = engineSourceOf(me);
    if (!mySource) return;

    var all = engines.all();
    var stopped = 0;
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (!e) continue;
      if (engineIdOf(e) === myId) continue;
      if (engineSourceOf(e) !== mySource) continue;
      try {
        e.forceStop();
        stopped++;
      } catch (_) {}
    }
    if (stopped > 0) log("stopped duplicate engines=" + stopped);
  } catch (e) {
    log("[WARN] single-instance check failed: " + e);
  }
}

function engineIdOf(e) {
  try {
    if (e && typeof e.getId === "function") return String(e.getId());
  } catch (_) {}
  try {
    if (e && e.id != null) return String(e.id);
  } catch (_) {}
  return "";
}

function engineSourceOf(e) {
  try {
    if (e && typeof e.getSource === "function") return String(e.getSource());
  } catch (_) {}
  try {
    if (e && e.source != null) return String(e.source);
  } catch (_) {}
  return "";
}

function ensureNotificationObserver() {
  try {
    events.observeNotification();
    return true;
  } catch (e) {
    log("[ERR] observeNotification failed: " + e);
    var now = Date.now();
    if (now - lastPermToastAt > 15000) {
      toast("请开启通知读取权限，脚本会自动重试");
      lastPermToastAt = now;
    }
    // Do not auto-open any settings page to avoid ROM security/manager hijack popups.
    return false;
  }
}

function ensureRuntimeReady() {
  if (!observerReady) observerReady = ensureNotificationObserver();
  if (!cfg || !cfg.apiUrl) tryPrepareConfig();
  if (!didFirstPing && cfg && cfg.apiUrl) {
    pingDevice();
    didFirstPing = true;
  }
}

function tryPrepareConfig() {
  try {
    var c = STORE.get("cfg", null);
    if (c && c.apiUrl && isConfigAlive(c)) {
      cfg = c;
      return true;
    }
    if (c && c.apiUrl) STORE.remove("cfg");

    var base = String(STORE.get("baseUrl", "") || "");
    if (base && !isBaseAlive(base)) {
      STORE.remove("baseUrl");
      base = "";
    }
    if (!base) {
      base = detectBaseUrl();
      if (base) STORE.put("baseUrl", base);
    }
    if (!base) {
      logInit("wait base url...");
      return false;
    }

    var claimed = tryAutoClaim(base);
    if (!claimed || !claimed.apiUrl) {
      // Cached base may be stale after router/IP change, try one re-detect pass.
      var detected = detectBaseUrl();
      if (detected && detected !== base) {
        STORE.put("baseUrl", detected);
        base = detected;
        claimed = tryAutoClaim(base);
      }
    }
    if (!claimed || !claimed.apiUrl) {
      logInit("wait scan approval...");
      return false;
    }

    claimed.baseUrl = base;
    STORE.put("cfg", claimed);
    cfg = claimed;
    log("apiUrl=" + cfg.apiUrl);
    if (ENABLE_TOAST) toast("Auto pairing success");
    return true;
  } catch (e) {
    logInit("init-error: " + e);
    return false;
  }
}

function logInit(msg) {
  var now = Date.now();
  if (now - lastInitLogAt < 10000) return;
  lastInitLogAt = now;
  log("[INIT] " + msg);
}

function loadOrAutoClaimConfig() {
  var c = STORE.get("cfg", null);
  if (c && c.apiUrl) {
    if (isConfigAlive(c)) {
      log("cached cfg ok => " + c.apiUrl);
      return c;
    }
    log("cached cfg invalid, re-claiming...");
    STORE.remove("cfg");
  }

  var base = STORE.get("baseUrl", "");
  if (!base) {
    base = detectBaseUrl();
    if (base) STORE.put("baseUrl", base);
  }
  if (!base) throw new Error("base url not found, make sure desktop and phone are in same LAN");
  log("detected baseUrl=" + base);

  c = waitAutoClaim(base);
  c.baseUrl = base;
  STORE.put("cfg", c);
  toast("Auto pairing success");
  return c;
}

function waitAutoClaim(base, maxTry) {
  if (!maxTry) maxTry = 60; // about 6 minutes
  for (var i = 0; i < maxTry; i++) {
    var c = tryAutoClaim(base);
    if (c && c.apiUrl) return c;
    sleep(CLAIM_RETRY_MS);
  }
  throw new Error("auto claim timeout, please scan admin QR and retry");
}

function isConfigAlive(c) {
  try {
    var health = c.healthUrl;
    if (!health) {
      var m = String(c.apiUrl || "").match(/^(https?:\/\/[^\/]+)/i);
      if (!m) return false;
      health = m[1] + "/api/health";
    }
    var r = http.get(health, { timeout: 2500 });
    return !!(r && r.statusCode === 200);
  } catch (_) {
    return false;
  }
}

function tryAutoClaim(base) {
  try {
    var r = http.postJson(base + "/api/pairing/auto-claim", {
      deviceName: DEVICE_NAME,
      deviceId: DEVICE_ID,
      platform: "android"
    }, { timeout: 5000 });

    if (!r || r.statusCode !== 200) return null;
    var body = JSON.parse(r.body.string());
    if (!body.ok || !body.config || !body.config.apiUrl) return null;

    return {
      apiUrl: body.config.apiUrl,
      healthUrl: body.config.healthUrl || (base + "/api/health"),
      authToken: body.config.authToken || ""
    };
  } catch (_) {
    return null;
  }
}

function detectBaseUrl() {
  if (FIXED_BASE_URL) {
    var fixed = String(FIXED_BASE_URL).replace(/\/+$/, "");
    if (/^https?:\/\/[^\/]+(:\d+)?$/i.test(fixed) && isBaseAlive(fixed)) {
      return fixed;
    }
  }
  try {
    var candidateBases = [];
    var seenBase = {};
    function addBase(base) {
      if (!base) return;
      base = String(base).replace(/\/+$/, "");
      if (!/^https?:\/\/[^\/]+(:\d+)?$/i.test(base)) return;
      if (seenBase[base]) return;
      seenBase[base] = 1;
      candidateBases.push(base);
    }

    var cached = String(STORE.get("baseUrl", "") || "").replace(/\/+$/, "");
    if (cached) addBase(cached);

    var ips = getLocalIps();
    for (var i = 0; i < ips.length; i++) {
      var seg = ips[i].split(".");
      if (seg.length !== 4) continue;
      var prefix = seg[0] + "." + seg[1] + "." + seg[2] + ".";
      var hosts = [];
      function addHost(n) {
        if (n < 1 || n > 254) return;
        for (var j = 0; j < hosts.length; j++) {
          if (hosts[j] === n) return;
        }
        hosts.push(n);
      }

      var localLast = Number(seg[3] || 0);
      if (localLast > 0) {
        addHost(localLast);
        for (var d = 1; d <= 20; d++) {
          addHost(localLast + d);
          addHost(localLast - d);
        }
      }

      var common = [1,2,3,4,5,6,7,8,9,10,20,30,40,50,60,70,80,90,100,101,102,103,104,105,106,107,108,109,110,120,130,140,150,160,170,180,190,200,210,220,230,240,250];
      for (var c = 0; c < common.length; c++) addHost(common[c]);

      for (var h = 0; h < hosts.length; h++) {
        addBase("http://" + prefix + hosts[h] + ":3180");
      }
    }

    for (var k = 0; k < candidateBases.length; k++) {
      if (isBaseAlive(candidateBases[k])) return candidateBases[k];
    }
  } catch (_) {}
  return null;
}

function isBaseAlive(base) {
  try {
    var b = String(base || "").replace(/\/+$/, "");
    if (!b) return false;
    var h = http.get(b + "/api/health", { timeout: 700 });
    return !!(h && h.statusCode === 200);
  } catch (_) {
    return false;
  }
}

function sendOrQueue(payload) {
  ensurePayloadId(payload);
  if (!cfg || !cfg.apiUrl) {
    enqueue(payload);
    log("queued(no-cfg) => " + payload.channel + " " + (payload.amount == null ? "--" : payload.amount));
    return;
  }
  var ok = postNotify(payload);
  if (ok) {
    log("ok => " + payload.channel + " " + (payload.amount == null ? "--" : payload.amount));
  } else {
    enqueue(payload);
    log("queued => " + payload.channel + " " + (payload.amount == null ? "--" : payload.amount));
  }
}

function postNotify(payload) {
  try {
    if (!cfg || !cfg.apiUrl) return false;
    var headers = { "Content-Type": "application/json" };
    if (cfg.authToken) headers["X-Auth-Token"] = cfg.authToken;
    var r = http.postJson(cfg.apiUrl, payload, { headers: headers, timeout: 5000 });
    if (!r || r.statusCode !== 200) return false;
    var body = JSON.parse(r.body.string());
    return body && (body.ok === true || body.queued === true || body.duplicate === true);
  } catch (_) {
    return false;
  }
}

function enqueue(payload) {
  ensurePayloadId(payload);
  var q = STORE.get("queue", []);
  q.push({ payload: payload, ts: Date.now(), retry: 0 });
  if (q.length > 500) q = q.slice(q.length - 500);
  STORE.put("queue", q);
}

function flushQueue() {
  if (!cfg || !cfg.apiUrl) return;
  var q = STORE.get("queue", []);
  if (!q || !q.length) return;

  var remain = [];
  var sent = 0;
  for (var i = 0; i < q.length; i++) {
    var item = q[i];
    if (!item || !item.payload) continue;
    ensurePayloadId(item.payload);
    if (postNotify(item.payload)) {
      sent++;
    } else {
      item.retry = (item.retry || 0) + 1;
      remain.push(item);
    }
  }

  STORE.put("queue", remain);
  if (sent > 0) log("retry-sent=" + sent + " remain=" + remain.length);
}

function healthPing() {
  if (!cfg || !cfg.apiUrl) return;
  pingDevice();
  if (!cfg.healthUrl) return;
  try {
    var r = http.get(cfg.healthUrl, { timeout: 4000 });
    if (r && r.statusCode === 200) {
      var h = JSON.parse(r.body.string());
      if (!h.ok) log("health-warn => " + JSON.stringify(h.warnings || []));
    }
  } catch (_) {}
}

function pingDevice() {
  try {
    if (!cfg || !cfg.apiUrl) return;
    var m = String(cfg.apiUrl || "").match(/^(https?:\/\/[^\/]+)/i);
    if (!m) return;
    var url = m[1] + "/api/device/ping";
    var headers = { "Content-Type": "application/json" };
    if (cfg.authToken) headers["X-Auth-Token"] = cfg.authToken;
    http.postJson(url, {
      deviceId: DEVICE_ID,
      deviceName: DEVICE_NAME,
      platform: "android"
    }, { headers: headers, timeout: 3500 });
  } catch (_) {}
}

function containsAny(s, arr) {
  for (var i = 0; i < arr.length; i++) if (s.indexOf(arr[i]) >= 0) return true;
  return false;
}

function ensurePayloadId(payload) {
  if (!payload) return;
  if (payload.clientMsgId) return;
  payload.clientMsgId = createClientMsgId(null, Date.now());
}

function getNotifyMeta(n) {
  var m = { id: "", key: "", postTime: 0 };
  try {
    if (n && typeof n.getId === "function") m.id = String(n.getId());
  } catch (_) {}
  try {
    if (n && typeof n.getKey === "function") m.key = String(n.getKey() || "");
  } catch (_) {}
  try {
    if (n && typeof n.getPostTime === "function") m.postTime = Number(n.getPostTime() || 0);
  } catch (_) {}
  try {
    if (!m.postTime && n && typeof n.getWhen === "function") m.postTime = Number(n.getWhen() || 0);
  } catch (_) {}
  return m;
}

function buildDedupeKey(pkg, title, text, meta) {
  var parts = [pkg, title, text];
  if (meta) {
    if (meta.key) {
      parts.push("k=" + meta.key);
    } else {
      if (meta.id) parts.push("id=" + meta.id);
      if (meta.postTime) parts.push("ts=" + meta.postTime);
    }
  }
  return parts.join("|");
}

function createClientMsgId(meta, now) {
  var seed = String(now || Date.now()) + "-" + Math.random().toString(36).slice(2, 9);
  var suffix = "";
  if (meta && meta.key) suffix = String(meta.key).slice(-16);
  if (!suffix && meta) suffix = String(meta.id || "") + "-" + String(meta.postTime || 0);
  suffix = String(suffix || "").replace(/[^\w\-:.]/g, "");

  var id = "msg-" + DEVICE_ID + "-" + seed;
  if (suffix) id += "-" + suffix;
  return id.slice(0, 120);
}

function cleanupDedupe(now) {
  if (now - lastDedupeCleanupAt < 8000) return;
  lastDedupeCleanupAt = now;

  var keys = Object.keys(dedupe);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (now - Number(dedupe[k] || 0) > DEDUPE_TTL_MS) delete dedupe[k];
  }

  keys = Object.keys(dedupe);
  if (keys.length <= MAX_DEDUPE_KEYS) return;
  keys.sort(function (a, b) { return Number(dedupe[a] || 0) - Number(dedupe[b] || 0); });
  var drop = keys.length - MAX_DEDUPE_KEYS;
  for (var j = 0; j < drop; j++) delete dedupe[keys[j]];
}

function parseAmount(s) {
  var t = String(s).replace(/[，,]/g, "").replace(/。/g, ".");
  t = t.replace(/￥/g, "¥");
  var regs = [
    /(?:RMB|CNY|¥|\$)\s*([0-9]+(?:\.[0-9]{1,2})?)/i,
    /(?:收款|到账|成功收款)\D{0,6}([0-9]+(?:\.[0-9]{1,2})?)/,
    /([0-9]+(?:\.[0-9]{1,2})?)\s*(?:元|块)/
  ];
  for (var i = 0; i < regs.length; i++) {
    var m = t.match(regs[i]);
    if (m && m[1]) return Number(m[1]);
  }
  return null;
}

function formatTime(ts) {
  var d = new Date(ts);
  function p(n) { return (n < 10 ? "0" : "") + n; }
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
    p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function getLocalIp() {
  try {
    var wifi = context.getSystemService(android.content.Context.WIFI_SERVICE);
    if (!wifi) return null;
    var info = wifi.getConnectionInfo();
    if (!info) return null;
    var ipInt = info.getIpAddress();
    if (!ipInt) return null;

    var a = (ipInt & 255);
    var b = ((ipInt >>> 8) & 255);
    var c = ((ipInt >>> 16) & 255);
    var d = ((ipInt >>> 24) & 255);
    return a + "." + b + "." + c + "." + d;
  } catch (e) {
    log("[ERR] getLocalIp: " + e);
    return null;
  }
}

function getLocalIps() {
  var list = [];
  var seen = {};
  function add(ip) {
    ip = String(ip || "").trim();
    if (!isUsableIpv4(ip)) return;
    if (seen[ip]) return;
    seen[ip] = 1;
    list.push(ip);
  }

  add(getLocalIp());

  try {
    var nis = java.net.NetworkInterface.getNetworkInterfaces();
    while (nis && nis.hasMoreElements()) {
      var ni = nis.nextElement();
      if (!ni) continue;
      try {
        if (!ni.isUp() || ni.isLoopback()) continue;
      } catch (_) {}

      var addrs = ni.getInetAddresses();
      while (addrs && addrs.hasMoreElements()) {
        var addr = addrs.nextElement();
        if (!addr) continue;
        var ip = String(addr.getHostAddress() || "");
        if (!ip) continue;
        var cut = ip.indexOf("%");
        if (cut > 0) ip = ip.substring(0, cut);
        if (ip.indexOf(":") >= 0) continue;
        add(ip);
      }
    }
  } catch (_) {}

  return list;
}

function isUsableIpv4(ip) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return false;
  if (ip.indexOf("127.") === 0) return false;
  if (ip.indexOf("169.254.") === 0) return false;
  if (ip.indexOf("198.18.") === 0 || ip.indexOf("198.19.") === 0) return false;
  if (ip === "0.0.0.0") return false;
  return true;
}

function getDeviceId() {
  var id = STORE.get("deviceId", "");
  if (id) return id;
  id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  STORE.put("deviceId", id);
  return id;
}
