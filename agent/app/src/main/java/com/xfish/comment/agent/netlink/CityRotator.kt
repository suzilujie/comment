package com.xfish.comment.agent.netlink

import android.content.Context
import com.xfish.comment.agent.core.Bus
import com.xfish.comment.agent.core.Config
import com.xfish.comment.agent.core.Log
import com.xfish.comment.agent.core.Rnd
import com.xfish.comment.agent.core.Time
import com.xfish.comment.agent.data.Prefs
import com.xfish.comment.agent.net.CityPoolItemDto
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json

/**
 * 定时切换出口 IP（设计文档 §5.3：**设备自治 + 纯随机跨省**）。
 *
 * 粒度是**省级**：抖音的 IP 属地只显示到省，市级属多余精度 ——
 * 同省内任意城市都算命中，可用节点数量级提升，且不会再有「切到隔壁市就算失败」。
 *
 * 流程：
 *  0. 硬前置：无在途任务（防「评着 A 省帖子、IP 已成 B 省」）；
 *  1. **基线探测**：切换前就不通的话，这不是切城能解决的问题 → 直接放弃 + 告警；
 *  2. 从后台下发的**省份池**随机取若干个（排除当前省份），逐个尝试；
 *  3. 每个省份内：读 group → 校验类型为 select → 随机选节点 → 切换 → 回读确认；
 *  4. 等待连接建立 → **快速探测**新出口 → 校验省份是否命中；
 *  5. 成功则落盘并**立即上报**；失败按**根因分流**。
 *
 * 失败分流（本模块最重要的设计）：
 *  · **ControllerDown**（控制器不可达）—— 与目标省份无关，换多少个都没用 → **立即中止**；
 *  · **GroupMissing**（该省没配 group）—— 换下一个省份可能成功 → **换省**；
 *  · 节点不通 / 属地不符 —— **换省**；
 *  · 全部试完仍失败 —— 网络类 30 分钟后重试（恢复快），配置类等下个周期（改了才有用）。
 *
 * 设计取舍：**不做回滚**。设备的目标是「有网 + 属地可用」，不是「回到原点」，
 * 所以失败后继续换省比切回原节点更直接 —— 但必须配上「尝试上限」防死循环。
 */
object CityRotator {

    private const val TAG = "rotator"
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * 允许切换的组类型（小写比较）。
     * 只有「手动选择」类才安全：url-test / fallback / load-balance 会让 Clash 自行换节点，
     * 导致属地漂移 → 派单后执行前属地已变 → 任务被判 ip_mismatch。
     * 类型名因内核而异：原版 Clash = `Select`，Clash Meta = `Selector`。
     */
    private val MANUAL_GROUP_TYPES = setOf("select", "selector")

    /** 单调时钟锚点：上次切换时的 elapsedRealtime（只在没有 Prefs 记录时兜底用） */
    @Volatile
    private var lastSwitchElapsedMs: Long = 0L

    /**
     * 是否到期。
     *
     * 以 `Prefs.nextIpSwitchAt` 为**权威** —— 成功时是完整周期，失败时是短重试间隔；
     * 没有记录时才回退到「锚点 + 周期」推算。
     */
    suspend fun isDue(context: Context, nowMs: Long = Time.nowMs()): Boolean {
        val at = Prefs.nextIpSwitchAt(context)
        if (at > 0L) return nowMs >= at
        if (lastSwitchElapsedMs == 0L) return false
        return Time.elapsedMs() - lastSwitchElapsedMs >= periodMs()
    }

    /** 周期：2 天 ± 4 小时（抖动避免多设备同刻切换） */
    private fun periodMs(): Long {
        val baseDays = Config.IP_ROTATE_DAYS * 24L * 3600_000L
        val jitterMs = Config.IP_ROTATE_JITTER_HOURS * 3600_000L
        return baseDays + Rnd.long(-jitterMs, jitterMs)
    }

    /** 服务启动时初始化计时锚点与首次切换时间 */
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
        if (Prefs.nextIpSwitchAt(context) <= 0L) {
            val next = Time.nowMs() + periodMs()
            Prefs.setNextIpSwitchAt(context, next)
            Log.i(TAG, "首次安排切城：${Time.localText(next)}")
        }
    }

    /** 单个省份的尝试结果 */
    private sealed interface RegionOutcome {
        data class Success(val ip: String, val region: String) : RegionOutcome

        /** 控制器不可达 —— 与目标省份无关，应中止整轮 */
        object ControllerDown : RegionOutcome

        data class Failed(val reason: String) : RegionOutcome
    }

    /**
     * 执行一次切城。
     * @param hasInFlightTask 由调用方注入（避免本模块直接依赖执行器）
     * @return 成功时返回 (ip, region)，失败返回 null（并已记录日志与上报）
     */
    suspend fun rotate(
        context: Context,
        hasInFlightTask: Boolean,
        reportEvent: suspend (taskId: String?, event: String, reasonCode: String?, ip: String?, city: String?) -> Unit,
    ): Pair<String, String>? = withContext(Dispatchers.IO) {

        // ── 阶段 0：硬前置 ──
        if (hasInFlightTask) {
            Log.i(TAG, "有在途任务，本次跳过切城")
            return@withContext null
        }

        val pool = loadCityPool(context)
        if (pool.size < 2) {
            Log.w(TAG, "省份池不足（${pool.size} 个），跳过切城")
            return@withContext null
        }
        // 已切换到的省份（省名，不是 slug —— 组名对所有省份都相同，无法区分当前在哪）
        val currentRegion = Prefs.currentCitySlug(context)

        // ── 阶段 1：基线探测 ──
        // 切换前就不通 → 换任何省份都不通，而且失败会被误归因到「新节点不通」、
        // 把设备困在一个不通的节点上。所以这里直接放弃并明确告警。
        val baseline = IpProbe.probeFast()
        if (baseline == null) {
            Log.w(TAG, "切换前网络已不通，跳过本次切城（这不是切城能解决的问题）")
            reportEvent(null, "ip_switched", "noNetworkBeforeSwitch", null, null)
            reschedule(context, retrySoon = false)
            return@withContext null
        }
        Log.i(TAG, "基线探测通过：${baseline.region.ifBlank { "-" }} / ${baseline.ip}")

        // ── 阶段 2：省份尝试循环（有上限，防止省份池全是坏省份时死循环）──
        val candidates = pool
            .filterNot { it.city == currentRegion }
            .shuffled()
            .take(Config.IP_SWITCH_MAX_REGION_ATTEMPTS)
        if (candidates.isEmpty()) {
            Log.w(TAG, "排除当前省份后无可选目标（池=${pool.size}，当前=$currentRegion）")
            return@withContext null
        }
        Log.i(TAG, "本轮候选省份：${candidates.joinToString("、") { it.city }}")

        var lastReason: String? = null
        for (target in candidates) {
            Log.i(TAG, "尝试目标省份：${target.city}（${target.slug}）")
            when (val outcome = tryOneRegion(context, target, reportEvent)) {
                is RegionOutcome.Success -> return@withContext (outcome.ip to outcome.region)

                RegionOutcome.ControllerDown -> {
                    // 控制器不可达：与目标省份无关，继续试纯属浪费
                    Log.e(TAG, "Clash 控制器不可达，中止切城（换省份无意义）")
                    reportEvent(null, "ip_switched", "clashUnreachable", null, null)
                    reschedule(context, retrySoon = false)
                    return@withContext null
                }

                is RegionOutcome.Failed -> {
                    Log.w(TAG, "省份 ${target.city} 尝试失败：${outcome.reason}")
                    lastReason = outcome.reason
                }
            }
        }

        Log.w(TAG, "切城失败：已试 ${candidates.size} 个省份，最后原因=${lastReason ?: "-"}")
        reportEvent(null, "ip_switched", lastReason ?: "switchFailed", null, null)
        // 配置类问题改了才有用，不缩短间隔；网络/节点类问题恢复快，30 分钟后再试
        reschedule(context, retrySoon = !isConfigFault(lastReason))
        null
    }

    /** 配置类失败：改配置前重试没有意义 */
    private fun isConfigFault(reason: String?): Boolean = when (reason) {
        "clashUnreachable", "regionGroupMissing", "groupNotSelect", "noNodeInGroup" -> true
        else -> false
    }

    /** 在某个省份内试切（同省最多 [Config.IP_VERIFY_MAX_ATTEMPTS] 个节点） */
    private suspend fun tryOneRegion(
        context: Context,
        target: CityPoolItemDto,
        reportEvent: suspend (String?, String, String?, String?, String?) -> Unit,
    ): RegionOutcome {
        // 组名是「省份节点池」，与目标省份无关 —— 省份由**节点名**表达（见下方按省份挑节点）
        val group = Config.CLASH_CITY_GROUP

        repeat(Config.IP_VERIFY_MAX_ATTEMPTS) { attempt ->
            val tag = "第 ${attempt + 1} 次"

            val info = when (val gr = ClashClient.getGroupResult(group)) {
                ClashClient.GroupResult.ControllerDown -> return RegionOutcome.ControllerDown
                ClashClient.GroupResult.GroupMissing -> {
                    Log.w(TAG, "未找到代理组「$group」（请确认 Clash 里存在该 select 组）")
                    return RegionOutcome.Failed("regionGroupMissing")
                }
                is ClashClient.GroupResult.Ok -> gr.info
            }

            // 硬约定：必须是手动选择组，否则 Clash 会自动换节点导致 IP 漂移。
            // 注意类型名在不同内核上不一致：原版 Clash 返回 "Select"，Clash Meta 返回 "Selector"
            // —— 必须大小写不敏感且兼容两种写法，否则会出现「明明是手动组却被拒绝」。
            if (info.type.lowercase() !in MANUAL_GROUP_TYPES) {
                Log.e(TAG, "组 $group 类型为 ${info.type}，必须是手动选择组 —— 拒绝切换")
                return RegionOutcome.Failed("groupNotSelect")
            }

            val nodePool = info.all
                .filterNot { it.contains("自动") || it.contains("auto", true) }
                .ifEmpty { info.all }
            if (nodePool.isEmpty()) {
                Log.w(TAG, "组 ${target.slug} 无可用节点（$tag）")
                return RegionOutcome.Failed("noNodeInGroup")
            }

            // **优先挑「名字与目标省份匹配」的节点**。
            // 常见的两类配置：
            //  ① 一个组、每省一个节点（节点名就是省份名，如 city-pool 组里的「河北」）
            //     → 必须按省份挑，否则随机选中别的省，属地校验必然失败；
            //  ② 每省一个组、组内多节点（如 province-hebei 组里 5 个河北节点）
            //     → 组内匹配不到省份名，退回随机即可。
            // 不传 slug：slug 是省份唯一标识（province-hebei），与节点名（河北）无关；
            // 省份与节点名靠 city 归一化匹配即可
            val matched = nodePool.filter { RegionName.matches(it, target.city) }
            val node = Rnd.pick(matched.ifEmpty { nodePool })
            if (node == null) {
                Log.w(TAG, "组 ${target.slug} 无法选出节点（$tag）")
                return RegionOutcome.Failed("noNodeInGroup")
            }
            Log.i(
                TAG,
                "选中节点=$node（${if (matched.isEmpty()) "组内随机" else "按省份匹配" }，" +
                    "组内共 ${nodePool.size} 个可选）",
            )

            if (!ClashClient.selectNode(group, node)) {
                Log.w(TAG, "节点切换失败（$tag）group=$group node=$node")
                return@repeat
            }

            delay(Config.IP_SWITCH_SETTLE_MS)
            val probe = IpProbe.probeFast()
            if (probe == null) {
                Log.w(TAG, "切换后探测失败（$tag）node=$node —— 该节点可能不通")
                return@repeat
            }

            // 省份校验：省级归一化，同省内任意城市都算命中
            if (!RegionName.matches(probe.region, target.city, target.slug)) {
                Log.w(
                    TAG,
                    "属地与目标省份不符（$tag）：探测=${probe.region.ifBlank { "-" }}" +
                        "/${probe.city.ifBlank { "-" }} 目标=${target.city}",
                )
                return@repeat
            }

            // ── 成功：落盘 + 立即上报（不等下次心跳）──
            Prefs.setCurrentCitySlug(context, target.city)
            Prefs.markIpSwitched(context, Time.nowMs())
            Prefs.saveIp(context, probe.ip, probe.region)
            reportEvent(null, "ip_switched", null, probe.ip, probe.region)

            lastSwitchElapsedMs = Time.elapsedMs()
            val nextAtMs = Time.nowMs() + periodMs()
            Prefs.setNextIpSwitchAt(context, nextAtMs)

            Bus.emit(Bus.Events.IP_SWITCHED, "${probe.region} / ${probe.ip}")
            Log.i(
                TAG,
                "切城完成：${probe.region}（${probe.city}）${probe.ip} 节点=$node " +
                    "IPv6泄露=${probe.ipv6Leak}，下次约 ${Time.localText(nextAtMs)}",
            )
            return RegionOutcome.Success(probe.ip, probe.region)
        }
        return RegionOutcome.Failed("regionAllNodesFailed")
    }

    /**
     * 重排下次切换时间。
     * @param retrySoon true = 网络类失败，[Config.IP_SWITCH_RETRY_MINUTES] 分钟后重试；
     *                  false = 配置类失败，等下个完整周期（改了配置才有意义）
     */
    private suspend fun reschedule(context: Context, retrySoon: Boolean) {
        lastSwitchElapsedMs = Time.elapsedMs()
        val delayMs = if (retrySoon) Config.IP_SWITCH_RETRY_MINUTES * 60_000L else periodMs()
        val next = Time.nowMs() + delayMs
        Prefs.setNextIpSwitchAt(context, next)
        Log.i(TAG, "下次切城：${Time.localText(next)}（${if (retrySoon) "快速重试" else "等下一周期"}）")
    }

    private suspend fun loadCityPool(context: Context): List<CityPoolItemDto> {
        val raw = Prefs.cityPoolJson(context) ?: return emptyList()
        return runCatching {
            json.decodeFromString<List<CityPoolItemDto>>(raw)
        }.getOrElse {
            Log.w(TAG, "省份池解析失败：${it.message}")
            emptyList()
        }
    }

    /** 供面板展示：下次切换时间 */
    suspend fun nextSwitchText(context: Context): String {
        val at = Prefs.nextIpSwitchAt(context)
        if (at <= 0L) return "未安排"
        val diff = at - Time.nowMs()
        if (diff <= 0) return "即将切换"
        // 失败重试是分钟级，成功周期是小时级 —— 两种都要能读出来
        val mins = diff / 60_000
        return if (mins < 60) {
            "${Time.localText(at)}（约 $mins 分钟后）"
        } else {
            "${Time.localText(at)}（约 ${diff / 3600_000} 小时后）"
        }
    }
}
