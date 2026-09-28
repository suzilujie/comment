package com.xfish.comment.agent.netlink

/**
 * 地域名归一化（**省级粒度**）。
 *
 * 为什么用省级而不是市级：
 *  抖音的 IP 属地只显示到省（「浙江」「广东」），市级精确匹配是**多余的精度** ——
 *  它会让「杭州组」和「宁波组」互不兼容，切城时只要落到隔壁市就算失败。
 *  按省判定后，同省任意节点都算命中，可用节点数量级提升，且不会再有「属地不符」。
 *
 * 归一化三层（由强到弱）：
 *  1. **精确匹配**（忽略大小写与空白）；
 *  2. **内置映射表**（34 个省级行政区的中英对照，ip-api 的 regionName 返回英文）；
 *  3. **包含匹配**（处理「浙江省」vs「浙江」），外加 slug 兜底（`province-zhejiang` → `zhejiang`）。
 *
 * 三层都不命中 → 返回 false：**宁可误判为不匹配，也不带病执行**
 * （属地错配的代价远高于漏发一条评论）。
 *
 * ⚠ 长期方案：由后台提供 IP→地域解析接口（`/agent/ipgeo`），把归一化集中到服务端。
 */
object RegionName {

    /** 省级中英对照（ip-api `regionName`/`region` 的常见写法 → 中文） */
    private val dict: Map<String, String> = mapOf(
        // ── 直辖市（本身即省级）──
        "beijing" to "北京", "beijing municipality" to "北京",
        "shanghai" to "上海", "shanghai municipality" to "上海",
        "tianjin" to "天津", "tianjin municipality" to "天津",
        "chongqing" to "重庆", "chongqing municipality" to "重庆",
        // ── 省 ──
        "hebei" to "河北", "shanxi" to "山西", "liaoning" to "辽宁",
        "jilin" to "吉林", "heilongjiang" to "黑龙江",
        "jiangsu" to "江苏", "zhejiang" to "浙江", "anhui" to "安徽",
        "fujian" to "福建", "jiangxi" to "江西", "shandong" to "山东",
        "henan" to "河南", "hubei" to "湖北", "hunan" to "湖南",
        "guangdong" to "广东", "hainan" to "海南",
        "sichuan" to "四川", "guizhou" to "贵州", "yunnan" to "云南",
        "shaanxi" to "陕西", "gansu" to "甘肃", "qinghai" to "青海",
        // ── 自治区 ──
        "inner mongolia" to "内蒙古", "nei mongol" to "内蒙古",
        "guangxi" to "广西", "guangxi zhuang" to "广西",
        "tibet" to "西藏", "xizang" to "西藏",
        "ningxia" to "宁夏", "ningxia hui" to "宁夏",
        "xinjiang" to "新疆", "xinjiang uygur" to "新疆",
        // ── 特别行政区 ──
        "hong kong" to "香港", "macau" to "澳门", "macao" to "澳门", "taiwan" to "台湾",
        // ── 境外（设备可能落在海外节点上）──
        "singapore" to "新加坡", "japan" to "日本", "tokyo" to "日本",
        "hongkong" to "香港",
    )

    /** 归一为中文省份名（无法归一则返回原名） */
    fun normalize(raw: String?): String {
        if (raw.isNullOrBlank()) return ""
        val k = raw.trim().lowercase()
        dict[k]?.let { return it }
        // 去掉常见后缀再试一次（ip-api 有 "Zhejiang Sheng" / "Guangdong Province" 之类）
        val stripped = k
            .removeSuffix(" sheng").removeSuffix(" shi")
            .removeSuffix(" province").removeSuffix(" municipality")
            .removeSuffix(" autonomous region").removeSuffix(" region")
            .removeSuffix(" special administrative region")
            .trim()
        dict[stripped]?.let { return it }
        // 包含匹配：任一 key 出现在输入里
        dict.entries.firstOrNull { k.contains(it.key) }?.let { return it.value }
        return raw.trim()
    }

    /**
     * 判断「探测到的地域」是否属于「目标省份」。
     * @param probed     探测结果（英文省份名，如 `Zhejiang`）
     * @param target     目标省份（后台城市池里的中文名，如 `浙江`）
     * @param targetSlug 目标 slug（如 `province-zhejiang`），作额外线索
     */
    fun matches(probed: String?, target: String?, targetSlug: String? = null): Boolean {
        if (probed.isNullOrBlank() || target.isNullOrBlank()) return false

        val p = probed.trim()
        val t = target.trim()
        if (p.equals(t, ignoreCase = true)) return true

        val pn = normalize(p)
        if (pn.equals(t, ignoreCase = true)) return true

        // 包含匹配：处理「浙江省」/「浙江」
        if (pn.contains(t) || t.contains(pn)) return true

        // slug 兜底：province-zhejiang → zhejiang
        val slugKey = targetSlug?.substringAfterLast('-')?.lowercase()
        if (!slugKey.isNullOrBlank()) {
            val pk = p.lowercase()
            val pnk = pn.lowercase()
            if (pk.contains(slugKey) || slugKey.contains(pk)) return true
            if (pnk.contains(slugKey) || slugKey.contains(pnk)) return true
        }
        return false
    }

    /** 是否能在本地归一化（用于诊断：不能归一说明映射表需补充） */
    fun canNormalize(raw: String?): Boolean {
        if (raw.isNullOrBlank()) return false
        return dict.containsKey(raw.trim().lowercase())
    }

    /**
     * 归一化结果是否已是「可识别的省份」。
     *
     * 判定依据：归一后含非 ASCII 字符（即中文）。
     * 返回 true 说明能落到后台的省份命名体系里；返回 false 表示这个原始值
     * 既不在映射表中、也不是中文 —— **直接上报必然与 `posts.city` 匹配不上**。
     * 这时应当改报 `unknown`，把这问题在日志里显式暴露出来，
     * 而不是静默地一直领不到任务（后台只会回一个 `no_post_in_city`，很难查）。
     */
    fun isResolved(raw: String?): Boolean {
        val n = normalize(raw)
        return n.isNotBlank() && n.any { it.code > 127 }
    }
}
