package com.xfish.comment.agent.runtime

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import com.xfish.comment.agent.BuildConfig
import com.xfish.comment.agent.accessibility.Actions
import com.xfish.comment.agent.accessibility.Human
import com.xfish.comment.agent.core.Bus
import com.xfish.comment.agent.core.Config
import com.xfish.comment.agent.core.Log
import com.xfish.comment.agent.core.Rnd
import com.xfish.comment.agent.core.Time
import com.xfish.comment.agent.data.AgentDb
import com.xfish.comment.agent.data.Prefs
import com.xfish.comment.agent.exec.AppContextHolder
import com.xfish.comment.agent.exec.MaterialStore
import com.xfish.comment.agent.exec.TaskExecutor
import com.xfish.comment.agent.net.Api
import com.xfish.comment.agent.net.ClaimReq
import com.xfish.comment.agent.net.CommandDto
import com.xfish.comment.agent.net.DeviceStateDto
import com.xfish.comment.agent.net.HeartbeatReq
import com.xfish.comment.agent.net.TaskPackageDto
import com.xfish.comment.agent.net.WalPendingDto
import com.xfish.comment.agent.netlink.CityRotator
import com.xfish.comment.agent.netlink.ClashClient
import com.xfish.comment.agent.netlink.IpProbe
import com.xfish.comment.agent.netlink.RegionName
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * 常驻前台服务：设备端 Agent 的运行时骨架（设计文档 §3.6）。
 *
 * 三条并行循环：
 *  · **心跳循环**：固定 30 秒（±10% 抖动）上报状态，只同步状态、不领任务；
 *  · **领取循环**：空闲且到达本机「可领取时刻」时调用领取接口（设备只猜时机）；
 *  · **切城循环**：到期（2 天 ± 4 小时）且无在途任务时，随机跨城并立即上报。
 *
 * 另有一条 Watchdog 循环检查无障碍是否掉线（掉线需人工重开，必须上报后台告警）。
 */
class AgentService : Service() {

    companion object {
        private const val TAG = "service"

        /** 出口身份探测缓存有效期（心跳复用，避免每次走代理探测） */
        private const val PROBE_TTL_MS = 5 * 60_000L

        @Volatile
        var running: Boolean = false
            private set

        /** 是否正在执行任务（用于跳过某些操作与面板展示） */
        @Volatile
        var executing: Boolean = false
            private set

        /** 当前正在执行的任务号（随心跳上报，让后台知道设备在忙哪一条） */
        @Volatile
        var busyTaskId: String? = null
            private set

        fun start(context: Context) {
            val intent = Intent(context, AgentService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, AgentService::class.java))
        }

        /** 调试入口：立即领取一次（App 内按钮 / 后台指令均可触发） */
        const val ACTION_CLAIM_NOW = "com.xfish.comment.agent.action.CLAIM_NOW"

        /**
         * 请求「立即领取」：跳过本机「距上次完成 + 30~60 分钟」的等待，马上问后台。
         *
         * 注意：只跳过**设备端**等待，后台仍按账号约束裁决
         * （可能返回空 + retryAfterSeconds，属正常结果）。
         */
        fun claimNow(context: Context) {
            val intent = Intent(context, AgentService::class.java).setAction(ACTION_CLAIM_NOW)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        /** 调试入口：立即执行一次切城（跳过 2 天 ± 4 小时的周期） */
        const val ACTION_ROTATE_NOW = "com.xfish.comment.agent.action.ROTATE_NOW"

        fun rotateNow(context: Context) {
            val intent = Intent(context, AgentService::class.java).setAction(ACTION_ROTATE_NOW)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var reporter: Reporter

    private var heartbeatJob: Job? = null
    private var claimJob: Job? = null
    private var rotateJob: Job? = null
    private var watchJob: Job? = null

    /** 原子门闩：保证 bootstrap 只执行一次（开机自启 + App 拉起可能连续触发 onStartCommand） */
    private val bootstrapped = AtomicBoolean(false)

    /** 调试：一次性「立即领取」标志（消费后清空，不改变生产节奏常量） */
    @Volatile
    private var forceClaimOnce: Boolean = false

    /** 等待期唤醒通道：让「立即领取」不必等满 30 秒切片 */
    private val claimWaker = Channel<Unit>(Channel.CONFLATED)

    /** 调试：一次性「立即切城」标志（消费后清空，不改变生产周期常量） */
    @Volatile
    private var forceRotateOnce: Boolean = false

    /** 切城循环唤醒通道：让「立即切城」不必等满 5 分钟切片 */
    private val rotateWaker = Channel<Unit>(Channel.CONFLATED)

    /** 出口身份缓存：心跳不做全量探测（每 30 秒走一次代理探测既慢又费流量） */
    @Volatile
    private var probeCache: IpProbe.Result? = null

    @Volatile
    private var probeCachedAt: Long = 0L

    @Volatile
    private var consecutiveHeartbeatFailures: Int = 0

    private val json = Json { encodeDefaults = false; explicitNulls = false }

    override fun onCreate() {
        super.onCreate()
        running = true
        AppContextHolder.context = applicationContext
        Notify.ensureChannel(this)
        reporter = Reporter(this)
        Log.i(TAG, "服务已创建")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ServiceCompat.startForeground(
            this,
            Config.NOTIFY_ID,
            Notify.build(this, "正在启动…"),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            } else {
                0
            },
        )

        // 调试：立即领取一次（跳过本机「距上次完成 + 30~60 分钟」的等待）
        if (intent?.action == ACTION_CLAIM_NOW) {
            forceClaimOnce = true
            claimWaker.trySend(Unit)
            Log.i(TAG, "收到「立即领取」请求（调试），本轮跳过本机等待")
            Bus.emit(Bus.Events.UI_REFRESH)
        }

        // 调试：立即切城一次（跳过 2 天 ± 4 小时的周期）
        if (intent?.action == ACTION_ROTATE_NOW) {
            forceRotateOnce = true
            rotateWaker.trySend(Unit)
            Log.i(TAG, "收到「立即切城」请求（调试），本轮跳过周期检查")
            Bus.emit(Bus.Events.UI_REFRESH)
        }

        // 原子门闩：开机时 App.onCreate 与 BootReceiver 可能连续拉起服务，
        // 非原子判断会启动两套循环（心跳翻倍 + 并发领取），故只放行一次
        if (bootstrapped.compareAndSet(false, true)) {
            scope.launch { bootstrap() }
        }

        // START_STICKY：被系统杀掉后尽量自动重启
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        running = false
        scope.cancel()
        Log.w(TAG, "服务已销毁")
        super.onDestroy()
    }

    // ── 启动流程 ──────────────────────────────────────────────

    private suspend fun bootstrap() {
        Log.i(TAG, "bootstrap 开始（版本 ${BuildConfig.VERSION_NAME}）")

        Api.baseUrl = Prefs.server(this, BuildConfig.DEFAULT_SERVER)
        Log.i(TAG, "后台地址：${Api.baseUrl}")

        // 崩溃恢复：上次遗留的未决记录一律视为「结果未知」，禁止重试
        recoverUnsettled()

        // 清理上一轮遗留的相册条目与过期素材缓存
        runCatching { MaterialStore.sweepLegacyAlbum(this) }
        runCatching { MaterialStore.pruneCache(this) }

        // 恢复切城计时（单调时钟锚点）
        runCatching { CityRotator.onServiceStart(this) }

        startHeartbeatLoop()
        startClaimLoop()
        startRotateLoop()
        startWatchLoop()

        Log.i(TAG, "bootstrap 完成，三条循环已启动")
    }

    /** 崩溃 / 断电恢复：未决记录无法确认是否已发出 → unknown，且不自动重试 */
    private suspend fun recoverUnsettled() {
        runCatching {
            val dao = AgentDb.get(this).taskDao()
            val list = dao.findUnsettled()
            if (list.isEmpty()) return@runCatching

            Log.w(TAG, "发现 ${list.size} 条未决记录，按 unknown 处理（禁止自动重试）")
            for (rec in list) {
                dao.markFinished(rec.taskId, com.xfish.comment.agent.data.LocalState.UNKNOWN, "crash_recovery", Time.nowMs())
                reporter.sendEvent(
                    event = "task_aborted",
                    taskId = rec.taskId,
                    reasonCode = "crash_recovery_unknown",
                    detail = buildJsonObject {
                        put("note", "进程重启，无法确认是否已发出，请人工核对")
                        put("postUrl", rec.postUrl)
                    },
                )
            }
        }.onFailure { Log.w(TAG, "未决记录恢复失败：${it.message}") }
    }

    // ── ① 心跳循环 ────────────────────────────────────────────

    private fun startHeartbeatLoop() {
        heartbeatJob = scope.launch {
            while (isActive) {
                val ok = runCatching { doHeartbeat() }
                    .onFailure { Log.w(TAG, "心跳异常：${it.message}") }
                    .getOrDefault(false)

                val delayMs = if (ok) {
                    consecutiveHeartbeatFailures = 0
                    Rnd.jitterMs(Config.HEARTBEAT_SECONDS, Config.HEARTBEAT_JITTER_RATIO)
                } else {
                    consecutiveHeartbeatFailures++
                    val backoff = (30_000L * consecutiveHeartbeatFailures)
                        .coerceAtMost(Config.HEARTBEAT_MAX_BACKOFF_SECONDS * 1000L)
                    Log.w(TAG, "心跳失败第 $consecutiveHeartbeatFailures 次，退避 ${backoff / 1000}s")
                    Bus.emit(Bus.Events.HEARTBEAT_FAIL, "第 $consecutiveHeartbeatFailures 次")
                    backoff
                }
                Notify.update(this@AgentService, statusText(ok))
                delay(delayMs)
            }
        }
    }

    private suspend fun doHeartbeat(): Boolean {
        val deviceId = Prefs.deviceId(this)

        // 队列重传（断网期间积压的回执与事件）
        reporter.flushQueues()

        val probe = ensureProbe()

        val walPending = AgentDb.get(this).taskDao().findUnsettled()
            .map { WalPendingDto(it.taskId, it.state) }
            .ifEmpty { null }

        val req = HeartbeatReq(
            deviceId = deviceId,
            seq = Prefs.nextSeq(this),
            state = DeviceStateDto(
                battery = SelfCheck.battery(this),
                storageFreeMb = SelfCheck.storageFreeMb(),
                accessibilityOk = SelfCheck.accessibilityOk(this),
                foregroundOk = SelfCheck.foregroundOk(),
                // 属地是派单硬匹配条件：探测不到属地即视为出口不可用，
                // 让后台据此拒绝派单（而不是上报一个匹配不到任何帖子的地域）。
                proxyOk = probe != null && probe.region.isNotBlank(),
                ip = probe?.ip ?: Prefs.lastIp(this) ?: "0.0.0.0",
                // 上报**省级**属地（与后台帖子/省份池同粒度）；不回退历史值（会掩盖代理异常）。
                // 防呆见 resolveRegionForReport：只有能归一成已知省份才上报真实值。
                ipCity = resolveRegionForReport(probe?.region),
                ipv6Leak = probe?.ipv6Leak,
                agentVersion = BuildConfig.VERSION_NAME,
                rulePackVersion = Prefs.rulePackVersion(this),
                douyinVersion = Actions.versionName(this, Config.PKG_DOUYIN),
                clockOffsetSec = Time.clockOffsetSec(),
            ),
            profile = SelfCheck.profile(this),
            // 契约字段：设备当前在忙哪条任务（由 runTask 维护；早期恒 null，该字段形同虚设）
            busyTaskId = AgentService.busyTaskId,
            walPending = walPending,
            at = System.currentTimeMillis(),
        )

        val resp = Api.heartbeat(req)

        // 校时（所有时间比较以服务端为准）
        Time.onServerTime(resp.serverTimeMs)
        Prefs.markHeartbeat(this)

        // 城市池（仅内容变化时后台才下发）
        resp.cityPool?.let { pool ->
            val version = resp.cityPoolVersion ?: pool.joinToString(",") { it.slug }
            if (Prefs.cityPoolVersion(this) != version) {
                Prefs.saveCityPool(this, version, json.encodeToString(pool))
                Log.i(TAG, "城市池已更新：${pool.joinToString("、") { it.city }}（$version）")
            }
        }

        // 人格档案
        resp.personality?.let { p ->
            if (Prefs.personaVersion(this) != p.version) {
                Prefs.savePersona(this, p.version, p.profile.toString())
                Human.invalidate()
                Log.i(TAG, "人格档案已更新 v${p.version}")
            }
        }

        // 规则包版本
        resp.rulePackVersion?.let { Prefs.setRulePackVersion(this, it) }

        // 指令：按 commandId 去重 + 过期判定。
        // 后台虽有 delivered 标记，但回执丢失时仍可能重复下发 —— 而 rotate_now / restart
        // 这类指令重复执行的副作用不小（连续切城、连续重启服务）。
        for (cmd in resp.commands) {
            if (isCommandExpired(cmd.expireAt)) {
                Log.w(TAG, "指令已过期，忽略：${cmd.kind}（${cmd.commandId}）")
                continue
            }
            if (!markCommandHandled(cmd.commandId)) {
                Log.i(TAG, "指令已处理过，跳过：${cmd.kind}（${cmd.commandId}）")
                continue
            }
            runCatching { handleCommand(cmd) }
                .onFailure { Log.w(TAG, "指令处理失败 ${cmd.kind}: ${it.message}") }
        }

        Bus.emit(Bus.Events.HEARTBEAT_OK, resp)
        Bus.emit(Bus.Events.UI_REFRESH)
        return true
    }

    /**
     * 心跳上报用的属地值。
     *
     * 只有能归一成「可识别的省份」时才上报真实值，否则上报 `unknown`：
     *  · 后台 schema 要求非空（空值会被 400 拒绝）；
     *  · 上报一个必然匹配不上 `posts.city` 的英文原名，只会让「一直领不到任务」
     *    变得极难排查 —— 后台只会回一个 `no_post_in_city`，看不出是归属没归一成功。
     *
     * 归一失败时打 WARN，便于发现映射表缺失的省份。
     */
    private fun resolveRegionForReport(raw: String?): String {
        if (raw.isNullOrBlank()) return "unknown"
        if (RegionName.isResolved(raw)) return RegionName.normalize(raw)
        Log.w(
            TAG,
            "属地无法归一为已知省份（原始值='$raw'），本轮上报 unknown；" +
                "若频繁出现请补 RegionName 映射表",
        )
        return "unknown"
    }

    /** 出口身份：命中缓存直接复用，避免每次心跳都走代理探测 */
    private suspend fun ensureProbe(force: Boolean = false): IpProbe.Result? {
        val now = Time.elapsedMs()
        val fresh = now - probeCachedAt < PROBE_TTL_MS
        if (!force && fresh && probeCache != null) return probeCache

        val result = IpProbe.probe()
        if (result != null) {
            probeCache = result
            probeCachedAt = now
            Prefs.saveIp(this, result.ip, result.region)
        }
        return result
    }

    // ── ② 领取循环 ────────────────────────────────────────────

    private fun startClaimLoop() {
        claimJob = scope.launch {
            while (isActive) {
                try {
                    if (Prefs.isPaused(this@AgentService)) {
                        delay(10_000)
                        continue
                    }
                    if (executing) {
                        delay(3_000)
                        continue
                    }
                    if (!SelfCheck.accessibilityOk(this@AgentService)) {
                        // 无障碍不可用 → 领了也干不了，避免浪费任务
                        delay(20_000)
                        continue
                    }

                    val waitMs = nextEligibleAt() - Time.nowMs()
                    if (waitMs > 0 && !forceClaimOnce) {
                        // 等待期间被「立即领取」唤醒则立刻复查，否则最迟 30 秒后复查
                        val slice = waitMs.coerceAtMost(30_000L).coerceAtLeast(5_000L)
                        withTimeoutOrNull(slice) { claimWaker.receive() }
                        continue
                    }
                    val manualTriggered = forceClaimOnce
                    if (manualTriggered) {
                        forceClaimOnce = false
                        Log.i(TAG, "调试模式：跳过本机等待，立即调用领取接口")
                    }

                    // 属地前置检查：**探测不到属地就不领任务**。
                    // 属地是后台派单的硬匹配条件，领了也会在执行时被判 ip_mismatch 中止，
                    // 既浪费一次派发、又干扰后台统计。手动触发时强制重探，避免用过期缓存误判。
                    val probe = ensureProbe(force = manualTriggered)
                    if (probe == null || probe.region.isBlank()) {
                        Log.w(
                            TAG,
                            "属地未就绪（${probe?.let { "ip=${it.ip} 无属地" } ?: "探测失败"}），本轮不领取，30s 后重试",
                        )
                        delay(30_000)
                        continue
                    }

                    val resp = Api.claim(
                        ClaimReq(
                            deviceId = Prefs.deviceId(this@AgentService),
                            seq = Prefs.nextSeq(this@AgentService),
                            sinceLastFinishSec = sinceLastFinishSec(),
                        ),
                    )
                    Time.onServerTime(resp.serverTimeMs)
                    Prefs.markClaim(this@AgentService)

                    val task = resp.task
                    if (task == null) {
                        val retry = (resp.retryAfterSeconds ?: Config.CLAIM_FALLBACK_RETRY_SECONDS)
                        Log.d(TAG, "领取为空：${resp.reason ?: "-"}，${retry}s 后重试")
                        Bus.emit(Bus.Events.TASK_EMPTY, resp.reason ?: "empty")
                        // 退避期间同样允许被「立即领取」唤醒：
                        // 否则手动触发要等满整个退避（曾出现点了两次都无响应、5 分钟后才生效）
                        val backoffMs = retry.coerceAtLeast(Config.CLAIM_MIN_LOOP_SECONDS) * 1000L
                        withTimeoutOrNull(backoffMs) { claimWaker.receive() }
                        continue
                    }

                    runTask(task)
                } catch (e: Exception) {
                    Log.w(TAG, "领取循环异常：${e.message}")
                    delay(20_000)
                }
            }
        }
    }

    private suspend fun runTask(task: TaskPackageDto) {
        executing = true
        busyTaskId = task.taskId
        Notify.update(this, "执行中：${task.postId}")
        Bus.emit(Bus.Events.TASK_CLAIMED, task)
        try {
            val outcome = TaskExecutor.execute(this, task, reporter)
            Log.i(TAG, "任务结束 ${task.taskId} → ${outcome.status}")
        } catch (e: Exception) {
            Log.e(TAG, "任务执行抛出异常（执行器内部应已兜底）", e)
        } finally {
            executing = false
            busyTaskId = null
            // 重置「可领取时刻」：距本次完成 + 随机 30–60 分钟
            val next = Time.nowMs() + Rnd.long(
                Config.CLAIM_MIN_INTERVAL_MIN * 60_000L,
                Config.CLAIM_MAX_INTERVAL_MIN * 60_000L,
            )
            Prefs.setNextEligibleAt(this, next)
            Log.i(TAG, "下次可领取时间：${Time.localText(next)}")
            // 出口探测缓存失效（执行过程中可能发生网络变化）
            probeCachedAt = 0
            Notify.update(this, statusText(true))
            Bus.emit(Bus.Events.UI_REFRESH)
        }
    }

    /**
     * 本机「可领取时刻」：
     *  · 若已有记录，直接用；
     *  · 否则按「距上次完成 + 随机 30–60 分钟」计算并固化
     *    （**必须固化**，否则每次计算都会得到不同结果，导致时机抖动）。
     */
    private suspend fun nextEligibleAt(): Long {
        val stored = Prefs.nextEligibleAt(this)
        if (stored > 0L) return stored

        val lastFinish = AgentDb.get(this).taskDao().lastFinishAt()
        val value = if (lastFinish == null) {
            0L // 从未执行过 → 立即可领
        } else {
            lastFinish + Rnd.long(
                Config.CLAIM_MIN_INTERVAL_MIN * 60_000L,
                Config.CLAIM_MAX_INTERVAL_MIN * 60_000L,
            )
        }
        Prefs.setNextEligibleAt(this, value)
        return value
    }

    private suspend fun sinceLastFinishSec(): Long? {
        val last = AgentDb.get(this).taskDao().lastFinishAt() ?: return null
        return ((Time.nowMs() - last) / 1000).coerceAtLeast(0)
    }

    // ── ③ 切城循环 ────────────────────────────────────────────

    private fun startRotateLoop() {
        rotateJob = scope.launch {
            while (isActive) {
                // 每 5 分钟检查一次是否到期；期间可被「立即切城」唤醒
                withTimeoutOrNull(5 * 60_000L) { rotateWaker.receive() }
                if (Prefs.isPaused(this@AgentService)) continue
                if (executing) continue
                if (!forceRotateOnce && !CityRotator.isDue(this@AgentService)) continue
                if (forceRotateOnce) {
                    forceRotateOnce = false
                    Log.i(TAG, "调试模式：跳过周期检查，立即切城")
                } else {
                    Log.i(TAG, "切城周期到期，开始随机跨城")
                }
                runCatching {
                    CityRotator.rotate(
                        context = this@AgentService,
                        hasInFlightTask = hasInFlightTask(),
                        reportEvent = { taskId, event, reason, ip, city ->
                            reporter.sendEvent(
                                event = event,
                                taskId = taskId,
                                reasonCode = reason,
                                ip = ip,
                                ipCity = city,
                                ipv6Leak = probeCache?.ipv6Leak,
                            )
                        },
                    )
                }.onFailure { Log.w(TAG, "切城异常：${it.message}") }

                // 探测缓存失效，让下一次心跳重新探测
                probeCachedAt = 0
                Bus.emit(Bus.Events.UI_REFRESH)
            }
        }
    }

    /** 是否存在在途任务（切城的硬前置条件） */
    private suspend fun hasInFlightTask(): Boolean {
        if (executing) return true
        return runCatching { AgentDb.get(this).taskDao().findUnsettled().isNotEmpty() }
            .getOrDefault(false)
    }

    // ── ④ Watchdog ───────────────────────────────────────────

    private fun startWatchLoop() {
        watchJob = scope.launch {
            while (isActive) {
                delay(30_000L)
                runCatching {
                    val needHuman = Watchdog.check(this@AgentService)
                    if (needHuman) {
                        reporter.sendEvent(
                            event = "device_offline_notice",
                            reasonCode = "accessibility_down",
                            detail = buildJsonObject {
                                put("describe", Watchdog.describe(this@AgentService))
                                put("downCount", Watchdog.a11yDownCount)
                            },
                        )
                        Notify.update(this@AgentService, "需要人工处理：无障碍服务已关闭")
                    }
                }.onFailure { Log.w(TAG, "watchdog 异常：${it.message}") }
            }
        }
    }

    // ── 指令处理 ─────────────────────────────────────────────

    /** 已处理指令 ID → 处理时刻（单调时钟），用于防御性去重 */
    private val handledCommandIds = java.util.concurrent.ConcurrentHashMap<String, Long>()

    /** @return true = 首次处理（应执行）；false = 已处理过（跳过） */
    private fun markCommandHandled(id: String): Boolean {
        val now = Time.elapsedMs()
        // 超过 64 条时清理 1 小时前的记录，避免长期运行无限增长
        if (handledCommandIds.size > 64) {
            handledCommandIds.entries.removeIf { now - it.value > 3_600_000L }
        }
        return handledCommandIds.putIfAbsent(id, now) == null
    }

    /** 指令是否已过期（expireAt 为 ISO 串；解析失败按「未过期」处理，宁可执行也不漏） */
    private fun isCommandExpired(expireAt: String?): Boolean {
        if (expireAt.isNullOrBlank()) return false
        return runCatching {
            java.time.OffsetDateTime.parse(expireAt).toInstant().toEpochMilli() < System.currentTimeMillis()
        }.getOrDefault(false)
    }

    private suspend fun handleCommand(cmd: CommandDto) {
        Log.i(TAG, "收到指令：${cmd.kind}（${cmd.commandId}）")
        when (cmd.kind) {
            "probe" -> {
                val detail = SelfCheck.run(this)
                reporter.sendEvent(event = "probe_result", commandId = cmd.commandId, detail = detail)
                val missing = SelfCheck.probeCriticalLocators(this)
                if (missing.isNotEmpty()) {
                    Log.w(TAG, "关键元素未命中：${missing.joinToString("、")}（新机型需先适配）")
                }
            }

            "switch_node" -> {
                val slug = cmd.payload?.get("slug")?.jsonPrimitive?.contentOrNullSafe()
                val node = cmd.payload?.get("node")?.jsonPrimitive?.contentOrNullSafe()
                val ok = if (slug != null && node != null) ClashClient.selectNode(slug, node) else false
                reporter.sendEvent(
                    event = "command_result",
                    commandId = cmd.commandId,
                    reasonCode = if (ok) null else "switch_failed",
                    detail = buildJsonObject {
                        put("ok", ok)
                        put("slug", slug ?: "")
                        put("node", node ?: "")
                    },
                )
                if (ok) probeCachedAt = 0
            }

            "rotate_now" -> {
                // 后台下发的调试指令：等效于 App 内「立即切城」按钮
                forceRotateOnce = true
                rotateWaker.trySend(Unit)
                reporter.sendEvent(
                    event = "command_result",
                    commandId = cmd.commandId,
                    detail = buildJsonObject { put("ok", true); put("action", "rotate_now") },
                )
            }

            "claim_now" -> {
                // 后台下发的调试指令：等效于 App 内「立即领取」按钮
                forceClaimOnce = true
                claimWaker.trySend(Unit)
                reporter.sendEvent(
                    event = "command_result",
                    commandId = cmd.commandId,
                    detail = buildJsonObject { put("ok", true); put("action", "claim_now") },
                )
            }

            "pause" -> {
                Prefs.setPaused(this, true)
                Notify.update(this, "已暂停接单（后台指令）")
                reporter.sendEvent(
                    event = "command_result",
                    commandId = cmd.commandId,
                    detail = buildJsonObject { put("ok", true); put("action", "paused") },
                )
            }

            "resume" -> {
                Prefs.setPaused(this, false)
                Notify.update(this, statusText(true))
                reporter.sendEvent(
                    event = "command_result",
                    commandId = cmd.commandId,
                    detail = buildJsonObject { put("ok", true); put("action", "resumed") },
                )
            }

            "refresh_pool" -> {
                // 下一次心跳会重新拉取城市池；此处立即触发一次心跳
                runCatching { doHeartbeat() }
                reporter.sendEvent(
                    event = "command_result",
                    commandId = cmd.commandId,
                    detail = buildJsonObject { put("ok", true); put("action", "pool_refreshed") },
                )
            }

            "restart" -> {
                reporter.sendEvent(
                    event = "command_result",
                    commandId = cmd.commandId,
                    detail = buildJsonObject { put("ok", true); put("action", "restarting") },
                )
                delay(800)
                scope.launch {
                    stopSelf()
                    delay(1_500)
                    start(applicationContext)
                }
            }

            "upgrade" -> {
                // 自更新属 P2；此处仅回报未实现，避免后台等待
                Log.w(TAG, "upgrade 指令尚未实现（P2）")
                reporter.sendEvent(
                    event = "command_result",
                    commandId = cmd.commandId,
                    reasonCode = "not_implemented",
                    detail = buildJsonObject { put("ok", false); put("note", "P2 自更新未实现") },
                )
            }

            else -> Log.w(TAG, "未知指令：${cmd.kind}")
        }
    }

    private suspend fun statusText(heartbeatOk: Boolean): String = buildString {
        val paused = Prefs.isPaused(this@AgentService)
        when {
            paused -> append("已暂停接单")
            executing -> append("执行任务中")
            heartbeatOk -> {
                append("在线")
                probeCache?.region?.takeIf { it.isNotBlank() }?.let { append(" · $it") }
            }
            else -> append("心跳异常（重试中）")
        }
    }
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? =
    runCatching { content }.getOrNull()?.takeIf { it.isNotBlank() && it != "null" }
