package com.xfish.comment.agent.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.accessibility.AccessibilityNodeInfo
import com.xfish.comment.agent.core.Config
import com.xfish.comment.agent.core.Log
import com.xfish.comment.agent.core.Rnd
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * 动作原语（设计文档 §3.6 执行层）。
 *
 * 优先级：**控件动作（performAction）优先，手势注入兜底**。
 *  · performAction(ACTION_CLICK) 更稳、更"干净"；
 *  · dispatchGesture 用于自定义控件不响应、或需要「拟人轨迹」的场景。
 */
object Actions {

    private const val TAG = "actions"

    // ── 点击 ─────────────────────────────────────────────────

    /**
     * 点击节点：先尝试控件点击，失败再用手势点其中心。
     * @return 是否成功
     */
    suspend fun click(node: AccessibilityNodeInfo, preferGesture: Boolean = false): Boolean {
        val target = if (node.isClickable && node.isEnabled) node else NodeFinder.clickableAncestor(node)
        if (target == null) {
            Log.w(TAG, "click: 找不到可点击祖先节点")
            return false
        }

        if (!preferGesture) {
            val ok = runCatching { target.performAction(AccessibilityNodeInfo.ACTION_CLICK) }.getOrDefault(false)
            if (ok) {
                Log.d(TAG, "click via performAction ok")
                return true
            }
        }

        // 手势兜底：按高斯热区落在控件中心附近（真人倾向点中心）
        val rect = Rect().also { target.getBoundsInScreen(it) }
        if (rect.width() <= 0 || rect.height() <= 0) {
            Log.w(TAG, "click: 节点尺寸异常 $rect")
            return false
        }
        val cx = rect.centerX() + Rnd.gaussian(0.0, rect.width() / 6.0)
        val cy = rect.centerY() + Rnd.gaussian(0.0, rect.height() / 6.0)
        val x = cx.coerceIn(rect.left + 2.0, rect.right - 2.0)
        val y = cy.coerceIn(rect.top + 2.0, rect.bottom - 2.0)
        return tap(x, y)
    }

    /** 手势点击（单点） */
    suspend fun tap(x: Double, y: Double): Boolean {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val stroke = GestureDescription.StrokeDescription(path, 0L, Rnd.long(60, 120))
        return dispatch(stroke)
    }

    // ── 滑动 ─────────────────────────────────────────────────

    /**
     * 滑动（贝塞尔曲线 + 变速 + 起止停顿）。
     * 真人滑动是曲线且变速；直线匀速滑动是典型机器特征。
     * @param x 垂直滑动的固定 x（一般为屏幕中线附近）
     */
    suspend fun swipeVertical(x: Double, fromY: Double, toY: Double): Boolean {
        val path = Path()
        // 三次贝塞尔：横向偏移形成自然弧度 + 起止平缓
        val c1x = x + Rnd.double(-40.0, 40.0)
        val c1y = fromY + (toY - fromY) * 0.33
        val c2x = x + Rnd.double(-40.0, 40.0)
        val c2y = fromY + (toY - fromY) * 0.66
        path.moveTo(x.toFloat(), fromY.toFloat())
        path.cubicTo(c1x.toFloat(), c1y.toFloat(), c2x.toFloat(), c2y.toFloat(), x.toFloat(), toY.toFloat())
        // 时长随距离变化（约 0.35–0.9 秒），避免"每次都一样快"
        val duration = Rnd.long(340, 900)
        val stroke = GestureDescription.StrokeDescription(path, 0L, duration)
        return dispatch(stroke)
    }

    // ── 系统动作 ─────────────────────────────────────────────

    /** 返回（逐级退出用；**禁止 force-stop 杀进程**） */
    fun back(): Boolean = AutoService.back()

    /** 回桌面 */
    fun home(): Boolean = AutoService.home()

    /** 打开系统设置页 */
    fun openSettings(context: Context, action: String) {
        runCatching {
            context.startActivity(Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure { Log.w(TAG, "openSettings failed: ${it.message}") }
    }

    // ── 输入：剪贴板 + 粘贴（主方案，兜底为长按 → 点「粘贴」）──────

    /**
     * 把话术写入剪贴板。
     * 说明：Android 10+ 后台**写**剪贴板通常允许，**读**受限；此处只写不读。
     */
    fun setClipboard(context: Context, text: String): Boolean = runCatching {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("comment", text))
        true
    }.getOrElse {
        Log.e(TAG, "setClipboard failed", it)
        false
    }

    /**
     * 粘贴到当前聚焦的输入框。
     * 路径 1：对聚焦节点发 ACTION_PASTE（最快）
     * 路径 2：长按输入框 → 在弹出菜单里点「粘贴」（最像真人，兜底）
     */
    suspend fun pasteIntoFocused(context: Context, text: String, inputNode: AccessibilityNodeInfo?): Boolean {
        if (!setClipboard(context, text)) return false
        delay(Rnd.long(350, 900)) // 写入剪贴板到粘贴之间的自然间隙

        // 路径 1：ACTION_PASTE
        val target = inputNode ?: findFocusedEditable()
        if (target != null) {
            val ok = runCatching {
                target.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
                target.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            }.getOrDefault(false)
            if (ok) {
                Log.i(TAG, "paste via ACTION_PASTE ok")
                return true
            }
        }

        // 路径 2：长按 → 点「粘贴」气泡
        Log.i(TAG, "ACTION_PASTE 未生效，改用长按菜单")
        if (target == null) {
            Log.w(TAG, "paste: 找不到输入框节点")
            return false
        }
        val rect = Rect().also { target.getBoundsInScreen(it) }
        longPress(rect.centerX().toDouble(), rect.centerY().toDouble())
        val pasteNode = NodeFinder.waitFor(
            NodeFinder.Locator(textContains = listOf("粘贴"), textExact = listOf("粘贴")),
            timeoutMs = 2_500,
        )
        if (pasteNode != null) {
            return click(pasteNode)
        }
        Log.w(TAG, "paste: 未找到「粘贴」菜单项")
        return false
    }

    /** 长按手势 */
    suspend fun longPress(x: Double, y: Double, durationMs: Long = Rnd.long(500, 900)): Boolean {
        val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
        val stroke = GestureDescription.StrokeDescription(path, 0L, durationMs)
        return dispatch(stroke)
    }

    /** 找到当前聚焦或可编辑的输入框 */
    fun findFocusedEditable(): AccessibilityNodeInfo? {
        val root = AutoService.root() ?: return null
        var hit: AccessibilityNodeInfo? = null

        fun dfs(node: AccessibilityNodeInfo, depth: Int) {
            if (hit != null || depth > 25) return
            if (node.isEditable || node.isFocused && node.className?.contains("EditText", true) == true) {
                hit = node
                return
            }
            for (i in 0 until node.childCount) {
                val c = node.getChild(i) ?: continue
                dfs(c, depth + 1)
            }
        }
        dfs(root, 0)
        return hit
    }

    // ── 应用与链接 ───────────────────────────────────────────

    /**
     * 唤起抖音（设计文档 §6.3 步骤 1：**随机入口**，不要每次同一种方式直启）。
     *  A：直接 launch intent（可靠）
     *  B：回桌面 → 按图标文本点击（更拟人，依赖桌面可读）
     */
    suspend fun launchDouyin(context: Context): Boolean {
        val pkg = when {
            installed(context, Config.PKG_DOUYIN) -> Config.PKG_DOUYIN
            installed(context, Config.PKG_DOUYIN_LITE) -> Config.PKG_DOUYIN_LITE
            else -> {
                Log.w(TAG, "抖音未安装")
                return false
            }
        }

        val useIconEntry = Rnd.bool(0.4)
        if (useIconEntry) {
            home()
            delay(Rnd.long(700, 1_400))
            val icon = NodeFinder.waitFor(
                NodeFinder.Locator(
                    textContains = listOf("抖音"),
                    descContains = listOf("抖音"),
                ),
                timeoutMs = 2_500,
            )
            if (icon != null && click(icon)) {
                val ok = waitDouyinForeground(8_000)
                Log.i(TAG, "抖音已通过桌面图标唤起（前台=$ok）")
                return true
            }
            Log.d(TAG, "桌面图标入口失败，回退 launch intent")
        }

        val intent = context.packageManager.getLaunchIntentForPackage(pkg)
        if (intent == null) {
            Log.w(TAG, "getLaunchIntentForPackage 返回空")
            return false
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(intent) }
            .onFailure { Log.w(TAG, "launch failed: ${it.message}"); return false }
        // 等待抖音真正进入前台：冷启动常需 3~5 秒，固定延时会在未就绪时就发短链，
        // 导致 AppLinkHandler 被丢弃、抖音始终不进前台。
        val ok = waitDouyinForeground(8_000)
        Log.i(TAG, "抖音已通过 launch intent 唤起（前台=$ok）")
        return true
    }

    /**
     * 轮询等待抖音进入前台。
     *
     * 按**真实时间**计时：探测本身在冷启动期可能阻塞数百毫秒到数秒，
     * 早期用「累加 delay」计时会让 8 秒超时实际拉长到 60+ 秒。
     */
    private suspend fun waitDouyinForeground(timeoutMs: Long): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (AutoService.douyinForeground()) return true
            delay(300)
        }
        return AutoService.douyinForeground()
    }

    /**
     * 打开短链（真人路径：点分享链接 → 系统弹「打开抖音」→ 确认）。
     * 不做关键词搜索定位（设计文档已明确）。
     */
    suspend fun openShortLink(context: Context, url: String): Boolean {
        // 优先「指定抖音包名」打开：
        // 裸 ACTION_VIEW 会命中多个处理者（抖音 / 抖音极速版 / 浏览器 均为 isDefault），
        // 系统因此弹出「打开方式」选择器；而选择器不在无障碍监听范围（只监听抖音包名），
        // 无法自动点击 → 抖音迟迟不进前台 → 任务被误判为 login_invalid 中止。
        val pkg = when {
            installed(context, Config.PKG_DOUYIN) -> Config.PKG_DOUYIN
            installed(context, Config.PKG_DOUYIN_LITE) -> Config.PKG_DOUYIN_LITE
            else -> null
        }
        var launched = false
        if (pkg != null) {
            val toDouyin = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                setPackage(pkg)
            }
            launched = runCatching { context.startActivity(toDouyin); true }
                .onFailure { Log.w(TAG, "指定 $pkg 打开短链失败：${it.message}") }
                .getOrDefault(false)
            if (launched) Log.i(TAG, "短链已指定由 $pkg 打开")
        }

        if (!launched) {
            // 回退：裸 ACTION_VIEW（可能弹「打开方式」选择器）
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            runCatching { context.startActivity(intent) }
                .onFailure { Log.w(TAG, "openShortLink failed: ${it.message}"); return false }
        }
        delay(Rnd.long(1_200, 2_200))

        // 系统可能弹「打开抖音」确认框（部分机型 / 首次访问会出现）
        val confirm = NodeFinder.waitFor(
            NodeFinder.Locator(
                textExact = listOf("打开", "允许", "确定", "打开抖音"),
                textContains = listOf("打开抖音"),
            ),
            timeoutMs = 2_500,
        )
        if (confirm != null) {
            click(confirm)
            delay(Rnd.long(900, 1_600))
        }
        return true
    }

    fun installed(context: Context, pkg: String): Boolean = runCatching {
        context.packageManager.getPackageInfo(pkg, 0)
        true
    }.getOrDefault(false)

    /** 已安装应用的版本名（用于上报 douyinVersion） */
    fun versionName(context: Context, pkg: String): String? = runCatching {
        context.packageManager.getPackageInfo(pkg, 0).versionName
    }.getOrNull()

    // ── 手势派发 ─────────────────────────────────────────────

    private suspend fun dispatch(stroke: GestureDescription.StrokeDescription): Boolean {
        val svc = AutoService.get() ?: return false
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return suspendCancellableCoroutine { cont ->
            val callback = object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    if (cont.isActive) cont.resume(true)
                }

                override fun onCancelled(gestureDescription: GestureDescription?) {
                    if (cont.isActive) cont.resume(false)
                }
            }
            val accepted = svc.dispatchGesture(gesture, callback, null)
            if (!accepted && cont.isActive) cont.resume(false)
        }
    }

    /** 「忽略电池优化」跳转（自检引导用） */
    fun requestIgnoreBatteryOptimization(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        runCatching {
            context.startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                    .setData(Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }.onFailure {
            openSettings(context, Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        }
    }

    /**
     * 「显示在其他应用上层」跳转。
     *
     * 该权限是**后台启动 Activity 的前提**：本应用以常驻服务身份唤起抖音、打开短链，
     * 若无此权限，Android 10+ 会静默拦截 startActivity，表现为「抖音始终不进前台」。
     */
    fun requestOverlayPermission(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        runCatching {
            context.startActivity(
                Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
                    .setData(Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }.onFailure {
            openSettings(context, Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
        }
    }

    /** 是否已授予「显示在其他应用上层」 */
    fun hasOverlayPermission(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)
}
