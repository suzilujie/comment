package com.xfish.comment.agent.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.xfish.comment.agent.core.Bus
import com.xfish.comment.agent.core.Config
import com.xfish.comment.agent.core.Log

/**
 * 无障碍服务：设备端 Agent 的「眼睛与手指」。
 *
 * 职责边界（薄 Agent 原则）：
 *  · 只提供**感知**（读控件树）与**操作**（点击 / 滑动 / 返回 / 粘贴）；
 *  · 不做任何业务决策（配额、间隔、选帖等全部在后台）。
 *
 * 唯一例外：遇到限流 / 验证码 / 风控弹窗时**本地秒级中止**（时效性等不了往返）。
 */
class AutoService : AccessibilityService() {

    companion object {
        private const val TAG = "a11y"

        /** 窗口事件缓存的有效期；超时后才回退去读 rootInActiveWindow */
        private const val PAGE_CACHE_TTL_MS = 3_000L

        @Volatile
        private var instance: AutoService? = null

        /** 最近一次窗口变化缓存的包名 / 类名（含时间戳） */
        @Volatile
        private var cachedPkg: String? = null

        @Volatile
        private var cachedCls: String? = null

        @Volatile
        private var cachedAt: Long = 0L

        /** 服务是否已连接（心跳用它上报 accessibilityOk） */
        val connected: Boolean get() = instance != null

        fun get(): AutoService? = instance

        /** 当前窗口根节点（可能为 null：抖音在后台或正在切换页面） */
        fun root(): AccessibilityNodeInfo? = runCatching {
            instance?.rootInActiveWindow
        }.getOrNull()

        /**
         * 当前前台包名。
         *
         * **优先读窗口事件缓存**：`rootInActiveWindow` 是同步 IPC（还会触发整树构建），
         * 抖音冷启动 / 切页期间单次可阻塞数秒 —— 曾导致「等前台 8 秒」实际耗时 60+ 秒。
         * 缓存过期（TTL 内无窗口事件）才回退读树，保证极端情况下依然能拿到结果。
         */
        fun currentPackage(): String? {
            if (System.currentTimeMillis() - cachedAt < PAGE_CACHE_TTL_MS) return cachedPkg
            return runCatching { instance?.rootInActiveWindow?.packageName?.toString() }.getOrNull()
        }

        /**
         * 当前页面（`包名/类名`），用于日志定位「到底进了哪个页面」。
         *
         * **刻意不设 TTL**：窗口事件的 `className` 才是 Activity 名（如 `...detail.ui.DetailActivity`），
         * 而 `rootInActiveWindow.className` 只是根 View（如 `android.widget.FrameLayout`），
         * 对定位毫无价值。抖音详情页常驻时不再产生窗口事件，若按 TTL 回退读树，
         * 日志就会打出 `FrameLayout` 这种误导信息（实测踩过）。
         */
        fun currentPage(): String {
            val pkg = cachedPkg ?: root()?.packageName?.toString() ?: "-"
            val cls = cachedCls ?: root()?.className?.toString() ?: "-"
            return "$pkg/$cls"
        }

        /** 抖音是否在前台 */
        fun douyinForeground(): Boolean {
            val pkg = currentPackage() ?: return false
            return pkg == Config.PKG_DOUYIN || pkg == Config.PKG_DOUYIN_LITE
        }

        /** 全局返回（逐级退出用，禁止 force-stop 杀进程） */
        fun back(): Boolean =
            instance?.performGlobalAction(GLOBAL_ACTION_BACK) ?: false

        /** 回到桌面 */
        fun home(): Boolean =
            instance?.performGlobalAction(GLOBAL_ACTION_HOME) ?: false
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this

        // 收紧事件订阅：只关心变化类事件，减少无效回调与功耗
        serviceInfo = (serviceInfo ?: AccessibilityServiceInfo()).apply {
            eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
                AccessibilityEvent.TYPE_VIEW_CLICKED or
                AccessibilityEvent.TYPE_VIEW_FOCUSED
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            flags = flags or AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
                AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            notificationTimeout = 100
        }

        Log.i(TAG, "无障碍服务已连接")
        Bus.emit(Bus.Events.A11Y_CONNECTED)
        Bus.emit(Bus.Events.UI_REFRESH)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 事件本身不驱动业务：执行器用自己的等待/轮询逻辑读树。
        // 这里只在窗口变化时轻量记一笔（debug 级别），便于排障。
        val e = event ?: return
        if (e.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            // 窗口事件本身已带包名/类名，直接缓存：后续查询零 IPC 开销
            cachedPkg = e.packageName?.toString()
            cachedCls = e.className?.toString()
            cachedAt = System.currentTimeMillis()
            Log.d(TAG, "window → ${cachedPkg ?: ""} ${cachedCls ?: ""}")
        }
    }

    override fun onInterrupt() {
        Log.w(TAG, "无障碍服务被中断")
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        cachedPkg = null
        cachedCls = null
        cachedAt = 0L
        Log.w(TAG, "无障碍服务已断开")
        Bus.emit(Bus.Events.A11Y_DISCONNECTED)
        Bus.emit(Bus.Events.UI_REFRESH)
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }
}

/** 便捷：从任意 Context 判断无障碍是否已授权（用于自检与面板展示） */
object A11yStatus {
    fun enabled(context: Context): Boolean {
        val expected = "${context.packageName}/${AutoService::class.java.name}"
        val flat = android.provider.Settings.Secure.getString(
            context.contentResolver,
            android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        return flat.split(':').any { it.equals(expected, ignoreCase = true) } || AutoService.connected
    }
}
