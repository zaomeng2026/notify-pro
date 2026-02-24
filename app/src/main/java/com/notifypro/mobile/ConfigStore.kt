package com.notifypro.mobile

import android.content.Context
import android.provider.Settings
import org.json.JSONArray
import java.util.UUID

class ConfigStore(context: Context) {
    private val prefs = context.getSharedPreferences("notify_pro_mobile", Context.MODE_PRIVATE)
    private val appContext = context.applicationContext

    fun getBaseUrl(): String = prefs.getString(KEY_BASE_URL, "")?.trim().orEmpty()

    fun setBaseUrl(url: String) {
        prefs.edit().putString(KEY_BASE_URL, normalizeBaseUrl(url)).apply()
    }

    fun getApiUrl(): String = prefs.getString(KEY_API_URL, "")?.trim().orEmpty()

    fun setApiUrl(url: String) {
        prefs.edit().putString(KEY_API_URL, url.trim()).apply()
    }

    fun getAuthToken(): String = prefs.getString(KEY_AUTH_TOKEN, "")?.trim().orEmpty()

    fun setAuthToken(token: String) {
        prefs.edit().putString(KEY_AUTH_TOKEN, token.trim()).apply()
    }

    fun getAdminPassword(): String = prefs.getString(KEY_ADMIN_PASSWORD, "")?.trim().orEmpty()

    fun setAdminPassword(password: String) {
        prefs.edit().putString(KEY_ADMIN_PASSWORD, password.trim()).apply()
    }

    fun clearRemoteConfig() {
        prefs.edit().remove(KEY_API_URL).remove(KEY_AUTH_TOKEN).apply()
    }

    fun getPendingQueueJson(): String = prefs.getString(KEY_PENDING_QUEUE_JSON, "")?.trim().orEmpty()

    fun setPendingQueueJson(value: String) {
        prefs.edit().putString(KEY_PENDING_QUEUE_JSON, value).commit()
    }

    fun getPendingQueueSize(): Int {
        val raw = getPendingQueueJson()
        if (raw.isBlank()) return 0
        return try {
            JSONArray(raw).length()
        } catch (_: Throwable) {
            0
        }
    }

    fun getDeviceId(): String {
        val cached = prefs.getString(KEY_DEVICE_ID, "")?.trim().orEmpty()
        if (cached.isNotEmpty()) return cached

        val androidId = try {
            Settings.Secure.getString(appContext.contentResolver, Settings.Secure.ANDROID_ID).orEmpty()
        } catch (_: Throwable) {
            ""
        }
        val id = if (androidId.isNotBlank()) androidId else UUID.randomUUID().toString().replace("-", "")
        prefs.edit().putString(KEY_DEVICE_ID, id).apply()
        return id
    }

    fun getDeviceName(): String = "phone-${android.os.Build.MODEL.orEmpty().ifBlank { "android" }}"

    companion object {
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_API_URL = "api_url"
        private const val KEY_AUTH_TOKEN = "auth_token"
        private const val KEY_ADMIN_PASSWORD = "admin_password"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_PENDING_QUEUE_JSON = "pending_queue_json"

        fun normalizeBaseUrl(input: String): String {
            var v = input.trim()
            if (v.isBlank()) return ""
            if (!v.startsWith("http://", true) && !v.startsWith("https://", true)) {
                v = "http://$v"
            }
            if (v.endsWith("/")) v = v.dropLast(1)
            return try {
                val u = java.net.URL(v)
                val host = u.host.orEmpty().trim().lowercase()
                if (
                    host.isBlank() ||
                    host == "+" ||
                    host == "0.0.0.0" ||
                    host == "::" ||
                    host == "[::]" ||
                    host.startsWith("198.18.") ||
                    host.startsWith("198.19.")
                ) {
                    ""
                } else {
                    val protocol = u.protocol.lowercase()
                    val hostPart = if (host.contains(":")) "[$host]" else host
                    val portPart = if (u.port > 0) ":${u.port}" else ""
                    "$protocol://$hostPart$portPart"
                }
            } catch (_: Throwable) {
                ""
            }
        }
    }
}
