package com.xfish.comment.agent.core

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet

/**
 * 进程内事件总线：模块间解耦（服务、无障碍、执行器、界面互不直接依赖）。
 * 与后台的 bus.ts 同构设计。
 */
object Bus {

    private val handlers = ConcurrentHashMap<String, MutableSet<(Any?) -> Unit>>()

    fun on(event: String, handler: (Any?) -> Unit): () -> Unit {
        val set = handlers.getOrPut(event) { CopyOnWriteArraySet() }
        set.add(handler)
        return { set.remove(handler) }
    }

    fun emit(event: String, payload: Any? = null) {
        handlers[event]?.forEach { h ->
            runCatching { h(payload) }.onFailure { Log.e("bus", "handler failed: $event", it) }
        }
    }

    object Events {
        /** 心跳成功（搭载 HeartbeatResp） */
        const val HEARTBEAT_OK = "heartbeat.ok"
        /** 心跳失败（搭载错误信息字符串） */
        const val HEARTBEAT_FAIL = "heartbeat.fail"
        /** 领取到任务（搭载 TaskPackage） */
        const val TASK_CLAIMED = "task.claimed"
        /** 领取为空（搭载原因字符串） */
        const val TASK_EMPTY = "task.empty"
        /** 任务开始执行 */
        const val TASK_STARTED = "task.started"
        /** 任务结束（搭载终态与原因码） */
        const val TASK_FINISHED = "task.finished"
        /** 切 IP 完成（搭载 ip/city） */
        const val IP_SWITCHED = "ip.switched"
        /** 无障碍服务连接 / 断开 */
        const val A11Y_CONNECTED = "a11y.connected"
        const val A11Y_DISCONNECTED = "a11y.disconnected"
        /** 需要刷新面板 */
        const val UI_REFRESH = "ui.refresh"
    }
}
