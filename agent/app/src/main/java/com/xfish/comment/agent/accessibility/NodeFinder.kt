package com.xfish.comment.agent.accessibility

import android.view.accessibility.AccessibilityNodeInfo
import com.xfish.comment.agent.core.Log
import com.xfish.comment.agent.core.Time
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
 *
 * ## 性能约定（2026-09-28 改造）
 *
 * **一次遍历抓快照，之后全在内存里匹配**。
 *
 * 早期实现是「定位链上每个候选串各遍历一次全树」：`commentInputEntry` 有
 * 9 个 textContains + 4 个 descContains + className ≈ **14 次全树 IPC**；叠加
 * `waitFor` 的 250ms 轮询后，单次等待最坏可达**数百次整树扫描** ——
 * 真机表现为「找评论输入框固定白等 5 秒，最后靠 `editableField` 兜底才命中」。
 *
 * 现在遍历只发生一次，IPC 次数从 `O(候选串数)` 降到 `O(1)`。
 * 之所以能这样，是因为 `text` / `contentDescription` / `className` / `isClickable`
 * 都是 [AccessibilityNodeInfo] 对象上的**本地字段**（取节点时已一并带回），
 * 读取不产生 IPC；**只有 `getChild` / `parent` 需要跨进程调用**。
 */
object NodeFinder {

    private const val TAG = "finder"

    /**
     * 单次遍历的节点数上限。
     * 长评论列表可达上千节点，超过此值即停止 —— 目的是把最坏耗时钉死在可控范围，
     * 宁可漏掉极深处的节点，也不让一次定位拖垮整个任务。
     */
    private const val DEFAULT_MAX_NODES = 600

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

    /**
     * 节点特征快照。
     *
     * 所有字段都在**遍历时一次性读出**（均为节点本地字段，无额外 IPC），
     * 之后定位链的每一级都在这份 List 上做内存匹配。
     */
    private class NodeSnapshot(
        val node: AccessibilityNodeInfo,
        val text: String,
        val desc: String,
        val className: String?,
        val clickable: Boolean,
    )

    // ── 查询 ─────────────────────────────────────────────────

    /** 在当前窗口按定位链查找第一个命中节点 */
    fun find(locator: Locator): AccessibilityNodeInfo? {
        val root = AutoService.root() ?: return null
        return findIn(root, locator)
    }

    fun findIn(root: AccessibilityNodeInfo, locator: Locator): AccessibilityNodeInfo? {
        val nodes = snapshot(root, locator.maxDepth)
        if (nodes.isEmpty()) return null
        return matchIn(root, nodes, locator)
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
     * 按**单调时钟**计时：改系统时间不会让超时乱跳（项目约定 §4.4）。
     * @return 命中节点或 null（超时）
     */
    suspend fun waitFor(locator: Locator, timeoutMs: Long = 6_000, intervalMs: Long = 250): AccessibilityNodeInfo? {
        val deadline = Time.elapsedMs() + timeoutMs
        while (Time.elapsedMs() < deadline) {
            find(locator)?.let { return it }
            delay(intervalMs)
        }
        Log.w(TAG, "waitFor timeout: ${describe(locator)}")
        return null
    }

    /** 等待某段文本出现（用于提交后校验、弹窗识别）；同样按单调时钟计时 */
    suspend fun waitForTextContains(keyword: String, timeoutMs: Long = 8_000, intervalMs: Long = 300): Boolean {
        val deadline = Time.elapsedMs() + timeoutMs
        while (Time.elapsedMs() < deadline) {
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
    fun snapshotTexts(maxNodes: Int = DEFAULT_MAX_NODES): List<String> {
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

    // ── 实现 ─────────────────────────────────────────────────

    /** 一次遍历抓取全部节点特征（本文件唯一的「大」IPC 开销来源） */
    private fun snapshot(root: AccessibilityNodeInfo, maxDepth: Int): List<NodeSnapshot> {
        val out = ArrayList<NodeSnapshot>(256)
        walk(root, 0, maxDepth) { node ->
            out.add(
                NodeSnapshot(
                    node = node,
                    text = node.text?.toString().orEmpty(),
                    desc = node.contentDescription?.toString().orEmpty(),
                    className = node.className?.toString(),
                    clickable = node.isClickable,
                ),
            )
            out.size < DEFAULT_MAX_NODES
        }
        return out
    }

    /**
     * 在快照上按优先级链匹配（纯内存运算，无 IPC）。
     *
     * 各级的判定语义与原实现**逐条保持一致**（尤其 clickableOnly 的适用范围）：
     *  · textExact / textContains：命中节点需满足 clickableOnly（否则向上找可点祖先，但返回原节点）
     *  · textRegex / descContains：原实现**不校验** clickableOnly，此处保持一致
     *  · className：原实现要求节点自身 clickable，且**不受** clickableOnly 影响
     */
    private fun matchIn(
        root: AccessibilityNodeInfo,
        nodes: List<NodeSnapshot>,
        locator: Locator,
    ): AccessibilityNodeInfo? {
        // 1) 精确文本
        locator.textExact.forEach { t ->
            nodes.firstOrNull { it.text == t && clickableOk(it, locator) }?.let { return it.node }
        }
        // 2) 包含文本
        locator.textContains.forEach { t ->
            nodes.firstOrNull { it.text.contains(t) && clickableOk(it, locator) }?.let { return it.node }
        }
        // 3) 正则文本
        locator.textRegex?.let { re ->
            nodes.firstOrNull { it.text.isNotBlank() && re.containsMatchIn(it.text) }?.let { return it.node }
        }
        // 4) contentDescription
        locator.descContains.forEach { d ->
            nodes.firstOrNull { it.desc.contains(d) }?.let { return it.node }
        }
        // 5) viewId：仍走官方 API —— 它是**单次** IPC，且能命中 viewIdResourceName 读不到的节点
        locator.viewIds.forEach { id ->
            val first = runCatching { root.findAccessibilityNodeInfosByViewId(id) }.getOrNull()?.firstOrNull()
            if (first != null) {
                val hit = if (!locator.clickableOnly || first.isClickable) first else clickableAncestor(first)
                if (hit != null) return hit
            }
        }
        // 6) 类名兜底：按 clickableOnly 判定（与前面几级口径一致）。
        //    ⚠ 早期实现无条件要求 `node.isClickable`：某个抖音版本的 EditText 若是
        //    clickable=false，`editableField` 就会恒为 null —— 而它正是
        //    `inputStillHasScript()` 的判据，于是「输入框是否仍有话术」永远返回 false，
        //    提交判定与校验全部失真（读到的是"输入框已空"）。
        locator.className?.let { c ->
            nodes.firstOrNull { it.className == c && clickableOk(it, locator) }?.let { return it.node }
        }
        return null
    }

    /** clickableOnly 判定：命中节点本身可点，或其祖先可点（与原实现一致） */
    private fun clickableOk(s: NodeSnapshot, locator: Locator): Boolean =
        !locator.clickableOnly || s.clickable || clickableAncestor(s.node) != null

    /**
     * 深度优先遍历；回调返回 false 表示提前终止。
     * 有深度上限与节点数上限，避免超大页面（长评论列表）遍历过慢。
     */
    private fun walk(
        root: AccessibilityNodeInfo,
        startDepth: Int,
        maxDepth: Int,
        maxNodes: Int = DEFAULT_MAX_NODES,
        onNode: (AccessibilityNodeInfo) -> Boolean,
    ) {
        var visited = 0

        fun dfs(node: AccessibilityNodeInfo, depth: Int): Boolean {
            if (depth > maxDepth) return true
            if (++visited > maxNodes) return true
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
