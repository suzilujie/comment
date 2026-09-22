package com.xfish.comment.agent.net

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * 设备 ↔ 后台的传输对象。
 *
 * ⚠ 这些类必须与后台 `backend/src/contracts/agent.ts` 与 `platform.ts` 的 Zod 契约
 *    **字段名一一对应**；任何一端改动都要同步另一端（设计文档 §9.3 契约单一来源）。
 *    契约测试见 `ContractTest.kt`（用样例报文双向校验）。
 */

// ──────────────────────── 设备 → 后台 ────────────────────────

/** 设备状态快照（心跳第 1 段的载体） */
@Serializable
data class DeviceStateDto(
    val battery: Int? = null,
    val storageFreeMb: Int? = null,
    /** 无障碍服务是否启用（决定能否干活） */
    val accessibilityOk: Boolean,
    /** Agent 前台服务是否存活 */
    val foregroundOk: Boolean,
    /** 代理是否连通 */
    val proxyOk: Boolean,
    /** 出口 IP（必须走代理请求公网探针获得） */
    val ip: String,
    /** 出口 IP 所属城市（属地校验依据） */
    val ipCity: String,
    /** IPv6 是否泄露（true = 存在直连风险） */
    val ipv6Leak: Boolean? = null,
    val agentVersion: String,
    val rulePackVersion: String? = null,
    val douyinVersion: String? = null,
    /** 本机时钟偏移（秒，正数表示设备快） */
    val clockOffsetSec: Int? = null,
)

/** 机型档案（多机型适配与规则包分槽依据） */
@Serializable
data class DeviceProfileDto(
    val model: String,
    /** 形如 2400x1080 */
    val resolution: String,
    val dpi: Int? = null,
    val osVersion: String,
    val romVersion: String? = null,
    val fontScale: Float? = null,
    val darkMode: Boolean? = null,
)

/** 本地未决记录（WAL） */
@Serializable
data class WalPendingDto(val taskId: String, val state: String)

/** ① 心跳请求 */
@Serializable
data class HeartbeatReq(
    val deviceId: String,
    val seq: Long,
    val state: DeviceStateDto,
    val profile: DeviceProfileDto? = null,
    val busyTaskId: String? = null,
    val walPending: List<WalPendingDto>? = null,
    /** 设备本地时间（毫秒），仅用于诊断 */
    val at: Long? = null,
)

/** ② 领取请求 */
@Serializable
data class ClaimReq(
    val deviceId: String,
    val seq: Long,
    /** 距上次完成的秒数（设备端猜测，仅诊断用） */
    val sinceLastFinishSec: Long? = null,
)

/** ③ 事件请求 */
@Serializable
data class EventReq(
    val deviceId: String,
    /** task_started / task_aborted / ip_switched / device_offline_notice / command_result / probe_result */
    val event: String,
    val taskId: String? = null,
    val commandId: String? = null,
    val reasonCode: String? = null,
    val ip: String? = null,
    val ipCity: String? = null,
    val ipv6Leak: Boolean? = null,
    val detail: JsonObject? = null,
    val at: Long? = null,
)

/** ④ 回执请求 */
@Serializable
data class ReceiptReq(
    val deviceId: String,
    val taskId: String,
    /** succeeded / failed / aborted / unknown */
    val status: String,
    val reasonCode: String? = null,
    val evidence: String? = null,
    val idempotencyKey: String? = null,
    val startedAt: Long? = null,
    val finishedAt: Long? = null,
    val detail: JsonObject? = null,
)

// ──────────────────────── 后台 → 设备 ────────────────────────

/** 设备指令（commandId 幂等） */
@Serializable
data class CommandDto(
    val commandId: String,
    val kind: String,
    val payload: JsonObject? = null,
    val expireAt: String? = null,
)

/** 城市池条目（slug 即 Clash 的 provider 名与 group 名） */
@Serializable
data class CityPoolItemDto(val city: String, val slug: String)

/** 人格档案（人格层长期稳定；波动层在设备端抽样） */
@Serializable
data class PersonalityDto(
    val version: Int,
    val profile: JsonObject,
)

/** ① 心跳响应 */
@Serializable
data class HeartbeatResp(
    val serverTimeMs: Long,
    val serverTime: String,
    val nextHeartbeatSeconds: Int,
    val commands: List<CommandDto> = emptyList(),
    val cityPool: List<CityPoolItemDto>? = null,
    val cityPoolVersion: String? = null,
    val personality: PersonalityDto? = null,
    val rulePackVersion: String? = null,
    val eligibleForTask: Boolean = false,
)

/** 图片素材（随任务携带，内网通道下载） */
@Serializable
data class TaskImageDto(
    val hash: String,
    val url: String,
    val sizeBytes: Int? = null,
)

/** 任务包（§4.1） */
@Serializable
data class TaskPackageDto(
    val taskId: String,
    val postId: String,
    val postUrl: String,
    val accountId: String,
    val actions: List<String>,
    /** text / image */
    val commentType: String,
    val scriptText: String,
    val scriptId: String? = null,
    val image: TaskImageDto? = null,
    /** 回执截止时间（ISO，带 +08:00） */
    val deadlineAt: String,
    /** 派单时刻的出口城市（设备端执行前需自查一致） */
    val ipCityTarget: String,
)

/** ② 领取响应 */
@Serializable
data class ClaimResp(
    val serverTimeMs: Long,
    val serverTime: String,
    val task: TaskPackageDto? = null,
    val retryAfterSeconds: Int? = null,
    val reason: String? = null,
)

/** ③④ 通用响应 */
@Serializable
data class AckResp(
    val ok: Boolean,
    val serverTimeMs: Long,
    /** unknown_no_retry / retry_allowed / none */
    val walDecision: String? = null,
    val message: String? = null,
)

/** 错误响应体（后台统一格式：{ ok:false, code, error }） */
@Serializable
data class ErrorResp(
    val ok: Boolean = false,
    val code: String? = null,
    val error: String? = null,
    @SerialName("message") val messageAlt: String? = null,
)
