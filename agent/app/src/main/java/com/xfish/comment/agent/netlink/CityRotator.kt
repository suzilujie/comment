package com.xfish.comment.agent.netlink

import android.content.Context
import com.xfish.comment.agent.core.Bus
import com.xfish.comment.agent.core.Config
import com.xfish.comment.agent.core.Log
import com.xfish.comment.agent.core.Rnd
import com.xfish.comment.agent.core.Time
import com.xfish.comment.agent.data.AgentDb
import com.xfish.comment.agent.data.Prefs
import com.xfish.comment.agent.net.CityPoolItemDto
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

/**
 * 定时切换 IP（设计文档 §5.3：**设备自治 + 纯随机跨城**）。
 *
 * 流程（9 步）：
 *  1. 本地计时到期（2 天 ± 4 小时，用单调时钟计时，避免改系统时间影响）；
 *  2. 确认**无在途任务**（防止「评着 A 城帖子、IP 已成 B 城」的属地错配）；
 *  3. 从后台下发的**城市池**中纯随机选一座（排除当前城市）；
 *  4. 调 Clash External Controller 切换 group（三步校验：组存在 → 选节点 → 回读确认）；
 *  5. 等待连接建立；
 *  6. 探测新出口 IP 与属地（含 IPv6 泄露检查）；
 *  7. 校验属地是否属于目标城市（不一致重试，最多 N 次）；
 *  8. **立即上报**新 IP + 属地 + 时间（不等下次心跳）；
 *  9. 记录下次切换时间（2 天 ± 4 小时）。
 *
 * 空跑容忍：纯随机跨城可能切到「当天没有帖子」的城市，**不算故障**，
 * 由后台统计「空跑日数」评估城市池质量。
 */
object CityRotator {

    private const val TAG = "rotator"
    private val json = Json { ignoreUnknownKeys = true }

    /** 单调时钟锚点：记录上次切换时的 elapsedRealtime，用于周期计时 */
    @Volatile
    private var lastSwitchElapsedMs: Long = 0L

    /** 是否到期（用单调时钟，改系统时间不影响） */
    fun isDue(nowElapsedMs: Long = Time.elapsedMs()): Boolean {
        if (lastSwitchElapsedMs == 0L) return false // 首次由 onServiceStart 初始化
        val periodMs = periodMs()
        return nowElapsedMs - lastSwitchElapsedMs >= periodMs
    }

    /** 周期：2 天 ± 4 小时（抖动避免多设备同刻切换） */
    private fun periodMs(): Long {
        val baseDays = Config.IP_ROTATE_DAYS * 24L * 3600_000L
        val jitterMs = Config.IP_ROTATE_JITTER_HOURS * 3600_000L
        return baseDays + Rnd.long(-jitterMs, jitterMs)
    }

    /** 服务启动时初始化计时锚点：若从未切换过，安排一个抖动后的首次切换时间 */
    suspend fun onServiceStart(context: Context) {
        val lastSwitchAt = Prefs.lastIpSwitchAt(context)
        if (lastSwitchAt > 0L) {
            val elapsedSince = Time.nowMs() - lastSwitchAt
            lastSwitchElapsedMs = Time.elapsedMs() - elapsedSince
            Log.i(TAG, "恢复切换周期，距上次切换 ${elapsedSince / 3600_000} 小时")
        } else {
            lastSwitchElapsedMs = Time.elapsedMs()
            Log.i(TAG, "首次启动，切换周期从当前开始计时")
        }
    }

    /**
     * 执行一次切城。
     * @param hasInFlightTask 由调用方注入（避免本模块直接依赖执行器）
     * @return 成功时返回 (ip, city)，失败返回 null（并已记录日志）
     */
    suspend fun rotate(
        context: Context,
        hasInFlightTask: Boolean,
        reportEvent: suspend (taskId: String?, event: String, reasonCode: String?, ip: String?, city: String?) -> Unit,
    ): Pair<String, String>? = withContext(Dispatchers.IO) {

        // 步骤 2：无在途任务才允许切（硬约束，防止属地错配）
        if (hasInFlightTask) {
            Log.i(TAG, "有在途任务，本次跳过切城")
            return@withContext null
        }

        // 步骤 3：从城市池随机选城（排除当前）
        val pool = loadCityPool(context)
        if (pool.size < 2) {
            Log.w(TAG, "城市池不足（${pool.size} 个），跳过切城")
            return@withContext null
        }
        val currentSlug = Prefs.currentCitySlug(context)
        // 先按 slug 排除当前城市，再随机取（pool 是 CityPoolItemDto 列表，不能直接与 String 做排除）
        val candidates = pool.filterNot { it.slug == currentSlug }
        val target = Rnd.pick(candidates) ?: run {
            Log.w(TAG, "无法选出目标城市")
            return@withContext null
        }
        Log.i(TAG, "随机选中目标城市：${target.city}（${target.slug}），当前=$currentSlug")

        // 步骤 4-7：切换 → 等待 → 探测 → 校验（最多重试 N 次）
        repeat(Config.IP_VERIFY_MAX_ATTEMPTS) { attempt ->
            val node = pickNode(target.slug)
            if (node == null) {
                Log.w(TAG, "城市 ${target.city} 的节点组不可用（provider 可能未刷新）")
                reportEvent(null, "ip_switched", "nodeGroupMissing", null, null)
                return@repeat
            }

            val switched = ClashClient.selectNode(target.slug, node)
            if (!switched) {
                Log.w(TAG, "切换失败（第 ${attempt + 1} 次）")
                return@repeat
            }

            delay(Config.IP_SWITCH_SETTLE_MS)
            val probe = IpProbe.probe()
            if (probe == null) {
                Log.w(TAG, "切换后探测失败（第 ${attempt + 1} 次）")
                return@repeat
            }

            // 属地校验：允许中英文口径差异，交由后台归一化；此处做「非空」与「未回落到当前城」判断
            if (probe.city.isBlank()) {
                Log.w(TAG, "属地为空，无法校验（第 ${attempt + 1} 次）")
                return@repeat
            }
            if (currentSlug != null && probe.city.equals(currentSlug, ignoreCase = true)) {
                Log.w(TAG, "属地未变化（第 ${attempt + 1} 次）")
                return@repeat
            }

            // 步骤 8：立即上报（不等下次心跳）
            Prefs.setCurrentCitySlug(context, target.slug)
            Prefs.markIpSwitched(context, Time.nowMs())
            Prefs.saveIp(context, probe.ip, probe.city)
            reportEvent(null, "ip_switched", null, probe.ip, probe.city)

            // 步骤 9：重排下次切换时间
            lastSwitchElapsedMs = Time.elapsedMs()
            val nextAtMs = Time.nowMs() + periodMs()
            Prefs.setNextIpSwitchAt(context, nextAtMs)

            Bus.emit(Bus.Events.IP_SWITCHED, "${probe.city} / ${probe.ip}")
            Log.i(TAG, "切城完成：${probe.city} ${probe.ip}（来源 ${probe.source}，" +
                "IPv6 泄露=${probe.ipv6Leak}），下次约 ${Time.localText(nextAtMs)}")
            return@withContext (probe.ip to probe.city)
        }

        Log.w(TAG, "切城失败：重试 ${Config.IP_VERIFY_MAX_ATTEMPTS} 次仍未成功")
        reportEvent(null, "ip_switched", "switchFailed", null, null)
        // 失败也重排下次时间，避免进入高频重试
        lastSwitchElapsedMs = Time.elapsedMs()
        Prefs.setNextIpSwitchAt(context, Time.nowMs() + periodMs())
        null
    }

    /** 取该城市节点组里的随机节点（优先非「自动/故障」类节点名） */
    private suspend fun pickNode(slug: String): String? {
        val info = ClashClient.getGroup(slug) ?: return null
        val candidates = info.all.filterNot { it.contains("自动") || it.contains("auto", true) }
        val pool = candidates.ifEmpty { info.all }
        return Rnd.pick(pool)
    }

    private suspend fun loadCityPool(context: Context): List<CityPoolItemDto> {
        val raw = Prefs.cityPoolJson(context) ?: return emptyList()
        return runCatching {
            json.decodeFromString<List<CityPoolItemDto>>(raw)
        }.getOrElse {
            Log.w(TAG, "城市池解析失败：${it.message}")
            emptyList()
        }
    }

    /** 供面板展示：下次切换时间 */
    suspend fun nextSwitchText(context: Context): String {
        val at = Prefs.nextIpSwitchAt(context)
        if (at <= 0L) return "未安排"
        val diff = at - Time.nowMs()
        if (diff <= 0) return "即将切换"
        val hours = diff / 3600_000
        return "${Time.localText(at)}（约 ${hours} 小时后）"
    }
}
