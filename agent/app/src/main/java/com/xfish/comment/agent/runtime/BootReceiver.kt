package com.xfish.comment.agent.runtime

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.xfish.comment.agent.core.Log

/**
 * 开机自启（保活三层防线的第二层）。
 *
 * 现实提醒：
 *  · 多数国产 ROM 需要用户手动加入「自启动白名单」，否则本广播不会被投递；
 *  · 无障碍服务在重启后常被系统自动关闭 —— 这需要**人工重开**（见 Watchdog）。
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != "android.intent.action.QUICKBOOT_POWERON") {
            return
        }
        Log.i("boot", "收到开机广播：$action，尝试拉起常驻服务")
        runCatching { AgentService.start(context.applicationContext) }
            .onFailure { Log.w("boot", "拉取服务失败：${it.message}") }
    }
}
