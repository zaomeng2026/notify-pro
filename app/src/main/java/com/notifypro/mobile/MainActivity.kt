package com.notifypro.mobile

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.notifypro.mobile.databinding.ActivityMainBinding

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var store: ConfigStore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        store = ConfigStore(applicationContext)

        binding.etBaseUrl.setText(store.getBaseUrl())
        refreshUi()

        binding.btnSave.setOnClickListener {
            val base = ConfigStore.normalizeBaseUrl(binding.etBaseUrl.text?.toString().orEmpty())
            if (base.isBlank()) {
                toast("请输入服务器地址")
                return@setOnClickListener
            }
            store.setBaseUrl(base)
            store.clearRemoteConfig()
            refreshUi()
            toast("已保存")
        }

        binding.btnOpenNotifyAccess.setOnClickListener {
            openIntentSafely(
                Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS),
                Intent(Settings.ACTION_SETTINGS)
            )
        }

        binding.btnOpenBattery.setOnClickListener {
            openIntentSafely(
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
                Intent(Settings.ACTION_SETTINGS)
            )
        }

        binding.btnOpenAdmin.setOnClickListener {
            val base = ConfigStore.normalizeBaseUrl(binding.etBaseUrl.text?.toString().orEmpty())
            if (base.isBlank()) {
                toast("请先填写服务器地址")
                return@setOnClickListener
            }
            openUrlSafely("$base/admin")
        }
    }

    override fun onResume() {
        super.onResume()
        refreshUi()
    }

    private fun refreshUi() {
        val listenerEnabled = isNotificationListenerEnabled()
        val apiUrl = store.getApiUrl()
        val queueSize = store.getPendingQueueSize()
        binding.tvStatus.text = buildString {
            append("监听权限: ")
            append(if (listenerEnabled) "已开启" else "未开启")
            append('\n')
            append("基础地址: ")
            append(store.getBaseUrl().ifBlank { "-" })
            append('\n')
            append("API地址: ")
            append(apiUrl.ifBlank { "-" })
            append('\n')
            append("离线队列: ")
            append(queueSize)
            append('\n')
            append("设备ID: ")
            append(store.getDeviceId())
            append('\n')
            append("版本: ${BuildConfig.VERSION_NAME}")
            append('\n')
            append("安卓: ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        }
    }

    private fun isNotificationListenerEnabled(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        val cn = ComponentName(this, NotifyListenerService::class.java).flattenToString()
        return enabled.split(':').any { it == cn }
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    private fun openUrlSafely(url: String) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            startActivity(intent)
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
        } catch (_: ActivityNotFoundException) {
            // fallback below
        } catch (_: Throwable) {
            // fallback below
        }

        try {
            startActivity(fallback)
        } catch (_: Throwable) {
            toast("无法打开系统设置")
        }
    }
}
