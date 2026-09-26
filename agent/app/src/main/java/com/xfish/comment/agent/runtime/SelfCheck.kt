package com.xfish.comment.agent.runtime

import android.content.Context
import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo
import android.os.Environment
import android.os.StatFs
import com.xfish.comment.agent.accessibility.A11yStatus
import com.xfish.comment.agent.accessibility.Actions
import com.xfish.comment.agent.accessibility.AutoService
import com.xfish.comment.agent.accessibility.NodeFinder
import com.xfish.comment.agent.core.Log
import com.xfish.comment.agent.core.Time
import com.xfish.comment.agent.exec.DouyinLocators
import com.xfish.comment.agent.net.DeviceProfileDto
import com.xfish.comment.agent.netlink.ClashClient
import com.xfish.comment.agent.netlink.IpProbe
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 自检（设计文档 §3.7 手段 5「自检探针 + 门禁适配」、§3.8 写路径「自检指令」）。
 *
 * 用途：
 *  1. 新机型**首次运行**时验证关键元素定位器是否命中 —— 未通过不接业务任务；
 *  2. 排障时由后台下发 probe 指令，回执一份完整状态。
 */
object SelfCheck {

    private const val TAG = "selfcheck"

    /** 设备基础信息（心跳与注册都要用） */
    fun profile(context: Context): DeviceProfileDto {
        val dm = context.resources.displayMetrics
        return DeviceProfileDto(
            model = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
            resolution = "${dm.widthPixels}x${dm.heightPixels}",
            dpi = dm.densityDpi,
            osVersion = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            romVersion = romVersion(),
            fontScale = context.resources.configuration.fontScale,
            darkMode = isDarkMode(context),
        )
    }

    /** 电量（0–100）；读不到返回 null */
    fun battery(context: Context): Int? = runCatching {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as android.os.BatteryManager
        bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
            .takeIf { it in 0..100 }
    }.getOrNull()

    /** 可用存储（MB） */
    fun storageFreeMb(): Int? = runCatching {
        val stat = StatFs(Environment.getDataDirectory().path)
        (stat.availableBytes / (1024 * 1024)).toInt()
    }.getOrNull()

    /** 前台服务是否存活（本服务正在运行即为 true） */
    fun foregroundOk(): Boolean = AgentService.running

    /** 无障碍是否可用 */
    fun accessibilityOk(context: Context): Boolean = A11yStatus.enabled(context) && AutoService.connected

    /** Clash 外部控制器是否可达 */
    suspend fun clashReachable(): Boolean = ClashClient.ping()

    /**
     * 完整自检：返回结构化结果（供 probe 指令回执与界面展示）。
     */
    suspend fun run(context: Context): JsonObject {
        val ip = IpProbe.probe()
        val clash = clashReachable()
        val a11y = accessibilityOk(context)
        val nodes = if (a11y && AutoService.douyinForeground()) NodeFinder.dumpSummary(40) else emptyList()

        Log.i(TAG, "自检：a11y=$a11y clash=$clash ip=${ip?.ip ?: "-"} city=${ip?.city ?: "-"}")

        return buildJsonObject {
            put("accessibilityOk", a11y)
            put("overlayPermission", Actions.hasOverlayPermission(context))
            put("foregroundOk", foregroundOk())
            put("clashReachable", clash)
            put("exitIp", ip?.ip ?: "")
            put("exitCity", ip?.city ?: "")
            put("ipv6Leak", ip?.ipv6Leak ?: false)
            put("probeSource", ip?.source ?: "")
            put("clockOffsetSec", Time.clockOffsetSec())
            put("douyinForeground", AutoService.douyinForeground())
            put("nodeSamples", nodes.size)
            // 前若干条节点摘要，供新机型适配时比对定位器命中情况
            put("nodeDump", nodes.take(25).joinToString("\n"))
        }
    }

    /**
     * 关键元素命中检查（新机型门禁）。
     * 返回未命中的元素名列表；**非空即表示不应放行接单**。
     *
     * 全自动流程：抖音不在前台时**自动唤起** → 查首页可见元素 →
     * **自动打开评论面板**查输入框入口 → 自动退回，恢复自检前的界面。
     */
    suspend fun probeCriticalLocators(context: Context): List<String> {
        // ① 自动唤起抖音（自检需要读取抖音界面节点，不再要求人工先打开）
        if (!AutoService.douyinForeground()) {
            Log.i(TAG, "抖音不在前台，自检自动唤起")
            if (!Actions.launchDouyin(context)) {
                return listOf("douyin_not_launched（无法唤起抖音，请确认已安装）")
            }
            if (!waitDouyinForeground(8_000)) {
                return listOf("douyin_not_foreground（已尝试自动唤起但未进入前台，可能被系统拦截）")
            }
            delay(1_200) // 等首页渲染稳定
        }

        val missing = mutableListOf<String>()

        // ② 首页/帖子页直接可见的元素
        val onFeed = mapOf(
            "评论区入口" to DouyinLocators.commentEntry,
            "点赞按钮" to DouyinLocators.likeButton,
            "收藏按钮" to DouyinLocators.favoriteButton,
        )
        for ((name, locator) in onFeed) {
            if (NodeFinder.find(locator) == null) missing += name
        }

        // ③ 评论面板内的元素：自动打开面板再查
        //    控件点击可能对抖音自定义控件无效（返回 true 但面板未开），故加一次手势点击重试；
        //    并以「输入框入口是否出现」作为面板打开的标志，而非固定延时。
        var panelInput: AccessibilityNodeInfo? = null
        // 面板可能已处于展开状态（用户手动打开过 / 抖音默认展示评论区）。
        // 此时不能再去点「入口」——展开态下 commentEntry 的宽泛候选会命中
        // desc="缩小评论区" 的关闭按钮，把面板关掉（抖音 39.7.0 实测）。
        panelInput = NodeFinder.find(DouyinLocators.commentInputEntry)
        if (panelInput != null) {
            Log.i(TAG, "评论面板已处于展开状态，跳过打开动作")
        } else if ("评论区入口" !in missing) {
            for (attempt in 0..1) {
                val entry = NodeFinder.find(DouyinLocators.commentEntry) ?: break
                Actions.click(entry, preferGesture = attempt == 1)
                // 评论面板唤起较慢（实测可达 3s+），超时给足
                panelInput = NodeFinder.waitFor(DouyinLocators.commentInputEntry, timeoutMs = 6_000)
                if (panelInput != null) {
                    Log.i(TAG, "评论面板已打开（第 ${attempt + 1} 次点击生效）")
                    break
                }
                Log.w(TAG, "第 ${attempt + 1} 次打开评论面板未生效，重试")
            }
        }
        if (panelInput == null) missing += "输入框入口"
        // 发送按钮仅在「输入态」出现，未进入输入态查不到属正常，不计入缺失
        if (panelInput != null && NodeFinder.find(DouyinLocators.sendButton) != null) {
            Log.i(TAG, "发送按钮命中（当前已处于输入态）")
        }

        // ④ 收尾：退出评论面板，恢复自检前的界面
        if (panelInput != null) {
            Actions.back()
            delay(500)
        }

        if (missing.isEmpty()) Log.i(TAG, "关键元素全部命中")
        else Log.w(TAG, "关键元素未命中：${missing.joinToString("、")}")
        return missing
    }

    /** 等待抖音进入前台（自检自动唤起后轮询） */
    private suspend fun waitDouyinForeground(timeoutMs: Long): Boolean {
        var waited = 0L
        while (waited < timeoutMs) {
            if (AutoService.douyinForeground()) return true
            delay(400)
            waited += 400
        }
        return AutoService.douyinForeground()
    }

    private fun romVersion(): String = runCatching {
        val props = listOf(
            "ro.miui.ui.version.name",
            "ro.build.version.emui",
            "ro.build.version.opporom",
            "ro.vivo.os.version",
            "ro.build.display.id",
        )
        for (p in props) {
            val v = readProp(p)
            if (!v.isNullOrBlank()) return@runCatching v
        }
        Build.DISPLAY
    }.getOrDefault(Build.DISPLAY)

    private fun readProp(name: String): String? = runCatching {
        val cls = Class.forName("android.os.SystemProperties")
        val get = cls.getMethod("get", String::class.java)
        get.invoke(null, name) as? String
    }.getOrNull()

    private fun isDarkMode(context: Context): Boolean = runCatching {
        val flags = context.resources.configuration.uiMode and
            android.content.res.Configuration.UI_MODE_NIGHT_MASK
        flags == android.content.res.Configuration.UI_MODE_NIGHT_YES
    }.getOrDefault(false)
}
