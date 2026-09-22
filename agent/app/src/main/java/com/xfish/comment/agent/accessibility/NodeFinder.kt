package com.xfish.comment.agent.accessibility

import android.view.accessibility.AccessibilityNodeInfo
import com.xfish.comment.agent.core.Log
import kotlinx.coroutines.delay

/**
 * 控件树定位（L1，主力方案，免截屏）。
 *
 * 采用**定位器优先级链（Locator Priority Chain）**（设计文档 §3.7 手段 1）：
 *   文本精确 → 文本包含 → 文本正则 → contentDescription → viewId → 类名 + 层级锚点
 * 机型与版本差异被降级为「回退链中的某一级」，而不是每个机型一套逻辑。
 *
 * 注意：**抖音是第三方 App，viewId 通常不可读**（非 debuggable），
 * 所以主力是 text / contentDescription，viewId 命中属额外收益。
 */
object NodeFinder {

    private const val TAG = "finder"

    /** 定位条件（按优先级依次尝试） */
    data class Locator(
        val textExact: List<String> = emptyList(),
        val textContains: List<String> = emptyList(),
        val textRegex: Regex? = null,
        val descContains: List<String> = emptyList(),
        val viewIds: List<String> = emptyList(),
        val className: String? = null,
        /** 命中后要求可点击（多数按钮场景） */
        val clickableOnly: Boolean = false,
        /** 最大深度限制，避免全树扫描过慢 */
        val maxDepth: Int = 30,
    )

    // ── 查询 ─────────────────────────────────────────────────

    /** 在当前窗口按定位链查找第一个命中节点 */
    fun find(locator: Locator): AccessibilityNodeInfo? {
        val root = AutoService.root() ?: return null
        return findIn(root, locator)
    }

    fun findIn(root: AccessibilityNodeInfo, locator: Locator): AccessibilityNodeInfo? {
        // 1) 精确文本
        locator.textExact.forEach { t -> findByText(root, t, exact = true, locator)?.let { return it } }
        // 2) 包含文本
        locator.textContains.forEach { t -> findByText(root, t, exact = false, locator)?.let { return it } }
        // 3) 正则文本
        locator.textRegex?.let { re -> findByRegex(root, re, locator)?.let { return it } }
        // 4) contentDescription
        locator.descContains.forEach { d -> findByDesc(root, d, locator)?.let { return it } }
        // 5) viewId（若可读）
        locator.viewIds.forEach { id -> findByViewId(root, id, locator)?.let { return it } }
        // 6) 类名兜底
        locator.className?.let { c -> findByClass(root, c, locator)?.let { return it } }
        return null
    }

    /** 找到所有命中文本的节点（用于「浏览评论」「统计条目」等场景） */
    fun findAllByTextContains(keyword: String, limit: Int = 20): List<AccessibilityNodeInfo> {
        val root = AutoService.root() ?: return emptyList()
        val out = ArrayList<AccessibilityNodeInfo>()
        walk(root, 0, 30) { node ->
            val t = node.text?.toString()
            if (!t.isNullOrBlank() && t.contains(keyword)) {
                out.add(node)
                if (out.size >= limit) return@walk false
            }
            true
        }
        return out
    }

    /**
     * 等待节点出现（轮询；抖音页面有渲染延迟，直接点会点空）。
     * @return 命中节点或 null（超时）
     */
    suspend fun waitFor(locator: Locator, timeoutMs: Long = 6_000, intervalMs: Long = 250): AccessibilityNodeInfo? {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            find(locator)?.let { return it }
            delay(intervalMs)
        }
        Log.w(TAG, "waitFor timeout: ${describe(locator)}")
        return null
    }

    /** 等待某段文本出现（用于提交后校验、弹窗识别） */
    suspend fun waitForTextContains(keyword: String, timeoutMs: Long = 8_000, intervalMs: Long = 300): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (containsText(keyword)) return true
            delay(intervalMs)
        }
        return false
    }

    /** 当前界面是否包含指定文本（含子串） */
    fun containsText(keyword: String): Boolean = findAllByTextContains(keyword, 1).isNotEmpty()

    /**
     * 一次遍历抓取当前界面所有非空文本（text + contentDescription）。
     *
     * ⚠ 性能：无障碍节点读取是**跨进程 IPC**，全树遍历一次成本很高。
     * 多关键词联合判定（风控/限流/验证码共 15+ 个关键词）若逐词遍历，
     * 会退化成 N 次全树扫描（实测可拖到数十秒）。统一改为「抓一次、内存里匹配」。
     */
    fun snapshotTexts(maxNodes: Int = 600): List<String> {
        val root = AutoService.root() ?: return emptyList()
        val out = ArrayList<String>()
        walk(root, 0, 30) { node ->
            node.text?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it) }
            node.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { out.add(it) }
            out.size < maxNodes
        }
        return out
    }

    /** 当前界面是否包含任一文本（单次遍历完成匹配） */
    fun containsAny(keywords: List<String>): String? {
        if (keywords.isEmpty()) return null
        val texts = snapshotTexts()
        if (texts.isEmpty()) return null
        return keywords.firstOrNull { k -> texts.any { it.contains(k) } }
    }

    /** 可点击祖先：抖音的文本节点常不可点，需向上找可点击父节点 */
    fun clickableAncestor(node: AccessibilityNodeInfo, maxUp: Int = 6): AccessibilityNodeInfo? {
        var cur: AccessibilityNodeInfo? = node
        var up = 0
        while (cur != null && up <= maxUp) {
            if (cur.isClickable && cur.isEnabled) return cur
            cur = cur.parent
            up++
        }
        return null
    }

    // ── 遍历实现 ─────────────────────────────────────────────

    private fun findByText(
        root: AccessibilityNodeInfo,
        text: String,
        exact: Boolean,
        locator: Locator,
    ): AccessibilityNodeInfo? {
        var hit: AccessibilityNodeInfo? = null
        walk(root, 0, locator.maxDepth) { node ->
            val t = node.text?.toString().orEmpty()
            val ok = if (exact) t == text else t.contains(text)
            if (ok && (!locator.clickableOnly || node.isClickable || clickableAncestor(node) != null)) {
                hit = node
                false
            } else true
        }
        return hit
    }

    private fun findByRegex(
        root: AccessibilityNodeInfo,
        re: Regex,
        locator: Locator,
    ): AccessibilityNodeInfo? {
        var hit: AccessibilityNodeInfo? = null
        walk(root, 0, locator.maxDepth) { node ->
            val t = node.text?.toString().orEmpty()
            if (t.isNotBlank() && re.containsMatchIn(t)) {
                hit = node
                false
            } else true
        }
        return hit
    }

    private fun findByDesc(
        root: AccessibilityNodeInfo,
        desc: String,
        locator: Locator,
    ): AccessibilityNodeInfo? {
        var hit: AccessibilityNodeInfo? = null
        walk(root, 0, locator.maxDepth) { node ->
            val d = node.contentDescription?.toString().orEmpty()
            if (d.contains(desc)) {
                hit = node
                false
            } else true
        }
        return hit
    }

    private fun findByViewId(
        root: AccessibilityNodeInfo,
        id: String,
        locator: Locator,
    ): AccessibilityNodeInfo? {
        val list = runCatching { root.findAccessibilityNodeInfosByViewId(id) }.getOrNull()
        val first = list?.firstOrNull() ?: return null
        return if (!locator.clickableOnly || first.isClickable) first else clickableAncestor(first)
    }

    private fun findByClass(
        root: AccessibilityNodeInfo,
        className: String,
        locator: Locator,
    ): AccessibilityNodeInfo? {
        var hit: AccessibilityNodeInfo? = null
        walk(root, 0, locator.maxDepth) { node ->
            if (node.className?.toString() == className && node.isClickable) {
                hit = node
                false
            } else true
        }
        return hit
    }

    /**
     * 深度优先遍历；回调返回 false 表示提前终止。
     * 有深度上限与节点数上限，避免超大页面（长评论列表）遍历过慢。
     */
    private fun walk(
        root: AccessibilityNodeInfo,
        startDepth: Int,
        maxDepth: Int,
        onNode: (AccessibilityNodeInfo) -> Boolean,
    ) {
        var visited = 0
        val maxVisited = 600

        fun dfs(node: AccessibilityNodeInfo, depth: Int): Boolean {
            if (depth > maxDepth) return true
            if (++visited > maxVisited) return true
            if (!onNode(node)) return false
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                if (!dfs(child, depth + 1)) return false
            }
            return true
        }
        dfs(root, startDepth)
    }

    /** 供日志的可读描述 */
    fun describe(locator: Locator): String = buildString {
        if (locator.textExact.isNotEmpty()) append("text=${locator.textExact.joinToString("|")} ")
        if (locator.textContains.isNotEmpty()) append("contains=${locator.textContains.joinToString("|")} ")
        if (locator.textRegex != null) append("regex=${locator.textRegex.pattern} ")
        if (locator.descContains.isNotEmpty()) append("desc=${locator.descContains.joinToString("|")} ")
        if (locator.viewIds.isNotEmpty()) append("id=${locator.viewIds.joinToString("|")} ")
        if (locator.className != null) append("class=${locator.className} ")
    }.trim()

    /**
     * 导出当前页面的关键节点摘要（自检探针用，设计文档 §3.7 手段 5）。
     * 只导出有 text / contentDescription 的节点，避免输出过长。
     */
    fun dumpSummary(maxNodes: Int = 120): List<String> {
        val root = AutoService.root() ?: return emptyList()
        val out = ArrayList<String>()
        walk(root, 0, 30) { node ->
            val t = node.text?.toString()?.trim()
            val d = node.contentDescription?.toString()?.trim()
            if (!t.isNullOrBlank() || !d.isNullOrBlank()) {
                out.add(
                    "${node.className?.toString()?.substringAfterLast('.') ?: "?"}" +
                        "|clickable=${node.isClickable}" +
                        (if (!t.isNullOrBlank()) "|text=$t" else "") +
                        (if (!d.isNullOrBlank()) "|desc=$d" else ""),
                )
            }
            out.size < maxNodes
        }
        return out
    }
}
