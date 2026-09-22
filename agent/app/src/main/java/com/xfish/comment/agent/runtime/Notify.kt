package com.xfish.comment.agent.runtime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.xfish.comment.agent.MainActivity
import com.xfish.comment.agent.R
import com.xfish.comment.agent.core.Config

/**
 * 常驻通知（前台服务必需）。
 *
 * 注意：状态栏常驻通知是「前台服务」的必然代价，也是检测面之一；
 * 文案保持中性（"服务运行中"），不出现任何业务敏感词。
 */
object Notify {

    fun ensureChannel(context: Context) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(Config.NOTIFY_CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            Config.NOTIFY_CHANNEL_ID,
            context.getString(R.string.notify_channel_name),
            NotificationManager.IMPORTANCE_LOW, // LOW：不出声、不弹横幅
        ).apply {
            description = context.getString(R.string.notify_channel_desc)
            setShowBadge(false)
            enableLights(false)
            enableVibration(false)
        }
        nm.createNotificationChannel(channel)
    }

    /** 构造常驻通知（内容随状态变化：在线 / 离线 / 忙碌） */
    fun build(context: Context, text: String): Notification {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pi = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(context, Config.NOTIFY_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(context.getString(R.string.notify_title))
            .setContentText(text)
            .setContentIntent(pi)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setShowWhen(false)
            .build()
    }

    /** 更新通知文案 */
    fun update(context: Context, text: String) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        runCatching { nm.notify(Config.NOTIFY_ID, build(context, text)) }
    }
}
