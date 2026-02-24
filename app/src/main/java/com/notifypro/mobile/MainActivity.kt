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
            toast("已取消扫码")
            return@registerForActivityResult
        }
        val pair = parsePairUrl(content)
        if (pair == null) {
            toast("二维码无效")
            return@registerForActivityResult
        }
        approveAndClaim(pair.baseUrl, pair.token)
    }

    private val cameraPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) {
                toast("未授予相机权限")
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
                toast("请输入正确的服务器地址")
                return@setOnClickListener
            }
            val oldBase = store.getBaseUrl()
            val baseChanged = oldBase.isNotBlank() && oldBase != base
            store.setBaseUrl(base)
            if (baseChanged) {
                // Only clear claimed api/token when base host actually changed.
                store.clearRemoteConfig()
                MobileLogStore.warn(applicationContext, "base changed, cleared claimed api/token: $oldBase -> $base")
                toast("服务器地址已变更，请重新扫码绑定")
            } else {
                MobileLogStore.info(applicationContext, "base url saved (keep claim): $base")
                toast("已保存")
            }
            refreshUi()
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
                toast("请输入正确的服务器地址")
                return@setOnClickListener
            }
            openUrlSafely("$base/admin")
        }

        binding.btnLoadStats.setOnClickListener { loadStats() }
        binding.btnLoadSettings.setOnClickListener { loadSettings() }
        binding.btnSaveSettings.setOnClickListener { saveSettings() }
        binding.btnRefreshLogs.setOnClickListener { refreshLogs() }
        binding.btnClearLogs.setOnClickListener {
            MobileLogStore.clear(applicationContext)
            refreshLogs()
            toast("日志已清空")
        }

        refreshUi()
        testConnection()
        loadStats()
        loadSettings()
        refreshLogs()
    }

    override fun onResume() {
        super.onResume()
        refreshUi()
        refreshLogs()
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
            append("通知监听：")
            append(if (listenerEnabled) "已开启" else "未开启")
            append('\n')
            append("基础地址：")
            append(store.getBaseUrl().ifBlank { "-" })
            append('\n')
            append("接口地址：")
            append(apiUrl.ifBlank { "-" })
            append('\n')
            append("离线队列：")
            append(queueSize)
            append('\n')
            append("设备ID：")
            append(store.getDeviceId())
            append('\n')
            append("版本：$versionName")
            append('\n')
            append("安卓：${Build.VERSION.RELEASE}（API ${Build.VERSION.SDK_INT}）")
        }
    }

    private fun loadStats() {
        val base = resolveBaseUrlFromInput()
        if (base.isBlank()) {
            binding.tvStats.text = "未加载（缺少服务器地址）"
            return
        }
        io.execute {
            val snapshot = NotifyApi.getSnapshot(base)
            runOnUiThread {
                if (snapshot == null) {
                    binding.tvStats.text = "加载统计失败"
                    return@runOnUiThread
                }
                binding.tvStats.text = buildString {
                    append("今日笔数：${snapshot.todayCount}\n")
                    append("今日金额：${snapshot.todayAmount}\n")
                    append("总笔数：${snapshot.totalCount}\n")
                    append("总金额：${snapshot.totalAmount}")
                }
            }
        }
    }

    private fun testConnection() {
        val base = resolveBaseUrlFromInput()
        if (base.isBlank()) {
            binding.tvConnectionTest.text = "测试失败：缺少服务器地址"
            MobileLogStore.warn(applicationContext, "test connection failed: missing base URL")
            return
        }

        binding.tvConnectionTest.text = "测试中..."
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
                    append("健康检查：")
                    append(if (healthOk) "正常" else "失败")
                    append('\n')
                    append("当前API：")
                    append(if (apiUrl.isBlank()) "未绑定" else apiUrl)
                    append('\n')

                    append("连接状态接口：")
                    if (status == null) {
                        append("失败")
                    } else {
                        append(if (status.online) "在线" else "离线")
                        append(" | 设备数=")
                        append(status.deviceCount)
                        if (status.lastDeviceName.isNotBlank()) {
                            append(" | 最近设备=")
                            append(status.lastDeviceName)
                        }
                        if (status.lastIp.isNotBlank()) {
                            append(" | IP=")
                            append(status.lastIp)
                        }
                    }
                    append('\n')

                    append("Ping（带Token）：")
                    if (apiUrl.isBlank()) {
                        append("跳过（API地址为空）")
                    } else {
                        append(if (pingStatus != null) "成功" else "失败")
                        if (pingStatus != null) {
                            append(" | 在线=")
                            append(if (pingStatus.online) "是" else "否")
                        }
                    }
                }
                MobileLogStore.info(
                    applicationContext,
                    "test connection done: health=$healthOk statusApi=${status != null} ping=${pingStatus != null}"
                )
                refreshLogs()
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
                    MobileLogStore.warn(applicationContext, "load settings failed")
                    toast("加载设置失败")
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
            toast("请输入正确的服务器地址")
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
                    MobileLogStore.warn(applicationContext, "save settings failed")
                    toast("保存设置失败")
                    return@runOnUiThread
                }
                MobileLogStore.info(applicationContext, "settings saved")
                toast("设置已保存")
                loadStats()
                refreshLogs()
            }
        }
    }

    private fun startQrScan() {
        val options = ScanOptions()
        options.setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        options.setPrompt("请扫描后台页面的绑定二维码")
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
        toast("正在绑定，请稍候...")
        io.execute {
            val approved = NotifyApi.approvePairing(baseUrl, token)
            if (!approved) {
                MobileLogStore.warn(applicationContext, "pair approve failed")
                runOnUiThread { toast("绑定确认失败") }
                return@execute
            }

            val claim = NotifyApi.autoClaim(baseUrl, store.getDeviceId(), store.getDeviceName())
            if (claim == null) {
                MobileLogStore.warn(applicationContext, "pair auto-claim failed")
                runOnUiThread { toast("领取配置失败") }
                return@execute
            }

            store.setBaseUrl(baseUrl)
            store.setApiUrl(claim.apiUrl)
            store.setAuthToken(claim.authToken)

            runOnUiThread {
                binding.etBaseUrl.setText(baseUrl)
                MobileLogStore.info(applicationContext, "pair success: $baseUrl")
                refreshUi()
                toast("绑定成功")
                testConnection()
                loadStats()
                loadSettings()
                refreshLogs()
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
            toast("未找到可用浏览器")
        } catch (_: Throwable) {
            toast("打开失败")
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
            toast("无法打开系统设置")
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
        toast("无法打开电池后台设置")
    }

    private fun refreshLogs() {
        binding.tvLogs.text = MobileLogStore.render(applicationContext, 300)
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
}
