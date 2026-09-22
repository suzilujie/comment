package com.xfish.comment.agent.core

import android.os.SystemClock
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 时间工具（设计文档 §4.4 时钟一致性 + 项目约定）。
 *
 * 硬约定：
 *  1. **间隔计时一律用单调时钟 `elapsedRealtime()`**，绝不用墙上时钟
 *     （用户改时间 / 时区错乱不会让定时乱跳）；
 *  2. 需要「当前时刻」时用 `nowMs()`（已按后台 serverTime 校准）；
 *  3. 业务判定（自然日、时段）统一按 **UTC+8**；
 *  4. 禁止用格式化字符串比较时间，一律用毫秒数。
 */
object Time {

    private const val LOCAL_OFFSET_MS = 8 * 60 * 60 * 1000L
    private val tzLocal = TimeZone.getTimeZone("Asia/Shanghai")

    /** 上次对齐时钟时的服务端时间戳 */
    @Volatile
    private var offsetMs: Long = 0L

    /** 是否已与后台对齐过时钟 */
    @Volatile
    var synced: Boolean = false
        private set

    /**
     * 用后台返回的 serverTimeMs 校准本地时钟。
     * 不做平滑（本项目秒级精度即可），但记录 synced 与偏移量用于健康上报。
     */
    fun onServerTime(serverTimeMs: Long) {
        offsetMs = serverTimeMs - System.currentTimeMillis()
        synced = true
    }

    /** 当前时刻（毫秒），已按后台对齐 */
    fun nowMs(): Long = System.currentTimeMillis() + offsetMs

    /** 本机时钟偏移（秒）：正数表示本机快 */
    fun clockOffsetSec(): Int = (offsetMs / 1000).toInt()

    /** 单调时钟（毫秒），仅用于本地间隔计时 */
    fun elapsedMs(): Long = SystemClock.elapsedRealtime()

    /** UTC+8 自然日键：yyyy-MM-dd（用于「今日已完成」这类计数） */
    fun localDateKey(at: Long = nowMs()): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA).apply { timeZone = tzLocal }
        return fmt.format(Date(at))
    }

    /** UTC+8 当天第几分钟（0..1439），用于投放时段窗口判定 */
    fun localMinuteOfDay(at: Long = nowMs()): Int {
        val d = Date(at + LOCAL_OFFSET_MS)
        val fmt = SimpleDateFormat("HH:mm", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val parts = fmt.format(d).split(":")
        return (parts[0].toIntOrNull() ?: 0) * 60 + (parts[1].toIntOrNull() ?: 0)
    }

    /** UTC+8 展示文本：MM-dd HH:mm:ss */
    fun localText(at: Long = nowMs()): String {
        val fmt = SimpleDateFormat("MM-dd HH:mm:ss", Locale.CHINA).apply { timeZone = tzLocal }
        return fmt.format(Date(at))
    }

    /** 相对时间描述（用于面板） */
    fun humanAgo(then: Long?, now: Long = nowMs()): String {
        if (then == null) return "从未"
        val diff = now - then
        return when {
            diff < 0 -> "未来"
            diff < 60_000 -> "${diff / 1000} 秒前"
            diff < 3_600_000 -> "${diff / 60_000} 分钟前"
            diff < 86_400_000 -> "${diff / 3_600_000} 小时前"
            else -> "${diff / 86_400_000} 天前"
        }
    }
}
