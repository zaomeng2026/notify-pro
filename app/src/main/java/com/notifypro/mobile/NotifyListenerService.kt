package com.notifypro.mobile

import android.app.Notification.EXTRA_TEXT
import android.app.Notification.EXTRA_TITLE
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections
import java.util.LinkedHashSet
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class NotifyListenerService : NotificationListenerService() {
    private val tag = "NotifyListener"
    private val acceptedPackages = setOf("com.tencent.mm", "com.eg.android.AlipayGphone")
    private val hints = listOf(
        "\u6536\u6b3e",
        "\u5230\u8d26",
        "\u6210\u529f\u6536\u6b3e",
        "\u5fae\u4fe1\u652f\u4ed8",
        "\u652f\u4ed8\u5b9d",
        "\u4e2a\u4eba\u6536\u6b3e\u7801"
    )

    private val dedupeMs = 5000L
    private val dedupeTtlMs = 45_000L
    private val maxDedupeKeys = 1200
    private val maxQueue = 500
    private val maxDiscoveryCandidates = 180
    private val maxRetry = 120
    private val maxPendingAgeMs = 24 * 60 * 60 * 1000L

    private lateinit var store: ConfigStore
    private val dedupe = ConcurrentHashMap<String, Long>()
    private val queueLock = Any()
    private val ensureLock = Any()
    private val ioExecutor = Executors.newSingleThreadScheduledExecutor()
    private val infraExecutor = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var lastDedupeCleanupAt = 0L
    @Volatile private var lastEnsureRequestAt = 0L

    private data class NotifyPayload(
        val packageName: String,
        val channel: String,
        val title: String,
        val content: String,
        val amount: Double?,
        val clientMsgId: String,
        val deviceId: String,
        val deviceName: String
    )

    private data class PendingItem(
        val payload: NotifyPayload,
        val ts: Long,
        val retry: Int
    )

    override fun onCreate() {
        super.onCreate()
        store = ConfigStore(applicationContext)
        infraExecutor.scheduleWithFixedDelay({ safeEnsureConfig() }, 2, 10, TimeUnit.SECONDS)
        infraExecutor.scheduleWithFixedDelay({ safePing() }, 10, 60, TimeUnit.SECONDS)
        ioExecutor.scheduleWithFixedDelay({ safeFlushQueue() }, 8, 8, TimeUnit.SECONDS)
    }

    override fun onDestroy() {
        ioExecutor.shutdownNow()
        infraExecutor.shutdownNow()
        super.onDestroy()
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.d(tag, "listener connected")
        infraExecutor.execute { safeEnsureConfig() }
        ioExecutor.execute { safeFlushQueue() }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        val pkg = sbn.packageName ?: return
        if (!acceptedPackages.contains(pkg)) return

        val n = sbn.notification ?: return
        val extras = n.extras ?: return
        val title = (extras.getCharSequence(EXTRA_TITLE)?.toString() ?: "").trim()
        val text = (extras.getCharSequence(EXTRA_TEXT)?.toString() ?: "").trim()
        val merged = "$title $text".trim()
        if (merged.isBlank()) return
        if (!containsAny(merged, hints)) return

        val now = System.currentTimeMillis()
        val dedupeKey = buildDedupeKey(sbn, pkg, title, text)
        val last = dedupe[dedupeKey] ?: 0L
        if (now - last <= dedupeMs) return
        dedupe[dedupeKey] = now
        cleanupDedupe(now)

        val payload = NotifyPayload(
            packageName = pkg,
            channel = if (pkg == "com.tencent.mm") "wechat" else "alipay",
            title = title,
            content = text,
            amount = parseAmount(merged),
            clientMsgId = createClientMsgId(sbn, pkg, title, text),
            deviceId = store.getDeviceId(),
            deviceName = store.getDeviceName()
        )

        ioExecutor.execute {
            sendOrQueue(payload)
        }
    }

    private fun sendOrQueue(payload: NotifyPayload) {
        val apiUrl = store.getApiUrl()
        if (apiUrl.isBlank()) {
            enqueue(payload)
            Log.d(tag, "queued(no-config) msgId=${payload.clientMsgId}")
            requestEnsureConfig()
            return
        }

        if (postPayload(payload)) {
            return
        }
        enqueue(payload)
        Log.d(tag, "queued(send-fail) msgId=${payload.clientMsgId}")
        requestEnsureConfig()
    }

    private fun postPayload(payload: NotifyPayload): Boolean {
        val apiUrl = store.getApiUrl()
        if (apiUrl.isBlank()) return false
        return try {
            val ok = NotifyApi.postNotify(
                apiUrl = apiUrl,
                authToken = store.getAuthToken(),
                packageName = payload.packageName,
                channel = payload.channel,
                title = payload.title,
                content = payload.content,
                amount = payload.amount,
                clientMsgId = payload.clientMsgId,
                deviceId = payload.deviceId,
                deviceName = payload.deviceName
            )
            if (!ok) Log.d(tag, "notify fail msgId=${payload.clientMsgId}")
            ok
        } catch (e: Throwable) {
            Log.w(tag, "notify error: ${e.message}")
            false
        }
    }

    private fun enqueue(payload: NotifyPayload) {
        synchronized(queueLock) {
            val list = loadQueue()
            list.add(PendingItem(payload = payload, ts = System.currentTimeMillis(), retry = 0))
            val trimmed = if (list.size > maxQueue) list.takeLast(maxQueue) else list
            saveQueue(trimmed)
        }
    }

    private fun safeFlushQueue() {
        try {
            val apiUrl = store.getApiUrl()
            if (apiUrl.isBlank()) return
            synchronized(queueLock) {
                val q = loadQueue()
                if (q.isEmpty()) return
                val remain = mutableListOf<PendingItem>()
                var sent = 0
                var dropped = 0
                val now = System.currentTimeMillis()
                for (item in q) {
                    if (now - item.ts > maxPendingAgeMs || item.retry >= maxRetry) {
                        dropped++
                        continue
                    }
                    if (postPayload(item.payload)) {
                        sent++
                    } else {
                        val next = item.copy(retry = item.retry + 1)
                        if (next.retry >= maxRetry || now - next.ts > maxPendingAgeMs) {
                            dropped++
                        } else {
                            remain.add(next)
                        }
                    }
                }
                saveQueue(remain)
                if (sent > 0) {
                    Log.d(tag, "retry-sent=$sent dropped=$dropped remain=${remain.size}")
                }
                if (sent <= 0 && dropped > 0) {
                    Log.d(tag, "retry-dropped=$dropped remain=${remain.size}")
                }
            }
        } catch (e: Throwable) {
            Log.w(tag, "flush queue fail: ${e.message}")
        }
    }

    private fun safePing() {
        try {
            val apiUrl = store.getApiUrl()
            if (apiUrl.isBlank()) return
            NotifyApi.ping(
                baseApiUrl = apiUrl,
                authToken = store.getAuthToken(),
                deviceId = store.getDeviceId(),
                deviceName = store.getDeviceName()
            )
        } catch (e: Throwable) {
            Log.w(tag, "ping fail: ${e.message}")
        }
    }

    private fun requestEnsureConfig() {
        val now = System.currentTimeMillis()
        if (now - lastEnsureRequestAt < 5000) return
        lastEnsureRequestAt = now
        infraExecutor.execute { safeEnsureConfig() }
    }

    private fun safeEnsureConfig() {
        synchronized(ensureLock) {
            try {
                val apiUrl = store.getApiUrl()
                if (apiUrl.isNotBlank() && NotifyApi.isHealthOk(extractBaseFromApi(apiUrl) ?: "")) return

                val base = store.getBaseUrl().ifBlank { discoverBaseUrl().orEmpty() }
                if (base.isBlank()) return
                store.setBaseUrl(base)

                val claim = NotifyApi.autoClaim(base, store.getDeviceId(), store.getDeviceName()) ?: return
                store.setApiUrl(claim.apiUrl)
                store.setAuthToken(claim.authToken)
                Log.d(tag, "auto-claim ok => ${claim.apiUrl}")
            } catch (e: Throwable) {
                Log.w(tag, "ensure config fail: ${e.message}")
            }
        }
    }

    private fun discoverBaseUrl(): String? {
        val candidates = LinkedHashSet<String>()
        val cached = ConfigStore.normalizeBaseUrl(store.getBaseUrl())
        if (cached.isNotBlank()) candidates.add(cached)

        val localIps = findLocalIpv4s()
        for (ip in localIps) {
            val seg = ip.split(".")
            if (seg.size != 4) continue
            val prefix = "${seg[0]}.${seg[1]}.${seg[2]}."
            val last = seg[3].toIntOrNull() ?: 1
            val hosts = LinkedHashSet<Int>()
            hosts.add(last)
            for (d in 1..20) {
                hosts.add(last + d)
                hosts.add(last - d)
            }
            listOf(
                1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 80, 90,
                100, 101, 102, 103, 104, 105, 110, 120, 130, 140,
                150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250
            ).forEach { hosts.add(it) }

            for (h in hosts) {
                if (h !in 1..254) continue
                candidates.add("http://${prefix}${h}:3180")
                if (candidates.size >= maxDiscoveryCandidates) break
            }
            if (candidates.size >= maxDiscoveryCandidates) break
        }

        for (base in candidates) {
            if (NotifyApi.isHealthOk(base, timeoutMs = 450)) return base
        }
        return null
    }

    private fun findLocalIpv4s(): List<String> {
        return try {
            val list = mutableListOf<String>()
            val ifaces = Collections.list(NetworkInterface.getNetworkInterfaces())
            for (ni in ifaces) {
                if (!ni.isUp || ni.isLoopback) continue
                val addrs = Collections.list(ni.inetAddresses)
                for (addr in addrs) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress) {
                        val ip = addr.hostAddress ?: continue
                        if (isUsableLanIp(ip)) list.add(ip)
                    }
                }
            }
            list.distinct()
        } catch (_: Throwable) {
            emptyList()
        }
    }

    private fun isUsableLanIp(ip: String): Boolean {
        if (ip.startsWith("127.")) return false
        if (ip.startsWith("169.254.")) return false
        if (ip.startsWith("198.18.") || ip.startsWith("198.19.")) return false
        return ip.startsWith("10.") ||
            ip.startsWith("192.168.") ||
            ip.matches(Regex("^172\\.(1[6-9]|2[0-9]|3[0-1])\\..*"))
    }

    private fun extractBaseFromApi(apiUrl: String): String? {
        return try {
            val u = java.net.URL(apiUrl)
            val p = if (u.port > 0) u.port else u.defaultPort
            "${u.protocol}://${u.host}:$p"
        } catch (_: Throwable) {
            null
        }
    }

    private fun containsAny(text: String, words: List<String>): Boolean {
        for (w in words) {
            if (text.contains(w)) return true
        }
        return false
    }

    private fun parseAmount(text: String): Double? {
        val t = text
            .replace("\uFF0C", "")
            .replace(",", "")
            .replace("\u3002", ".")
            .replace("\uFFE5", "\u00A5")

        val regs = listOf(
            Regex("""(?:RMB|CNY|\u00A5|\$)\s*([0-9]+(?:\.[0-9]{1,2})?)""", RegexOption.IGNORE_CASE),
            Regex("""(?:\u6536\u6b3e|\u5230\u8d26|\u6210\u529f\u6536\u6b3e)\D{0,6}([0-9]+(?:\.[0-9]{1,2})?)"""),
            Regex("""([0-9]+(?:\.[0-9]{1,2})?)\s*(?:\u5143|\u5757)""")
        )
        for (r in regs) {
            val m = r.find(t) ?: continue
            val v = m.groupValues.getOrNull(1)?.toDoubleOrNull()
            if (v != null) return v
        }
        return null
    }

    private fun buildDedupeKey(sbn: StatusBarNotification, pkg: String, title: String, text: String): String {
        val unique = sbn.key?.takeIf { it.isNotBlank() } ?: "${sbn.id}|${sbn.postTime}"
        return "$pkg|$title|$text|$unique"
    }

    private fun createClientMsgId(
        sbn: StatusBarNotification,
        pkg: String,
        title: String,
        text: String
    ): String {
        val unique = sbn.key?.takeIf { it.isNotBlank() } ?: "$pkg|${sbn.id}|${sbn.postTime}|$title|$text"
        val sig = Integer.toHexString(unique.hashCode())
        val stamp = java.lang.Long.toString(sbn.postTime, 36)
        val idPart = sbn.id.toString()
        val device = store.getDeviceId().takeLast(8)
        return "msg-$device-$idPart-$stamp-$sig"
    }

    private fun cleanupDedupe(now: Long) {
        if (now - lastDedupeCleanupAt < 8000) return
        lastDedupeCleanupAt = now

        val it = dedupe.entries.iterator()
        while (it.hasNext()) {
            val e = it.next()
            if (now - e.value > dedupeTtlMs) it.remove()
        }

        if (dedupe.size <= maxDedupeKeys) return
        val sorted = dedupe.entries.sortedBy { it.value }
        val drop = dedupe.size - maxDedupeKeys
        for (i in 0 until drop) {
            dedupe.remove(sorted[i].key)
        }
    }

    private fun loadQueue(): MutableList<PendingItem> {
        val raw = store.getPendingQueueJson()
        if (raw.isBlank()) return mutableListOf()
        return try {
            val arr = JSONArray(raw)
            val list = mutableListOf<PendingItem>()
            for (i in 0 until arr.length()) {
                val item = arr.optJSONObject(i) ?: continue
                val payload = item.optJSONObject("payload") ?: continue
                val parsed = parsePendingItem(payload, item)
                if (parsed != null) list.add(parsed)
            }
            list
        } catch (_: Throwable) {
            mutableListOf()
        }
    }

    private fun saveQueue(list: List<PendingItem>) {
        val arr = JSONArray()
        for (item in list) {
            val payload = JSONObject()
                .put("packageName", item.payload.packageName)
                .put("channel", item.payload.channel)
                .put("title", item.payload.title)
                .put("content", item.payload.content)
                .put("amount", item.payload.amount)
                .put("clientMsgId", item.payload.clientMsgId)
                .put("deviceId", item.payload.deviceId)
                .put("deviceName", item.payload.deviceName)

            arr.put(
                JSONObject()
                    .put("payload", payload)
                    .put("ts", item.ts)
                    .put("retry", item.retry)
            )
        }
        store.setPendingQueueJson(arr.toString())
    }

    private fun parsePendingItem(payload: JSONObject, item: JSONObject): PendingItem? {
        val packageName = payload.optString("packageName", "")
        val channel = payload.optString("channel", "")
        val title = payload.optString("title", "")
        val content = payload.optString("content", "")
        val clientMsgId = payload.optString("clientMsgId", "")
        val deviceId = payload.optString("deviceId", "")
        val deviceName = payload.optString("deviceName", "")
        if (packageName.isBlank() || channel.isBlank() || clientMsgId.isBlank()) return null
        val amount = if (payload.has("amount")) payload.optDouble("amount").takeIf { !it.isNaN() } else null
        val p = NotifyPayload(
            packageName = packageName,
            channel = channel,
            title = title,
            content = content,
            amount = amount,
            clientMsgId = clientMsgId,
            deviceId = if (deviceId.isBlank()) store.getDeviceId() else deviceId,
            deviceName = if (deviceName.isBlank()) store.getDeviceName() else deviceName
        )
        return PendingItem(
            payload = p,
            ts = item.optLong("ts", System.currentTimeMillis()),
            retry = item.optInt("retry", 0)
        )
    }
}
