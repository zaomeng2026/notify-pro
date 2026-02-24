package com.notifypro.mobile

import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object NotifyApi {
    private const val TAG = "NotifyApi"

    data class ClaimResult(
        val apiUrl: String,
        val authToken: String
    )

    data class FeatureConfig(
        val voiceBroadcastEnabled: Boolean,
        val showTotalAmount: Boolean,
        val showTodayAmount: Boolean
    )

    data class ShopSettings(
        val shopName: String,
        val notice: String,
        val qrCodeUrl: String,
        val contact: String,
        val feature: FeatureConfig
    )

    data class Snapshot(
        val totalCount: Int,
        val totalAmount: Double,
        val todayCount: Int,
        val todayAmount: Double
    )

    data class ConnectionStatus(
        val online: Boolean,
        val deviceCount: Int,
        val lastSeenText: String,
        val lastDeviceName: String,
        val lastIp: String
    )

    fun isHealthOk(url: String, timeoutMs: Int = 2500): Boolean {
        val base = ConfigStore.normalizeBaseUrl(url)
        if (base.isBlank()) return false
        return try {
            val (code, _) = request("GET", "$base/api/health", null, null, timeoutMs)
            code == 200
        } catch (_: Throwable) {
            false
        }
    }

    fun autoClaim(baseUrl: String, deviceId: String, deviceName: String): ClaimResult? {
        val base = ConfigStore.normalizeBaseUrl(baseUrl)
        if (base.isBlank()) return null

        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("deviceName", deviceName)
            .put("platform", "android")

        val (code, text) = request("POST", "$base/api/pairing/auto-claim", body.toString(), null, 5000)
        if (code != 200 || text.isBlank()) return null
        val json = JSONObject(text)
        if (!json.optBoolean("ok", false)) return null
        val config = json.optJSONObject("config") ?: return null
        val apiUrl = config.optString("apiUrl", "")
        if (apiUrl.isBlank()) return null
        return ClaimResult(
            apiUrl = apiUrl,
            authToken = config.optString("authToken", "")
        )
    }

    fun approvePairing(baseUrl: String, token: String): Boolean {
        val base = ConfigStore.normalizeBaseUrl(baseUrl)
        if (base.isBlank() || token.isBlank()) return false
        val body = JSONObject().put("token", token)
        return try {
            val (code, text) = request("POST", "$base/api/pairing/approve", body.toString(), null, 5000)
            if (code != 200 || text.isBlank()) return false
            JSONObject(text).optBoolean("ok", false)
        } catch (e: Throwable) {
            Log.w(TAG, "approvePairing fail: ${e.message}")
            false
        }
    }

    fun getSettings(baseUrl: String): ShopSettings? {
        val base = ConfigStore.normalizeBaseUrl(baseUrl)
        if (base.isBlank()) return null
        return try {
            val (code, text) = request("GET", "$base/api/settings", null, null, 5000)
            if (code != 200 || text.isBlank()) return null
            val json = JSONObject(text)
            if (!json.optBoolean("ok", false)) return null
            parseSettings(json.optJSONObject("settings"))
        } catch (e: Throwable) {
            Log.w(TAG, "getSettings fail: ${e.message}")
            null
        }
    }

    fun saveSettings(baseUrl: String, settings: ShopSettings): ShopSettings? {
        val base = ConfigStore.normalizeBaseUrl(baseUrl)
        if (base.isBlank()) return null
        val body = JSONObject()
            .put("shopName", settings.shopName)
            .put("notice", settings.notice)
            .put("qrCodeUrl", settings.qrCodeUrl)
            .put("contact", settings.contact)
            .put(
                "feature",
                JSONObject()
                    .put("voiceBroadcastEnabled", settings.feature.voiceBroadcastEnabled)
                    .put("showTotalAmount", settings.feature.showTotalAmount)
                    .put("showTodayAmount", settings.feature.showTodayAmount)
            )
        return try {
            val (code, text) = request("POST", "$base/api/settings", body.toString(), null, 5000)
            if (code != 200 || text.isBlank()) return null
            val json = JSONObject(text)
            if (!json.optBoolean("ok", false)) return null
            parseSettings(json.optJSONObject("settings"))
        } catch (e: Throwable) {
            Log.w(TAG, "saveSettings fail: ${e.message}")
            null
        }
    }

    fun getSnapshot(baseUrl: String, limit: Int = 200): Snapshot? {
        val base = ConfigStore.normalizeBaseUrl(baseUrl)
        if (base.isBlank()) return null
        val safeLimit = limit.coerceIn(1, 500)
        return try {
            val (code, text) = request("GET", "$base/api/records?limit=$safeLimit", null, null, 5000)
            if (code != 200 || text.isBlank()) return null
            val json = JSONObject(text)
            if (!json.optBoolean("ok", false)) return null
            val s = json.optJSONObject("snapshot") ?: return null
            Snapshot(
                totalCount = s.optInt("totalCount", 0),
                totalAmount = s.optDouble("totalAmount", 0.0),
                todayCount = s.optInt("todayCount", 0),
                todayAmount = s.optDouble("todayAmount", 0.0)
            )
        } catch (e: Throwable) {
            Log.w(TAG, "getSnapshot fail: ${e.message}")
            null
        }
    }

    fun postNotify(
        apiUrl: String,
        authToken: String,
        packageName: String,
        channel: String,
        title: String,
        content: String,
        amount: Double?,
        clientMsgId: String,
        deviceId: String,
        deviceName: String
    ): Boolean {
        val body = JSONObject()
            .put("title", title)
            .put("content", content)
            .put("package", packageName)
            .put("channel", channel)
            .put("amount", amount)
            .put("clientMsgId", clientMsgId)
            .put("time", formatNow())
            .put("device", deviceId)
            .put("deviceName", deviceName)
            .put("platform", "android")

        val headers = mutableMapOf<String, String>()
        if (authToken.isNotBlank()) headers["X-Auth-Token"] = authToken
        val (code, text) = request("POST", apiUrl, body.toString(), headers, 5000)
        if (code != 200 || text.isBlank()) return false

        return try {
            val json = JSONObject(text)
            json.optBoolean("ok", false) || json.optBoolean("queued", false) || json.optBoolean("duplicate", false)
        } catch (e: Throwable) {
            Log.w(TAG, "notify parse fail: ${e.message}")
            false
        }
    }

    fun ping(baseApiUrl: String, authToken: String, deviceId: String, deviceName: String): Boolean {
        val root = extractRoot(baseApiUrl) ?: return false
        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("deviceName", deviceName)
            .put("platform", "android")
        val headers = mutableMapOf<String, String>()
        if (authToken.isNotBlank()) headers["X-Auth-Token"] = authToken
        return try {
            val (code, text) = request("POST", "$root/api/device/ping", body.toString(), headers, 3500)
            if (code != 200 || text.isBlank()) return false
            JSONObject(text).optBoolean("ok", false)
        } catch (_: Throwable) {
            false
        }
    }

    fun getConnectionStatus(baseUrl: String): ConnectionStatus? {
        val base = ConfigStore.normalizeBaseUrl(baseUrl)
        if (base.isBlank()) return null
        return try {
            val (code, text) = request("GET", "$base/api/connection/status", null, null, 5000)
            if (code != 200 || text.isBlank()) return null
            val json = JSONObject(text)
            if (!json.optBoolean("ok", false)) return null
            parseConnectionStatus(json.optJSONObject("status"))
        } catch (e: Throwable) {
            Log.w(TAG, "getConnectionStatus fail: ${e.message}")
            null
        }
    }

    fun pingAndGetStatus(baseApiUrl: String, authToken: String, deviceId: String, deviceName: String): ConnectionStatus? {
        val root = extractRoot(baseApiUrl) ?: return null
        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("deviceName", deviceName)
            .put("platform", "android")
        val headers = mutableMapOf<String, String>()
        if (authToken.isNotBlank()) headers["X-Auth-Token"] = authToken
        return try {
            val (code, text) = request("POST", "$root/api/device/ping", body.toString(), headers, 5000)
            if (code != 200 || text.isBlank()) return null
            val json = JSONObject(text)
            if (!json.optBoolean("ok", false)) return null
            parseConnectionStatus(json.optJSONObject("status"))
        } catch (e: Throwable) {
            Log.w(TAG, "pingAndGetStatus fail: ${e.message}")
            null
        }
    }

    private fun extractRoot(apiUrl: String): String? {
        return try {
            val u = URL(apiUrl)
            val port = if (u.port > 0) u.port else u.defaultPort
            "${u.protocol}://${u.host}:${port}"
        } catch (_: Throwable) {
            null
        }
    }

    private fun parseSettings(json: JSONObject?): ShopSettings? {
        json ?: return null
        val f = json.optJSONObject("feature")
        return ShopSettings(
            shopName = json.optString("shopName", ""),
            notice = json.optString("notice", ""),
            qrCodeUrl = json.optString("qrCodeUrl", ""),
            contact = json.optString("contact", ""),
            feature = FeatureConfig(
                voiceBroadcastEnabled = f?.optBoolean("voiceBroadcastEnabled", false) ?: false,
                showTotalAmount = f?.optBoolean("showTotalAmount", true) ?: true,
                showTodayAmount = f?.optBoolean("showTodayAmount", true) ?: true
            )
        )
    }

    private fun parseConnectionStatus(json: JSONObject?): ConnectionStatus? {
        json ?: return null
        return ConnectionStatus(
            online = json.optBoolean("online", false),
            deviceCount = json.optInt("deviceCount", 0),
            lastSeenText = json.optString("lastSeenText", ""),
            lastDeviceName = json.optString("lastDeviceName", ""),
            lastIp = json.optString("lastIp", "")
        )
    }

    private fun request(
        method: String,
        url: String,
        body: String?,
        headers: Map<String, String>?,
        timeoutMs: Int
    ): Pair<Int, String> {
        val conn = (URL(url).openConnection() as HttpURLConnection)
        conn.requestMethod = method
        conn.connectTimeout = timeoutMs
        conn.readTimeout = timeoutMs
        conn.useCaches = false
        conn.doInput = true
        conn.setRequestProperty("Content-Type", "application/json")
        headers?.forEach { (k, v) -> conn.setRequestProperty(k, v) }

        if (!body.isNullOrBlank()) {
            conn.doOutput = true
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        }

        return try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.use { s ->
                BufferedReader(InputStreamReader(s, Charsets.UTF_8)).use { it.readText() }
            }.orEmpty()
            code to text
        } finally {
            conn.disconnect()
        }
    }

    private fun formatNow(): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault())
        return sdf.format(Date())
    }
}
