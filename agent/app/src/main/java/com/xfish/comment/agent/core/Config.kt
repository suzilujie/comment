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
    const val HEARTBEAT_JITTER_RATIO = 0.10
    /** 心跳连续失败的退避上限（秒） */
    const val HEARTBEAT_MAX_BACKOFF_SECONDS = 300

    // ── 任务领取（§5.1）────────────────────────────────────────
    /** 领取时机 = 距上次「完成」+ 本机随机 [30, 60] 分钟（设备只猜时机） */
    const val CLAIM_MIN_INTERVAL_MIN = 30
    const val CLAIM_MAX_INTERVAL_MIN = 60
    /** 被后台拒绝（返回空）后的最小退避（秒）；后台会返回 retryAfterSeconds 覆盖 */
    const val CLAIM_FALLBACK_RETRY_SECONDS = 300
    /** 领取轮询的最小间隔（秒），防止异常时狂刷 */
    const val CLAIM_MIN_LOOP_SECONDS = 30

    // ── 切 IP（§5.3，设备自治 + 纯随机跨城）─────────────────────
    /** 轮换周期：2 天 */
    const val IP_ROTATE_DAYS = 2
    /** 周期抖动：±4 小时（避免多设备同刻切换） */
    const val IP_ROTATE_JITTER_HOURS = 4
    /** 切换后等待连接建立的时长（毫秒） */
    const val IP_SWITCH_SETTLE_MS = 4_000L
    /** 属地校验重试次数 */
    const val IP_VERIFY_MAX_ATTEMPTS = 3

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
        const val VERIFY_FAILED = "verify_failed"
        const val RATE_LIMITED = "rate_limited"
        const val CAPTCHA = "captcha"
        const val RISK_DIALOG = "risk_dialog"
        const val NETWORK = "network"
        const val UNKNOWN = "unknown"
    }
}
