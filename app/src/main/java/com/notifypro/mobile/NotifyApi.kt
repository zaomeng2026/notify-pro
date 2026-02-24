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

    fun ping(baseApiUrl: String, authToken: String, deviceId: String, deviceName: String) {
        val root = extractRoot(baseApiUrl) ?: return
        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("deviceName", deviceName)
            .put("platform", "android")
        val headers = mutableMapOf<String, String>()
        if (authToken.isNotBlank()) headers["X-Auth-Token"] = authToken
        request("POST", "$root/api/device/ping", body.toString(), headers, 3500)
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
