package com.xfish.comment.agent.netlink

import com.xfish.comment.agent.core.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.Inet6Address
import java.net.NetworkInterface
import java.util.concurrent.TimeUnit

/**
 * 出口 IP 与属地探测（设计文档 §9.4 工程坑一）。
 *
 * 关键点：
 *  1. **必须走代理请求公网接口**才能拿到真实出口 IP —— 不能用「后台回显来源 IP」，
 *     后台看到的只会是内网地址；
 *  2. 顺带检查 **IPv6 是否泄露**（IPv4 走代理但 IPv6 直连时，属地会闪现实地址）；
 *  3. 探测失败不要报假数据：返回 null，让心跳把 proxyOk 置 false，
 *     后台因此不会派单（状态即准入）。
 */
object IpProbe {

    private const val TAG = "ipprobe"

    /**
     * 探测端点：优先返回 IP + 城市。
     * 可换成自建端点（推荐，见下方说明）——自建端点还能同时解决「城市名中英口径」问题。
     */
    private val endpoints = listOf(
        // 返回 JSON：{"query":"1.2.3.4","city":"Hangzhou", ...}（免 key）
        ProbeEndpoint("http://ip-api.com/json/?fields=status,query,city,regionName,country", "ip-api"),
        // 备用 JSON 源（ip-api 被限流/不可达时接管，同样带 city）
        ProbeEndpoint("https://ipapi.co/json/", "ipapi.co"),
        ProbeEndpoint("https://ip.useragentinfo.com/json", "useragentinfo"),
        // 兜底：只返回纯 IP 文本（**无属地**，仅保证 ip 字段可用）
        ProbeEndpoint("http://members.3322.org/dyndns/getip", "3322"),
    )

    private val client = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    /** 短超时客户端：仅用于切城过程中的快速校验（见 [probeFast]） */
    private val fastClient = OkHttpClient.Builder()
        .connectTimeout(4, TimeUnit.SECONDS)
        .readTimeout(4, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true }

    data class Result(
        /** 出口 IPv4（走代理后看到的地址） */
        val ip: String,
        /**
         * 出口属地 —— **省级**（如 `浙江`）。
         * 派单的属地匹配用这个字段（抖音 IP 属地也只到省，市级是多余精度）。
         * 可能为空（仅拿到纯 IP 的端点），由调用方判定。
         */
        val region: String,
        /** 出口城市（仅用于日志 / 排障，不参与匹配） */
        val city: String,
        /** 是否检测到 IPv6 直连泄露 */
        val ipv6Leak: Boolean,
        /** 探测来源，便于排障 */
        val source: String,
    )

    /** 全量探测出口身份（4 个端点依次尝试）；全部失败返回 null */
    suspend fun probe(): Result? = withContext(Dispatchers.IO) {
        val ipv6Leak = detectIpv6Leak()
        var withoutRegion: Result? = null
        for (ep in endpoints) {
            try {
                val body = httpGet(ep.url, client) ?: continue
                val (ip, city, region) = parse(ep.kind, body)
                if (ip.isNullOrBlank()) continue
                Log.i(
                    TAG,
                    "exit ip=$ip region=${region.ifBlank { "-" }} city=${city.ifBlank { "-" }} " +
                        "ipv6Leak=$ipv6Leak via ${ep.name}",
                )
                val r = Result(ip, region, city, ipv6Leak, ep.name)
                // **优先返回带省份的结果**：省份是派单的硬匹配条件。
                // 只有纯 IP 的结果先记下作兜底，继续尝试其它端点。
                if (region.isNotBlank()) return@withContext r
                if (withoutRegion == null) withoutRegion = r
            } catch (e: Exception) {
                Log.w(TAG, "probe failed via ${ep.name}: ${e.message}")
            }
        }
        if (withoutRegion == null) Log.w(TAG, "all probe endpoints failed (代理未连通？)")
        withoutRegion
    }

    /**
     * 快速探测：**只试首选端点 + 短超时**，用于切城过程里的即时校验。
     *
     * 为什么不复用 [probe]：全量探测最坏 4 端点 × 8 秒 = 32 秒，而切城要连续
     * 试多个省份，若每次校验都走全量，整个流程会拖到几分钟且毫无收益 ——
     * 切城只需要知道「新出口通不通、落在哪个省」。
     */
    suspend fun probeFast(): Result? = withContext(Dispatchers.IO) {
        val ipv6Leak = detectIpv6Leak()
        val ep = endpoints.first()
        try {
            val body = httpGet(ep.url, fastClient) ?: return@withContext null
            val (ip, city, region) = parse(ep.kind, body)
            if (ip.isNullOrBlank()) return@withContext null
            Log.i(TAG, "fast exit ip=$ip region=${region.ifBlank { "-" }} via ${ep.name}")
            Result(ip, region, city, ipv6Leak, ep.name)
        } catch (e: Exception) {
            Log.w(TAG, "fast probe failed: ${e.message}")
            null
        }
    }

    /** 仅探测 IP */
    suspend fun probeIp(): String? = probe()?.ip

    /** 解析三元组：ip / 城市 / 省份（regionName 优先，其次 region） */
    private fun parse(kind: String, body: String): Triple<String?, String, String> = when (kind) {
        // 各 JSON 源字段名略有差异：ip-api 用 query，其余多用 ip
        "json" -> {
            val obj = runCatching { json.parseToJsonElement(body).jsonObject }.getOrNull()
            val ip = (obj?.get("query") ?: obj?.get("ip"))?.jsonPrimitive?.contentOrNullSafe()
            val city = obj?.get("city")?.jsonPrimitive?.contentOrNullSafe().orEmpty()
            val region = obj?.get("regionName")?.jsonPrimitive?.contentOrNullSafe()
                ?: obj?.get("region")?.jsonPrimitive?.contentOrNullSafe().orEmpty()
            Triple(ip, city, region)
        }
        else -> Triple(body.trim().takeIf { it.length in 7..45 }, "", "")
    }

    private fun httpGet(url: String, c: OkHttpClient = client): String? {
        val req = Request.Builder().url(url).get().build()
        c.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return null
            return resp.body?.string()
        }
    }

    /**
     * IPv6 泄露检查：若本机存在可用的**公网 IPv6 地址**，则存在直连风险
     * （代理通常只接管 IPv4，IPv6 会绕过）。
     */
    private fun detectIpv6Leak(): Boolean = try {
        NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }
            .any { addr ->
                addr is Inet6Address &&
                    !addr.isLoopbackAddress &&
                    !addr.isLinkLocalAddress &&
                    !addr.isSiteLocalAddress
            }
    } catch (_: Throwable) {
        false
    }

    private data class ProbeEndpoint(val url: String, val name: String) {
        /** 3322 只返回纯文本 IP，无属地；其余均为 JSON 源 */
        val kind: String get() = if (name == "3322") "plain" else "json"
    }
}

private fun kotlinx.serialization.json.JsonPrimitive.contentOrNullSafe(): String? =
    runCatching { content }.getOrNull()?.takeIf { it.isNotBlank() && it != "null" }
