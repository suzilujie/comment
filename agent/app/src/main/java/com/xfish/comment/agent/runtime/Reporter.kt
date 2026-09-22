package com.xfish.comment.agent.runtime

import android.content.Context
import com.xfish.comment.agent.core.Bus
import com.xfish.comment.agent.core.Log
import com.xfish.comment.agent.core.Time
import com.xfish.comment.agent.data.AgentDb
import com.xfish.comment.agent.data.EventRecord
import com.xfish.comment.agent.data.Prefs
import com.xfish.comment.agent.data.ReceiptRecord
import com.xfish.comment.agent.exec.TaskExecutor
import com.xfish.comment.agent.net.AckResp
import com.xfish.comment.agent.net.Api
import com.xfish.comment.agent.net.EventReq
import com.xfish.comment.agent.net.ReceiptReq
import com.xfish.comment.agent.net.TaskPackageDto
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

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
        val req = ReceiptReq(
            deviceId = Prefs.deviceId(context),
            taskId = task.taskId,
            status = outcome.status,
            reasonCode = outcome.reasonCode,
            evidence = outcome.evidence,
            idempotencyKey = "${task.taskId}:${outcome.status}:${outcome.finishedAt ?: Time.nowMs()}",
            startedAt = outcome.startedAt,
            finishedAt = outcome.finishedAt ?: Time.nowMs(),
            detail = outcome.detail,
        )
        val payload = json.encodeToString(ReceiptReq.serializer(), req)

        try {
            val ack = Api.receipt(req)
            handleAck(task.taskId, ack)
            markReported(task.taskId)
            Log.i(TAG, "回执已送达：${task.taskId} → ${outcome.status}")
        } catch (e: Exception) {
            Log.w(TAG, "回执上报失败，转本地队列：${e.message}")
            enqueueReceipt(task.taskId, outcome, payload)
        }

        Bus.emit(Bus.Events.TASK_FINISHED, "${outcome.status}/${outcome.reasonCode ?: "-"}")
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
                    handleAck(rec.taskId, ack)
                    markReported(rec.taskId)
                    db.receiptDao().delete(rec.id)
                    Log.i(TAG, "重传回执成功：${rec.taskId}（第 ${rec.attempts + 1} 次）")
                } catch (e: Exception) {
                    db.receiptDao().bumpAttempts(rec.id)
                    Log.w(TAG, "回执重传失败 ${rec.taskId}: ${e.message}")
                    throw e // 网络仍未恢复，本轮不再继续
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
                    throw e
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

    /** 处理后台裁决：`unknown_no_retry` 时本地标记为不可重试（底线） */
    private suspend fun handleAck(taskId: String, ack: AckResp) {
        if (ack.walDecision == "unknown_no_retry") {
            Log.w(TAG, "后台裁决：$taskId 为 unknown，禁止重试（转人工）")
        }
    }

    private suspend fun markReported(taskId: String) {
        runCatching {
            AgentDb.get(context).taskDao().markFinished(
                taskId,
                com.xfish.comment.agent.data.LocalState.REPORTED,
                null,
                Time.nowMs(),
            )
        }
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
        }
    }
}
