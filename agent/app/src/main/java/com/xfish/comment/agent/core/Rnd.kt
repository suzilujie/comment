package com.xfish.comment.agent.core

import java.security.SecureRandom
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.sqrt

/**
 * 随机工具（设备端）。
 *
 * 分工（设计文档 §4.4「抖动的生成规则」）：
 *  · **纯节拍的随机**（心跳 ±10%、切 IP 计时抖动）→ 设备端生成；
 *  · 与业务相关的随机（完成间隔、任务与素材选择）→ 后台生成，设备只按结果退避。
 *
 * 实现要求：**必须使用 SecureRandom**。默认 `Random()` 在部分机型上序列可重现，
 * 会导致数十台设备的抖动塌缩成同一节奏（这正是要避免的机器特征）。
 */
object Rnd {

    private val sr = SecureRandom()

    /** 整数随机 [min, max]（含两端） */
    fun int(min: Int, max: Int): Int {
        if (max <= min) return min
        return min + sr.nextInt(max - min + 1)
    }

    /** 长整型随机 [min, max]（含两端） */
    fun long(min: Long, max: Long): Long {
        if (max <= min) return min
        return min + (sr.nextDouble() * (max - min)).toLong()
    }

    /** 浮点随机 [min, max) */
    fun double(min: Double, max: Double): Double = min + sr.nextDouble() * (max - min)

    /** 按概率取真 */
    fun bool(probability: Double): Boolean = sr.nextDouble() < probability

    /** 从列表随机取一个 */
    fun <T> pick(list: List<T>): T? = if (list.isEmpty()) null else list[int(0, list.size - 1)]

    /** 从列表随机取一个，并排除若干值（用于「切城排除当前城市」） */
    fun <T> pickExcluding(list: List<T>, exclude: Collection<T>): T? {
        val filtered = list.filterNot { it in exclude }
        return pick(filtered)
    }

    /**
     * 高斯随机（Box–Muller），用于点击坐标热区：
     * 真人倾向点击控件中心，而不是在矩形内均匀取点。
     */
    fun gaussian(mean: Double, stdDev: Double): Double {
        val u1 = (sr.nextDouble()).coerceAtLeast(1e-9)
        val u2 = sr.nextDouble()
        val z = sqrt(-2.0 * ln(u1)) * cos(2.0 * PI * u2)
        return mean + z * stdDev
    }

    /**
     * 对数正态随机，用于「停留时长」这类时间分布：
     * 真人行为是「大量短间隔 + 少量长间隔」，均匀随机会产生"太规律的随机"。
     *
     * @param medianSec 中位时长（秒）
     * @param sigma     离散度（0.4–0.9，越大越长尾）
     */
    fun lognormalSec(medianSec: Double, sigma: Double): Double {
        val mu = ln(medianSec)
        val u1 = (sr.nextDouble()).coerceAtLeast(1e-9)
        val u2 = sr.nextDouble()
        val z = sqrt(-2.0 * ln(u1)) * cos(2.0 * PI * u2)
        return exp(mu + sigma * z)
    }

    /** 给基准秒数叠加 ±ratio 抖动，返回毫秒（用于心跳间隔） */
    fun jitterMs(baseSeconds: Int, ratio: Double): Long {
        val base = baseSeconds * 1000.0
        return (base * (1.0 - ratio + sr.nextDouble() * ratio * 2.0)).toLong()
    }

    /** 在 [min, max] 区间内随机一个毫秒值（用于动作间隔） */
    fun delayMs(minMs: Long, maxMs: Long): Long = long(minMs, maxMs)
}
