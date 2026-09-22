package com.xfish.comment.agent.exec

import com.xfish.comment.agent.accessibility.NodeFinder

/**
 * 抖音界面定位器（**规则包化的候选清单**，设计文档 §3.6 规则包 + §3.7 定位器回退链）。
 *
 * ⚠ 这里的每一项都必须经过 **PoC 六项验证**（设计文档 §3.5）在真机上确认命中率；
 *    当前是「基于常见界面结构的初始候选」，正式实现时应改为**由后台规则包下发**
 *    （`rule_pack` 分槽 common / byModel / byRom / byRes），本文件作为**内置基线规则**兜底。
 *
 * 设计要点：
 *  1. 每个元素给出**多个候选**（文本精确 / 文本包含 / 描述包含），逐级回退；
 *  2. 优先使用 `contentDescription`（抖音大量按钮只有描述没有文本）；
 *  3. 命中后统一走 `clickableAncestor`，因为文本节点常不可点。
 */
object DouyinLocators {

    /** 评论区入口（帖子右下角评论图标 / "查看全部评论"） */
    val commentEntry = NodeFinder.Locator(
        textExact = listOf("评论"),
        textContains = listOf("条评论", "查看全部评论", "说点什么"),
        descContains = listOf("评论"),
    )

    /** 打开评论输入框（占位提示文案；真机实测：「发条评论，说说你的感受」） */
    val commentInputEntry = NodeFinder.Locator(
        textContains = listOf(
            "发条评论", "说点什么", "留下你的精彩评论", "善语结善缘",
            "发表你的评论", "写评论", "抢首评", "友善评论",
        ),
        descContains = listOf("评论输入", "说点什么", "输入评论", "写评论"),
    )

    /** 发送按钮 */
    val sendButton = NodeFinder.Locator(
        textExact = listOf("发送", "发布"),
        descContains = listOf("发送"),
    )

    /** 点赞（未点赞态） */
    val likeButton = NodeFinder.Locator(
        descContains = listOf("点赞", "喜欢"),
        textExact = listOf("赞"),
    )

    /** 收藏（未收藏态） */
    val favoriteButton = NodeFinder.Locator(
        descContains = listOf("收藏"),
    )

    /** 「打开抖音」系统确认弹窗（短链唤起时可能出现） */
    val openInAppConfirm = NodeFinder.Locator(
        textExact = listOf("打开", "打开抖音", "允许"),
        textContains = listOf("打开抖音"),
    )

    /**
     * 风险提示关键词（命中即**本地秒级中止**，不盲目重试）。
     * 这是「唯一允许本地决策」的业务例外（设计文档 §3.6 职责边界）。
     */
    val riskKeywords = listOf(
        "操作频繁", "操作太快", "请稍后再试", "稍后再试",
        "系统繁忙", "网络繁忙",
        "异常", "被限制", "禁言",
        "验证", "滑块", "安全验证", "请完成验证",
        "账号存在风险", "违规", "无法完成",
    )

    /** 限流类（可短暂恢复，但本次必须中止） */
    val rateLimitKeywords = listOf("操作频繁", "操作太快", "请稍后再试", "稍后再试", "系统繁忙", "网络繁忙")

    /** 验证码类（需人工，必须告警） */
    val captchaKeywords = listOf("验证", "滑块", "安全验证", "请完成验证")

    /** 风控类（严重，必须告警） */
    val riskKeywordsSevere = listOf("账号存在风险", "被限制", "禁言", "无法完成", "违规")

    /** 输入框（可编辑节点，兜底用） */
    val editableField = NodeFinder.Locator(className = "android.widget.EditText")

    /**
     * 提交成功的判定：在评论列表中读到自己的话术。
     * 取话术前 N 个字符作为特征串（避免长文案比对开销与排版差异）。
     */
    fun commentSignature(scriptText: String): String {
        val cleaned = scriptText.replace("\n", "").replace(" ", "").trim()
        return cleaned.take(if (cleaned.length > 12) 12 else cleaned.length)
    }
}
