package com.xfish.comment.agent.net

import com.xfish.comment.agent.core.Config
import com.xfish.comment.agent.core.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** 设备端接口错误：区分「网络不可达」与「后台拒绝」，便于决定是否退避 */
sealed class ApiException(message: String) : Exception(message) {
    class Network(message: String) : ApiException(message)
    class Server(val status: Int, val code: String?, message: String) : ApiException(message)
    class Parse(message: String) : ApiException(message)
}

/**
 * 后台接口客户端（设计文档 §4.4 三通道）。
 *
 * · 全部为「设备主动」的 POST；
 * · 心跳与领取、上报各自独立，互不阻塞；
 * · 失败一律抛出 ApiException，由调用方决定退避策略。
 */
object Api {

    private const val TAG = "api"
    private const val JSON_TYPE = "application/json; charset=utf-8"

    /** 后台地址（由 App 启动时从 Prefs 注入，尾斜杠会被规范化去掉） */
    @Volatile
    var baseUrl: String = ""
        set(value) {
            field = value.trim().trimEnd('/')
        }

    val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        coerceInputValues = true
    }

    private val mediaType = JSON_TYPE.toMediaType()

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(Config.HTTP_CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(Config.HTTP_READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .writeTimeout(Config.HTTP_WRITE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false) // 重试由上层按退避策略控制，避免叠加放大
        .build()

    // ── 四个接口（无注册：设备首启心跳即自动登记）──────────────

    suspend fun heartbeat(req: HeartbeatReq): HeartbeatResp =
        post("/agent/heartbeat", json.encodeToString(req))

    suspend fun claim(req: ClaimReq): ClaimResp =
        post("/agent/task/claim", json.encodeToString(req))

    suspend fun event(req: EventReq): AckResp =
        post("/agent/event", json.encodeToString(req))

    suspend fun receipt(req: ReceiptReq): AckResp =
        post("/agent/receipt", json.encodeToString(req))

    // ── 通用 POST ────────────────────────────────────────────

    private suspend inline fun <reified T> post(path: String, bodyJson: String): T =
        withContext(Dispatchers.IO) {
            if (baseUrl.isBlank()) throw ApiException.Network("后台地址未配置")

            val url = baseUrl + path
            val startedAt = System.currentTimeMillis()
            // URL 非法（后台地址被填错）时 Request.Builder 会抛 IllegalArgumentException：
            // 那是构建期异常，调用方只按 ApiException 分派，会当成「未知异常」处理。
            // 这里统一翻译成 Network，让上游的退避/重试逻辑能正确归类。
            val request = try {
                Request.Builder()
                    .url(url)
                    .post(bodyJson.toRequestBody(mediaType))
                    .header("Accept", "application/json")
                    .build()
            } catch (e: IllegalArgumentException) {
                Log.e(TAG, "后台地址非法：$url", e)
                throw ApiException.Network("后台地址非法：${e.message}")
            }

            val raw: String
            val code: Int
            try {
                client.newCall(request).execute().use { resp ->
                    code = resp.code
                    raw = resp.body?.string().orEmpty()
                }
            } catch (e: IOException) {
                Log.w(TAG, "network error $path after ${System.currentTimeMillis() - startedAt}ms: ${e.message}")
                throw ApiException.Network(e.message ?: "网络不可达")
            }

            val cost = System.currentTimeMillis() - startedAt
            if (code !in 200..299) {
                val err = runCatching { json.decodeFromString<ErrorResp>(raw) }.getOrNull()
                val msg = err?.error ?: err?.messageAlt ?: raw.take(200)
                Log.w(TAG, "server error $path status=$code cost=${cost}ms: $msg")
                throw ApiException.Server(code, err?.code, msg)
            }

            Log.d(TAG, "$path -> $code cost=${cost}ms")

            try {
                json.decodeFromString<T>(raw)
            } catch (e: Exception) {
                Log.e(TAG, "parse error $path: ${raw.take(200)}", e)
                throw ApiException.Parse("响应解析失败: ${e.message}")
            }
        }

    /** 下载素材到本地文件（内网通道，不走代理） */
    suspend fun download(urlOrPath: String, dest: java.io.File): Long =
        withContext(Dispatchers.IO) {
            val url = if (urlOrPath.startsWith("http")) urlOrPath else baseUrl + normalizePath(urlOrPath)
            val request = Request.Builder().url(url).get().build()
            try {
                client.newCall(request).execute().use { resp ->
                    if (!resp.isSuccessful) throw ApiException.Server(resp.code, null, "素材下载失败")
                    val body = resp.body ?: throw ApiException.Parse("素材响应为空")
                    dest.parentFile?.mkdirs()
                    dest.outputStream().use { out -> body.byteStream().copyTo(out) }
                    dest.length()
                }
            } catch (e: IOException) {
                throw ApiException.Network(e.message ?: "素材下载网络错误")
            }
        }

    /** 把后台返回的素材路径规范成 URL 路径（兼容 "data/materials/x" 与 "/materials/x"） */
    private fun normalizePath(raw: String): String {
        val idx = raw.lastIndexOf("/materials/")
        if (idx >= 0) return raw.substring(idx)
        if (raw.startsWith("/")) return raw
        val name = raw.substringAfterLast('/')
        return "/materials/$name"
    }
}
