const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const app = express();
const PORT = Number(process.env.PORT || 3180);
const BASE_URL = resolveBaseUrl();
const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PAIRING_FILE = path.join(DATA_DIR, 'pairing.json');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const PAIRING_SESSIONS_FILE = path.join(DATA_DIR, 'pairing_sessions.json');

const MAX_RECORDS = Math.max(1000, Number(process.env.MAX_RECORDS || 20000));
const MAX_STREAM_CLIENTS = 200;
const SESSION_TTL_MS = 5 * 60 * 1000;
const APPROVAL_TTL_MS = 10 * 60 * 1000;
const CONNECTION_ONLINE_MS = Number(process.env.CONNECTION_ONLINE_MS || 90 * 1000);
const NOTIFY_DEDUPE_MS = Number(process.env.NOTIFY_DEDUPE_MS || 8 * 1000);
const CLIENT_MSG_ID_TTL_MS = Number(process.env.CLIENT_MSG_ID_TTL_MS || 24 * 60 * 60 * 1000);

app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

ensureDataFiles();

const clients = new Set();
const recentNotifyKeys = new Map();
const recentClientMsgIds = new Map();

app.get('/api/health', (_req, res) => {
  const records = readJson(RECORDS_FILE, []);
  const pairing = readJson(PAIRING_FILE, defaultPairing());
  const sessions = readJson(PAIRING_SESSIONS_FILE, []);
  const warnings = [];

  if (!pairing.code || String(pairing.code).length !== 6) {
    warnings.push('pairing code should be 6 digits');
  }

  res.json({
    ok: true,
    warnings,
    stats: {
      records: records.length,
      devices: Object.keys(pairing.devices || {}).length,
      pairingSessions: sessions.filter((s) => s.status === 'pending').length,
      connectionOnline: getConnectionStatus(pairing).online,
      serverTime: formatTime(Date.now())
    }
  });
});

app.post('/api/pairing/claim', (req, res) => {
  const body = req.body || {};
  const pairing = readJson(PAIRING_FILE, defaultPairing());
  const inputCode = String(body.code || '').trim();

  if (!inputCode || inputCode !== String(pairing.code)) {
    return res.status(400).json({ ok: false, message: 'invalid pairing code' });
  }

  const deviceId = String(body.deviceId || '').trim() || 'unknown-device';
  registerDevice(pairing, {
    deviceId,
    deviceName: String(body.deviceName || '').trim() || 'unknown',
    platform: String(body.platform || '').trim() || 'unknown',
    ip: getClientIp(req)
  });
  writeJson(PAIRING_FILE, pairing);
  broadcast('connection', getConnectionStatus(pairing));

  return res.json({
    ok: true,
    config: {
      apiUrl: absoluteUrl('/api/notify'),
      healthUrl: absoluteUrl('/api/health'),
      authToken: String(pairing.authToken || '')
    }
  });
});

app.post('/api/pairing/session', async (req, res) => {
  const ttl = clamp(Number(req.body && req.body.ttlMs ? req.body.ttlMs : SESSION_TTL_MS), 60 * 1000, 15 * 60 * 1000);
  const now = Date.now();
  const token = createToken();
  const sessions = cleanupSessions(readJson(PAIRING_SESSIONS_FILE, []), now);
  const expiresAt = now + ttl;

  sessions.unshift({
    token,
    status: 'pending',
    createdAt: now,
    expiresAt,
    approvedAt: null,
    approvedIp: ''
  });
  writeJson(PAIRING_SESSIONS_FILE, sessions.slice(0, 200));

  const bindUrl = absoluteUrl(`/pair/${token}`);
  const qrDataUrl = await QRCode.toDataURL(bindUrl, { margin: 1, width: 280 });

  return res.json({
    ok: true,
    session: {
      token,
      status: 'pending',
      bindUrl,
      qrDataUrl,
      expiresAt
    }
  });
});

app.get('/api/pairing/session/latest', async (_req, res) => {
  const now = Date.now();
  const sessions = cleanupSessions(readJson(PAIRING_SESSIONS_FILE, []), now);
  writeJson(PAIRING_SESSIONS_FILE, sessions);
  const session = sessions.find((s) => s.status === 'pending' || s.status === 'approved');
  if (!session) {
    return res.json({ ok: true, session: null });
  }
  const bindUrl = absoluteUrl(`/pair/${session.token}`);
  const qrDataUrl = await QRCode.toDataURL(bindUrl, { margin: 1, width: 280 });
  return res.json({
    ok: true,
    session: {
      ...session,
      bindUrl,
      qrDataUrl
    }
  });
});

app.get('/api/pairing/session/:token', async (req, res) => {
  const token = String(req.params.token || '').trim();
  const now = Date.now();
  const sessions = cleanupSessions(readJson(PAIRING_SESSIONS_FILE, []), now);
  writeJson(PAIRING_SESSIONS_FILE, sessions);
  const session = sessions.find((s) => s.token === token);
  if (!session) {
    return res.status(404).json({ ok: false, message: 'session not found' });
  }
  try {
    const bindUrl = absoluteUrl(`/pair/${session.token}`);
    const qrDataUrl = await QRCode.toDataURL(bindUrl, { margin: 1, width: 280 });
    return res.json({
      ok: true,
      session: {
        ...session,
        bindUrl,
        qrDataUrl
      }
    });
  } catch (_err) {
    const bindUrl = absoluteUrl(`/pair/${session.token}`);
    return res.json({
      ok: true,
      session: {
        ...session,
        bindUrl,
        qrDataUrl: ''
      }
    });
  }
});

app.post('/api/pairing/approve', (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  if (!token) {
    return res.status(400).json({ ok: false, message: 'token required' });
  }

  const now = Date.now();
  const ip = getClientIp(req);
  const sessions = cleanupSessions(readJson(PAIRING_SESSIONS_FILE, []), now);
  const index = sessions.findIndex((s) => s.token === token);
  if (index < 0) {
    return res.status(404).json({ ok: false, message: 'session not found' });
  }
  if (sessions[index].status !== 'pending') {
    return res.status(400).json({ ok: false, message: `session ${sessions[index].status}` });
  }

  sessions[index].status = 'approved';
  sessions[index].approvedAt = now;
  sessions[index].approvedIp = ip;
  writeJson(PAIRING_SESSIONS_FILE, sessions);

  const pairing = readJson(PAIRING_FILE, defaultPairing());
  pairing.autoApprovals = pairing.autoApprovals || {};
  pairing.autoApprovals[ip] = {
    token,
    approvedAt: now,
    expiresAt: now + APPROVAL_TTL_MS
  };
  writeJson(PAIRING_FILE, pairing);

  return res.json({ ok: true, ip, expiresAt: pairing.autoApprovals[ip].expiresAt });
});

app.post('/api/pairing/auto-claim', (req, res) => {
  const now = Date.now();
  const ip = getClientIp(req);
  const pairing = readJson(PAIRING_FILE, defaultPairing());
  pairing.autoApprovals = pairing.autoApprovals || {};

  let approval = pairing.autoApprovals[ip] || null;
  if (approval && approval.expiresAt < now) {
    delete pairing.autoApprovals[ip];
    approval = null;
  }

  // Fallback for phones whose browser/app traffic does not keep same source IP.
  // If there is any recent approved session, allow one-time claim.
  if (!approval) {
    const sessions = cleanupSessions(readJson(PAIRING_SESSIONS_FILE, []), now);
    const approved = sessions.find((s) => s.status === 'approved' && Number(s.expiresAt || 0) > now - 1000);
    if (approved) {
      approval = {
        token: approved.token,
        approvedAt: Number(approved.approvedAt || now),
        expiresAt: Number(approved.expiresAt || now + APPROVAL_TTL_MS)
      };
    }
  }

  if (!approval || approval.expiresAt < now) {
    writeJson(PAIRING_FILE, pairing);
    return res.status(403).json({ ok: false, message: 'not approved yet' });
  }

  const body = req.body || {};
  const deviceId = String(body.deviceId || '').trim() || `device-${now}`;
  registerDevice(pairing, {
    deviceId,
    deviceName: String(body.deviceName || '').trim() || 'unknown',
    platform: String(body.platform || '').trim() || 'android',
    ip
  });
  // Consume approvals for this token (including cross-IP fallback approvals).
  for (const k of Object.keys(pairing.autoApprovals)) {
    const a = pairing.autoApprovals[k];
    if (!a || a.expiresAt < now || a.token === approval.token) {
      delete pairing.autoApprovals[k];
    }
  }
  writeJson(PAIRING_FILE, pairing);
  broadcast('connection', getConnectionStatus(pairing));

  const sessions = readJson(PAIRING_SESSIONS_FILE, []);
  const index = sessions.findIndex((s) => s.token === approval.token);
  if (index >= 0 && sessions[index].status === 'approved') {
    sessions[index].status = 'used';
    sessions[index].usedAt = now;
    writeJson(PAIRING_SESSIONS_FILE, sessions);
  }

  return res.json({
    ok: true,
    config: {
      apiUrl: absoluteUrl('/api/notify'),
      healthUrl: absoluteUrl('/api/health'),
      authToken: String(pairing.authToken || '')
    }
  });
});

app.post('/api/notify', (req, res) => {
  const pairing = readJson(PAIRING_FILE, defaultPairing());
  const expectedToken = String(pairing.authToken || '');
  const incomingToken = String(req.get('X-Auth-Token') || '');

  if (expectedToken && expectedToken !== incomingToken) {
    return res.status(401).json({ ok: false, message: 'invalid token' });
  }

  const payload = req.body || {};
  const channel = normalizeChannel(payload.channel, payload.package);
  const amount = parseAmount(payload.amount);
  const now = Date.now();
  const records = readJson(RECORDS_FILE, []);
  const clientMsgId = safeText(payload.clientMsgId || payload.msgId || payload.eventId || '');

  if (clientMsgId) {
    const dup = findDuplicateByClientMsgId(clientMsgId, records);
    if (dup) {
      rememberClientMsgId(clientMsgId, now);
      return res.json({ ok: true, duplicate: true, id: dup.id || '' });
    }
  } else {
    const notifyKey = buildNotifyKey(payload, channel, amount);
    if (isDuplicateNotify(notifyKey, now)) {
      return res.json({ ok: true, duplicate: true });
    }
  }

  const record = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 7),
    channel,
    amount,
    title: safeText(payload.title),
    content: safeText(payload.content),
    package: safeText(payload.package),
    time: safeText(payload.time) || formatTime(now),
    device: safeText(payload.device),
    clientMsgId,
    createdAt: now
  };

  touchDeviceSeen(pairing, {
    deviceId: record.device || 'unknown-device',
    deviceName: safeText(payload.deviceName) || record.device || 'unknown-device',
    platform: safeText(payload.platform) || 'android',
    ip: getClientIp(req)
  });
  writeJson(PAIRING_FILE, pairing);

  records.unshift(record);
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
  writeJson(RECORDS_FILE, records);
  if (clientMsgId) rememberClientMsgId(clientMsgId, now);

  broadcast('payment', record);
  broadcast('snapshot', buildSnapshot(records));
  broadcast('connection', getConnectionStatus(pairing));

  return res.json({ ok: true, id: record.id });
});

app.get('/api/records', (req, res) => {
  const limit = clamp(Number(req.query.limit || 100), 1, 500);
  const records = readJson(RECORDS_FILE, []).slice(0, limit);
  res.json({ ok: true, records, snapshot: buildSnapshot(records) });
});

app.delete('/api/records', (_req, res) => {
  writeJson(RECORDS_FILE, []);
  recentNotifyKeys.clear();
  recentClientMsgIds.clear();
  broadcast('snapshot', buildSnapshot([]));
  res.json({ ok: true });
});

app.get('/api/settings', (_req, res) => {
  res.json({ ok: true, settings: normalizeSettings(readJson(SETTINGS_FILE, defaultSettings())) });
});

app.post('/api/settings', (req, res) => {
  const oldSettings = normalizeSettings(readJson(SETTINGS_FILE, defaultSettings()));
  const body = req.body || {};
  const oldFeature = oldSettings.feature || {};
  const inputFeature = body.feature || {};
  const incomingWechatQr = body.wechatQrCodeUrl != null ? body.wechatQrCodeUrl : body.qrCodeUrl;
  const incomingAlipayQr = body.alipayQrCodeUrl;

  const settings = normalizeSettings({
    ...oldSettings,
    shopName: safeText(body.shopName) || oldSettings.shopName,
    notice: safeText(body.notice),
    wechatQrCodeUrl: pickQrValue(incomingWechatQr, oldSettings.wechatQrCodeUrl || ''),
    alipayQrCodeUrl: pickQrValue(incomingAlipayQr, oldSettings.alipayQrCodeUrl || ''),
    qrCodeUrl: pickQrValue(incomingWechatQr, oldSettings.wechatQrCodeUrl || oldSettings.qrCodeUrl || ''),
    contact: safeText(body.contact),
    feature: {
      voiceBroadcastEnabled: toBool(inputFeature.voiceBroadcastEnabled, !!oldFeature.voiceBroadcastEnabled),
      showTotalAmount: toBool(inputFeature.showTotalAmount, oldFeature.showTotalAmount !== false),
      showTodayAmount: toBool(inputFeature.showTodayAmount, oldFeature.showTodayAmount !== false),
      showPaymentQrcodes: toBool(inputFeature.showPaymentQrcodes, oldFeature.showPaymentQrcodes !== false)
    },
    theme: {
      accent: normalizeColor(body.theme && body.theme.accent) || oldSettings.theme.accent
    }
  });

  writeJson(SETTINGS_FILE, settings);
  broadcast('settings', settings);
  res.json({ ok: true, settings });
});

app.get('/api/pairing/config', (_req, res) => {
  const pairing = readJson(PAIRING_FILE, defaultPairing());
  res.json({
    ok: true,
    pairing: {
      code: String(pairing.code || ''),
      authToken: String(pairing.authToken || ''),
      devices: pairing.devices || {}
    }
  });
});

app.get('/api/system/info', (_req, res) => {
  res.json({
    ok: true,
    baseUrl: BASE_URL,
    port: PORT,
    lanIp: getLanIp()
  });
});

app.get('/api/connection/status', (_req, res) => {
  const pairing = readJson(PAIRING_FILE, defaultPairing());
  res.json({ ok: true, status: getConnectionStatus(pairing) });
});

app.post('/api/device/ping', (req, res) => {
  const pairing = readJson(PAIRING_FILE, defaultPairing());
  const expectedToken = String(pairing.authToken || '');
  const incomingToken = String(req.get('X-Auth-Token') || '');
  if (expectedToken && expectedToken !== incomingToken) {
    return res.status(401).json({ ok: false, message: 'invalid token' });
  }

  const body = req.body || {};
  touchDeviceSeen(pairing, {
    deviceId: String(body.deviceId || '').trim() || 'unknown-device',
    deviceName: String(body.deviceName || '').trim() || '',
    platform: String(body.platform || '').trim() || 'android',
    ip: getClientIp(req)
  });
  writeJson(PAIRING_FILE, pairing);
  const status = getConnectionStatus(pairing);
  broadcast('connection', status);
  return res.json({ ok: true, status });
});

app.post('/api/pairing/config', (req, res) => {
  const pairing = readJson(PAIRING_FILE, defaultPairing());
  const body = req.body || {};

  if (body.code != null) {
    const code = String(body.code).trim();
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ ok: false, message: 'code must be 6 digits' });
    }
    pairing.code = code;
  }

  if (body.authToken != null) {
    pairing.authToken = String(body.authToken).trim();
  }

  writeJson(PAIRING_FILE, pairing);
  res.json({
    ok: true,
    pairing: {
      code: String(pairing.code || ''),
      authToken: String(pairing.authToken || ''),
      devices: pairing.devices || {}
    }
  });
});

app.get('/api/stream', (req, res) => {
  if (clients.size >= MAX_STREAM_CLIENTS) {
    return res.status(503).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  const client = { res };
  clients.add(client);

  sendEvent(res, 'hello', { ok: true, at: Date.now() });
  sendEvent(res, 'settings', normalizeSettings(readJson(SETTINGS_FILE, defaultSettings())));
  sendEvent(res, 'snapshot', buildSnapshot(readJson(RECORDS_FILE, [])));
  sendEvent(res, 'connection', getConnectionStatus(readJson(PAIRING_FILE, defaultPairing())));

  req.on('close', () => {
    clients.delete(client);
  });
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/setup', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.get('/pair/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pair.html'));
});

app.listen(PORT, () => {
  console.log(`[notify-pro] base url: ${BASE_URL}`);
  console.log(`[notify-pro] admin: ${BASE_URL}/admin`);
  console.log(`[notify-pro] display: ${BASE_URL}/`);
});

function buildSnapshot(records) {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;

  const totalCount = records.length;
  let totalAmount = 0;
  let todayCount = 0;
  let todayAmount = 0;
  const channels = { wechat: 0, alipay: 0, other: 0 };

  for (const record of records) {
    const amount = Number(record.amount || 0);
    if (!Number.isNaN(amount)) totalAmount += amount;

    if (record.channel === 'wechat') channels.wechat += 1;
    else if (record.channel === 'alipay') channels.alipay += 1;
    else channels.other += 1;

    const t = new Date(record.createdAt || Date.now());
    const key = `${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()}`;
    if (key === todayKey) {
      todayCount += 1;
      if (!Number.isNaN(amount)) todayAmount += amount;
    }
  }

  return {
    totalCount,
    totalAmount: round2(totalAmount),
    todayCount,
    todayAmount: round2(todayAmount),
    channels
  };
}

function normalizeChannel(channel, pkg) {
  const c = String(channel || '').toLowerCase();
  if (c.includes('we') || c.includes('wx')) return 'wechat';
  if (c.includes('ali')) return 'alipay';

  const p = String(pkg || '').toLowerCase();
  if (p.includes('mm')) return 'wechat';
  if (p.includes('alipay')) return 'alipay';
  return 'other';
}

function buildNotifyKey(payload, channel, amount) {
  const p = payload || {};
  const keyParts = [
    safeText(p.device || ''),
    safeText(p.package || ''),
    safeText(channel || ''),
    amount == null ? '' : String(amount),
    safeText(p.title || ''),
    safeText(p.content || ''),
    safeText(p.time || '')
  ];
  return keyParts.join('|');
}

function findDuplicateByClientMsgId(clientMsgId, records) {
  if (!clientMsgId) return null;
  const now = Date.now();
  cleanupClientMsgIdCache(now);

  if (recentClientMsgIds.has(clientMsgId)) {
    return { id: '' };
  }

  const items = Array.isArray(records) ? records : [];
  for (const item of items) {
    if (String(item && item.clientMsgId || '') === clientMsgId) {
      return item || { id: '' };
    }
  }
  return null;
}

function rememberClientMsgId(clientMsgId, now) {
  if (!clientMsgId) return;
  recentClientMsgIds.set(clientMsgId, Number(now || Date.now()));
  cleanupClientMsgIdCache(Number(now || Date.now()));
}

function cleanupClientMsgIdCache(now) {
  if (recentClientMsgIds.size <= 0) return;
  const ttl = Math.max(60 * 1000, Number(CLIENT_MSG_ID_TTL_MS || 0));
  for (const [k, ts] of recentClientMsgIds) {
    if (now - Number(ts || 0) > ttl) {
      recentClientMsgIds.delete(k);
    }
  }
  if (recentClientMsgIds.size > 20000) {
    const all = Array.from(recentClientMsgIds.entries()).sort((a, b) => Number(a[1] || 0) - Number(b[1] || 0));
    const drop = recentClientMsgIds.size - 20000;
    for (let i = 0; i < drop; i++) recentClientMsgIds.delete(all[i][0]);
  }
}

function isDuplicateNotify(key, now) {
  if (!key) return false;
  const ts = Number(recentNotifyKeys.get(key) || 0);
  if (ts > 0 && now - ts <= NOTIFY_DEDUPE_MS) {
    return true;
  }
  recentNotifyKeys.set(key, now);

  // Opportunistic cleanup to prevent unbounded growth.
  if (recentNotifyKeys.size > 5000) {
    for (const [k, v] of recentNotifyKeys) {
      if (now - Number(v || 0) > NOTIFY_DEDUPE_MS * 4) {
        recentNotifyKeys.delete(k);
      }
    }
  }
  return false;
}

function parseAmount(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return round2(n);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeText(v) {
  if (v == null) return '';
  return String(v).trim().slice(0, 500);
}

function toBool(v, fallback) {
  if (typeof v === 'boolean') return v;
  if (v == null) return !!fallback;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return !!fallback;
}

function normalizeColor(v) {
  const s = safeText(v);
  if (!s) return '';
  if (/^#[0-9a-fA-F]{6}$/.test(s) || /^#[0-9a-fA-F]{3}$/.test(s)) return s;
  return '';
}

function normalizeQrImageValue(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s) return '';
  if (/^https?:\/\/\S+$/i.test(s)) return s.slice(0, 1000);
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+$/.test(s) && s.length <= 2_500_000) {
    return s.replace(/\s+/g, '');
  }
  return '';
}

function pickQrValue(input, oldValue) {
  if (input == null) return normalizeQrImageValue(oldValue);
  return normalizeQrImageValue(input);
}

function absoluteUrl(pathname) {
  return BASE_URL + pathname;
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const client of clients) {
    try {
      sendEvent(client.res, event, data);
    } catch (_err) {
      clients.delete(client);
    }
  }
}

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(SETTINGS_FILE)) {
    writeJson(SETTINGS_FILE, defaultSettings());
  }

  if (!fs.existsSync(PAIRING_FILE)) {
    writeJson(PAIRING_FILE, defaultPairing());
  }

  if (!fs.existsSync(RECORDS_FILE)) {
    writeJson(RECORDS_FILE, []);
  }

  if (!fs.existsSync(PAIRING_SESSIONS_FILE)) {
    writeJson(PAIRING_SESSIONS_FILE, []);
  }
}

function normalizeSettings(settings) {
  const d = defaultSettings();
  const s = settings || {};
  const feature = s.feature || {};
  const wechatQr = normalizeQrImageValue(s.wechatQrCodeUrl || s.qrCodeUrl || '');
  const alipayQr = normalizeQrImageValue(s.alipayQrCodeUrl || '');
  return {
    ...d,
    ...s,
    wechatQrCodeUrl: wechatQr,
    alipayQrCodeUrl: alipayQr,
    qrCodeUrl: wechatQr || alipayQr || '',
    theme: {
      accent: normalizeColor(s.theme && s.theme.accent) || d.theme.accent
    },
    feature: {
      voiceBroadcastEnabled: toBool(feature.voiceBroadcastEnabled, d.feature.voiceBroadcastEnabled),
      showTotalAmount: toBool(feature.showTotalAmount, d.feature.showTotalAmount),
      showTodayAmount: toBool(feature.showTodayAmount, d.feature.showTodayAmount),
      showPaymentQrcodes: toBool(feature.showPaymentQrcodes, d.feature.showPaymentQrcodes)
    }
  };
}

function defaultSettings() {
  return {
    shopName: '\u6211\u7684\u5e97\u94fa',
    notice: '\u6b22\u8fce\u5149\u4e34\uff0c\u652f\u6301\u5fae\u4fe1/\u652f\u4ed8\u5b9d\u6536\u6b3e',
    wechatQrCodeUrl: '',
    alipayQrCodeUrl: '',
    qrCodeUrl: '',
    contact: '\u8054\u7cfb\u7535\u8bdd\uff1a13800000000',
    feature: {
      voiceBroadcastEnabled: false,
      showTotalAmount: true,
      showTodayAmount: true,
      showPaymentQrcodes: true
    },
    theme: { accent: '#1f6feb' }
  };
}

function defaultPairing() {
  return {
    code: '123456',
    authToken: '',
    devices: {},
    autoApprovals: {}
  };
}

function registerDevice(pairing, options) {
  const now = Date.now();
  pairing.devices = pairing.devices || {};
  const prev = pairing.devices[options.deviceId] || {};
  pairing.devices[options.deviceId] = {
    deviceName: options.deviceName || prev.deviceName || 'unknown',
    platform: options.platform || prev.platform || 'unknown',
    claimedAt: prev.claimedAt || formatTime(now),
    lastIp: options.ip || '',
    updatedAt: now,
    lastSeenAt: now
  };
}

function touchDeviceSeen(pairing, options) {
  const now = Date.now();
  const id = String(options.deviceId || '').trim() || 'unknown-device';
  pairing.devices = pairing.devices || {};
  const prev = pairing.devices[id] || {};
  pairing.devices[id] = {
    deviceName: options.deviceName || prev.deviceName || id,
    platform: options.platform || prev.platform || 'unknown',
    claimedAt: prev.claimedAt || formatTime(now),
    lastIp: options.ip || prev.lastIp || '',
    updatedAt: now,
    lastSeenAt: now
  };
}

function getConnectionStatus(pairing) {
  const now = Date.now();
  const devices = pairing && pairing.devices ? pairing.devices : {};
  const ids = Object.keys(devices);
  let lastSeenAt = 0;
  let lastDeviceId = '';
  let lastDeviceName = '';
  let lastIp = '';

  for (const id of ids) {
    const d = devices[id] || {};
    const ts = Number(d.lastSeenAt || d.updatedAt || 0);
    if (ts > lastSeenAt) {
      lastSeenAt = ts;
      lastDeviceId = id;
      lastDeviceName = String(d.deviceName || id);
      lastIp = String(d.lastIp || '');
    }
  }

  return {
    online: lastSeenAt > 0 && now - lastSeenAt <= CONNECTION_ONLINE_MS,
    thresholdMs: CONNECTION_ONLINE_MS,
    deviceCount: ids.length,
    lastSeenAt,
    lastSeenText: lastSeenAt ? formatTime(lastSeenAt) : '',
    lastDeviceId,
    lastDeviceName,
    lastIp
  };
}

function cleanupSessions(sessions, now) {
  return (sessions || []).filter((s) => Number(s.expiresAt || 0) > now - 1000);
}

function getClientIp(req) {
  const xf = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  const raw = xf || req.socket.remoteAddress || '';
  return String(raw).replace('::ffff:', '') || 'unknown-ip';
}

function createToken() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function resolveBaseUrl() {
  const forcedBase = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL || '');
  if (forcedBase) {
    return forcedBase;
  }

  const lanIp = getLanIp();
  if (lanIp) return `http://${lanIp}:${PORT}`;
  return `http://localhost:${PORT}`;
}

function normalizePublicBaseUrl(input) {
  const raw = String(input || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const protocol = String(u.protocol || '').toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return '';
    const host = String(u.hostname || '').trim().toLowerCase();
    if (!host || host === '+' || host === '0.0.0.0' || host === '::' || host === '[::]') return '';
    if (host.startsWith('198.18.') || host.startsWith('198.19.')) return '';
    return `${u.protocol}//${u.host}`.replace(/\/+$/, '');
  } catch (_err) {
    return '';
  }
}

function getLanIp() {
  try {
    const nets = os.networkInterfaces();
    const names = Object.keys(nets || {});
    const fallback = [];
    for (const name of names) {
      const list = nets[name] || [];
      for (const item of list) {
        if (!item || item.internal) continue;
        if (item.family === 'IPv4') {
          const ip = String(item.address || '');
          if (!ip) continue;
          if (isPreferredLanIp(ip)) return ip;
          if (isUsableIpv4(ip)) fallback.push(ip);
        }
      }
    }
    if (fallback.length) return fallback[0];
  } catch (_err) {}
  return '';
}

function isPreferredLanIp(ip) {
  if (!isUsableIpv4(ip)) return false;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  const m = ip.match(/^172\.(\d{1,3})\./);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

function isUsableIpv4(ip) {
  if (!ip) return false;
  if (ip.startsWith('127.')) return false;
  if (ip.startsWith('169.254.')) return false;
  if (ip.startsWith('198.18.') || ip.startsWith('198.19.')) return false;
  if (ip === '0.0.0.0') return false;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (err) {
    try {
      const short = path.basename(file);
      console.error(`[notify-pro] invalid json: ${short}, fallback applied: ${err.message}`);
      if (fs.existsSync(file)) {
        const backup = `${file}.broken.${Date.now()}.txt`;
        fs.copyFileSync(file, backup);
      }
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2), 'utf8');
    } catch (_writeErr) {}
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function formatTime(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? `0${n}` : `${n}`);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

