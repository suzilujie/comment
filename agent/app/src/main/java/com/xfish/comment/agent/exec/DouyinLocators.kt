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

    /**
     * 评论区入口（帖子右下角评论图标 / "查看全部评论"）。
     *
     * ⚠ 真机实测（抖音 39.7.0 / Redmi K30，2026-09-26）：评论区**展开后**页面上存在
     *    desc="缩小评论区" 的关闭按钮，会被宽泛候选 desc="评论" 误命中。因此：
     *    ① desc 候选按「精确 → 宽泛」排序；
     *    ② 调用方必须先判断面板是否已展开，再决定要不要点入口（见 SelfCheck / TaskExecutor）。
     */
    val commentEntry = NodeFinder.Locator(
        textExact = listOf("评论"),
        textContains = listOf("条评论", "查看全部评论"),
        descContains = listOf("查看评论", "评论按钮", "打开评论", "评论"),
    )

    /**
     * 评论输入框（占位文案随抖音版本变化，实测记录）：
     *  · 抖音 39.7.0（2026-09-26 实测）：text="分享你此刻的想法"，class=EditText，评论区唯一可编辑节点；
     *  · 早期版本：text="发条评论，说说你的感受"。
     * 末尾的 className 兜底：新文案尚未收录时仍能命中输入框。
     */
    val commentInputEntry = NodeFinder.Locator(
        textContains = listOf(
            "分享你此刻的想法",   // 抖音 39.7.0（K30 实测 2026-09-26）
            "发条评论", "说点什么", "留下你的精彩评论", "善语结善缘",
            "发表你的评论", "写评论", "抢首评", "友善评论",
        ),
        descContains = listOf("评论输入", "说点什么", "输入评论", "写评论"),
        className = "android.widget.EditText",
    )

    /** 发送按钮 */
    val sendButton = NodeFinder.Locator(
        textExact = listOf("发送", "发布"),
        descContains = listOf("发送"),
    )

    /**
     * 「表情」开关（工具栏里那个）。
     *
     * 用途：贴图后抖音会停在**表情面板展开态**，此时输入框不响应 `ACTION_PASTE` 与长按，
     * 必须先点它切回键盘（见 TaskExecutor.attachCommentImage 第 ⑤ 步）。
     * ⚠ 它是**开关**：面板已关时点它反而会打开，所以调用方必须先判断 [emojiPanelOpen]。
     */
    val emojiPanelToggle = NodeFinder.Locator(
        descContains = listOf("表情"),
        textExact = listOf("表情"),
    )

    // ── 图文评论的贴图链路（2026-09-28 真机实测 抖音 39.7.0 / Redmi K30）──
    //  评论输入栏：EditText(id:ety) | **插入图片(iv_image)** | at | 表情
    //  点「插入图片」→ 打开抖音自带相册 MvChoosePhotoActivity（标题「所有照片」）

    /** 评论输入栏的「插入图片」入口（折叠态与展开态都在同一位置） */
    val insertImageButton = NodeFinder.Locator(
        descContains = listOf("插入图片"),
        viewIds = listOf("com.ss.android.ugc.aweme:id/iv_image"),
    )

    /** 相册选择器已就绪（标题「所有照片」，或照片网格出现） */
    val albumPickerReady = NodeFinder.Locator(
        textContains = listOf("所有照片"),
        viewIds = listOf("com.ss.android.ugc.aweme:id/rv5"),
    )

    /**
     * 相册里的照片格提示文案。
     *
     * ⚠ 照片格**没有任何业务特征**：contentDescription 由系统拼成 ", 点按两次即可激活"
     *   （未命名的 ImageView），resource-id 是混淆过的 `rv5`。所以只能靠「位置」
     *   选图 —— 树序遍历的第一个格子就是相册里最新的一张。见 TaskExecutor.attachCommentImage。
     */
    const val ALBUM_CELL_HINT = "点按两次即可激活"

    /** 照片网格的纵向起点：标题/搜索框/分类按钮都在其上方，用它把匹配限制在网格内 */
    const val ALBUM_GRID_TOP = 450

    // 注：「图片是否已挂到评论上」的判据**不在这里** —— 它要同时看描述与坐标，
    //     `Locator` 表达不了，实现见 TaskExecutor.isImageAttachedNode()。
    //     这里留两个踩过的坑，避免以后又写错：
    //       · 「同时发布为作品」**不是**附图标志：只要评论编辑框展开它就存在
    //         （实测 2026-09-28：未贴图、仅展开编辑框时同样命中）；
    //       · `id:evr` 也不是：详情页「评论N」按钮内部的图标同样是 `evr`。
    //     两者任一都会把"贴图失败"误判成"已贴图"，然后放行发出一条
    //     后台记为图文、实际纯文字的评论 —— 正是本次改造要根除的那个 bug。

    /** 点赞（未点赞态） */
    val likeButton = NodeFinder.Locator(
        descContains = listOf("点赞", "喜欢"),
        textExact = listOf("赞"),
    )

    /** 收藏（未收藏态） */
    val favoriteButton = NodeFinder.Locator(
        descContains = listOf("收藏"),
    )

    /**
     * 评论区**是否已展开**的判据。
     *
     * ⚠ 刻意**不含 `className` 兜底**：[commentInputEntry] 的最后一级回退是
     * `className = "android.widget.EditText"`，而页面上任何 EditText（搜索框、
     * 描述输入…）都会命中它 —— 拿它判定"面板是否已展开"会**必然误判为已展开**
     * （2026-09-28 实测：连续两轮都打出"评论区已处于展开状态，跳过打开动作"）。
     * 这里只用「评论专属文案 / contentDescription」，命中才代表评论面板确实在。
     */
    val commentPanelOpen = NodeFinder.Locator(
        textContains = listOf(
            "分享你此刻的想法", "发条评论", "说点什么", "留下你的精彩评论",
            "善语结善缘", "发表你的评论", "写评论", "抢首评",
        ),
        descContains = listOf("评论输入", "输入评论"),
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

    /**
     * 限流类**强特征**：措辞本身就是「被限流」，正常视频文案里几乎不会出现，
     * 命中即判定（不要求弹窗结构）。
     */
    val rateLimitStrongKeywords = listOf("操作频繁", "操作太快", "评论频繁", "发言频繁")

    /** 限流类（可短暂恢复，但本次必须中止）；含弱特征，需弹窗结构配合判定 */
    val rateLimitKeywords = listOf("操作频繁", "操作太快", "请稍后再试", "稍后再试", "系统繁忙", "网络繁忙")

    /**
     * 验证码 / 安全验证的**强特征**：措辞本身就说明「这是验证页」。
     * 命中即判定 —— **不要求伴随弹窗结构**，因为滑块验证页常常只有滑块，
     * 连「确定/取消」都没有（早期统一要求 overlay，导致滑块验证被完整漏检）。
     */
    val captchaStrongKeywords = listOf(
        "拖动滑块", "滑动验证", "滑块验证", "完成验证", "安全验证", "请完成验证",
    )

    /** 验证码类**弱特征**（需人工，必须告警）；正文里也可能出现，需弹窗结构配合判定 */
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
