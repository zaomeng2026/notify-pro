package com.notifypro.mobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object MobileLogStore {
    private const val PREFS_NAME = "notify_pro_mobile_logs"
    private const val KEY_ITEMS = "items"
    private const val MAX_ITEMS = 300
    private const val MAX_MSG_LEN = 4000

    data class Item(
        val ts: Long,
        val level: String,
        val message: String
    )

    @Synchronized
    fun info(context: Context, message: String) = add(context, "I", message)

    @Synchronized
    fun warn(context: Context, message: String) = add(context, "W", message)

    @Synchronized
    fun error(context: Context, message: String) = add(context, "E", message)

    @Synchronized
    fun clear(context: Context) {
        prefs(context).edit().remove(KEY_ITEMS).apply()
    }

    fun maxItems(): Int = MAX_ITEMS

    @Synchronized
    fun render(context: Context, limit: Int = 200): String {
        val items = read(context, limit)
        if (items.isEmpty()) return "暂无日志"
        val sdf = SimpleDateFormat("MM-dd HH:mm:ss", Locale.getDefault())
        return buildString {
            for (item in items) {
                append(sdf.format(Date(item.ts)))
                append(" [")
                append(item.level)
                append("] ")
                append(item.message)
                append('\n')
            }
        }.trimEnd()
    }

    private fun add(context: Context, level: String, message: String) {
        val current = readAll(context).toMutableList()
        current.add(
            Item(
                ts = System.currentTimeMillis(),
                level = level,
                message = message.trim().take(MAX_MSG_LEN)
            )
        )
        val trimmed = if (current.size > MAX_ITEMS) current.takeLast(MAX_ITEMS) else current
        writeAll(context, trimmed)
    }

    private fun read(context: Context, limit: Int): List<Item> {
        val all = readAll(context)
        if (all.isEmpty()) return emptyList()
        val safeLimit = limit.coerceIn(1, MAX_ITEMS)
        return all.takeLast(safeLimit).asReversed()
    }

    private fun readAll(context: Context): List<Item> {
        val raw = prefs(context).getString(KEY_ITEMS, "").orEmpty().trim()
        if (raw.isBlank()) return emptyList()
        return try {
            val arr = JSONArray(raw)
            val out = ArrayList<Item>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                out.add(
                    Item(
                        ts = o.optLong("ts", 0L),
                        level = o.optString("level", "I"),
                        message = o.optString("message", "")
                    )
                )
            }
            out
        } catch (_: Throwable) {
            emptyList()
        }
    }

    private fun writeAll(context: Context, items: List<Item>) {
        val arr = JSONArray()
        for (item in items) {
            arr.put(
                JSONObject()
                    .put("ts", item.ts)
                    .put("level", item.level)
                    .put("message", item.message)
            )
        }
        prefs(context).edit().putString(KEY_ITEMS, arr.toString()).apply()
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
}
