package com.xfish.comment.agent.runtime

import android.content.Context
import com.xfish.comment.agent.accessibility.A11yStatus
import com.xfish.comment.agent.core.Bus
import com.xfish.comment.agent.core.Log

/**
 * 保活守护（设计文档 §3.6 三大机制之三：保活与自愈）。
 *
 * 三层防线中的第三层：
 *  ① 前台服务（AgentService）
 *  ② 电池白名单 / 自启动（需人工一次性配置）
 *  ③ **Watchdog**：周期检查无障碍是否掉线、服务是否仍在
 *
 * 重要现实：**重开无障碍通常需要人工在设置页点一次**（系统限制，无法自动化），
 * 因此检测到掉线后必须：
 *  · 上报设备异常（后台告警推人）；
 *  · 引导用户到无障碍设置页（App 内一键跳转）。
 */
object Watchdog {

    private const val TAG = "watchdog"

    /** 无障碍掉线累计次数（用于告警升级判断） */
    @Volatile
    var a11yDownCount: Int = 0
        private set

    /**
     * 检查一轮。
     * @return 是否需要人工介入
     */
    suspend fun check(context: Context): Boolean {
        var needHuman = false

        // ① 无障碍
        val a11y = A11yStatus.enabled(context) && com.xfish.comment.agent.accessibility.AutoService.connected
        if (!a11y) {
            a11yDownCount++
            Log.w(TAG, "无障碍服务不可用（第 $a11yDownCount 次检测）")
            // ⚠ 用 >= 而非 ==：早期写 == 2，导致「第 2 次报过一次之后再无信号」——
            // 无障碍长期掉线时后台只能收到一次告警，之后完全静默，没人知道设备已废。
            if (a11yDownCount >= 2) {
                Bus.emit(Bus.Events.A11Y_DISCONNECTED)
                needHuman = true
            }
        } else if (a11yDownCount > 0) {
            Log.i(TAG, "无障碍服务已恢复")
            a11yDownCount = 0
            Bus.emit(Bus.Events.A11Y_CONNECTED)
        }

        // ② 服务自身（本函数由服务调用，能跑到这里说明服务还活着）
        if (!AgentService.running) {
            Log.w(TAG, "检测到服务状态标记异常")
            needHuman = true
        }

        return needHuman
    }

    /** 生成给后台的异常描述（随心跳的 detail 侧或事件上报） */
    fun describe(context: Context): String = buildString {
        if (!A11yStatus.enabled(context)) append("无障碍未开启；")
        if (!AgentService.running) append("前台服务异常；")
        if (a11yDownCount >= 2) append("无障碍连续掉线 $a11yDownCount 次（需人工重开）；")
    }.ifBlank { "正常" }
}
