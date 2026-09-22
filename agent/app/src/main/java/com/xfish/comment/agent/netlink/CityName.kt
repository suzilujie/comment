package com.xfish.comment.agent.netlink

/**
 * 城市名归一化（**跨系统集成的真实痛点**）。
 *
 * 问题：出口 IP 探测接口（如 ip-api）返回英文城市名（`Hangzhou`），
 * 而后台城市池用的是中文（`杭州`），直接比较必然不匹配 → 属地自检永远失败。
 *
 * 三层处理（由强到弱）：
 *  1. **精确匹配**（忽略大小写与空白）；
 *  2. **内置映射表**（常见城市的中英对照）；
 *  3. **包含匹配**（任一方包含另一方，处理 "杭州市" vs "杭州"）。
 *
 * 若三层都不命中 → 返回 false，**宁可误判为不匹配也不带病执行**
 * （属地错配的代价远高于漏发一条评论）。
 *
 * ⚠ 长期方案：由后台提供 IP→城市的解析接口（`/agent/ipgeo`），
 *   把归一化集中到服务端，设备端只上报原始 IP。已列入待办。
 */
object CityName {

    /** 常见城市中英对照（一期覆盖城市池里的城市即可，后续由后台下发完整表） */
    private val dict: Map<String, String> = mapOf(
        "hangzhou" to "杭州", "ningbo" to "宁波", "wenzhou" to "温州", "jinhua" to "金华",
        "nanjing" to "南京", "suzhou" to "苏州", "wuxi" to "无锡", "changzhou" to "常州",
        "xuzhou" to "徐州", "nantong" to "南通",
        "shanghai" to "上海", "beijing" to "北京", "tianjin" to "天津", "chongqing" to "重庆",
        "guangzhou" to "广州", "shenzhen" to "深圳", "dongguan" to "东莞", "foshan" to "佛山",
        "zhuhai" to "珠海", "zhongshan" to "中山",
        "chengdu" to "成都", "mianyang" to "绵阳",
        "wuhan" to "武汉", "yichang" to "宜昌",
        "xian" to "西安", "xi'an" to "西安",
        "changsha" to "长沙", "zhuzhou" to "株洲",
        "zhengzhou" to "郑州", "luoyang" to "洛阳",
        "jinan" to "济南", "qingdao" to "青岛", "yantai" to "烟台",
        "hefei" to "合肥", "fuzhou" to "福州", "xiamen" to "厦门", "quanzhou" to "泉州",
        "nanchang" to "南昌", "shenyang" to "沈阳", "dalian" to "大连", "changchun" to "长春",
        "harbin" to "哈尔滨", "shijiazhuang" to "石家庄", "taiyuan" to "太原",
        "guiyang" to "贵阳", "kunming" to "昆明", "nanning" to "南宁", "haikou" to "海口",
        "lanzhou" to "兰州", "yinchuan" to "银川", "xining" to "西宁",
        "urumqi" to "乌鲁木齐", "hohhot" to "呼和浩特",
    )

    /** 把探测到的地名归一为中文城市名（无法归一则返回原名） */
    fun normalize(raw: String?): String {
        if (raw.isNullOrBlank()) return ""
        val key = raw.trim().lowercase().removeSuffix("city").trim()
        return dict[key] ?: dict[dict.keys.firstOrNull { key.contains(it) } ?: ""] ?: raw.trim()
    }

    /**
     * 判断「探测到的属地」是否属于「目标城市」。
     * @param probed  探测接口返回的地名（可能英文）
     * @param target  后台城市池里的城市名（中文）
     * @param targetSlug 目标城市的 slug（如 city-hangzhou），用作额外线索
     */
    fun matches(probed: String?, target: String?, targetSlug: String? = null): Boolean {
        if (probed.isNullOrBlank() || target.isNullOrBlank()) return false

        val p = probed.trim()
        val t = target.trim()
        if (p.equals(t, ignoreCase = true)) return true

        val pn = normalize(p)
        if (pn.equals(t, ignoreCase = true)) return true

        // 包含匹配：处理「杭州市」/「杭州」这类差异
        if (pn.contains(t) || t.contains(pn)) return true

        // 用 slug 兜底：city-hangzhou → hangzhou
        val slugKey = targetSlug?.substringAfterLast('-')?.lowercase()
        if (!slugKey.isNullOrBlank()) {
            val pk = p.lowercase()
            if (pk.contains(slugKey) || slugKey.contains(pk)) return true
        }
        return false
    }

    /** 是否能在本地归一化（用于诊断：不能归一说明映射表需补充） */
    fun canNormalize(raw: String?): Boolean {
        if (raw.isNullOrBlank()) return false
        val key = raw.trim().lowercase().removeSuffix("city").trim()
        return dict.containsKey(key)
    }
}
