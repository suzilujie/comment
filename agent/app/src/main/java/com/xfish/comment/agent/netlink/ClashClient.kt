package com.xfish.comment.agent.netlink

import com.xfish.comment.agent.core.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Clash 外部控制器客户端（设计文档 §5.3）。
 *
 * Agent 与 Clash 同机，可**直连 127.0.0.1:9090**，无需 adb forward。
 *
 * 三条硬约定（违反会导致 IP 漂移或切换失败）：
 *  1. 目标 group 必须已存在（由 Clash 的 `proxy-providers` 自动拉取生成）；
 *  2. group 类型必须是 `select`（若为 url-test / fallback，Clash 会自己换节点 → 属地错配）；
 *  3. 切换后必须回读 `now` 字段确认，不能假定成功。
 */
object ClashClient {

    private const val TAG = "clash"

    /** 默认控制器地址（Clash Meta / Clash for Android 常见配置） */
    const val DEFAULT_URL = "http://127.0.0.1:9090"

    /** 控制器地址与密钥（由设置注入，见 [configure]） */
    @Volatile
    var controllerUrl: String = DEFAULT_URL

    @Volatile
    var secret: String = ""

    /**
     * 注入控制器地址与密钥（App 启动 / 面板保存时调用）。
     * 地址留空则回退默认值；密钥可空。
     */
    fun configure(url: String, secret: String) {
        controllerUrl = url.trim().ifBlank { DEFAULT_URL }
        this.secret = secret.trim()
        Log.i(
            TAG,
            "控制器：$controllerUrl" + if (this.secret.isNotBlank()) "（含密钥）" else "（无密钥）",
        )
    }

    /** 常见 Clash 控制器端口（自动探测优先尝试） */
    private val COMMON_PORTS = listOf(9090, 9091, 9092, 9097, 9095, 6170, 9900, 51072)

    /** 短超时探测客户端（仅用于端口探测，避免拖慢启动） */
    private val probeClient = OkHttpClient.Builder()
        .connectTimeout(400, TimeUnit.MILLISECONDS)
        .readTimeout(800, TimeUnit.MILLISECONDS)
        .build()

    /**
     * 自动探测本机 Clash 外部控制器。
     *
     * 原理：控制器必定监听 127.0.0.1，故对候选端口发 `GET /version`，
     * 响应符合 Clash 特征即认定为控制器（401/403 也视为命中——说明端口上有受保护的 API）。
     *
     * @param fullScan 附带扫描 9000-9100 一段（较慢，建议仅手动触发时开启）
     * @return 命中的控制器地址；未找到返回 null
     */
    suspend fun autoDetect(fullScan: Boolean = false): String? = withContext(Dispatchers.IO) {
        val ports = LinkedHashSet<Int>().apply {
            addAll(COMMON_PORTS)
            if (fullScan) addAll(9000..9100)
        }
        for (port in ports) {
            val url = "http://127.0.0.1:$port"
            if (looksLikeClash(url)) {
                Log.i(TAG, "自动探测命中控制器：$url")
                return@withContext url
            }
        }
        Log.w(TAG, "自动探测未找到控制器（已试 ${ports.size} 个端口）")
        null
    }

    /** 判断某地址是否为 Clash 控制器（依据 /version 响应特征） */
    private fun looksLikeClash(baseUrl: String): Boolean = try {
        val req = Request.Builder().url("$baseUrl/version").get().build()
        probeClient.newCall(req).execute().use { resp ->
            when {
                // 有服务但要求鉴权 → 大概率是控制器（密钥需用户补填）
                resp.code == 401 || resp.code == 403 -> true
                !resp.isSuccessful -> false
                else -> {
                    val body = resp.body?.string().orEmpty()
                    body.trimStart().startsWith("{") && body.contains("\"version\"")
                }
            }
        }
    } catch (_: Exception) {
        false
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(6, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true }
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    /** 组内信息 */
    data class GroupInfo(
        val name: String,
        /** 组类型：select / url-test / fallback / load-balance ... */
        val type: String,
        /** 当前选中节点 */
        val now: String?,
        /** 可选节点列表 */
        val all: List<String>,
    )

    /**
     * 读取 group 的结果 —— **必须区分失败原因**。
     *
     * 切城据此决定策略：`ControllerDown` 换多少省份都没用（应当中止），
     * `GroupMissing` 只是这个省份没配组（换省份可能成功）。
     * 早期实现把两者都压成 null，导致「控制器没开」也会被当成「换个城市再试」，
     * 白白空转好几轮。
     */
    sealed interface GroupResult {
        data class Ok(val info: GroupInfo) : GroupResult

        /** 控制器不可达（连接失败 / 非 404 的 HTTP 错误）—— 与目标省份无关 */
        object ControllerDown : GroupResult

        /** 控制器可达但没有这个 group（404）—— provider 未刷新或组名不符 */
        object GroupMissing : GroupResult
    }

    /** 读取 group 信息，区分「控制器不可达」与「group 不存在」 */
    suspend fun getGroupResult(slug: String): GroupResult = withContext(Dispatchers.IO) {
        when (val r = requestRaw("GET", "/proxies/$slug", null)) {
            HttpResult.Unreachable -> GroupResult.ControllerDown
            is HttpResult.HttpError ->
                if (r.code == 404) GroupResult.GroupMissing else GroupResult.ControllerDown
            is HttpResult.Ok -> try {
                val obj = json.parseToJsonElement(r.body).jsonObject
                GroupResult.Ok(
                    GroupInfo(
                        name = obj["name"]?.jsonPrimitive?.contentOrNull() ?: slug,
                        type = obj["type"]?.jsonPrimitive?.contentOrNull() ?: "unknown",
                        now = obj["now"]?.jsonPrimitive?.contentOrNull(),
                        all = obj["all"]?.let { el ->
                            runCatching { el.jsonArrayToStrings() }.getOrDefault(emptyList())
                        } ?: emptyList(),
                    ),
                )
            } catch (e: Exception) {
                Log.e(TAG, "getGroup parse failed slug=$slug", e)
                // 响应不是合法 JSON：端口上有服务，但不是 Clash 控制器
                GroupResult.ControllerDown
            }
        }
    }

    /** 读取 group 信息（不区分失败原因的便捷版；需要区分时用 [getGroupResult]） */
    suspend fun getGroup(slug: String): GroupInfo? =
        (getGroupResult(slug) as? GroupResult.Ok)?.info

    /** 检查控制器是否可达（自检用） */
    suspend fun ping(): Boolean = withContext(Dispatchers.IO) {
        request("GET", "/version", null) != null
    }

    /**
     * 切换 group 到指定节点。
     * @return 成功与否（已回读 now 校验）
     */
    suspend fun selectNode(slug: String, nodeName: String): Boolean = withContext(Dispatchers.IO) {
        val info = getGroup(slug) ?: run {
            Log.w(TAG, "group not found: $slug（provider 可能尚未刷新）")
            return@withContext false
        }
        // 类型校验：Clash Meta 返回 "Select"，sing-box 兼容层返回 "Selector"。
        // 两者语义一致（手动选择组，不会像 url-test/fallback 那样自动换节点），故忽略大小写并同时接受；
        // 其余类型（url-test / fallback / load-balance）仍一律拒绝，避免切完被核心自动改回去导致属地漂移。
        if (info.type.lowercase() !in setOf("select", "selector")) {
            Log.e(TAG, "group $slug 类型为 ${info.type}，必须为 select/selector —— 拒绝切换（否则 IP 会漂移）")
            return@withContext false
        }
        if (info.all.isNotEmpty() && nodeName !in info.all) {
            Log.w(TAG, "node $nodeName 不在 group $slug 的候选列表中")
            return@withContext false
        }

        val body = buildJsonObject { put("name", nodeName) }.toString()
        val ok = request("PUT", "/proxies/$slug", body) != null
        if (!ok) {
            Log.w(TAG, "select failed slug=$slug node=$nodeName")
            return@withContext false
        }

        // 回读确认（硬要求：不假定切换成功）
        val after = getGroup(slug)
        val confirmed = after?.now == nodeName
        if (!confirmed) Log.w(TAG, "switch not confirmed: expect=$nodeName now=${after?.now}")
        confirmed
    }

    // ── HTTP 封装 ────────────────────────────────────────────

    /** HTTP 结果：区分「连通但报错」与「根本没连上」 */
    private sealed interface HttpResult {
        data class Ok(val body: String) : HttpResult
        data class HttpError(val code: Int) : HttpResult
        object Unreachable : HttpResult
    }

    private fun requestRaw(method: String, path: String, body: String?): HttpResult = try {
        val builder = Request.Builder().url(controllerUrl.trimEnd('/') + path)
        if (secret.isNotBlank()) builder.header("Authorization", "Bearer $secret")
        when (method) {
            "GET" -> builder.get()
            "PUT" -> builder.put((body ?: "{}").toRequestBody(jsonType))
            else -> builder.method(method, (body ?: "{}").toRequestBody(jsonType))
        }
        client.newCall(builder.build()).execute().use { resp ->
            if (!resp.isSuccessful) {
                Log.w(TAG, "$method $path → ${resp.code}")
                HttpResult.HttpError(resp.code)
            } else {
                HttpResult.Ok(resp.body?.string().orEmpty())
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "$method $path 异常: ${e.message}")
        HttpResult.Unreachable
    }

    private fun request(method: String, path: String, body: String?): String? =
        (requestRaw(method, path, body) as? HttpResult.Ok)?.body
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNull(): String? =
    runCatching { content }.getOrNull()?.takeIf { it.isNotBlank() && it != "null" }

private fun kotlinx.serialization.json.JsonElement.jsonArrayToStrings(): List<String> =
    (this as? kotlinx.serialization.json.JsonArray)
        ?.mapNotNull { runCatching { it.jsonPrimitive.content }.getOrNull() }
        ?: emptyList()
