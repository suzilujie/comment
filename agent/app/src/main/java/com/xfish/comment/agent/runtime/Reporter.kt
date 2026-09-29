package com.xfish.comment.agent.runtime

import android.content.Context
import com.xfish.comment.agent.core.Bus
import com.xfish.comment.agent.core.Log
import com.xfish.comment.agent.core.Time
import com.xfish.comment.agent.data.AgentDb
import com.xfish.comment.agent.data.EventRecord
import com.xfish.comment.agent.data.LocalState
import com.xfish.comment.agent.data.Prefs
import com.xfish.comment.agent.data.ReceiptRecord
import com.xfish.comment.agent.exec.TaskExecutor
import com.xfish.comment.agent.net.AckResp
import com.xfish.comment.agent.net.Api
import com.xfish.comment.agent.net.ApiException
import com.xfish.comment.agent.net.EventReq
import com.xfish.comment.agent.net.ReceiptReq
import com.xfish.comment.agent.net.TaskPackageDto
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 状态上报器（设计文档 §4.4 第 3 条链：回传执行状态）。
 *
 * 两条铁律：
 *  1. **即时上报**：开工信号与回执独立于心跳，秒级送达；
 *  2. **断网不丢**：上报失败写入本地队列（Room），恢复后重传，带幂等键由后台去重。
 */
class Reporter(private val context: Context) : TaskExecutor.Reporter {

    private companion object {
        const val TAG = "reporter"
        const val MAX_ATTEMPTS = 30
    }

    private val json = Json { encodeDefaults = false; explicitNulls = false }

    override suspend fun onStarted(taskId: String) {
        sendEvent(
            event = "task_started",
            taskId = taskId,
            reasonCode = null,
            detail = null,
        )
        Bus.emit(Bus.Events.TASK_STARTED, taskId)
        Log.i(TAG, "已上报 task_started: $taskId")
    }

    override suspend fun onFinished(task: TaskPackageDto, outcome: TaskExecutor.Outcome) {
        // finishedAt 只取一次：它同时参与幂等键与请求体，写两次 nowMs() 会得到不同值
        val finishedAt = outcome.finishedAt ?: Time.nowMs()
        val req = ReceiptReq(
            deviceId = Prefs.deviceId(context),
            taskId = task.taskId,
            status = outcome.status,
            reasonCode = outcome.reasonCode,
            evidence = outcome.evidence,
            idempotencyKey = "${task.taskId}:${outcome.status}:$finishedAt",
            startedAt = outcome.startedAt,
            finishedAt = finishedAt,
            detail = outcome.detail,
        )
        val payload = json.encodeToString(ReceiptReq.serializer(), req)

        try {
            val ack = Api.receipt(req)
            val normal = handleAck(task.taskId, ack)
            markReported(task.taskId, normal)
            Log.i(TAG, "回执已送达：${task.taskId} → ${outcome.status}")
        } catch (e: Exception) {
            Log.w(TAG, "回执上报失败，转本地队列：${e.message}")
            enqueueReceipt(task.taskId, outcome, payload)
        }

        Bus.emit(Bus.Events.TASK_FINISHED, "${outcome.status}/${outcome.reasonCode ?: "-"}")
    }

    /**
     * 崩溃 / 断电恢复：把一条**未决记录**按 `unknown` 上报。
     *
     * ⚠ 必须走**回执通道**，不能用 `task_aborted` 事件：
     *   后台把 `task_aborted` 一律落成 `aborted`，而 aborted 的语义是「**确认未发出**」——
     *   会退还当日配额并**释放帖子名额**，于是同一设备可以被**重新派到同一帖**；
     *   可这条评论其实**可能已经发出去了**（进程是在评论发出之后才被杀的）
     *   → 同一个帖子下面出现两条评论，撤不回来。
     *
     *   本地既然记的是 `UNKNOWN`，上报口径就必须一致：unknown 不退还、继续占着名额、转人工核对。
     */
    suspend fun reportUnknownAfterCrash(taskId: String, postUrl: String?) {
        val now = Time.nowMs()
        val req = ReceiptReq(
            deviceId = Prefs.deviceId(context),
            taskId = taskId,
            status = "unknown",
            reasonCode = "crash_recovery_unknown",
            evidence = "crash_recovery",
            idempotencyKey = "$taskId:unknown:$now",
            finishedAt = now,
            detail = buildJsonObject {
                put("note", "进程重启，无法确认是否已发出，请人工核对")
                if (!postUrl.isNullOrBlank()) put("postUrl", postUrl)
            },
        )
        val payload = json.encodeToString(ReceiptReq.serializer(), req)
        try {
            val ack = Api.receipt(req)
            markReported(taskId, handleAck(taskId, ack))
            Log.i(TAG, "崩溃恢复回执已送达：$taskId → unknown（禁止自动重试）")
        } catch (e: Exception) {
            Log.w(TAG, "崩溃恢复回执上报失败，转本地队列：${e.message}")
            enqueueReceipt(
                taskId,
                TaskExecutor.Outcome("unknown", "crash_recovery_unknown", "crash_recovery"),
                payload,
            )
        }
    }

    /** 上报一条事件（开工 / 中止 / 切 IP / 指令结果 / 自检结果） */
    suspend fun sendEvent(
        event: String,
        taskId: String? = null,
        commandId: String? = null,
        reasonCode: String? = null,
        detail: JsonObject? = null,
        ip: String? = null,
        ipCity: String? = null,
        ipv6Leak: Boolean? = null,
    ): Boolean {
        val req = EventReq(
            deviceId = Prefs.deviceId(context),
            event = event,
            taskId = taskId,
            commandId = commandId,
            reasonCode = reasonCode,
            ip = ip,
            ipCity = ipCity,
            ipv6Leak = ipv6Leak,
            detail = detail,
            at = Time.nowMs(),
        )
        return try {
            Api.event(req)
            true
        } catch (e: Exception) {
            Log.w(TAG, "事件上报失败（入队）：$event ${e.message}")
            enqueueEvent(event, taskId, commandId, reasonCode, json.encodeToString(EventReq.serializer(), req))
            false
        }
    }

    // ── 队列与重传 ───────────────────────────────────────────

    /** 重传本地队列（每次心跳前调用一次即可） */
    suspend fun flushQueues() {
        val db = AgentDb.get(context)

        // 回执队列
        runCatching {
            db.receiptDao().pending(20).forEach { rec ->
                try {
                    val req = json.decodeFromString(ReceiptReq.serializer(), rec.payloadJson)
                    val ack = Api.receipt(req)
                    val normal = handleAck(rec.taskId, ack)
                    markReported(rec.taskId, normal)
                    db.receiptDao().delete(rec.id)
                    Log.i(TAG, "重传回执成功：${rec.taskId}（第 ${rec.attempts + 1} 次）")
                } catch (e: Exception) {
                    db.receiptDao().bumpAttempts(rec.id)
                    if (isPermanentFailure(e)) {
                        // ⚠ 服务端明确拒绝（4xx / 解析失败）时**必须丢弃并继续**：
                        // 队列按 createdAt 顺序处理，留着这条毒记录会阻塞它后面**所有**回执
                        // （早期直接 throw，一条坏记录能把整个队列拖到 attempts 耗尽）。
                        Log.e(TAG, "回执被服务端拒绝，丢弃 ${rec.taskId}: ${e.message}")
                        db.receiptDao().delete(rec.id)
                    } else {
                        Log.w(TAG, "回执重传失败 ${rec.taskId}: ${e.message}")
                        throw e // 网络仍未恢复，本轮不再继续
                    }
                }
            }
            db.receiptDao().dropExhausted(MAX_ATTEMPTS)
        }.onFailure { }

        // 事件队列
        runCatching {
            db.eventDao().pending(30).forEach { rec ->
                try {
                    val req = json.decodeFromString(EventReq.serializer(), rec.payloadJson)
                    Api.event(req)
                    db.eventDao().delete(rec.id)
                } catch (e: Exception) {
                    db.eventDao().bumpAttempts(rec.id)
                    if (isPermanentFailure(e)) {
                        Log.e(TAG, "事件被服务端拒绝，丢弃 ${rec.event}: ${e.message}")
                        db.eventDao().delete(rec.id)
                    } else {
                        throw e
                    }
                }
            }
            db.eventDao().dropExhausted(MAX_ATTEMPTS)
        }.onFailure { }
    }

    suspend fun pendingCounts(): Pair<Int, Int> {
        val db = AgentDb.get(context)
        return runCatching { db.receiptDao().count() to db.eventDao().count() }
            .getOrDefault(0 to 0)
    }

    // ── 内部 ────────────────────────────────────────────────

    /**
     * 处理后台裁决。
     * @return true = 正常终结（本地记 `REPORTED`）；
     *         false = 后台裁决为 `unknown_no_retry`，本地必须记 **`UNKNOWN`**（禁止自动重试）。
     */
    private suspend fun handleAck(taskId: String, ack: AckResp): Boolean {
        if (ack.walDecision == "unknown_no_retry") {
            Log.w(TAG, "后台裁决：$taskId 为 unknown，禁止重试（转人工）")
            return false
        }
        return true
    }

    /**
     * 落盘上报终态。
     *
     * ⚠ `normal = false`（后台裁决 `unknown_no_retry`）时必须落 **`UNKNOWN`** 而非 `REPORTED`：
     * 早期无论裁决如何都记 `REPORTED`，等于把「禁止重试」这条底线丢了 ——
     * 后台若重派同 taskId，本地幂等守卫就拦不住（见 TaskExecutor 步骤 0）。
     */
    private suspend fun markReported(taskId: String, normal: Boolean = true) {
        runCatching {
            AgentDb.get(context).taskDao().markFinished(
                taskId,
                if (normal) LocalState.REPORTED else LocalState.UNKNOWN,
                if (normal) null else "unknown_no_retry",
                Time.nowMs(),
            )
        }
    }

    /** 「重传也不会成功」的失败：服务端 4xx、响应解析失败（网络类返回 false，需继续退避） */
    private fun isPermanentFailure(e: Throwable): Boolean = when (e) {
        is ApiException.Server -> e.status in 400..499
        is ApiException.Parse -> true
        else -> false
    }

    private suspend fun enqueueReceipt(
        taskId: String,
        outcome: TaskExecutor.Outcome,
        payload: String,
    ) {
        runCatching {
            AgentDb.get(context).receiptDao().enqueue(
                ReceiptRecord(
                    taskId = taskId,
                    status = outcome.status,
                    reasonCode = outcome.reasonCode,
                    evidence = outcome.evidence,
                    startedAt = outcome.startedAt,
                    finishedAt = outcome.finishedAt,
                    payloadJson = payload,
                    createdAt = Time.nowMs(),
                ),
            )
        }.onFailure {
            // 早期静默吞掉：磁盘满 / DB 异常时回执会**无声丢失**，事后完全查不到
            Log.e(TAG, "回执入队失败（该回执将丢失）：$taskId ${it.message}")
        }
    }

    private suspend fun enqueueEvent(
        event: String,
        taskId: String?,
        commandId: String?,
        reasonCode: String?,
        payload: String,
    ) {
        runCatching {
            AgentDb.get(context).eventDao().enqueue(
                EventRecord(
                    event = event,
                    taskId = taskId,
                    commandId = commandId,
                    reasonCode = reasonCode,
                    payloadJson = payload,
                    createdAt = Time.nowMs(),
                ),
            )
        }.onFailure { Log.e(TAG, "事件入队失败（该事件将丢失）：$event ${it.message}") }
    }
}
