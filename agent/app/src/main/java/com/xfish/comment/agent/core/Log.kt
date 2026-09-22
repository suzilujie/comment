package com.xfish.comment.agent.core

import android.content.Context
import android.util.Log as ALog
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList

/**
 * 轻量日志：控制台 + 按天滚动文件 + 内存环形缓冲（供主界面展示）。
 * 约定：时间戳按本地时区（UTC+8）输出，与后台口径一致。
 */
object Log {

    private const val MAX_LINES_IN_MEMORY = 300
    private const val KEEP_FILES_DAYS = 3

    private var logDir: File? = null

    /** 内存环形缓冲：最近若干条日志，供 UI 快速读取 */
    private val recent = CopyOnWriteArrayList<String>()

    private val dayFmt = SimpleDateFormat("yyyy-MM-dd", Locale.CHINA)
    private val tsFmt = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.CHINA)

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
        val line = "[${tsFmt.format(Date())}] $level/$tag: $msg" +
            (t?.let { " | ${it.javaClass.simpleName}: ${it.message}" } ?: "")

        when (level) {
            "E" -> ALog.e(tag, msg, t)
            "W" -> ALog.w(tag, msg)
            "D" -> ALog.d(tag, msg)
            else -> ALog.i(tag, msg)
        }

        recent.add(line)
        while (recent.size > MAX_LINES_IN_MEMORY) recent.removeAt(0)

        val dir = logDir ?: return
        try {
            val f = File(dir, "agent-${dayFmt.format(Date())}.log")
            f.appendText(line + "\n")
        } catch (_: Throwable) {
            // 落盘失败不影响主流程
        }
    }

    /** 供主界面展示的最近日志（最新在末尾） */
    fun tail(n: Int = 80): List<String> = recent.takeLast(n)

    /** 只保留最近若干天的日志文件，避免占满存储 */
    private fun pruneOldFiles(dir: File) {
        val files = dir.listFiles()?.sortedByDescending { it.name } ?: return
        files.drop(KEEP_FILES_DAYS).forEach { runCatching { it.delete() } }
    }
}
