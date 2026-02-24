package com.notifypro.mobile

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.notifypro.mobile.databinding.ActivityMainBinding
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var store: ConfigStore
    private val io = Executors.newSingleThreadExecutor()

    private val scanLauncher = registerForActivityResult(ScanContract()) { result ->
        val content = result.contents?.trim().orEmpty()
        if (content.isBlank()) {
            toast("Scan canceled")
            return@registerForActivityResult
        }
        val pair = parsePairUrl(content)
        if (pair == null) {
            toast("Invalid pair QR")
            return@registerForActivityResult
        }
        approveAndClaim(pair.baseUrl, pair.token)
    }

    private val cameraPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) {
                toast("Camera permission denied")
                return@registerForActivityResult
            }
            startQrScan()
        }

    private data class PairData(val baseUrl: String, val token: String)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        store = ConfigStore(applicationContext)

        binding.etBaseUrl.setText(store.getBaseUrl())

        binding.btnSave.setOnClickListener {
            val base = resolveBaseUrlFromInput()
            if (base.isBlank()) {
                toast("Please input valid server URL")
                return@setOnClickListener
            }
            store.setBaseUrl(base)
            store.clearRemoteConfig()
            refreshUi()
            toast("Saved")
        }

        binding.btnScanPair.setOnClickListener {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                startQrScan()
            } else {
                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            }
        }

        binding.btnTestConnection.setOnClickListener { testConnection() }

        binding.btnOpenNotifyAccess.setOnClickListener {
            openIntentSafely(
                Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS),
                Intent(Settings.ACTION_SETTINGS)
            )
        }

        binding.btnOpenBattery.setOnClickListener {
            openBatterySettings()
        }

        binding.btnOpenAdmin.setOnClickListener {
            val base = resolveBaseUrlFromInput()
            if (base.isBlank()) {
                toast("Please input valid server URL")
                return@setOnClickListener
            }
            openUrlSafely("$base/admin")
        }

        binding.btnLoadStats.setOnClickListener { loadStats() }
        binding.btnLoadSettings.setOnClickListener { loadSettings() }
        binding.btnSaveSettings.setOnClickListener { saveSettings() }

        refreshUi()
        testConnection()
        loadStats()
        loadSettings()
    }

    override fun onResume() {
        super.onResume()
        refreshUi()
    }

    override fun onDestroy() {
        io.shutdownNow()
        super.onDestroy()
    }

    private fun refreshUi() {
        val listenerEnabled = isNotificationListenerEnabled()
        val apiUrl = store.getApiUrl()
        val queueSize = store.getPendingQueueSize()
        val versionName = getAppVersionName()
        binding.tvStatus.text = buildString {
            append("Notify listener: ")
            append(if (listenerEnabled) "enabled" else "disabled")
            append('\n')
            append("Base URL: ")
            append(store.getBaseUrl().ifBlank { "-" })
            append('\n')
            append("API URL: ")
            append(apiUrl.ifBlank { "-" })
            append('\n')
            append("Offline queue: ")
            append(queueSize)
            append('\n')
            append("Device ID: ")
            append(store.getDeviceId())
            append('\n')
            append("Version: $versionName")
            append('\n')
            append("Android: ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        }
    }

    private fun loadStats() {
        val base = resolveBaseUrlFromInput()
        if (base.isBlank()) {
            binding.tvStats.text = "Not loaded (missing base URL)"
            return
        }
        io.execute {
            val snapshot = NotifyApi.getSnapshot(base)
            runOnUiThread {
                if (snapshot == null) {
                    binding.tvStats.text = "Load stats failed"
                    return@runOnUiThread
                }
                binding.tvStats.text = buildString {
                    append("Today count: ${snapshot.todayCount}\n")
                    append("Today amount: ${snapshot.todayAmount}\n")
                    append("Total count: ${snapshot.totalCount}\n")
                    append("Total amount: ${snapshot.totalAmount}")
                }
            }
        }
    }

    private fun testConnection() {
        val base = resolveBaseUrlFromInput()
        if (base.isBlank()) {
            binding.tvConnectionTest.text = "Test failed: missing base URL"
            return
        }

        binding.tvConnectionTest.text = "Testing..."
        io.execute {
            val healthOk = NotifyApi.isHealthOk(base, 2500)
            val status = NotifyApi.getConnectionStatus(base)

            val apiUrl = store.getApiUrl()
            val pingStatus = if (apiUrl.isNotBlank()) {
                NotifyApi.pingAndGetStatus(
                    baseApiUrl = apiUrl,
                    authToken = store.getAuthToken(),
                    deviceId = store.getDeviceId(),
                    deviceName = store.getDeviceName()
                )
            } else {
                null
            }

            runOnUiThread {
                binding.tvConnectionTest.text = buildString {
                    append("Health: ")
                    append(if (healthOk) "OK" else "FAIL")
                    append('\n')

                    append("Status API: ")
                    if (status == null) {
                        append("FAIL")
                    } else {
                        append(if (status.online) "ONLINE" else "OFFLINE")
                        append(" | devices=")
                        append(status.deviceCount)
                        if (status.lastDeviceName.isNotBlank()) {
                            append(" | last=")
                            append(status.lastDeviceName)
                        }
                        if (status.lastIp.isNotBlank()) {
                            append(" | ip=")
                            append(status.lastIp)
                        }
                    }
                    append('\n')

                    append("Ping(API token): ")
                    if (apiUrl.isBlank()) {
                        append("SKIP (apiUrl empty)")
                    } else {
                        append(if (pingStatus != null) "OK" else "FAIL")
                        if (pingStatus != null) {
                            append(" | online=")
                            append(if (pingStatus.online) "yes" else "no")
                        }
                    }
                }
            }
        }
    }

    private fun loadSettings() {
        val base = resolveBaseUrlFromInput()
        if (base.isBlank()) return
        io.execute {
            val settings = NotifyApi.getSettings(base)
            runOnUiThread {
                if (settings == null) {
                    toast("Load settings failed")
                    return@runOnUiThread
                }
                binding.etShopName.setText(settings.shopName)
                binding.etNotice.setText(settings.notice)
                binding.etQrCodeUrl.setText(settings.qrCodeUrl)
                binding.etContact.setText(settings.contact)
                binding.swVoiceBroadcast.isChecked = settings.feature.voiceBroadcastEnabled
                binding.swShowTotal.isChecked = settings.feature.showTotalAmount
                binding.swShowToday.isChecked = settings.feature.showTodayAmount
            }
        }
    }

    private fun saveSettings() {
        val base = resolveBaseUrlFromInput()
        if (base.isBlank()) {
            toast("Please input valid server URL")
            return
        }
        val payload = NotifyApi.ShopSettings(
            shopName = binding.etShopName.text?.toString().orEmpty().trim(),
            notice = binding.etNotice.text?.toString().orEmpty().trim(),
            qrCodeUrl = binding.etQrCodeUrl.text?.toString().orEmpty().trim(),
            contact = binding.etContact.text?.toString().orEmpty().trim(),
            feature = NotifyApi.FeatureConfig(
                voiceBroadcastEnabled = binding.swVoiceBroadcast.isChecked,
                showTotalAmount = binding.swShowTotal.isChecked,
                showTodayAmount = binding.swShowToday.isChecked
            )
        )

        io.execute {
            val saved = NotifyApi.saveSettings(base, payload)
            runOnUiThread {
                if (saved == null) {
                    toast("Save settings failed")
                    return@runOnUiThread
                }
                toast("Settings saved")
                loadStats()
            }
        }
    }

    private fun startQrScan() {
        val options = ScanOptions()
        options.setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        options.setPrompt("Scan pair QR from admin page")
        options.setBeepEnabled(true)
        options.setOrientationLocked(false)
        scanLauncher.launch(options)
    }

    private fun parsePairUrl(raw: String): PairData? {
        return try {
            val uri = Uri.parse(raw.trim())
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            val host = uri.host ?: return null
            val base = ConfigStore.normalizeBaseUrl(
                if (uri.port > 0) "$scheme://$host:${uri.port}" else "$scheme://$host"
            )
            if (base.isBlank()) return null
            val segments = uri.pathSegments ?: emptyList()
            if (segments.isEmpty()) return null

            var token = ""
            for (i in 0 until (segments.size - 1)) {
                if (segments[i] == "pair") {
                    token = segments[i + 1]
                    break
                }
            }
            if (token.isBlank()) token = segments.lastOrNull().orEmpty()
            token = token.trim()
            if (token.isBlank()) return null

            PairData(base, token)
        } catch (_: Throwable) {
            null
        }
    }

    private fun approveAndClaim(baseUrl: String, token: String) {
        toast("Pairing in progress...")
        io.execute {
            val approved = NotifyApi.approvePairing(baseUrl, token)
            if (!approved) {
                runOnUiThread { toast("Approve failed") }
                return@execute
            }

            val claim = NotifyApi.autoClaim(baseUrl, store.getDeviceId(), store.getDeviceName())
            if (claim == null) {
                runOnUiThread { toast("Claim failed") }
                return@execute
            }

            store.setBaseUrl(baseUrl)
            store.setApiUrl(claim.apiUrl)
            store.setAuthToken(claim.authToken)

            runOnUiThread {
                binding.etBaseUrl.setText(baseUrl)
                refreshUi()
                toast("Pair success")
                testConnection()
                loadStats()
                loadSettings()
            }
        }
    }

    private fun resolveBaseUrlFromInput(): String {
        val input = binding.etBaseUrl.text?.toString().orEmpty()
        val base = ConfigStore.normalizeBaseUrl(if (input.isBlank()) store.getBaseUrl() else input)
        if (base.isNotBlank()) store.setBaseUrl(base)
        return base
    }

    private fun isNotificationListenerEnabled(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        val cn = ComponentName(this, NotifyListenerService::class.java).flattenToString()
        return enabled.split(':').any { it == cn }
    }

    private fun getAppVersionName(): String {
        return try {
            val info = packageManager.getPackageInfo(packageName, 0)
            info.versionName ?: "-"
        } catch (_: Throwable) {
            "-"
        }
    }

    private fun openUrlSafely(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: ActivityNotFoundException) {
            toast("No browser found")
        } catch (_: Throwable) {
            toast("Open failed")
        }
    }

    private fun openIntentSafely(primary: Intent, fallback: Intent) {
        try {
            startActivity(primary)
            return
        } catch (_: Throwable) {
            // fallback below
        }
        try {
            startActivity(fallback)
        } catch (_: Throwable) {
            toast("Cannot open settings")
        }
    }

    private fun openBatterySettings() {
        val packageUri = Uri.parse("package:$packageName")
        val candidates = listOf(
            Intent("android.settings.APP_BATTERY_SETTINGS").apply {
                putExtra("package_name", packageName)
                data = packageUri
            },
            Intent("android.settings.APP_BATTERY_SAVER_SETTINGS").apply {
                putExtra("package_name", packageName)
                data = packageUri
            },
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = packageUri
            },
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri),
            Intent(Settings.ACTION_SETTINGS)
        )

        for (intent in candidates) {
            try {
                if (intent.resolveActivity(packageManager) != null) {
                    startActivity(intent)
                    return
                }
            } catch (_: Throwable) {
                // try next
            }
        }
        toast("Cannot open battery settings")
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
}
