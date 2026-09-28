package com.xfish.comment.agent.core

import android.content.Context
import android.util.Log as ALog
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 轻量日志：控制台 + 按天滚动文件 + 内存环形缓冲（供主界面展示）。
 * 约定：时间戳按本地时区（UTC+8）输出，与后台口径一致。
 */
object Log {

    private const val MAX_LINES_IN_MEMORY = 300
    private const val KEEP_FILES_DAYS = 3

    private var logDir: File? = null

    /**
     * 内存环形缓冲：最近若干条日志，供 UI 快速读取。
     * 用 [ArrayDeque] + 锁（而非 CopyOnWriteArrayList）—— 后者每次 `removeAt(0)` 都要
     * 整表复制，在「每写一条就可能删一条」的高频写入下是 O(n) 的无谓开销。
     */
    private val recent = ArrayDeque<String>()
    private val recentLock = Any()

    /**
     * ⚠ [SimpleDateFormat] **不是线程安全的**，而 [write] 会被心跳 / 切城 / 任务执行
     * 多个协程并发调用 —— 共享实例会导致时间戳错乱，极端情况抛 NumberFormatException。
     * 用 ThreadLocal 保证每线程一份实例。
     */
    private val dayFmt = ThreadLocal.withInitial { SimpleDateFormat("yyyy-MM-dd", Locale.CHINA) }
    private val tsFmt = ThreadLocal.withInitial { SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.CHINA) }

    fun init(context: Context) {
        val dir = File(context.filesDir, "logs")
        if (!dir.exists()) dir.mkdirs()
        logDir = dir
        pruneOldFiles(dir)
    }

    fun d(tag: String, msg: String) = write("D", tag, msg, null)
    fun i(tag: String, msg: String) = write("I", tag, msg, null)
    fun w(tag: String, msg: String) = write("W", tag, msg, null)
    fun e(tag: String, msg: String, t: Throwable? = null) = write("E", tag, msg, t)

    private fun write(level: String, tag: String, msg: String, t: Throwable?) {
        val line = "[${tsFmt.get().format(Date())}] $level/$tag: $msg" +
            (t?.let { " | ${it.javaClass.simpleName}: ${it.message}" } ?: "")

        when (level) {
            "E" -> ALog.e(tag, msg, t)
            "W" -> ALog.w(tag, msg)
            "D" -> ALog.d(tag, msg)
            else -> ALog.i(tag, msg)
        }

        synchronized(recentLock) {
            recent.addLast(line)
            while (recent.size > MAX_LINES_IN_MEMORY) recent.removeFirst()
        }

        val dir = logDir ?: return
        try {
            val f = File(dir, "agent-${dayFmt.get().format(Date())}.log")
            f.appendText(line + "\n")
        } catch (_: Throwable) {
            // 落盘失败不影响主流程
        }
    }

    /** 供主界面展示的最近日志（最新在末尾） */
    fun tail(n: Int = 80): List<String> = synchronized(recentLock) { recent.takeLast(n) }

    /** 只保留最近若干天的日志文件，避免占满存储 */
    private fun pruneOldFiles(dir: File) {
        val files = dir.listFiles()?.sortedByDescending { it.name } ?: return
        files.drop(KEEP_FILES_DAYS).forEach { runCatching { it.delete() } }
    }
}
