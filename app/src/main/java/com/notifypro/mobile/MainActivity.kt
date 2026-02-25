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
        MobileLogStore.info(applicationContext, "扫码结果：base=${pair.baseUrl} tokenLen=${pair.token.length}")
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
        binding.etAdminPassword.setText(store.getAdminPassword())
        if (binding.etBackupKeep.text.isNullOrBlank()) binding.etBackupKeep.setText("30")
        if (binding.etAutoDailyBackupHour.text.isNullOrBlank()) binding.etAutoDailyBackupHour.setText("4")

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
                MobileLogStore.warn(applicationContext, "基础地址变更，已清空已领取配置: $oldBase -> $base")
                toast("服务器地址已变更，请重新扫码绑定")
            } else {
                MobileLogStore.info(applicationContext, "基础地址已保存（保留已领取配置）: $base")
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

        binding.btnOpenLogs.setOnClickListener {
            startActivity(Intent(this, LogActivity::class.java))
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
            append("后台密码：")
            append(if (store.getAdminPassword().isBlank()) "未设置" else "已设置")
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
            MobileLogStore.warn(applicationContext, "连接测试失败：缺少服务器地址")
            return
        }

        binding.btnTestConnection.isEnabled = false
        binding.btnTestConnection.text = "测试中..."
        binding.tvConnectionTest.text = "测试中..."
        io.execute {
            val health = NotifyApi.healthDebug(base, 2500)
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
                binding.btnTestConnection.isEnabled = true
                binding.btnTestConnection.text = getString(R.string.btn_test_connection)
                binding.tvConnectionTest.text = buildString {
                    append("健康检查：")
                    append(if (health.ok) "正常" else "失败")
                    append(" (code=")
                    append(health.code)
                    append(')')
                    append('\n')
                    if (health.revision.isNotBlank()) {
                        append("服务端版本：")
                        append(health.revision)
                        append('\n')
                    }

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
                    "连接测试: base=$base healthOk=${health.ok} healthCode=${health.code} rev=${health.revision.ifBlank { "-" }} statusApi=${status != null} api=${if (apiUrl.isBlank()) "-" else apiUrl} ping=${pingStatus != null}"
                )
                if (!health.ok && health.bodySnippet.isNotBlank()) {
                    MobileLogStore.warn(applicationContext, "健康检查返回: ${health.bodySnippet}")
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
                    MobileLogStore.warn(applicationContext, "加载设置失败")
                    toast("加载设置失败")
                    return@runOnUiThread
                }
                binding.etShopName.setText(settings.shopName)
                binding.etNotice.setText(settings.notice)
                binding.etWechatQrCodeUrl.setText(settings.wechatQrCodeUrl)
                binding.etAlipayQrCodeUrl.setText(settings.alipayQrCodeUrl)
                binding.etContact.setText(settings.contact)
                binding.etBackupKeep.setText(settings.backupKeep.toString())
                binding.etAutoDailyBackupHour.setText(settings.autoDailyBackupHour.toString())
                binding.swVoiceBroadcast.isChecked = settings.feature.voiceBroadcastEnabled
                binding.swShowBrand.isChecked = settings.feature.showBrand
                binding.swShowNotice.isChecked = settings.feature.showNotice
                binding.swShowContact.isChecked = settings.feature.showContact
                binding.swShowTotalCount.isChecked = settings.feature.showTotalCount
                binding.swShowTotalAmount.isChecked = settings.feature.showTotalAmount
                binding.swShowTodayCount.isChecked = settings.feature.showTodayCount
                binding.swShowTodayAmount.isChecked = settings.feature.showTodayAmount
                binding.swShowPaymentQrcodes.isChecked = settings.feature.showPaymentQrcodes
                binding.swShowWechatQrcode.isChecked = settings.feature.showWechatQrcode
                binding.swShowAlipayQrcode.isChecked = settings.feature.showAlipayQrcode
                binding.swShowRecordsTable.isChecked = settings.feature.showRecordsTable
                binding.swShowFooterActions.isChecked = settings.feature.showFooterActions
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
            wechatQrCodeUrl = binding.etWechatQrCodeUrl.text?.toString().orEmpty().trim(),
            alipayQrCodeUrl = binding.etAlipayQrCodeUrl.text?.toString().orEmpty().trim(),
            contact = binding.etContact.text?.toString().orEmpty().trim(),
            backupKeep = (binding.etBackupKeep.text?.toString().orEmpty().trim().toIntOrNull() ?: 30).coerceIn(3, 365),
            autoDailyBackupHour = (binding.etAutoDailyBackupHour.text?.toString().orEmpty().trim().toIntOrNull() ?: 4).coerceIn(0, 23),
            feature = NotifyApi.FeatureConfig(
                voiceBroadcastEnabled = binding.swVoiceBroadcast.isChecked,
                showBrand = binding.swShowBrand.isChecked,
                showNotice = binding.swShowNotice.isChecked,
                showContact = binding.swShowContact.isChecked,
                showTotalCount = binding.swShowTotalCount.isChecked,
                showTotalAmount = binding.swShowTotalAmount.isChecked,
                showTodayCount = binding.swShowTodayCount.isChecked,
                showTodayAmount = binding.swShowTodayAmount.isChecked,
                showPaymentQrcodes = binding.swShowPaymentQrcodes.isChecked,
                showWechatQrcode = binding.swShowWechatQrcode.isChecked,
                showAlipayQrcode = binding.swShowAlipayQrcode.isChecked,
                showRecordsTable = binding.swShowRecordsTable.isChecked,
                showFooterActions = binding.swShowFooterActions.isChecked
            )
        )
        val inputPwd = binding.etAdminPassword.text?.toString().orEmpty().trim()
        val adminPassword = if (inputPwd.isNotBlank()) inputPwd else store.getAdminPassword()
        if (adminPassword.isNotBlank()) {
            store.setAdminPassword(adminPassword)
        }

        binding.btnSaveSettings.isEnabled = false
        binding.btnSaveSettings.text = "保存中..."
        io.execute {
            val saved = NotifyApi.saveSettings(base, payload, adminPassword)
            runOnUiThread {
                binding.btnSaveSettings.isEnabled = true
                binding.btnSaveSettings.text = getString(R.string.btn_save_settings)
                if (saved == null) {
                    MobileLogStore.warn(applicationContext, "保存设置失败")
                    toast("保存设置失败")
                    return@runOnUiThread
                }
                MobileLogStore.info(applicationContext, "设置已保存")
                toast("设置已保存")
                loadStats()
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
            val traceTag = "绑定追踪[v2]"
            fun trace(msg: String) = MobileLogStore.info(applicationContext, "$traceTag $msg")
            fun traceWarn(msg: String) = MobileLogStore.warn(applicationContext, "$traceTag $msg")

            try {
                val oldBase = store.getBaseUrl()
                val oldApi = store.getApiUrl()
                val baseChanged = oldBase.isNotBlank() && oldBase != baseUrl

                trace("start base=$baseUrl tokenLen=${token.length} oldBase=$oldBase oldApi=${if (oldApi.isBlank()) "-" else oldApi}")

                store.setBaseUrl(baseUrl)
                if (baseChanged || oldApi.isNotBlank()) {
                    store.clearRemoteConfig()
                    MobileLogStore.info(applicationContext, "开始扫码绑定，已清空旧接口配置: $oldBase -> $baseUrl")
                }

                runOnUiThread {
                    binding.etBaseUrl.setText(baseUrl)
                    refreshUi()
                }

                trace("skip approve step, try direct claim first")

                fun tryClaim(step: String, tokenArg: String): NotifyApi.ClaimResult? {
                    trace("call $step tokenLen=${tokenArg.length}")
                    val r = NotifyApi.autoClaimDebug(baseUrl, store.getDeviceId(), store.getDeviceName(), tokenArg)
                    trace("$step code=${r.code} ok=${r.claim != null} msg=${r.message}")
                    if (r.bodySnippet.isNotBlank()) {
                        trace("$step body=${r.bodySnippet}")
                    }
                    return r.claim
                }

                var claim = tryClaim("claim(token)", token)
                if (claim == null) claim = tryClaim("claim(no-token)", "")
                if (claim == null) {
                    for (i in 0 until 5) {
                        Thread.sleep(600)
                        claim = tryClaim("retry#${i + 1}(token)", token)
                        if (claim == null) claim = tryClaim("retry#${i + 1}(no-token)", "")
                        if (claim != null) break
                    }
                }

                if (claim == null) {
                    val approve = NotifyApi.approvePairingDebug(baseUrl, token)
                    trace("fallback approve code=${approve.code} ok=${approve.ok} msg=${approve.message}")
                    if (approve.bodySnippet.isNotBlank()) {
                        trace("fallback approve body=${approve.bodySnippet}")
                    }
                    if (!approve.ok) {
                        MobileLogStore.warn(applicationContext, "绑定确认失败，尝试直接领取配置 token=${token.take(8)}")
                    }
                    claim = tryClaim("after-approve claim(token)", token)
                }

                if (claim == null) {
                    val inferredBase = ConfigStore.normalizeBaseUrl(baseUrl)
                    val inferredApi = if (inferredBase.isBlank()) "" else "$inferredBase/api/notify"
                    if (inferredApi.isNotBlank()) {
                        val status = NotifyApi.pingAndGetStatus(
                            baseApiUrl = inferredApi,
                            authToken = "",
                            deviceId = store.getDeviceId(),
                            deviceName = store.getDeviceName()
                        )
                        trace("inferredApi=$inferredApi pingOk=${status != null}")
                        if (status != null) {
                            store.setBaseUrl(baseUrl)
                            store.setApiUrl(inferredApi)
                            store.setAuthToken("")
                            MobileLogStore.warn(applicationContext, "领取配置失败，已回退为基础地址推导接口: $inferredApi")
                            runOnUiThread {
                                binding.etBaseUrl.setText(baseUrl)
                                refreshUi()
                                toast("绑定已完成（推导接口模式）")
                                testConnection()
                                loadStats()
                            }
                            return@execute
                        }
                    }

                    store.setBaseUrl(baseUrl)
                    store.clearRemoteConfig()
                    traceWarn("claim failed finally, keep base and clear api/token")
                    MobileLogStore.warn(applicationContext, "领取配置失败，已保留最新基础地址: $baseUrl")
                    runOnUiThread {
                        binding.etBaseUrl.setText(baseUrl)
                        refreshUi()
                        toast("领取配置失败，请刷新二维码后重试")
                    }
                    return@execute
                }

                store.setBaseUrl(baseUrl)
                store.setApiUrl(claim.apiUrl)
                store.setAuthToken(claim.authToken)
                trace("success api=${claim.apiUrl} authToken=${if (claim.authToken.isBlank()) "-" else "***"}")

                runOnUiThread {
                    binding.etBaseUrl.setText(baseUrl)
                    MobileLogStore.info(applicationContext, "绑定成功: $baseUrl")
                    refreshUi()
                    toast("绑定成功")
                    testConnection()
                    loadStats()
                    loadSettings()
                }
            } catch (e: Throwable) {
                store.setBaseUrl(baseUrl)
                store.clearRemoteConfig()
                traceWarn("exception=${e.message}")
                MobileLogStore.warn(applicationContext, "绑定异常: ${e.message}")
                runOnUiThread {
                    binding.etBaseUrl.setText(baseUrl)
                    refreshUi()
                    toast("绑定异常，请查看日志")
                }
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
        val brand = Build.MANUFACTURER.lowercase()
        val candidates = mutableListOf<Intent>()

        if (brand.contains("vivo") || brand.contains("iqoo")) {
            candidates.add(Intent().setComponent(ComponentName("com.vivo.abe", "com.vivo.applicationbehaviorengine.ui.ExcessivePowerManagerActivity")))
            candidates.add(Intent().setComponent(ComponentName("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")))
            candidates.add(Intent().setComponent(ComponentName("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager")))
            candidates.add(Intent().setComponent(ComponentName("com.iqoo.secure", "com.iqoo.secure.MainActivity")))
        }

        candidates.addAll(listOf(
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
        ))

        for (intent in candidates) {
            try {
                if (intent.resolveActivity(packageManager) != null) {
                    startActivity(intent)
                    MobileLogStore.info(
                        applicationContext,
                        "已打开电池/后台设置: action=${intent.action ?: "-"} component=${intent.component?.flattenToShortString() ?: "-"}"
                    )
                    return
                }
            } catch (_: Throwable) {
                // try next
            }
        }
        MobileLogStore.warn(applicationContext, "电池后台设置跳转失败，品牌=$brand")
        toast("无法打开电池后台设置")
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
}
