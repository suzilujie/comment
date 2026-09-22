package com.xfish.comment.agent.core

import java.net.InetAddress
import java.net.ServerSocket

/**
 * 单实例保护：禁止 App 多开（应用分身 / 系统双开）。
 *
 * 原理：通过绑定本机 127.0.0.1 的固定 TCP 端口实现跨进程、跨用户互斥。
 * Android 各用户（含系统双开 / 应用分身）共享同一内核网络栈，因此第一个实例
 * bind 成功后，后续实例（无论主 user 还是分身 user）再 bind 同一端口都会抛
 * BindException（EADDRINUSE），据此判定「已有实例在运行」。
 *
 * 特性：
 *  · 持有 [ServerSocket] 引用，进程存活期间端口一直被占用；
 *  · 进程被系统杀掉后端口自动释放，重启后可正常重新绑定，不会误锁；
 *  · 对完全隔离的虚拟环境（VMOS 等独立虚拟机）无效——但那种环境本质上是
 *    「另一台设备」，不在本防护范围内。
 */
object SingleInstance {

    /** 冷门固定端口，仅用于互斥占位，从不收发任何数据 */
    private const val LOCK_PORT = 34661

    @Volatile
    private var lock: ServerSocket? = null

    /** 尝试获取单实例锁；true = 本进程为唯一实例，false = 已有实例在运行 */
    fun acquire(): Boolean {
        if (lock != null) return true
        return try {
            lock = ServerSocket(LOCK_PORT, 1, InetAddress.getLoopbackAddress())
            true
        } catch (_: Exception) {
            false
        }
    }
}
