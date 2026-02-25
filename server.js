const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');
const mysql = require('mysql2/promise');

const app = express();
const PORT = Number(process.env.PORT || 3180);
const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
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
const DEVICE_STALE_MS = Math.max(6 * 60 * 60 * 1000, Number(process.env.DEVICE_STALE_MS || 14 * 24 * 60 * 60 * 1000));
const MAX_DEVICE_SLOTS = Math.max(10, Number(process.env.MAX_DEVICE_SLOTS || 200));
const SETTINGS_SCHEMA_VERSION = 3;
const SERVER_REVISION = process.env.NOTIFY_PRO_REVISION || '2026-02-24-schema-fix';
const DEFAULT_BACKUP_KEEP = clamp(Number(process.env.BACKUP_KEEP || 30), 3, 365);
const DEFAULT_AUTO_DAILY_BACKUP = envBool(process.env.AUTO_DAILY_BACKUP, true);
const DEFAULT_AUTO_DAILY_BACKUP_HOUR = clamp(Number(process.env.AUTO_DAILY_BACKUP_HOUR || 4), 0, 23);
const MYSQL_URL = String(process.env.MYSQL_URL || '').trim();
const MYSQL_POOL_SIZE = clamp(Number(process.env.MYSQL_POOL_SIZE || 10), 2, 30);
const DEPLOY_MODE = normalizeDeployMode(process.env.DEPLOY_MODE || '');
const IS_CLOUD_MODE = DEPLOY_MODE === 'cloud';
const CLOUD_ALLOW_LOCAL_BASE = envBool(process.env.CLOUD_ALLOW_LOCAL_BASE, false);
const STRICT_CLOUD_MYSQL = envBool(process.env.STRICT_CLOUD_MYSQL, true);
const BASE_URL = resolveBaseUrl();

app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => {
  if (String(req.path || '').startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

ensureDataFiles();

const clients = new Set();
const recentNotifyKeys = new Map();
const recentClientMsgIds = new Map();
let mysqlPool = null;
let recordsBackend = 'json';
let lastDailyBackupKey = '';

app.get('/api/health', async (_req, res) => {
  try {
    const recordsCount = await getRecordsCount();
    const ops = getOpsConfig();
    const pairing = readJson(PAIRING_FILE, defaultPairing());
    cleanupPairingDevices(pairing);
    const sessions = readJson(PAIRING_SESSIONS_FILE, []);
    const warnings = [];

    if (!pairing.code || String(pairing.code).length !== 6) {
      warnings.push('pairing code should be 6 digits');
    }

    res.json({
      ok: true,
      revision: SERVER_REVISION,
      warnings,
      stats: {
        records: recordsCount,
        devices: Object.keys(pairing.devices || {}).length,
        pairingSessions: sessions.filter((s) => s.status === 'pending').length,
        connectionOnline: getConnectionStatus(pairing).online,
        serverTime: formatTime(Date.now()),
        recordsBackend,
        deployMode: DEPLOY_MODE,
        adminPasswordSet: !!getConfiguredAdminPassword(),
        backups: listBackups(1).length,
        backupKeep: ops.backupKeep,
        autoDailyBackupHour: ops.autoDailyBackupHour
      }
    });
  } catch (err) {
    console.error('[notify-pro] /api/health failed:', err && err.message || err);
    res.status(500).json({ ok: false, message: 'health check failed' });
  }
});

app.get('/api/admin/auth-status', (_req, res) => {
  const required = !!getConfiguredAdminPassword();
  res.json({ ok: true, required });
});

app.post('/api/admin/verify', (req, res) => {
  const requiredPassword = getConfiguredAdminPassword();
  if (!requiredPassword) {
    return res.json({ ok: true, required: false, verified: true });
  }
  const incoming = safeText(req.body && req.body.password);
  if (incoming && incoming === requiredPassword) {
    return res.json({ ok: true, required: true, verified: true });
  }
  return res.status(401).json({ ok: false, required: true, verified: false, message: 'admin password invalid' });
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
      apiUrl: absoluteUrlForReq(req, '/api/notify'),
      healthUrl: absoluteUrlForReq(req, '/api/health'),
      authToken: String(pairing.authToken || '')
    }
  });
});

app.post('/api/pairing/session', requireAdminPassword, async (req, res) => {
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

  const bindUrl = absoluteUrlForReq(req, `/pair/${token}`);
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

app.get('/api/pairing/session/latest', requireAdminPassword, async (req, res) => {
  const now = Date.now();
  const sessions = cleanupSessions(readJson(PAIRING_SESSIONS_FILE, []), now);
  writeJson(PAIRING_SESSIONS_FILE, sessions);
  const session = sessions.find((s) => s.status === 'pending' || s.status === 'approved');
  if (!session) {
    return res.json({ ok: true, session: null });
  }
  const bindUrl = absoluteUrlForReq(req, `/pair/${session.token}`);
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

app.get('/api/pairing/session/:token', requireAdminPassword, async (req, res) => {
  const token = String(req.params.token || '').trim();
  const now = Date.now();
  const sessions = cleanupSessions(readJson(PAIRING_SESSIONS_FILE, []), now);
  writeJson(PAIRING_SESSIONS_FILE, sessions);
  const session = sessions.find((s) => s.token === token);
  if (!session) {
    return res.status(404).json({ ok: false, message: 'session not found' });
  }
  try {
    const bindUrl = absoluteUrlForReq(req, `/pair/${session.token}`);
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
    const bindUrl = absoluteUrlForReq(req, `/pair/${session.token}`);
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

// Public bootstrap pairing session for display page:
// when no device is bound yet, homepage can show QR directly without entering admin.
app.get('/api/pairing/public-session', async (req, res) => {
  const now = Date.now();
  const pairing = readJson(PAIRING_FILE, defaultPairing());
  cleanupPairingDevices(pairing, now);
  writeJson(PAIRING_FILE, pairing);

  const status = getConnectionStatus(pairing);
  if (status.online) {
    return res.json({
      ok: true,
      eligible: false,
      reason: 'device-online',
      deviceCount: status.deviceCount,
      online: !!status.online,
      lastSeenAt: Number(status.lastSeenAt || 0)
    });
  }

  const sessions = cleanupSessions(readJson(PAIRING_SESSIONS_FILE, []), now);
  let session = sessions.find((s) => s.status === 'pending' || s.status === 'approved');
  if (!session) {
    session = {
      token: createToken(),
      status: 'pending',
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      approvedAt: null,
      approvedIp: ''
    };
    sessions.unshift(session);
  }
  writeJson(PAIRING_SESSIONS_FILE, sessions.slice(0, 200));

  const bindUrl = absoluteUrlForReq(req, `/pair/${session.token}`);
  const qrDataUrl = await QRCode.toDataURL(bindUrl, { margin: 1, width: 280 });
  return res.json({
    ok: true,
    eligible: true,
    session: {
      ...session,
      bindUrl,
      qrDataUrl
    }
  });
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
  const body = req.body || {};
  const reqToken = String(body.token || '').trim();
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

  // Strong fallback: if client carries explicit pairing token, trust that token first.
  // Also accept "pending" and promote it to approved to avoid app-side two-step race.
  if (!approval && reqToken) {
    const sessions = cleanupSessions(readJson(PAIRING_SESSIONS_FILE, []), now);
    const byToken = sessions.find((s) =>
      s.token === reqToken &&
      (s.status === 'pending' || s.status === 'approved' || s.status === 'used') &&
      Number(s.expiresAt || 0) > now - 1000
    );
    if (byToken) {
      if (byToken.status === 'pending') {
        byToken.status = 'approved';
        byToken.approvedAt = now;
        byToken.approvedIp = ip;
        writeJson(PAIRING_SESSIONS_FILE, sessions);
      }
      approval = {
        token: byToken.token,
        approvedAt: Number(byToken.approvedAt || byToken.usedAt || now),
        expiresAt: Number(byToken.expiresAt || now + APPROVAL_TTL_MS)
      };
    }
  }

  if (!approval || approval.expiresAt < now) {
    writeJson(PAIRING_FILE, pairing);
    return res.status(403).json({ ok: false, message: 'not approved yet' });
  }

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
  if (index >= 0 && sessions[index].status !== 'used') {
    sessions[index].status = 'used';
    sessions[index].usedAt = now;
    writeJson(PAIRING_SESSIONS_FILE, sessions);
  }

  return res.json({
    ok: true,
    config: {
      apiUrl: absoluteUrlForReq(req, '/api/notify'),
      healthUrl: absoluteUrlForReq(req, '/api/health'),
      authToken: String(pairing.authToken || '')
    }
  });
});

app.post('/api/notify', async (req, res) => {
  try {
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
    const eventAt = resolveEventTimestamp(payload, now);
    const clientMsgId = safeText(payload.clientMsgId || payload.msgId || payload.eventId || '');

    if (clientMsgId) {
      const dup = await findDuplicateByClientMsgId(clientMsgId);
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

    // Ignore non-amount notifications to avoid inflating count statistics.
    if (amount == null) {
      touchDeviceSeen(pairing, {
        deviceId: safeText(payload.device) || 'unknown-device',
        deviceName: safeText(payload.deviceName) || safeText(payload.device) || 'unknown-device',
        platform: safeText(payload.platform) || 'android',
        ip: getClientIp(req)
      });
      writeJson(PAIRING_FILE, pairing);
      broadcast('connection', getConnectionStatus(pairing));
      return res.json({ ok: true, skippedNoAmount: true });
    }

    const record = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 7),
      channel,
      amount,
      title: safeText(payload.title),
      content: safeText(payload.content),
      package: safeText(payload.package),
      time: safeText(payload.time) || formatTime(eventAt),
      device: safeText(payload.device),
      clientMsgId,
      createdAt: eventAt,
      receivedAt: now
    };

    touchDeviceSeen(pairing, {
      deviceId: record.device || 'unknown-device',
      deviceName: safeText(payload.deviceName) || record.device || 'unknown-device',
      platform: safeText(payload.platform) || 'android',
      ip: getClientIp(req)
    });
    writeJson(PAIRING_FILE, pairing);

    await insertRecord(record);
    if (clientMsgId) rememberClientMsgId(clientMsgId, now);

    const allRecords = await loadAllRecords();
    broadcast('payment', record);
    broadcast('snapshot', buildSnapshot(allRecords));
    broadcast('connection', getConnectionStatus(pairing));

    return res.json({ ok: true, id: record.id });
  } catch (err) {
    console.error('[notify-pro] /api/notify failed:', err && err.message || err);
    return res.status(500).json({ ok: false, message: 'notify failed' });
  }
});

app.get('/api/records', async (req, res) => {
  try {
    const limit = clamp(Number(req.query.limit || 100), 1, 500);
    const all = await loadAllRecords();
    const records = all.slice(0, limit);
    res.json({ ok: true, records, snapshot: buildSnapshot(all) });
  } catch (err) {
    console.error('[notify-pro] /api/records failed:', err && err.message || err);
    res.status(500).json({ ok: false, message: 'load records failed' });
  }
});

app.get('/api/records/export.csv', requireAdminPassword, async (req, res) => {
  try {
    const limit = clamp(Number(req.query.limit || 5000), 1, 50000);
    const all = await loadAllRecords();
    const rows = all.slice(0, limit);
    const headers = ['id', 'channel', 'amount', 'time', 'createdAt', 'title', 'content', 'package', 'device', 'clientMsgId'];
    const csvLines = [headers.join(',')];

    for (const r of rows) {
      csvLines.push([
        csvEscape(safeText(r && r.id)),
        csvEscape(safeText(r && r.channel)),
        csvEscape(parseAmount(r && r.amount) == null ? '' : String(parseAmount(r && r.amount))),
        csvEscape(safeText(r && r.time) || formatTime(Number(r && r.createdAt || Date.now()))),
        csvEscape(String(Number(r && r.createdAt || 0))),
        csvEscape(safeText(r && r.title)),
        csvEscape(safeText(r && r.content)),
        csvEscape(safeText(r && r.package)),
        csvEscape(safeText(r && r.device)),
        csvEscape(safeText(r && r.clientMsgId))
      ].join(','));
    }

    const stamp = formatTime(Date.now()).replace(/[-:\s]/g, '').slice(0, 14);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="notify-pro-records-${stamp}.csv"`);
    res.send('\ufeff' + csvLines.join('\r\n'));
  } catch (err) {
    console.error('[notify-pro] /api/records/export.csv failed:', err && err.message || err);
    res.status(500).json({ ok: false, message: 'export csv failed' });
  }
});

app.get('/api/stats/full', requireAdminPassword, async (req, res) => {
  try {
    const all = await loadAllRecords();
    const days = clamp(Number(req.query.days || 90), 7, 3650);
    res.json({ ok: true, stats: buildFullStats(all, days) });
  } catch (err) {
    console.error('[notify-pro] /api/stats/full failed:', err && err.message || err);
    res.status(500).json({ ok: false, message: 'load full stats failed' });
  }
});

app.delete('/api/records', requireAdminPassword, async (_req, res) => {
  try {
    await clearAllRecords();
    recentNotifyKeys.clear();
    recentClientMsgIds.clear();
    broadcast('snapshot', buildSnapshot([]));
    res.json({ ok: true });
  } catch (err) {
    console.error('[notify-pro] /api/records delete failed:', err && err.message || err);
    res.status(500).json({ ok: false, message: 'clear records failed' });
  }
});

app.get('/api/backups', requireAdminPassword, (_req, res) => {
  try {
    const items = listBackups(100);
    const ops = getOpsConfig();
    res.json({ ok: true, backups: items, keep: ops.backupKeep, autoDailyBackupHour: ops.autoDailyBackupHour });
  } catch (err) {
    console.error('[notify-pro] /api/backups failed:', err && err.message || err);
    res.status(500).json({ ok: false, message: 'list backups failed' });
  }
});

app.post('/api/backups/create', requireAdminPassword, (req, res) => {
  try {
    const tag = safeText(req.body && req.body.tag) || 'manual';
    const result = createDataBackup(tag);
    res.json({ ok: true, backup: result });
  } catch (err) {
    console.error('[notify-pro] /api/backups/create failed:', err && err.message || err);
    res.status(500).json({ ok: false, message: 'create backup failed' });
  }
});

app.get('/api/settings', (_req, res) => {
  res.json({
    ok: true,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    settings: toPublicSettings(readJson(SETTINGS_FILE, defaultSettings()))
  });
});

app.post('/api/settings', requireAdminPassword, (req, res) => {
  const oldSettings = normalizeSettings(readJson(SETTINGS_FILE, defaultSettings()));
  const body = req.body || {};
  const oldFeature = oldSettings.feature || {};
  const inputFeature = body.feature || {};
  const incomingWechatQr = body.wechatQrCodeUrl;
  const incomingAlipayQr = body.alipayQrCodeUrl;

  const settings = normalizeSettings({
    ...oldSettings,
    shopName: safeText(body.shopName) || oldSettings.shopName,
    notice: safeText(body.notice),
    wechatQrCodeUrl: pickQrValue(incomingWechatQr, oldSettings.wechatQrCodeUrl || ''),
    alipayQrCodeUrl: pickQrValue(incomingAlipayQr, oldSettings.alipayQrCodeUrl || ''),
    contact: safeText(body.contact),
    backupKeep: body.backupKeep != null ? body.backupKeep : oldSettings.backupKeep,
    autoDailyBackupHour: body.autoDailyBackupHour != null ? body.autoDailyBackupHour : oldSettings.autoDailyBackupHour,
    adminPassword: normalizeAdminPasswordInput(body.adminPassword, oldSettings.adminPassword),
    feature: {
      voiceBroadcastEnabled: toBool(inputFeature.voiceBroadcastEnabled, !!oldFeature.voiceBroadcastEnabled),
      showBrand: toBool(inputFeature.showBrand, oldFeature.showBrand !== false),
      showNotice: toBool(inputFeature.showNotice, oldFeature.showNotice !== false),
      showContact: toBool(inputFeature.showContact, oldFeature.showContact !== false),
      showTotalCount: toBool(inputFeature.showTotalCount, oldFeature.showTotalCount !== false),
      showTotalAmount: toBool(inputFeature.showTotalAmount, oldFeature.showTotalAmount !== false),
      showTodayCount: toBool(inputFeature.showTodayCount, oldFeature.showTodayCount !== false),
      showTodayAmount: toBool(inputFeature.showTodayAmount, oldFeature.showTodayAmount !== false),
      showPaymentQrcodes: toBool(inputFeature.showPaymentQrcodes, oldFeature.showPaymentQrcodes !== false),
      showWechatQrcode: toBool(inputFeature.showWechatQrcode, oldFeature.showWechatQrcode !== false),
      showAlipayQrcode: toBool(inputFeature.showAlipayQrcode, oldFeature.showAlipayQrcode !== false),
      showRecordsTable: toBool(inputFeature.showRecordsTable, oldFeature.showRecordsTable !== false),
      showFooterActions: toBool(inputFeature.showFooterActions, oldFeature.showFooterActions !== false)
    },
    theme: {
      accent: normalizeColor(body.theme && body.theme.accent) || oldSettings.theme.accent
    }
  });

  writeJson(SETTINGS_FILE, settings);
  const publicSettings = toPublicSettings(settings);
  broadcast('settings', publicSettings);
  res.json({ ok: true, schemaVersion: SETTINGS_SCHEMA_VERSION, settings: publicSettings });
});

app.get('/api/pairing/config', requireAdminPassword, (_req, res) => {
  const pairing = readJson(PAIRING_FILE, defaultPairing());
  cleanupPairingDevices(pairing);
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

app.get('/api/system/info', (_req, res) => {
  res.json({
    ok: true,
    baseUrl: BASE_URL,
    port: PORT,
    lanIp: getLanIp(),
    deployMode: DEPLOY_MODE,
    isCloudMode: IS_CLOUD_MODE,
    recordsBackend,
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
    serverRevision: SERVER_REVISION,
    pid: process.pid
  });
});

app.get('/api/diagnostics', requireAdminPassword, async (_req, res) => {
  try {
    const diag = await buildDiagnostics();
    res.json({ ok: true, diagnostics: diag });
  } catch (err) {
    console.error('[notify-pro] /api/diagnostics failed:', err && err.message || err);
    res.status(500).json({ ok: false, message: 'diagnostics failed' });
  }
});

app.get('/api/connection/status', (_req, res) => {
  const pairing = readJson(PAIRING_FILE, defaultPairing());
  cleanupPairingDevices(pairing);
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

app.post('/api/pairing/config', requireAdminPassword, (req, res) => {
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

  cleanupPairingDevices(pairing);
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

app.get('/api/stream', async (req, res) => {
  if (clients.size >= MAX_STREAM_CLIENTS) {
    return res.status(503).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();

  const client = { res };
  clients.add(client);

  let snapshotRecords = [];
  try {
    snapshotRecords = await loadAllRecords();
  } catch (err) {
    console.error('[notify-pro] stream snapshot load failed:', err && err.message || err);
  }

  sendEvent(res, 'hello', { ok: true, at: Date.now() });
  sendEvent(res, 'settings', toPublicSettings(readJson(SETTINGS_FILE, defaultSettings())));
  sendEvent(res, 'snapshot', buildSnapshot(snapshotRecords));
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

app.get('/stats', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'stats.html'));
});

app.get('/pair/:token', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pair.html'));
});

startServer().catch((err) => {
  console.error('[notify-pro] startup failed:', err && err.stack || err);
  process.exit(1);
});

function buildSnapshot(records) {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;

  let totalCount = 0;
  let totalAmount = 0;
  let todayCount = 0;
  let todayAmount = 0;
  const channels = { wechat: 0, alipay: 0, other: 0 };

  for (const record of records) {
    const amount = parseAmount(record && record.amount);
    if (amount == null) continue;
    totalCount += 1;
    totalAmount += amount;

    if (record.channel === 'wechat') channels.wechat += 1;
    else if (record.channel === 'alipay') channels.alipay += 1;
    else channels.other += 1;

    const t = new Date(record.createdAt || Date.now());
    const key = `${t.getFullYear()}-${t.getMonth() + 1}-${t.getDate()}`;
    if (key === todayKey) {
      todayCount += 1;
      todayAmount += amount;
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

function resolveEventTimestamp(payload, fallbackNow) {
  const now = Number(fallbackNow || Date.now());
  const p = payload || {};
  const candidates = [
    p.createdAt,
    p.eventAt,
    p.eventTime,
    p.ts,
    p.timestamp,
    p.clientTs,
    p.clientTime
  ];

  for (const v of candidates) {
    const ts = parseLooseTimestamp(v);
    if (isReasonableTimestamp(ts, now)) return ts;
  }

  const textTs = parseLooseDateText(p.time);
  if (isReasonableTimestamp(textTs, now)) return textTs;
  return now;
}

function parseLooseTimestamp(v) {
  if (v == null || v === '') return 0;
  const s = String(v).trim();
  if (!s) return 0;
  if (!/^\d{9,16}$/.test(s)) return 0;
  let n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 0;

  // seconds
  if (n >= 1e9 && n < 1e11) n *= 1000;
  // microseconds
  if (n >= 1e14) n = Math.floor(n / 1000);
  return Math.floor(n);
}

function parseLooseDateText(v) {
  const s = safeText(v);
  if (!s) return 0;

  const direct = Date.parse(s);
  if (Number.isFinite(direct)) return direct;

  const normalized = s.replace(/\//g, '-').replace(/年|月/g, '-').replace(/日/g, '').replace(/\s+/g, ' ').trim();
  const m = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/);
  if (!m) return 0;
  const y = Number(m[1]);
  const mon = Number(m[2]) - 1;
  const d = Number(m[3]);
  const hh = Number(m[4] || 0);
  const mm = Number(m[5] || 0);
  const ss = Number(m[6] || 0);
  return new Date(y, mon, d, hh, mm, ss).getTime();
}

function isReasonableTimestamp(ts, now) {
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const min = Date.UTC(2000, 0, 1);
  const max = now + 30 * 24 * 60 * 60 * 1000;
  return ts >= min && ts <= max;
}

function normalizeRecordsByEventTime(records) {
  const now = Date.now();
  const list = Array.isArray(records) ? records : [];
  let changed = false;

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const fromTime = parseLooseDateText(item.time);
    const oldCreatedAt = Number(item.createdAt || 0);
    if (isReasonableTimestamp(fromTime, now) && (!isReasonableTimestamp(oldCreatedAt, now) || Math.abs(oldCreatedAt - fromTime) > 5 * 60 * 1000)) {
      item.createdAt = fromTime;
      changed = true;
    }
  }

  list.sort((a, b) => Number(b && b.createdAt || 0) - Number(a && a.createdAt || 0));
  return { records: list, changed };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function envBool(v, fallback) {
  if (v == null) return !!fallback;
  const s = String(v).trim().toLowerCase();
  if (!s) return !!fallback;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return !!fallback;
}

function safeText(v) {
  if (v == null) return '';
  return String(v).trim().slice(0, 500);
}

function normalizeAdminPasswordInput(v, fallback) {
  if (v == null) return String(fallback || '').trim().slice(0, 120);
  const s = String(v).trim();
  if (!s) return String(fallback || '').trim().slice(0, 120);
  return s.slice(0, 120);
}

function getConfiguredAdminPassword() {
  const envPwd = String(process.env.ADMIN_PASSWORD || '').trim();
  if (envPwd) return envPwd;
  const raw = readJson(SETTINGS_FILE, defaultSettings()) || {};
  return normalizeAdminPasswordInput(raw.adminPassword, '');
}

function getRequestAdminPassword(req) {
  return String((req && req.get && req.get('X-Admin-Password')) || '').trim();
}

function requireAdminPassword(req, res, next) {
  const required = getConfiguredAdminPassword();
  if (!required) return next();
  const incoming = getRequestAdminPassword(req);
  if (incoming && incoming === required) return next();
  return res.status(401).json({ ok: false, message: 'admin password required' });
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

function absoluteUrlForReq(req, pathname) {
  const forcedBase = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL || '');
  if (forcedBase) return forcedBase + pathname;

  try {
    const xfh = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
    const host = xfh || String(req.get('host') || '').trim();
    if (host) {
      const xfp = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
      const proto = xfp === 'https' ? 'https' : (xfp === 'http' ? 'http' : (req.secure ? 'https' : 'http'));
      const normalized = normalizePublicBaseUrl(`${proto}://${host}`);
      if (normalized) return normalized + pathname;
    }
  } catch (_err) {}
  return absoluteUrl(pathname);
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

async function startServer() {
  const hasForcedBase = !!normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL || '');
  if (IS_CLOUD_MODE && !hasForcedBase && !CLOUD_ALLOW_LOCAL_BASE) {
    throw new Error('cloud mode requires PUBLIC_BASE_URL, e.g. https://pay.example.com');
  }

  await initRecordsStorage();
  app.listen(PORT, () => {
    const ops = getOpsConfig();
    console.log(`[notify-pro] deploy mode: ${DEPLOY_MODE}`);
    console.log(`[notify-pro] base url: ${BASE_URL}`);
    console.log(`[notify-pro] admin: ${BASE_URL}/admin`);
    console.log(`[notify-pro] display: ${BASE_URL}/`);
    console.log(`[notify-pro] records backend: ${recordsBackend}`);
    console.log(`[notify-pro] daily backup: ${DEFAULT_AUTO_DAILY_BACKUP ? `on @${ops.autoDailyBackupHour}:00` : 'off'}`);
    if (DEFAULT_AUTO_DAILY_BACKUP) {
      tryCreateDailyBackup('startup');
      const timer = setInterval(() => {
        tryCreateDailyBackup('daily');
      }, 30 * 60 * 1000);
      timer.unref && timer.unref();
    }
  });
}

async function initRecordsStorage() {
  if (!MYSQL_URL) {
    if (IS_CLOUD_MODE && STRICT_CLOUD_MYSQL) {
      throw new Error('cloud mode requires MYSQL_URL');
    }
    recordsBackend = 'json';
    return;
  }

  try {
    mysqlPool = mysql.createPool({
      uri: MYSQL_URL,
      waitForConnections: true,
      connectionLimit: MYSQL_POOL_SIZE,
      queueLimit: 0,
      decimalNumbers: true
    });

    await mysqlPool.query('SELECT 1');
    await mysqlPool.query(`
      CREATE TABLE IF NOT EXISTS payment_records (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        channel VARCHAR(16) NOT NULL,
        amount DECIMAL(18,2) NOT NULL,
        title VARCHAR(500) NOT NULL DEFAULT '',
        content VARCHAR(500) NOT NULL DEFAULT '',
        package_name VARCHAR(200) NOT NULL DEFAULT '',
        time_text VARCHAR(64) NOT NULL DEFAULT '',
        device VARCHAR(120) NOT NULL DEFAULT '',
        client_msg_id VARCHAR(200) NOT NULL DEFAULT '',
        created_at BIGINT NOT NULL,
        received_at BIGINT NOT NULL,
        INDEX idx_payment_created_at (created_at DESC),
        INDEX idx_payment_client_msg_id (client_msg_id),
        INDEX idx_payment_channel_created (channel, created_at DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    recordsBackend = 'mysql';
    await migrateRecordsJsonToMysqlIfNeeded();
  } catch (err) {
    if (IS_CLOUD_MODE && STRICT_CLOUD_MYSQL) {
      throw new Error(`mysql init failed in cloud mode: ${err && err.message || err}`);
    }
    console.error('[notify-pro] mysql init failed, fallback to json:', err && err.message || err);
    recordsBackend = 'json';
    if (mysqlPool) {
      try { await mysqlPool.end(); } catch (_) {}
    }
    mysqlPool = null;
  }
}

async function migrateRecordsJsonToMysqlIfNeeded() {
  if (!mysqlPool) return;
  const [rows] = await mysqlPool.query('SELECT COUNT(1) AS c FROM payment_records');
  const currentCount = Number(rows && rows[0] && rows[0].c || 0);
  if (currentCount > 0) return;

  const raw = readJson(RECORDS_FILE, []);
  const fixed = normalizeRecordsByEventTime(raw).records;
  let inserted = 0;
  for (const item of fixed) {
    const amount = parseAmount(item && item.amount);
    if (amount == null) continue;
    const record = {
      id: safeText(item && item.id) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
      channel: normalizeChannel(item && item.channel, item && item.package),
      amount,
      title: safeText(item && item.title),
      content: safeText(item && item.content),
      package: safeText(item && item.package),
      time: safeText(item && item.time),
      device: safeText(item && item.device),
      clientMsgId: safeText(item && item.clientMsgId),
      createdAt: Number(item && item.createdAt) || Date.now(),
      receivedAt: Number(item && item.receivedAt) || Date.now()
    };
    inserted += await insertRecord(record, { trimAfter: false, ignoreDuplicate: true }) ? 1 : 0;
  }
  await trimMysqlRecordsOverflow(MAX_RECORDS);
  if (inserted > 0) {
    console.log(`[notify-pro] migrated ${inserted} records from records.json to MySQL`);
  }
}

async function getRecordsCount() {
  if (mysqlPool) {
    const [rows] = await mysqlPool.query('SELECT COUNT(1) AS c FROM payment_records');
    return Number(rows && rows[0] && rows[0].c || 0);
  }
  const records = readJson(RECORDS_FILE, []);
  return Array.isArray(records) ? records.length : 0;
}

async function loadAllRecords() {
  if (mysqlPool) {
    const [rows] = await mysqlPool.query(`
      SELECT id, channel, amount, title, content, package_name, time_text, device, client_msg_id, created_at, received_at
      FROM payment_records
      ORDER BY created_at DESC, received_at DESC
      LIMIT ?
    `, [MAX_RECORDS]);
    return (rows || []).map(mapDbRecordToApiRecord);
  }

  const all = readJson(RECORDS_FILE, []);
  if (!Array.isArray(all)) return [];
  all.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  return all.slice(0, MAX_RECORDS);
}

function mapDbRecordToApiRecord(row) {
  return {
    id: safeText(row && row.id),
    channel: safeText(row && row.channel),
    amount: parseAmount(row && row.amount),
    title: safeText(row && row.title),
    content: safeText(row && row.content),
    package: safeText(row && row.package_name),
    time: safeText(row && row.time_text),
    device: safeText(row && row.device),
    clientMsgId: safeText(row && row.client_msg_id),
    createdAt: Number(row && row.created_at || 0),
    receivedAt: Number(row && row.received_at || 0)
  };
}

async function insertRecord(record, options) {
  const opt = options || {};
  if (mysqlPool) {
    const sql = opt.ignoreDuplicate
      ? `INSERT IGNORE INTO payment_records
          (id, channel, amount, title, content, package_name, time_text, device, client_msg_id, created_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      : `INSERT INTO payment_records
          (id, channel, amount, title, content, package_name, time_text, device, client_msg_id, created_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const [ret] = await mysqlPool.query(sql, [
      safeText(record.id),
      safeText(record.channel),
      Number(record.amount || 0),
      safeText(record.title),
      safeText(record.content),
      safeText(record.package),
      safeText(record.time),
      safeText(record.device),
      safeText(record.clientMsgId),
      Number(record.createdAt || Date.now()),
      Number(record.receivedAt || Date.now())
    ]);

    if (opt.trimAfter !== false) {
      await trimMysqlRecordsOverflow(MAX_RECORDS);
    }
    return Number(ret && ret.affectedRows || 0) > 0;
  }

  const records = readJson(RECORDS_FILE, []);
  records.unshift(record);
  if (records.length > 1 && Number(records[0].createdAt || 0) < Number(records[1].createdAt || 0)) {
    records.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  }
  if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;
  writeJson(RECORDS_FILE, records);
  return true;
}

async function trimMysqlRecordsOverflow(maxCount) {
  if (!mysqlPool) return;
  const safeMax = Math.max(1, Number(maxCount || MAX_RECORDS));
  await mysqlPool.query(`
    DELETE FROM payment_records
    WHERE id NOT IN (
      SELECT id FROM (
        SELECT id
        FROM payment_records
        ORDER BY created_at DESC, received_at DESC
        LIMIT ?
      ) t
    )
  `, [safeMax]);
}

async function findDuplicateByClientMsgId(clientMsgId) {
  if (!clientMsgId) return null;
  const now = Date.now();
  cleanupClientMsgIdCache(now);

  if (recentClientMsgIds.has(clientMsgId)) {
    return { id: '' };
  }

  if (mysqlPool) {
    const [rows] = await mysqlPool.query(
      `SELECT id, client_msg_id FROM payment_records WHERE client_msg_id = ? LIMIT 1`,
      [String(clientMsgId)]
    );
    if (rows && rows.length > 0) {
      return { id: safeText(rows[0].id || '') };
    }
    return null;
  }

  const items = readJson(RECORDS_FILE, []);
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (String(item && item.clientMsgId || '') === clientMsgId) {
      return item || { id: '' };
    }
  }
  return null;
}

async function clearAllRecords() {
  if (mysqlPool) {
    await mysqlPool.query('TRUNCATE TABLE payment_records');
    return;
  }
  writeJson(RECORDS_FILE, []);
}

function ensureBackupDirExists() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  ensureBackupDirExists();

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

  // Always normalize settings on startup so old feature schemas are migrated
  // before admin page reads/saves them.
  const rawSettings = readJson(SETTINGS_FILE, defaultSettings());
  const normalizedSettings = normalizeSettings(rawSettings);
  if (JSON.stringify(rawSettings) !== JSON.stringify(normalizedSettings)) {
    writeJson(SETTINGS_FILE, normalizedSettings);
  }

  // One-time repair for historical records written with server receive time.
  const records = readJson(RECORDS_FILE, []);
  const fixed = normalizeRecordsByEventTime(records);
  if (fixed.changed) {
    writeJson(RECORDS_FILE, fixed.records);
  }
}

function normalizeSettings(settings) {
  const d = defaultSettings();
  const s = settings || {};
  const feature = s.feature || {};
  const wechatQr = normalizeQrImageValue(s.wechatQrCodeUrl || '');
  const alipayQr = normalizeQrImageValue(s.alipayQrCodeUrl || '');
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    shopName: safeText(s.shopName) || d.shopName,
    notice: safeText(s.notice),
    contact: safeText(s.contact),
    backupKeep: clamp(Number(s.backupKeep == null ? d.backupKeep : s.backupKeep), 3, 365),
    autoDailyBackupHour: clamp(Number(s.autoDailyBackupHour == null ? d.autoDailyBackupHour : s.autoDailyBackupHour), 0, 23),
    adminPassword: normalizeAdminPasswordInput(s.adminPassword, d.adminPassword),
    wechatQrCodeUrl: wechatQr,
    alipayQrCodeUrl: alipayQr,
    theme: {
      accent: normalizeColor(s.theme && s.theme.accent) || d.theme.accent
    },
    feature: {
      voiceBroadcastEnabled: toBool(feature.voiceBroadcastEnabled, d.feature.voiceBroadcastEnabled),
      showBrand: toBool(feature.showBrand, d.feature.showBrand),
      showNotice: toBool(feature.showNotice, d.feature.showNotice),
      showContact: toBool(feature.showContact, d.feature.showContact),
      showTotalCount: toBool(feature.showTotalCount, d.feature.showTotalCount),
      showTotalAmount: toBool(feature.showTotalAmount, d.feature.showTotalAmount),
      showTodayCount: toBool(feature.showTodayCount, d.feature.showTodayCount),
      showTodayAmount: toBool(feature.showTodayAmount, d.feature.showTodayAmount),
      showPaymentQrcodes: toBool(feature.showPaymentQrcodes, d.feature.showPaymentQrcodes),
      showWechatQrcode: toBool(feature.showWechatQrcode, d.feature.showWechatQrcode),
      showAlipayQrcode: toBool(feature.showAlipayQrcode, d.feature.showAlipayQrcode),
      showRecordsTable: toBool(feature.showRecordsTable, d.feature.showRecordsTable),
      showFooterActions: toBool(feature.showFooterActions, d.feature.showFooterActions)
    }
  };
}

function buildFullStats(records, days) {
  const all = Array.isArray(records) ? records.slice() : [];
  all.sort((a, b) => Number(b && b.createdAt || 0) - Number(a && a.createdAt || 0));

  const channelSummary = {
    wechat: { count: 0, amount: 0 },
    alipay: { count: 0, amount: 0 },
    other: { count: 0, amount: 0 }
  };
  const dailyMap = new Map();
  const monthlyMap = new Map();
  const now = Date.now();
  const startAt = now - Math.max(1, Number(days || 90)) * 24 * 60 * 60 * 1000;
  const hourStats = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, amount: 0 }));

  const nowDate = new Date(now);
  const todayKey = `${nowDate.getFullYear()}-${pad2(nowDate.getMonth() + 1)}-${pad2(nowDate.getDate())}`;

  let totalCount = 0;
  let totalAmount = 0;
  for (const record of all) {
    const ch = normalizeChannel(record && record.channel, record && record.package);
    const nAmount = parseAmount(record && record.amount);
    if (nAmount == null) continue;
    const createdAt = Number(record && record.createdAt || 0) || now;
    const d = new Date(createdAt);
    const dayKey = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const monthKey = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;

    totalCount += 1;
    totalAmount += nAmount;

    if (!channelSummary[ch]) channelSummary[ch] = { count: 0, amount: 0 };
    channelSummary[ch].count += 1;
    channelSummary[ch].amount = round2(channelSummary[ch].amount + nAmount);

    if (createdAt >= startAt) {
      if (!dailyMap.has(dayKey)) {
        dailyMap.set(dayKey, {
          date: dayKey,
          count: 0,
          amount: 0,
          wechatCount: 0,
          alipayCount: 0,
          otherCount: 0
        });
      }
      const dayItem = dailyMap.get(dayKey);
      dayItem.count += 1;
      dayItem.amount = round2(dayItem.amount + nAmount);
      if (ch === 'wechat') dayItem.wechatCount += 1;
      else if (ch === 'alipay') dayItem.alipayCount += 1;
      else dayItem.otherCount += 1;
    }

    if (!monthlyMap.has(monthKey)) {
      monthlyMap.set(monthKey, { month: monthKey, count: 0, amount: 0 });
    }
    const monthItem = monthlyMap.get(monthKey);
    monthItem.count += 1;
    monthItem.amount = round2(monthItem.amount + nAmount);

    if (dayKey === todayKey) {
      const hour = d.getHours();
      if (hour >= 0 && hour <= 23) {
        hourStats[hour].count += 1;
        hourStats[hour].amount = round2(hourStats[hour].amount + nAmount);
      }
    }
  }

  const daily = Array.from(dailyMap.values()).sort((a, b) => b.date.localeCompare(a.date));
  const monthly = Array.from(monthlyMap.values()).sort((a, b) => b.month.localeCompare(a.month));
  const topAmountRecords = all
    .filter((r) => parseAmount(r && r.amount) != null)
    .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))
    .slice(0, 20)
    .map((r) => ({
      id: safeText(r.id),
      channel: normalizeChannel(r.channel, r.package),
      amount: round2(Number(parseAmount(r.amount) || 0)),
      time: safeText(r.time) || formatTime(Number(r.createdAt || now)),
      createdAt: Number(r.createdAt || now)
    }));

  return {
    generatedAt: now,
    totalCount,
    totalAmount: round2(totalAmount),
    channelSummary: {
      wechat: {
        count: channelSummary.wechat.count,
        amount: round2(channelSummary.wechat.amount)
      },
      alipay: {
        count: channelSummary.alipay.count,
        amount: round2(channelSummary.alipay.amount)
      },
      other: {
        count: channelSummary.other.count,
        amount: round2(channelSummary.other.amount)
      }
    },
    daily,
    monthly,
    todayHourly: hourStats,
    topAmountRecords
  };
}

function defaultSettings() {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    shopName: '\u6211\u7684\u5e97\u94fa',
    notice: '\u6b22\u8fce\u5149\u4e34\uff0c\u652f\u6301\u5fae\u4fe1/\u652f\u4ed8\u5b9d\u6536\u6b3e',
    wechatQrCodeUrl: '',
    alipayQrCodeUrl: '',
    contact: '\u8054\u7cfb\u7535\u8bdd\uff1a13800000000',
    backupKeep: DEFAULT_BACKUP_KEEP,
    autoDailyBackupHour: DEFAULT_AUTO_DAILY_BACKUP_HOUR,
    adminPassword: '',
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
    },
    theme: { accent: '#1f6feb' }
  };
}

function toPublicSettings(settings) {
  const s = normalizeSettings(settings);
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    shopName: s.shopName,
    notice: s.notice,
    wechatQrCodeUrl: s.wechatQrCodeUrl,
    alipayQrCodeUrl: s.alipayQrCodeUrl,
    contact: s.contact,
    backupKeep: s.backupKeep,
    autoDailyBackupHour: s.autoDailyBackupHour,
    feature: { ...(s.feature || {}) },
    theme: { ...(s.theme || {}) }
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
  cleanupPairingDevices(pairing, now);
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
  cleanupPairingDevices(pairing, now);
}

function cleanupPairingDevices(pairing, now) {
  const p = pairing || {};
  const tsNow = Number(now || Date.now());
  const raw = p.devices && typeof p.devices === 'object' ? p.devices : {};
  const items = [];
  for (const [id, d] of Object.entries(raw)) {
    const safeId = safeText(id) || '';
    if (!safeId) continue;
    const item = d || {};
    const lastSeenAt = Number(item.lastSeenAt || item.updatedAt || 0);
    if (lastSeenAt > 0 && tsNow - lastSeenAt > DEVICE_STALE_MS) continue;
    items.push({
      id: safeId,
      deviceName: safeText(item.deviceName) || safeId,
      platform: safeText(item.platform) || 'unknown',
      claimedAt: safeText(item.claimedAt) || (lastSeenAt > 0 ? formatTime(lastSeenAt) : ''),
      lastIp: safeText(item.lastIp),
      updatedAt: Number(item.updatedAt || lastSeenAt || tsNow),
      lastSeenAt: lastSeenAt > 0 ? lastSeenAt : Number(item.updatedAt || tsNow)
    });
  }

  items.sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));

  const result = {};
  const seen = new Set();
  let kept = 0;
  for (const item of items) {
    const fp = buildDeviceFingerprint(item);
    if (seen.has(fp)) continue;
    seen.add(fp);
    result[item.id] = {
      deviceName: item.deviceName,
      platform: item.platform,
      claimedAt: item.claimedAt,
      lastIp: item.lastIp,
      updatedAt: item.updatedAt,
      lastSeenAt: item.lastSeenAt
    };
    kept += 1;
    if (kept >= MAX_DEVICE_SLOTS) break;
  }
  p.devices = result;
}

function buildDeviceFingerprint(item) {
  const name = String(item.deviceName || '').trim().toLowerCase();
  const platform = String(item.platform || '').trim().toLowerCase();
  const ip = String(item.lastIp || '').trim().toLowerCase();
  if (name && platform && ip) return `${name}|${platform}|${ip}`;
  return `id:${String(item.id || '').trim().toLowerCase()}`;
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

function normalizeDeployMode(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'cloud' || s === 'saas') return 'cloud';
  return 'lan';
}

function resolveBaseUrl() {
  const forcedBase = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL || '');
  if (forcedBase) {
    return forcedBase;
  }

  if (IS_CLOUD_MODE) {
    return `http://localhost:${PORT}`;
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

function getOpsConfig() {
  const s = normalizeSettings(readJson(SETTINGS_FILE, defaultSettings()));
  return {
    backupKeep: clamp(Number(s.backupKeep == null ? DEFAULT_BACKUP_KEEP : s.backupKeep), 3, 365),
    autoDailyBackupHour: clamp(Number(s.autoDailyBackupHour == null ? DEFAULT_AUTO_DAILY_BACKUP_HOUR : s.autoDailyBackupHour), 0, 23)
  };
}

async function buildDiagnostics() {
  const warnings = [];
  const errors = [];
  const suggestions = [];
  const ops = getOpsConfig();

  const pairing = readJson(PAIRING_FILE, defaultPairing());
  cleanupPairingDevices(pairing);
  const status = getConnectionStatus(pairing);
  const recordsCount = await getRecordsCount();
  const hasAdminPassword = !!getConfiguredAdminPassword();
  const hasPublicBase = !!normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL || '');

  if (!hasAdminPassword) {
    warnings.push('后台管理员密码为空，存在误操作风险。');
    suggestions.push('建议在后台设置管理员密码。');
  }
  if (DEPLOY_MODE === 'cloud' && !hasPublicBase) {
    errors.push('云模式未配置 PUBLIC_BASE_URL。');
    suggestions.push('设置 PUBLIC_BASE_URL 为公网域名，例如 https://pay.example.com。');
  }
  if (DEPLOY_MODE === 'lan' && BASE_URL.indexOf('localhost') >= 0) {
    warnings.push('当前基础地址为 localhost，手机可能无法访问。');
    suggestions.push('检查网卡状态，确保服务器有可用局域网 IP。');
  }
  if (status.deviceCount <= 0) {
    warnings.push('暂无已绑定设备。');
    suggestions.push('请在大屏或后台生成二维码并用手机扫码绑定。');
  } else if (!status.online) {
    warnings.push('已有设备但当前离线。');
    suggestions.push('检查手机端通知监听权限、前台保活和网络连接。');
  }
  if (recordsCount <= 0) {
    warnings.push('暂无收款记录。');
    suggestions.push('可先做一笔 0.01 测试收款，确认通知链路。');
  }
  if (recordsBackend === 'json') {
    suggestions.push('当前为 JSON 存储，建议启用定期备份并导出 CSV 留档。');
  }

  return {
    generatedAt: Date.now(),
    checks: {
      deployMode: DEPLOY_MODE,
      baseUrl: BASE_URL,
      hasPublicBase,
      backupKeep: ops.backupKeep,
      autoDailyBackupHour: ops.autoDailyBackupHour,
      recordsBackend,
      recordsCount,
      adminPasswordSet: hasAdminPassword,
      deviceCount: status.deviceCount,
      online: !!status.online,
      lastSeenText: status.lastSeenText || '',
      lastDeviceName: status.lastDeviceName || '',
      lastIp: status.lastIp || ''
    },
    warnings,
    errors,
    suggestions
  };
}

function createDataBackup(tag) {
  ensureBackupDirExists();
  const ops = getOpsConfig();
  const cleanTag = normalizeBackupTag(tag);
  const ts = formatTime(Date.now()).replace(/[-:\s]/g, '');
  const backupId = `${ts}-${cleanTag}`;
  const dir = path.join(BACKUP_DIR, backupId);
  fs.mkdirSync(dir, { recursive: true });

  const sourceFiles = [SETTINGS_FILE, PAIRING_FILE, PAIRING_SESSIONS_FILE, RECORDS_FILE];
  const copied = [];
  for (const src of sourceFiles) {
    if (!fs.existsSync(src)) continue;
    const name = path.basename(src);
    const dst = path.join(dir, name);
    fs.copyFileSync(src, dst);
    copied.push(name);
  }

  const meta = {
    backupId,
    createdAt: Date.now(),
    tag: cleanTag,
    deployMode: DEPLOY_MODE,
    recordsBackend,
    files: copied
  };
  writeJson(path.join(dir, 'meta.json'), meta);
  cleanupOldBackups(ops.backupKeep);
  return { backupId, dir: path.relative(__dirname, dir), files: copied };
}

function tryCreateDailyBackup(tag) {
  if (!DEFAULT_AUTO_DAILY_BACKUP) return;
  const ops = getOpsConfig();
  const now = new Date();
  if (now.getHours() < Number(ops.autoDailyBackupHour || 0)) return;
  const key = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  if (lastDailyBackupKey === key) return;
  createDataBackup(tag || 'daily');
  lastDailyBackupKey = key;
}

function listBackups(limit) {
  ensureBackupDirExists();
  const safeLimit = clamp(Number(limit || 100), 1, 500);
  const items = [];
  const entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent || !ent.isDirectory()) continue;
    const dir = path.join(BACKUP_DIR, ent.name);
    const stat = fs.statSync(dir);
    items.push({
      id: ent.name,
      dir: path.relative(__dirname, dir),
      createdAt: Number(stat.mtimeMs || 0),
      createdText: formatTime(Number(stat.mtimeMs || Date.now()))
    });
  }
  items.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  return items.slice(0, safeLimit);
}

function cleanupOldBackups(keep) {
  ensureBackupDirExists();
  const fallbackKeep = getOpsConfig().backupKeep;
  const safeKeep = clamp(Number(keep || fallbackKeep), 1, 1000);
  const all = listBackups(2000);
  if (all.length <= safeKeep) return;
  for (let i = safeKeep; i < all.length; i++) {
    const dir = path.join(__dirname, all[i].dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function normalizeBackupTag(tag) {
  const raw = safeText(tag || '');
  if (!raw) return 'manual';
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'manual';
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (s.indexOf('"') >= 0 || s.indexOf(',') >= 0 || s.indexOf('\n') >= 0 || s.indexOf('\r') >= 0) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
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
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(value, null, 2);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (_err) {
    try {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    } catch (_e1) {}
    fs.renameSync(tmp, file);
  }
}

function pad2(n) {
  const v = Number(n || 0);
  return v < 10 ? `0${v}` : `${v}`;
}

function formatTime(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

