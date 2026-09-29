package com.xfish.comment.agent.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.xfish.comment.agent.core.Bus
import com.xfish.comment.agent.core.Config
import com.xfish.comment.agent.core.Log
import kotlinx.coroutines.delay

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

        /** 「有意义页面」类名的保鲜期：超时后 [currentPage] 不再拿它当当前页面 */
        private const val PAGE_CLS_TTL_MS = 60_000L

        /** 视频详情页特征（抖音短链解析成功后必经此 Activity） */
        private const val DETAIL_ACTIVITY_HINT = "detail.ui.DetailActivity"

        /** 容器 / 控件类名前缀：这些类名标不出「哪个页面」，不参与页面判定 */
        private val VIEW_CLASS_PREFIXES = listOf(
            "android.widget.", "android.view.", "android.webkit.",
            "androidx.", "com.android.internal.",
        )

        @Volatile
        private var instance: AutoService? = null

        /** 最近一次窗口变化缓存的包名 / 类名（含时间戳） */
        @Volatile
        private var cachedPkg: String? = null

        @Volatile
        private var cachedCls: String? = null

        @Volatile
        private var cachedAt: Long = 0L

        /** 最近一个「像页面」的类名（Activity/Dialog，排除布局容器）及其发生时刻 */
        @Volatile
        private var lastPageCls: String? = null

        @Volatile
        private var lastPageAt: Long = 0L

        /** 最近一次出现视频详情页的时刻（单调时钟） */
        @Volatile
        private var lastDetailAt: Long = 0L

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
            // ⚠ 用**单调时钟**：本文件其它时刻（lastPageAt / lastDetailAt）都是 elapsedRealtime，
            //    唯独这里原来是墙钟。用户或系统把时间往回调几秒时，`now - cachedAt` 会变负、
            //    小于 TTL → **过期缓存被当成新鲜**，currentPackage() 返回旧包名 →
            //    douyinForeground() 误判（进而影响短链后"是否进了抖音"的判定）。
            if (SystemClock.elapsedRealtime() - cachedAt < PAGE_CACHE_TTL_MS) return cachedPkg
            return runCatching { instance?.rootInActiveWindow?.packageName?.toString() }.getOrNull()
        }

        /** 类名是否「像个页面」（Activity / Dialog），而不是布局容器 */
        private fun looksLikePage(cls: String?): Boolean {
            if (cls.isNullOrBlank()) return false
            if (cls.endsWith("Activity") || cls.endsWith("Dialog")) return true
            if (VIEW_CLASS_PREFIXES.any { cls.startsWith(it) }) return false
            return !(cls.endsWith("Layout") || cls.endsWith("View") || cls.endsWith("ViewGroup"))
        }

        /**
         * 当前页面（`包名/类名`），用于日志定位「到底进了哪个页面」。
         *
         * ⚠ 窗口事件里的 `className` 有两类，混用会打出误导信息（实测踩过两次）：
         *  · **Activity**（`...detail.ui.DetailActivity`）—— 真正的页面标识；
         *  · **布局容器**（`android.widget.FrameLayout`、`...tabstrip.container.CustomRelativeLayout`）
         *    —— 只说明"某块布局在变化"，看起来像首页，实际可能正停在详情页。
         * 所以优先用「最近出现过的、像页面的类名」，容器类名只在完全没有 Activity 时兜底；
         * 同时给 60 秒保鲜期：太久以前的页面不该继续冒充"当前页面"。
         */
        fun currentPage(): String {
            val pkg = cachedPkg ?: root()?.packageName?.toString() ?: "-"
            val fresh = lastPageCls?.takeIf {
                lastPageAt > 0L && SystemClock.elapsedRealtime() - lastPageAt < PAGE_CLS_TTL_MS
            }
            val cls = fresh ?: cachedCls ?: root()?.className?.toString() ?: "-"
            return "$pkg/$cls"
        }

        /**
         * 近期是否出现过**视频详情页**。
         *
         * ⚠ 用「出现过」而不是「当前就在」：抖音详情页常驻后不再产生窗口事件，
         * 之后首页 tab 容器的 window 事件会覆盖 [cachedCls]，于是"当前页面"看起来是首页 ——
         * 但详情页其实一直在。而「有没有进过详情页」正是「短链有没有解析成功」的可靠标志。
         */
        fun sawDetailPage(windowMs: Long = 15_000L): Boolean =
            lastDetailAt > 0L && SystemClock.elapsedRealtime() - lastDetailAt < windowMs

        /**
         * 等待详情页出现。
         *
         * ⚠ 判据不能只是「找得到评论入口」：**首页推荐流的视频同样有评论入口**，
         * 短链失效停在首页时也会通过 —— 那样就会给一个**错误的视频**发评论，
         * 而且回执还是 succeeded（2026-09-28 实测：入口确认仅 23ms 就"通过"了）。
         */
        suspend fun awaitDetailPage(timeoutMs: Long = 8_000L): Boolean {
            val t0 = SystemClock.elapsedRealtime()
            while (SystemClock.elapsedRealtime() - t0 < timeoutMs) {
                if (sawDetailPage()) return true
                delay(250)
            }
            return sawDetailPage()
        }

        /**
         * 复位「见过详情页」标记，返回复位时刻。
         *
         * ⚠ 为什么需要它：短链解析失败时，设备可能**正停在上一轮任务留下的详情页**上 ——
         *   此时 [sawDetailPage] 依然为 true（15 秒窗口内），"已进入目标视频"被误判通过，
         *   评论就发到**上一个视频**上，而且回执还是 succeeded。
         *   打开短链**之前**先清零，之后只认"本次跳转触发的新详情页"，即可挡下这种情况。
         */
        fun resetDetailMarker(): Long {
            lastDetailAt = 0L
            return SystemClock.elapsedRealtime()
        }

        /**
         * 等待「**[sinceMs] 之后**出现过详情页」。
         *
         * 与 [awaitDetailPage] 的区别：后者只要求"最近 15 秒内有过详情页"，
         * 而那个页面可能是打开短链**之前**就存在的旧页面；这里要求窗口事件发生在给定时刻之后，
         * 即确由本次跳转触发。
         */
        suspend fun awaitDetailPageSince(sinceMs: Long, timeoutMs: Long = 8_000L): Boolean {
            val t0 = SystemClock.elapsedRealtime()
            while (SystemClock.elapsedRealtime() - t0 < timeoutMs) {
                if (lastDetailAt > sinceMs) return true
                delay(250)
            }
            return lastDetailAt > sinceMs
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
            cachedAt = SystemClock.elapsedRealtime()

            val cls = cachedCls
            if (cls != null) {
                // 只有「像页面」的类名才记入 lastPageCls（容器类名不参与，否则会盖掉真实页面）
                if (looksLikePage(cls)) {
                    lastPageCls = cls
                    lastPageAt = SystemClock.elapsedRealtime()
                }
                if (cls.contains(DETAIL_ACTIVITY_HINT)) {
                    lastDetailAt = SystemClock.elapsedRealtime()
                }
            }
            Log.d(TAG, "window → ${cachedPkg ?: ""} ${cls ?: ""}")
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
        lastPageCls = null
        lastPageAt = 0L
        lastDetailAt = 0L
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
