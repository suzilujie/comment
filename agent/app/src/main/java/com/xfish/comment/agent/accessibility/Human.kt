package com.xfish.comment.agent.accessibility

import android.content.Context
import com.xfish.comment.agent.core.Log
import com.xfish.comment.agent.core.Rnd
import com.xfish.comment.agent.data.Prefs
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * 行为人格与逐步拟人化（设计文档 §6.3 / §6.5）。
 *
 * 两层随机：
 *  · **人格层（Persona）**：后台生成、长期稳定 —— 每台设备的「性格」不同；
 *  · **波动层（Fluctuation）**：本模块按人格参数逐次抽样 —— 同一设备每次不同。
 *
 * 原则（必须遵守）：
 *  1. 时序用**对数正态**，坐标用**高斯热区**，滑动用**贝塞尔变速**；
 *  2. 人格参数缺失时用内置默认值（后台未下发人格时也能跑）；
 *  3. 人格**不得越过硬约束**（日上限、完成间隔、投放时段由后台裁决）。
 */
object Human {

    private const val TAG = "human"
    private val json = Json { ignoreUnknownKeys = true }

    /** 人格档案（字段与后台 personality_store.ts 输出对应） */
    data class Persona(
        val dwellMedianSec: Double = 12.0,
        val dwellSigma: Double = 0.6,
        val preClickMsMedian: Double = 1500.0,
        val preClickSigma: Double = 0.5,
        val likeProbability: Double = 0.80,
        val favoriteProbability: Double = 0.60,
        val commentsToReadMin: Int = 2,
        val commentsToReadMax: Int = 5,
        val thinkPauseMinSec: Double = 1.2,
        val thinkPauseMaxSec: Double = 4.5,
        val verifyPauseMinSec: Double = 0.6,
        val verifyPauseMaxSec: Double = 1.8,
        val lingerAfterPostMinSec: Double = 2.0,
        val lingerAfterPostMaxSec: Double = 5.0,
        val exitMode: String = "back_key",
    )

    @Volatile
    private var cached: Persona? = null

    @Volatile
    private var cachedVersion: Int = -1

    /** 读取人格（带缓存；后台更新版本后自动失效） */
    suspend fun persona(context: Context): Persona {
        val version = Prefs.personaVersion(context)
        cached?.let { if (version == cachedVersion) return it }

        val raw = Prefs.personaJson(context)
        val parsed = if (raw.isNullOrBlank()) {
            Log.i(TAG, "未下发人格档案，使用内置默认参数")
            Persona()
        } else {
            runCatching { parse(json.parseToJsonElement(raw).let { it as JsonObject }) }
                .getOrElse {
                    Log.w(TAG, "人格解析失败，用默认参数：${it.message}")
                    Persona()
                }
        }
        cached = parsed
        cachedVersion = version
        Log.i(TAG, "人格已加载 v$version：停留中位=${parsed.dwellMedianSec}s 反应中位=${parsed.preClickMsMedian}ms " +
            "点赞=${parsed.likeProbability} 收藏=${parsed.favoriteProbability} 读评论=${parsed.commentsToReadMin}~${parsed.commentsToReadMax}")
        return parsed
    }

    private fun parse(obj: JsonObject): Persona {
        fun d(vararg keys: String): Double? {
            for (k in keys) {
                val v = obj[k]?.jsonPrimitive ?: continue
                v.doubleOrNull?.let { return it }
                v.intOrNull?.let { return it.toDouble() }
            }
            return null
        }

        fun i(vararg keys: String): Int? {
            for (k in keys) {
                obj[k]?.jsonPrimitive?.intOrNull?.let { return it }
                obj[k]?.jsonPrimitive?.doubleOrNull?.let { return it.toInt() }
            }
            return null
        }

        val def = Persona()
        val comments = i("commentsToRead") ?: 3
        return Persona(
            dwellMedianSec = d("dwellMedianSec") ?: def.dwellMedianSec,
            dwellSigma = d("dwellSigma") ?: def.dwellSigma,
            preClickMsMedian = d("preClickMsMedian") ?: def.preClickMsMedian,
            preClickSigma = d("preClickSigma") ?: def.preClickSigma,
            likeProbability = d("likeProbability") ?: def.likeProbability,
            favoriteProbability = d("favoriteProbability") ?: def.favoriteProbability,
            // 后台给的是「读几条评论」的单值，这里在 ±1 内做波动，避免每次都一样
            commentsToReadMin = (comments - 1).coerceAtLeast(1),
            commentsToReadMax = (comments + 1).coerceAtLeast(2),
            thinkPauseMinSec = d("thinkPauseSec")?.let { (it * 0.6).coerceAtLeast(0.5) } ?: def.thinkPauseMinSec,
            thinkPauseMaxSec = d("thinkPauseSec") ?: def.thinkPauseMaxSec,
            verifyPauseMinSec = d("verifyPauseSec")?.let { (it * 0.5).coerceAtLeast(0.3) } ?: def.verifyPauseMinSec,
            verifyPauseMaxSec = d("verifyPauseSec") ?: def.verifyPauseMaxSec,
            lingerAfterPostMinSec = d("lingerAfterPostSec")?.let { (it * 0.5).coerceAtLeast(1.0) } ?: def.lingerAfterPostMinSec,
            lingerAfterPostMaxSec = d("lingerAfterPostSec") ?: def.lingerAfterPostMaxSec,
            exitMode = obj["exitMode"]?.jsonPrimitive?.contentOrNullSafe() ?: def.exitMode,
        )
    }

    // ── 抽样（波动层）─────────────────────────────────────────

    /** 浏览停留（对数正态，含长尾） */
    suspend fun dwellForBrowsing(context: Context, factor: Double = 1.0) {
        val p = persona(context)
        val sec = Rnd.lognormalSec(p.dwellMedianSec * factor, p.dwellSigma)
            .coerceIn(3.0, 90.0)
        Log.d(TAG, "浏览停留 ${"%.1f".format(sec)} 秒")
        delay((sec * 1000).toLong())
    }

    /** 点击前的「注视」延迟（真人不会看到就立刻点） */
    suspend fun reactBeforeClick(context: Context) {
        val p = persona(context)
        val ms = (Rnd.lognormalSec(p.preClickMsMedian / 1000.0, p.preClickSigma) * 1000)
            .coerceIn(400.0, 6_000.0)
        delay(ms.toLong())
    }

    /** 输入前的「思考」停顿 */
    suspend fun thinkPause(context: Context) {
        val p = persona(context)
        delay(Rnd.double(p.thinkPauseMinSec, p.thinkPauseMaxSec).times(1000).toLong())
    }

    /** 提交前的「检查」停顿 */
    suspend fun verifyPause(context: Context) {
        val p = persona(context)
        delay(Rnd.double(p.verifyPauseMinSec, p.verifyPauseMaxSec).times(1000).toLong())
    }

    /** 发完之后的停留（不要发完就消失） */
    suspend fun lingerAfterPost(context: Context) {
        val p = persona(context)
        delay(Rnd.double(p.lingerAfterPostMinSec, p.lingerAfterPostMaxSec).times(1000).toLong())
    }

    /** 本次是否点赞 / 收藏（按人格概率，不做 100% 必点） */
    suspend fun shouldLike(context: Context): Boolean = Rnd.bool(persona(context).likeProbability)

    suspend fun shouldFavorite(context: Context): Boolean = Rnd.bool(persona(context).favoriteProbability)

    /** 本次读完几条评论后再发（真人不会打开就发） */
    suspend fun commentsToRead(context: Context): Int {
        val p = persona(context)
        return Rnd.int(p.commentsToReadMin, p.commentsToReadMax)
    }

    /** 通用随机等待（用于步骤之间的自然间隙） */
    suspend fun pause(minMs: Long = 300, maxMs: Long = 1_200) {
        delay(Rnd.delayMs(minMs, maxMs))
    }

    /** 失效缓存（后台下发新人格后调用） */
    fun invalidate() {
        cached = null
        cachedVersion = -1
    }
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? =
    runCatching { content }.getOrNull()?.takeIf { it.isNotBlank() && it != "null" }
