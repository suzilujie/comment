package com.xfish.comment.agent.core

/**
 * 设备端常量（设计文档 §4.4 / §5.1 / §5.3 / §6.3）。
 *
 * 约定：这里只放「与后台契约相关、改了必须两边同步」的值；
 * 可在运行期调整的参数（后台地址、注册口令等）走 Prefs（DataStore）。
 */
object Config {

    // ── 心跳（§4.4）────────────────────────────────────────────
    /** 心跳基准间隔：固定 30 秒 */
    const val HEARTBEAT_SECONDS = 30
    /** 心跳抖动比例：±10%（避免数十台设备同一秒打点） */
    /**
     * 心跳抖动比例。
     *
     * ⚠ 200 台规模下这个值很关键：稳态心跳若太整齐，就变成周期性洪峰。
     * 0.20 = ±6 秒，把 200 台摊在 12 秒的窗口里（后台 onlineThreshold 完全能容忍）。
     */
    const val HEARTBEAT_JITTER_RATIO = 0.20

    /**
     * 首次心跳的**启动错峰上限**（毫秒）。
     *
     * 稳态有心跳抖动，但**首次心跳是同步的**（bootstrap 一完成就发）——
     * 200 台批量安装 / 一起重启时会在同一秒内打后台。这里做一次性随机延迟摊开洪峰。
     */
    const val HEARTBEAT_STARTUP_JITTER_MS = 20_000L
    /** 心跳连续失败的退避上限（秒） */
    const val HEARTBEAT_MAX_BACKOFF_SECONDS = 300

    /**
     * 后台可下发的心跳间隔上下限（秒）。
     *
     * 后台会在心跳响应里返回 `nextHeartbeatSeconds`，设备按它排期（见
     * `AgentService.serverHeartbeatSeconds`）。夹一层区间防止误配置：
     * 下发 0 会打成忙等、下发 86400 会让设备"看起来永久离线"。
     */
    const val HEARTBEAT_SECONDS_MIN = 10
    const val HEARTBEAT_SECONDS_MAX = 300

    // ── 任务领取（§5.1）────────────────────────────────────────
    /** 领取时机 = 距上次「完成」+ 本机随机 [30, 60] 分钟（设备只猜时机） */
    const val CLAIM_MIN_INTERVAL_MIN = 30
    const val CLAIM_MAX_INTERVAL_MIN = 60
    /** 被后台拒绝（返回空）后的最小退避（秒）；后台会返回 retryAfterSeconds 覆盖 */
    const val CLAIM_FALLBACK_RETRY_SECONDS = 300
    /** 领取轮询的最小间隔（秒），防止异常时狂刷 */
    const val CLAIM_MIN_LOOP_SECONDS = 30

    // ── 切 IP（§5.3，设备自治 + 纯随机跨省）─────────────────────
    /** 轮换周期：2 天 */
    const val IP_ROTATE_DAYS = 2
    /** 周期抖动：±4 小时（避免多设备同刻切换） */
    const val IP_ROTATE_JITTER_HOURS = 4
    /** 切换后等待连接建立的时长（毫秒） */
    const val IP_SWITCH_SETTLE_MS = 4_000L
    /** **单个省份内**的节点尝试次数（同省内换节点重试） */
    const val IP_VERIFY_MAX_ATTEMPTS = 3
    /** 一次切城最多尝试几个省份（防止城市池全是坏省份时死循环） */
    const val IP_SWITCH_MAX_REGION_ATTEMPTS = 3
    /**
     * 切城失败后的重试间隔（分钟）。
     * 网络类故障（节点临时挂掉）恢复很快，没必要等满整个轮换周期。
     */
    const val IP_SWITCH_RETRY_MINUTES = 30

    /**
     * Clash 里承载「省份节点池」的代理组名。
     *
     * 支持两种常见配置，代码会自动适配：
     *  ① **一个组、每省一个节点**（当前配置）：组内节点名即省份名（如「河北」「浙江」），
     *     切城时按省份名挑节点；
     *  ② 每省一个组、组内多节点（如 province-hebei）：组内匹配不到省份名，退回随机选。
     *
     * ⚠ 组的 type 必须是 `select`（url-test / fallback 会让 Clash 自行换节点导致 IP 漂移）。
     */
    const val CLASH_CITY_GROUP = "city-pool"

    // ── HTTP ─────────────────────────────────────────────────
    const val HTTP_CONNECT_TIMEOUT_SECONDS = 10L
    const val HTTP_READ_TIMEOUT_SECONDS = 20L
    const val HTTP_WRITE_TIMEOUT_SECONDS = 15L

    // ── 抖音 ─────────────────────────────────────────────────
    /** 抖音主包名（唤起与归属判断） */
    const val PKG_DOUYIN = "com.ss.android.ugc.aweme"
    const val PKG_DOUYIN_LITE = "com.ss.android.ugc.aweme.lite"

    // ── 通知 ─────────────────────────────────────────────────
    const val NOTIFY_CHANNEL_ID = "agent_foreground"
    const val NOTIFY_ID = 1001

    /**
     * 定位器连续失效多少次后暂停领取。
     *
     * 抖音改版（或换新机型）会让定位器整批失效，此时继续领任务只是持续浪费后台派发、
     * 并在后台堆积 element_missing / post_mismatch。达到阈值后停领并告警，等人工适配。
     */
    const val LOCATOR_FAIL_STREAK_PAUSE = 3

    /** 定位器失效后的暂停时长（毫秒） */
    const val LOCATOR_FAIL_PAUSE_MS = 30 * 60_000L

    // ── 回执原因码（与后台约定，便于统计归因）───────────────────
    object Reason {
        const val IP_MISMATCH = "ip_mismatch"           // 出口属地与目标城市不一致
        const val DUPLICATE_TASK = "duplicate_task"     // 幂等：该任务已执行过
        const val ACCESSIBILITY_OFF = "accessibility_off"
        const val DOUYIN_NOT_LAUNCHED = "douyin_not_launched"
        const val LOGIN_INVALID = "login_invalid"
        const val POST_MISMATCH = "post_mismatch"       // 打开的不是目标帖子
        const val ELEMENT_MISSING = "element_missing"
        const val INPUT_FAILED = "input_failed"
        const val SUBMIT_FAILED = "submit_failed"
        /** 图文评论：图片没能贴到评论上（**未发送**，按 aborted 上报，可退配额） */
        const val IMAGE_ATTACH_FAILED = "image_attach_failed"
        const val VERIFY_FAILED = "verify_failed"
        const val RATE_LIMITED = "rate_limited"
        const val CAPTCHA = "captcha"
        const val RISK_DIALOG = "risk_dialog"
        const val NETWORK = "network"
        const val UNKNOWN = "unknown"
        const val DEADLINE_EXCEEDED = "deadline_exceeded"   // 已过后台截止时间，未提交
    }
}
