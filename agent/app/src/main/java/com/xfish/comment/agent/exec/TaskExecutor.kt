package com.xfish.comment.agent.exec

import android.content.Context
import android.graphics.Rect
import android.net.Uri
import android.view.accessibility.AccessibilityNodeInfo
import com.xfish.comment.agent.accessibility.Actions
import com.xfish.comment.agent.accessibility.AutoService
import com.xfish.comment.agent.accessibility.Human
import com.xfish.comment.agent.accessibility.NodeFinder
import com.xfish.comment.agent.core.Config
import com.xfish.comment.agent.core.Log
import com.xfish.comment.agent.core.Rnd
import com.xfish.comment.agent.core.Time
import com.xfish.comment.agent.data.AgentDb
import com.xfish.comment.agent.data.LocalState
import com.xfish.comment.agent.data.TaskRecord
import com.xfish.comment.agent.net.TaskPackageDto
import com.xfish.comment.agent.netlink.RegionName
import com.xfish.comment.agent.netlink.IpProbe
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 任务执行器（设计文档 §3.6 执行层 + §5.2 单条评论执行时序）。
 *
 * 三段式：**定位（Locate）→ 动作（Act）→ 验证（Verify）**，任一环节失败即中止或降级。
 *
 * ══ 幂等与状态判定（本文件最重要的部分）══
 * 评论有副作用且不可撤销，因此：
 *  · 执行前先落盘意图（PENDING）→ 执行 → 落盘结果；
 *  · **确认未发出** → `failed` / `aborted`（可退还配额）；
 *  · **无法确认是否已发出** → `unknown`，**禁止自动重试**（转人工确认）。
 *
 * 提交后的判定（实测约束：抖音的评论正文与昵称**不暴露给无障碍服务**，
 * 所以"在列表里读到自己的评论"基本不可能命中）：
 *  · 列表里读到本轮话术 → `succeeded`（comment_visible）
 *  · 评论数（desc="评论N，按钮"）+1 → `succeeded`（comment_count_increased，唯一可读的正向证据）
 *  · 输入框仍有文本 → 提交未生效 → `failed`（确认未发出）
 *  · 输入框空了但两条证据都拿不到 → 可能已发出（审核中 / 计数未刷新）→ **`unknown`**
 */
object TaskExecutor {

    private const val TAG = "exec"

    /** 执行结果（对应后台任务终态） */
    data class Outcome(
        val status: String,          // succeeded / failed / aborted / unknown
        val reasonCode: String?,
        val evidence: String?,
        val detail: JsonObject? = null,
        val startedAt: Long? = null,
        val finishedAt: Long? = null,
    )

    /** 上报接口：由常驻服务实现（避免执行器直接依赖网络层） */
    interface Reporter {
        /** 开工信号（"我要开始了"） */
        suspend fun onStarted(taskId: String)

        /** 任务结束（终态） */
        suspend fun onFinished(task: TaskPackageDto, outcome: Outcome)
    }

    /**
     * 执行一条任务。**整个流程保证不抛异常**（任何异常都转化为终态）。
     */
    suspend fun execute(context: Context, task: TaskPackageDto, reporter: Reporter): Outcome {
        val dao = AgentDb.get(context).taskDao()
        val startedAt = Time.nowMs()
        val albumUris = mutableListOf<Uri>()

        Log.i(TAG, "===== 开始执行任务 ${task.taskId} 帖子=${task.postId} 形态=${task.commentType} =====")

        try {
            // ── 步骤 0：幂等校验（已执行过的任务不再执行）──
            // ⚠ UNKNOWN 必须一并拦截：它的语义是「可能已发出、禁止自动重试」。
            // 若后台对未收到回执的任务重派同 taskId，本地不拦就会重跑 → 重复评论。
            val existing = dao.find(task.taskId)
            if (existing != null && existing.state in setOf(
                    LocalState.RUNNING, LocalState.SUCCESS, LocalState.REPORTED, LocalState.UNKNOWN,
                )
            ) {
                Log.w(TAG, "任务 ${task.taskId} 已处理过（${existing.state}），跳过")
                return finish(
                    Outcome("aborted", Config.Reason.DUPLICATE_TASK, "local_state=${existing.state}", startedAt = startedAt),
                    task, reporter,
                )
            }

            // ── 步骤 0.5：无障碍可用性（决定能否干活）──
            if (!AutoService.connected) {
                Log.w(TAG, "无障碍服务未连接，无法执行")
                return finish(Outcome("aborted", Config.Reason.ACCESSIBILITY_OFF, "a11y_disconnected", startedAt = startedAt), task, reporter)
            }

            // ── 步骤 1：属地自检（双重校验的执行前那一重）──
            val probe = IpProbe.probe()
            if (probe == null) {
                Log.w(TAG, "出口 IP 探测失败（代理未连通？）")
                return finish(Outcome("aborted", Config.Reason.NETWORK, "ip_probe_failed", startedAt = startedAt), task, reporter)
            }
            // 属地自检（**省级**）：探测不到省份、或与目标省份不符，一律不执行。
            // **不回退历史值** —— 那会掩盖代理异常，让评论带着错误属地发出去。
            if (!RegionName.matches(probe.region, task.ipCityTarget)) {
                Log.w(
                    TAG,
                    "属地不匹配：探测=${probe.region.ifBlank { "-" }}" +
                        "/${probe.city.ifBlank { "-" }} 目标=${task.ipCityTarget} → 拒绝执行",
                )
                return finish(
                    Outcome(
                        "aborted", Config.Reason.IP_MISMATCH,
                        "probe=${probe.region.ifBlank { "-" }} target=${task.ipCityTarget}",
                        startedAt = startedAt,
                    ),
                    task, reporter,
                )
            }
            Log.i(TAG, "属地自检通过：${probe.region}（${probe.city} / ip=${probe.ip}）")

            // ── 步骤 2：写前意图落盘（WAL）──
            dao.upsert(
                TaskRecord(
                    taskId = task.taskId,
                    postId = task.postId,
                    postUrl = task.postUrl,
                    commentType = task.commentType,
                    scriptText = task.scriptText,
                    imagePath = task.image?.hash,
                    ipCityTarget = task.ipCityTarget,
                    deadlineAt = task.deadlineAt,
                    state = LocalState.PENDING,
                    createdAt = startedAt,
                ),
            )

            // ── 步骤 3：开工信号（后台据此置 executing，并提升 unknown 判定精度）──
            reporter.onStarted(task.taskId)
            dao.markStarted(task.taskId, LocalState.RUNNING, Time.nowMs())

            // ── 步骤 4：素材准备（仅图文评论）──
            // ⚠ 这里**只下载/缓存**，**写相册推迟到步骤 8.6（贴图前一刻）**。
            //    原因见 attachCommentImage 的注释：相册选择器只能按位置选图（第一格 = 最新一张），
            //    "写入相册"与"点选"之间的时间窗越短，期间新增照片导致选错图的概率越低。
            //    下载放在这里是为了**早失败、便宜失败** —— 此刻还没碰抖音。
            if (task.commentType == "image") {
                val image = task.image
                if (image == null) {
                    Log.w(TAG, "任务为图文形态但未携带图片")
                    return finish(Outcome("aborted", Config.Reason.ELEMENT_MISSING, "image_missing", startedAt = startedAt), task, reporter)
                }
                if (MaterialStore.ensureCached(context, image) == null) {
                    return finish(Outcome("failed", Config.Reason.NETWORK, "material_download_failed", startedAt = startedAt), task, reporter)
                }
            }

            // ── 步骤 5：唤起抖音 + 短链直达帖子 ──
            // 计时统一用**单调时钟**（项目约定 §4.4）：nowMs() 会被后台校时影响，
            // 校准瞬间可能让「已等 10 秒」这类判定凭空跳变。
            val t5 = Time.elapsedMs()
            if (!Actions.launchDouyin(context)) {
                return finish(Outcome("failed", Config.Reason.DOUYIN_NOT_LAUNCHED, "launch_failed", startedAt = startedAt), task, reporter)
            }
            riskOrNull()?.let { return finish(it.copy(startedAt = startedAt), task, reporter) }
            Log.i(TAG, "步骤5-a 唤起抖音完成：耗时=${Time.elapsedMs() - t5}ms 页面=${AutoService.currentPage()}")

            if (!Actions.openShortLink(context, task.postUrl)) {
                return finish(Outcome("failed", Config.Reason.DOUYIN_NOT_LAUNCHED, "short_link_failed", startedAt = startedAt), task, reporter)
            }
            // 等抖音进入前台：AppLinkHandler 需先解析短链（实测约 2.5s）再跳转，等待给足。
            // 按真实时间计时——探测在冷启动期可能阻塞，累加 delay 会把超时悄悄拉长。
            val fgStart = Time.elapsedMs()
            while (Time.elapsedMs() - fgStart < 10_000 && !AutoService.douyinForeground()) {
                delay(500)
            }
            val waitedMs = Time.elapsedMs() - fgStart
            riskOrNull()?.let { return finish(it.copy(startedAt = startedAt), task, reporter) }

            if (!AutoService.douyinForeground()) {
                Log.w(
                    TAG,
                    "短链打开后抖音未进入前台（已等 ${waitedMs}ms，可能短链失效或落入浏览器）" +
                        "页面=${AutoService.currentPage()}",
                )
                return finish(Outcome("aborted", Config.Reason.LOGIN_INVALID, "douyin_not_foreground", startedAt = startedAt), task, reporter)
            }
            Log.i(TAG, "步骤5-b 短链已进入抖音：等待=${waitedMs}ms 页面=${AutoService.currentPage()}")

            // ── 确认已进入**目标视频详情页** ──
            // ⚠ 判据不能只是「找得到评论入口」：**首页推荐流的视频同样有评论入口**，
            //    短链失效停在首页时也会通过 —— 那样就会给一个**错误的视频**发评论，
            //    而回执还是 succeeded（2026-09-28 实测：入口确认仅 23ms 就"通过"了，
            //    当时页面其实是 homepage...CustomRelativeLayout）。
            // 改为「**详情页出现过**」（短链解析成功的可靠标志）＋「评论入口可读」。
            val tPost = Time.elapsedMs()
            var onPost = AutoService.awaitDetailPage(8_000) &&
                NodeFinder.waitFor(DouyinLocators.commentEntry, timeoutMs = 3_000) != null

            if (!onPost) {
                // 短链可能没被解析（停在首页 / 推荐流）→ 重投一次短链再判一次
                Log.w(TAG, "首次未确认详情页（页面=${AutoService.currentPage()}），重投一次短链")
                Actions.openShortLink(context, task.postUrl)
                onPost = AutoService.awaitDetailPage(8_000) &&
                    NodeFinder.waitFor(DouyinLocators.commentEntry, timeoutMs = 3_000) != null
            }

            if (!onPost) {
                Log.w(
                    TAG,
                    "未进入目标视频页（无详情页特征）：帖子=${task.postId} " +
                        "页面=${AutoService.currentPage()} 探测耗时=${Time.elapsedMs() - tPost}ms",
                )
                logPageDump("未进入目标视频页")
                return finish(
                    Outcome("failed", Config.Reason.POST_MISMATCH, "detail_page_not_entered", startedAt = startedAt),
                    task, reporter,
                )
            }
            Log.i(
                TAG,
                "✅ 已进入目标视频页：帖子=${task.postId} url=${task.postUrl} " +
                    "页面=${AutoService.currentPage()} " +
                    "短链直达总耗时=${Time.elapsedMs() - t5}ms 入口确认耗时=${Time.elapsedMs() - tPost}ms",
            )

            // ── 步骤 6：浏览停留 + 随机滑动（行为仿真）──
            Human.dwellForBrowsing(context)
            val swipes = Rnd.int(0, 3)
            repeat(swipes) {
                Actions.swipeVertical(screenCenterX(context), screenHeight(context) * 0.72, screenHeight(context) * 0.35)
                Human.pause(600, 1_800)
            }
            riskOrNull()?.let { return finish(it.copy(startedAt = startedAt), task, reporter) }

            // ── 步骤 7：点赞 / 收藏（按人格概率，不做 100% 必点）──
            if (task.actions.contains("like") && Human.shouldLike(context)) {
                Human.reactBeforeClick(context)
                val node = NodeFinder.find(DouyinLocators.likeButton)
                if (node != null && Actions.click(node)) Log.i(TAG, "已点赞")
                else Log.d(TAG, "点赞节点未命中（跳过）")
            }
            if (task.actions.contains("favorite") && Human.shouldFavorite(context)) {
                Human.reactBeforeClick(context)
                val node = NodeFinder.find(DouyinLocators.favoriteButton)
                if (node != null && Actions.click(node)) Log.i(TAG, "已收藏")
                else Log.d(TAG, "收藏节点未命中（跳过）")
            }

            // ── 步骤 8：打开评论区 → 先读几条评论（真人不会打开就发）──
            // 若面板已展开（抖音部分页面默认展开评论区），不要再去点「入口」——
            // 展开态下 commentEntry 的宽泛候选会命中 desc="缩小评论区" 的关闭按钮（39.7.0 实测）。
            // ⚠ 判据用 commentPanelOpen（**不含 EditText 类名兜底**）：
            // commentInputEntry 的最后一级回退是 className=EditText，页面任何输入框都会命中，
            // 拿它判定"已展开"必然误判（实测连续两轮都跳过打开动作）。
            val panelAlreadyOpen = NodeFinder.find(DouyinLocators.commentPanelOpen) != null
            if (!panelAlreadyOpen) {
                val entry = NodeFinder.find(DouyinLocators.commentEntry)
                if (entry == null || !Actions.click(entry)) {
                    logPageDump("评论区入口未命中或点击失败")
                    return finish(Outcome("failed", Config.Reason.ELEMENT_MISSING, "comment_entry_click_failed", startedAt = startedAt), task, reporter)
                }
                delay(Rnd.long(900, 1_800))
            } else {
                // 措辞要准：命中的可能是「详情页底部输入框」也可能是「已展开的面板输入框」，
                // 两者占位文案相同、都无法区分。判据的实际含义是「输入框已经可见、可以直接输入」，
                // 所以跳过打开动作是正确的。早期写成"评论区已处于展开状态"会让人误以为判定出错。
                Log.i(TAG, "评论输入框已可见，跳过打开动作")
            }
            riskOrNull()?.let { return finish(it.copy(startedAt = startedAt), task, reporter) }

            val toRead = Human.commentsToRead(context)
            Log.i(TAG, "先浏览 $toRead 条评论")
            repeat(toRead) {
                Actions.swipeVertical(screenCenterX(context), screenHeight(context) * 0.70, screenHeight(context) * 0.45)
                Human.pause(900, 2_600)
            }

            // ── 步骤 8.5：记录评论数基线（发送前必须取，否则无法比较）──
            // 抖音评论正文/昵称不暴露给无障碍服务（2026-09-26 实测：整页 dump 仅 212 个节点、
            // 无任何评论文本、无昵称），"读到自己的评论"基本不可命中；
            // 因此把可读的「评论数」作为提交成功的第二判据（发送后 +1）。
            // 读不到时**先把评论面板真正打开再读一次**：
            //   步骤 8 判断"面板是否已展开"用的是输入框占位文案，而**折叠态底栏与展开态编辑框
            //   的占位文案完全相同**（实测都是「发条评论，和大家一起讨论」）—— 面板其实没展开
            //   也会判成"已展开"并跳过打开动作，于是评论列表从未加载、评论数基线恒为 null，
            //   「评论数 +1」这条**唯一**可用的正向证据直接作废
            //   （实测 2026-09-28：0 评论视频的纯文字评论明明发出去了，却判 unknown）。
            //   面板是否真的展开，用「放大评论区/缩小评论区」这个**只在面板存在时才出现**的按钮判断。
            var commentCountBefore = readCommentCount()
            if (commentCountBefore == null &&
                NodeFinder.containsAny(listOf("放大评论区", "缩小评论区")) == null
            ) {
                Log.i(TAG, "评论数基线读不到，尝试打开评论面板后重读")
                NodeFinder.find(DouyinLocators.commentEntry)?.let { Actions.click(it) }
                delay(Rnd.long(900, 1_600))
                commentCountBefore = readCommentCount()
            }
            Log.i(TAG, "发送前评论数基线=$commentCountBefore")

            // ── 步骤 8.6：图文评论 → 贴图（**发送前必须完成**）──
            // 顺序刻意是"先贴图、再打字"：抖音的相册是「单击即选中并返回」，返回后编辑框
            // 自动展开、键盘弹起，正好接着走步骤 9 输入话术。
            // 失败一律按 **aborted**：此刻还没点发送 → 确认未发出、可退配额。
            // ⚠ 绝不能"贴图失败就退回发纯文字" —— 后台会把它记成图文评论，统计上 1/4 配比
            //    看似完成，实际一条图都没带（这正是改造前的状态）。
            if (task.commentType == "image") {
                attachCommentImage(context, task, albumUris, startedAt)?.let {
                    return finish(it, task, reporter)
                }
            }

            // ── 步骤 9：输入话术（剪贴板 + 粘贴）──
            val inputEntry = NodeFinder.waitFor(DouyinLocators.commentInputEntry, timeoutMs = 5_000)
                ?: NodeFinder.find(DouyinLocators.editableField)
            if (inputEntry == null) {
                logPageDump("评论输入框未命中")
                return finish(Outcome("failed", Config.Reason.ELEMENT_MISSING, "input_entry_not_found", startedAt = startedAt), task, reporter)
            }
            Human.reactBeforeClick(context)
            Actions.click(inputEntry)
            Human.thinkPause(context)   // "思考"停顿：真人不会点开就发

            val editable = Actions.findFocusedEditable() ?: inputEntry
            if (!Actions.pasteIntoFocused(context, task.scriptText, editable)) {
                return finish(Outcome("failed", Config.Reason.INPUT_FAILED, "paste_failed", startedAt = startedAt), task, reporter)
            }
            Human.verifyPause(context)  // "检查"停顿

            // 校验文本确实进了输入框
            val signature = DouyinLocators.commentSignature(task.scriptText)
            val typedOk = NodeFinder.waitForTextContains(signature, timeoutMs = 3_000)
            if (!typedOk) {
                Log.w(TAG, "输入框未读到话术（signature=$signature）")
                return finish(Outcome("failed", Config.Reason.INPUT_FAILED, "text_not_typed", startedAt = startedAt), task, reporter)
            }

            // ── 步骤 10：提交 ──
            // 超期检查：前面有大量拟人化等待（浏览最长 90 秒 + 阅读评论 + 收尾 1~3 条），
            // 叠加后可能已过后台给的 deadline。此刻**还没点发送**，所以按 aborted 明确
            // 「确认未发出、可退配额」上报，而不是继续发一条后台已判超时的评论。
            if (isPastDeadline(task)) {
                Log.w(TAG, "已超过后台截止时间（${task.deadlineAt}），放弃提交")
                return finish(
                    Outcome("aborted", Config.Reason.DEADLINE_EXCEEDED, "past_deadline", startedAt = startedAt),
                    task, reporter,
                )
            }
            // 实测：抖音的「发送」是 clickable=false 的 TextView，控件点击可能落在错误的祖先上，
            // 表现为「点完发送但文本仍在输入框」。改为「点击 → 验证输入框是否清空 → 重试」。
            riskOrNull()?.let { return finish(it.copy(startedAt = startedAt), task, reporter) }
            var submitted = false
            for (attempt in 0..2) {
                val send = NodeFinder.find(DouyinLocators.sendButton)
                    ?: NodeFinder.waitFor(DouyinLocators.sendButton, timeoutMs = 2_000)
                    ?: break
                Actions.click(send, preferGesture = attempt > 0)
                delay(900)
                if (!inputStillHasScript(signature)) {
                    submitted = true
                    Log.i(TAG, "发送已点击（第 ${attempt + 1} 次），输入框已不含话术")
                    break
                }
                Log.w(TAG, "第 ${attempt + 1} 次点击发送未生效（输入框仍含话术），重试")
            }
            if (!submitted) {
                Log.w(TAG, "发送点击后输入框未清空 → 判定提交失败")
                return finish(Outcome("failed", Config.Reason.SUBMIT_FAILED, "send_button_not_effective", startedAt = startedAt), task, reporter)
            }
            Log.i(TAG, "已点击发送，等待结果……")

            // ── 步骤 11：校验（决定 succeeded / failed / unknown）──
            delay(Rnd.long(1_200, 2_000))
            // ⚠ 这里已经点过发送，评论**可能已发出**：风控信号必须归 unknown，绝不能报 aborted。
            // 后台把 aborted 当「确认未发出」→ 退还当日配额并可能重新派单 → 同帖评论两次。
            riskOrNull()?.let { return finish(it.asUnknownAfterSubmit(startedAt), task, reporter) }

            val tVerify = Time.elapsedMs()
            // 真机实测（2026-09-26 / Redmi K30 / 抖音 39.7.0）：发送成功后评论其实已发出，
            // 校验却读不到 → 误判 not_visible_but_input_empty（unknown）。两个原因：
            //   ① 发送后评论面板可能被收起，评论列表不在无障碍树里（dump 里只有标题与输入框）；
            //   ② 步骤 8 浏览评论已把列表滚到中段，而新评论在最顶部 —— 不回顶就永远读不到。
            // 因此改为「确保面板展开 → 滚回顶部 → 轮询读取」三轮，命中即止。
            var visible = false
            var inputStillHasText = false
            var countAfter: Int? = null
            for (round in 0..2) {
                if (round > 0) {
                    // 同上：此刻已提交，风控只能归 unknown（禁止自动重试）
                    riskOrNull()?.let { return finish(it.asUnknownAfterSubmit(startedAt), task, reporter) }
                    // 面板收起时先重新展开（展开态下点 commentEntry 会命中「缩小评论区」，故先判）
                    if (NodeFinder.find(DouyinLocators.commentPanelOpen) == null) {
                        NodeFinder.find(DouyinLocators.commentEntry)?.let { Actions.click(it) }
                        delay(Rnd.long(800, 1_400))
                    }
                    // 新评论在列表最顶部：拇指自上而下滑两次，把列表拉回顶部
                    repeat(2) {
                        Actions.swipeVertical(
                            screenCenterX(context),
                            screenHeight(context) * 0.35,
                            screenHeight(context) * 0.72,
                        )
                        delay(Rnd.long(500, 900))
                    }
                }
                visible = NodeFinder.waitForTextContains(signature, timeoutMs = 3_000)
                // 关键证据：输入框（EditText）是否仍持有本次话术。
                // 不能用「输入框里有任意文本」判定——抖音的其它提示文案会被误判成「未发出」，
                // 导致明明已提交成功却记成 failed（且与步骤 10 的判定标准不一致）。
                inputStillHasText = inputStillHasScript(signature)
                // 第二判据：评论数是否 +1（评论正文不可读，计数可读 → 唯一可用的正向证据）
                countAfter = readCommentCount()
                if (visible || inputStillHasText || commentCountGrew(commentCountBefore, countAfter)) break
            }

            val countGrew = commentCountGrew(commentCountBefore, countAfter)
            Log.i(
                TAG,
                "步骤11 校验：评论可见=$visible 输入框仍含话术=$inputStillHasText " +
                    "评论数=$commentCountBefore->$countAfter " +
                    "signature=$signature 耗时=${Time.elapsedMs() - tVerify}ms 页面=${AutoService.currentPage()}",
            )
            if (!visible && !countGrew) {
                // failed / unknown 的关键现场：是否弹风控、是否进了审核、是否列表未刷新
                logPageDump("未读到评论")
            }

            val outcome = when {
                visible && !inputStillHasText -> Outcome(
                    "succeeded", null, "comment_visible", startedAt = startedAt, finishedAt = Time.nowMs(),
                )

                // 提交未生效（文本仍在输入框）→ 确认未发出
                inputStillHasText -> Outcome(
                    "failed", Config.Reason.SUBMIT_FAILED, "text_still_in_input",
                    startedAt = startedAt, finishedAt = Time.nowMs(),
                )

                // 评论数 +1 → 平台已接受这条评论（正向证据；评论正文不暴露给 a11y，读不到属正常）
                countGrew -> Outcome(
                    "succeeded", null, "comment_count_increased:$commentCountBefore->$countAfter",
                    startedAt = startedAt, finishedAt = Time.nowMs(),
                )

                // 输入框空了、但两条证据都拿不到 → 可能已发出（审核中 / 计数未刷新）
                // **这是最关键的一类：必须归 unknown，禁止自动重试**
                else -> Outcome(
                    "unknown", Config.Reason.VERIFY_FAILED, "not_visible_but_input_empty",
                    startedAt = startedAt, finishedAt = Time.nowMs(),
                )
            }
            Log.i(TAG, "执行结果：${outcome.status}（${outcome.reasonCode ?: "-"}）evidence=${outcome.evidence}")
            return finish(outcome, task, reporter)
        } catch (e: Exception) {
            // 任何异常都不能让任务悬空：无法确认时一律 unknown（保守优先）
            Log.e(TAG, "执行异常，按 unknown 处理（禁止自动重试）", e)
            val o = Outcome(
                "unknown", Config.Reason.UNKNOWN,
                "exception:${e.javaClass.simpleName}",
                startedAt = startedAt, finishedAt = Time.nowMs(),
            )
            return runCatching { finish(o, task, reporter) }.getOrDefault(o)
        } finally {
            // 收尾：素材延时清理 + 逐级退出（**禁止 force-stop**）
            runCatching { exitGracefully(context) }
            if (albumUris.isNotEmpty()) {
                // 延时清理：立即删除会让抖音引用失效
                runCatching { MaterialStore.cleanupAlbumLater(context, albumUris) }
            }
        }
    }

    // ── 图文评论：贴图 ────────────────────────────────────────

    /**
     * 把素材图片贴到评论上（**只在 commentType == "image" 时调用**）。
     *
     * 三步：写相册 → 点「插入图片」→ 在相册里选第一格 → 校验缩略图出现。
     *
     * ⚠ 为什么必须「刚写完相册就马上选」：
     *   抖音相册选择器（`MvChoosePhotoActivity`）里的照片格**没有任何可识别特征** ——
     *   contentDescription 是系统拼出来的「, 点按两次即可激活」，resource-id 是混淆过的
     *   `rv5`，也不能按文件名搜。所以只能按**位置**选：树序第一个格子 = 相册里最新的一张。
     *
     *   于是"我们写入的那张图是不是最新"就成了**唯一**的正确性前提。早期实现是在步骤 4
     *   （刚领到任务时）就写相册，中间隔着打开抖音、浏览、点赞、读评论近两分钟 —— 这期间
     *   任何新增照片都会让我们选错，把**别人的私人照片**当评论配图发出去，而且**不可撤销**。
     *   所以这里刻意在点按钮之前才写相册，把时间窗压到几秒。
     *
     *   更彻底的做法是申请 `READ_MEDIA_IMAGES` 后断言「相册最新一张 == 本任务素材」；
     *   当前 App 没有媒体读取权限（只能看到自己写入的条目），做不了这个断言，
     *   因此用"极短时间窗 + 缩略图事后校验"兜底。
     *
     * @return null 表示贴图成功；非 null 为应当中止的终态
     */
    private suspend fun attachCommentImage(
        context: Context,
        task: TaskPackageDto,
        albumUris: MutableList<Uri>,
        startedAt: Long,
    ): Outcome? {
        val image = task.image ?: return Outcome(
            "aborted", Config.Reason.ELEMENT_MISSING, "image_missing", startedAt = startedAt,
        )
        val local = MaterialStore.ensureCached(context, image)
            ?: return Outcome("failed", Config.Reason.NETWORK, "material_download_failed", startedAt = startedAt)
        // 此刻才写相册：让这张图成为相册里"最新的一张"
        val uri = MaterialStore.publishToAlbum(context, local, "agent_${image.hash}.jpg")
            ?: return Outcome("failed", Config.Reason.ELEMENT_MISSING, "album_write_failed", startedAt = startedAt)
        albumUris += uri

        // ① 点「插入图片」
        Human.reactBeforeClick(context)
        val entry = NodeFinder.waitFor(DouyinLocators.insertImageButton, timeoutMs = 4_000)
            ?: run {
                logPageDump("未找到「插入图片」入口")
                return Outcome(
                    "aborted", Config.Reason.IMAGE_ATTACH_FAILED, "insert_image_entry_missing",
                    startedAt = startedAt,
                )
            }
        if (!Actions.click(entry)) {
            logPageDump("「插入图片」点击失败")
            return Outcome(
                "aborted", Config.Reason.IMAGE_ATTACH_FAILED, "insert_image_click_failed",
                startedAt = startedAt,
            )
        }

        // ② 等相册就绪，并**严格取树序第一个**照片格（= 最新一张）
        //    位置约束（top >= ALBUM_GRID_TOP）把标题/搜索框/分类按钮排除在外，
        //    避免"第一个含该提示的节点"其实是网格外的某个图标。
        val cell = NodeFinder.waitForFirstWhere(timeoutMs = 10_000) { n ->
            val d = n.contentDescription?.toString().orEmpty()
            val r = Rect().also { n.getBoundsInScreen(it) }
            d.contains(DouyinLocators.ALBUM_CELL_HINT) && r.top >= DouyinLocators.ALBUM_GRID_TOP
        }
        if (cell == null) {
            logPageDump("相册选择器未就绪（未找到照片格）")
            return Outcome(
                "aborted", Config.Reason.IMAGE_ATTACH_FAILED, "album_not_opened", startedAt = startedAt,
            )
        }

        // ③ 选中（抖音相册是单击即选中并返回，没有"完成"按钮）
        Human.pause(600, 1_400)
        if (!Actions.click(cell)) {
            logPageDump("相册照片格点击失败")
            return Outcome(
                "aborted", Config.Reason.IMAGE_ATTACH_FAILED, "album_pick_failed", startedAt = startedAt,
            )
        }

        // ④ 校验：编辑框里真的出现了缩略图，才算贴上了。
        //    ⚠ 判据不能只看「同时发布为作品」—— 只要评论编辑框展开它就存在（实测未贴图时也有），
        //      那样"贴图失败"会被误判成成功，然后发出一条后台记为图文、实际纯文字的评论
        //      （正是本次改造要根除的 bug）。也不能只看 desc="关闭"：评论区面板右上角的
        //      关闭按钮（id:back_btn）描述同样是「关闭」，靠坐标才能区分。
        val attached = NodeFinder.waitForFirstWhere(timeoutMs = 8_000) { n -> isImageAttachedNode(n) }
        if (attached == null) {
            logPageDump("贴图后未出现缩略图")
            return Outcome(
                "aborted", Config.Reason.IMAGE_ATTACH_FAILED, "image_not_attached", startedAt = startedAt,
            )
        }
        // ⑤ 收起表情面板，切回键盘。
        //    贴图后抖音停在**表情面板展开态**，该状态下输入框既不响应 ACTION_PASTE，
        //    长按也弹不出「粘贴」菜单（实测：任务 100% 卡在 input_failed）。
        //    ⚠ 「表情」是**开关**：面板已关时点它反而会打开，所以必须先判断再点。
        if (isEmojiPanelOpen()) {
            NodeFinder.find(DouyinLocators.emojiPanelToggle)?.let {
                Actions.click(it)
                delay(Rnd.long(500, 900))
                Log.i(TAG, "已收起表情面板，切回键盘")
            }
        }
        Log.i(TAG, "✅ 已贴图：素材=${image.hash} 相册条目=$uri")
        return null
    }

    /**
     * 判断一个节点是不是「评论上已挂着图片」的证据 —— 即编辑框内那张缩略图右上角的删除按钮。
     *
     * 判据 = `desc="关闭"` **且**位于编辑框缩略图区（屏幕左侧、y≈850~1120）。
     * 坐标约束是必需的：评论区面板自己的关闭按钮（`id:back_btn`）描述同样是「关闭」，
     * 但它固定在屏幕右上角（x≈959~1069），两者只能靠位置区分。
     */
    private fun isImageAttachedNode(n: AccessibilityNodeInfo): Boolean {
        val d = n.contentDescription?.toString().orEmpty()
        val r = Rect().also { n.getBoundsInScreen(it) }
        return d == "关闭" && r.top in 850..1120 && r.left < 400
    }

    /**
     * 表情面板是否展开。
     *
     * 判据：评论工具栏下方（y > 1350）存在 contentDescription 形如 `[呲牙]` 的表情格。
     * 刻意**不用 resource-id** —— 抖音的 id 是混淆过的（本次实测为 `h9q`），换版本即失效；
     * 而「表情格的描述是 `[xx]`」这个形状要稳定得多。
     */
    private fun isEmojiPanelOpen(): Boolean =
        NodeFinder.findFirstWhere { n ->
            val d = n.contentDescription?.toString().orEmpty()
            val r = Rect().also { n.getBoundsInScreen(it) }
            d.length in 3..8 && d.startsWith("[") && d.endsWith("]") && r.top > 1350
        } != null

    // ── 内部工具 ──────────────────────────────────────────────

    /**
     * 元素未命中 / 校验失败时的现场快照：当前页面 + 可见文本摘要。
     *
     * 等价于「文字版截图」——定位器失效、风控弹窗、审核提示都能一眼看出来，
     * 且比图片更易 grep、体积更小，无需上传通道。
     */
    private fun logPageDump(what: String) {
        val dump = NodeFinder.dumpSummary(maxNodes = 30)
        Log.w(
            TAG,
            "$what → 页面=${AutoService.currentPage()} 文本摘要（${dump.size} 条）：${dump.joinToString(" | ")}",
        )
    }

    /**
     * 是否已过后台给的截止时间。
     *
     * deadlineAt 为 ISO 串。解析失败按「未超期」处理 —— 宁可多跑一条，
     * 也不要因为解析问题把正常任务全废掉。
     */
    private fun isPastDeadline(task: TaskPackageDto): Boolean {
        val raw = task.deadlineAt
        if (raw.isBlank()) return false
        return runCatching {
            java.time.OffsetDateTime.parse(raw).toInstant().toEpochMilli() < Time.nowMs()
        }.getOrDefault(false)
    }

    /** 风险评估（非空即代表必须中止） */
    private fun riskOrNull(): Outcome? = when (val s = RiskGuard.check()) {
        RiskGuard.Signal.NONE -> null
        RiskGuard.Signal.RATE_LIMIT -> Outcome("aborted", s.reasonCode, "rate_limited_local")
        RiskGuard.Signal.CAPTCHA -> Outcome("aborted", s.reasonCode, "captcha_local")
        RiskGuard.Signal.RISK_DIALOG -> Outcome("aborted", s.reasonCode, "risk_dialog_local")
    }

    /**
     * **已点击发送之后**出现的风控信号 → 一律改判 `unknown`。
     *
     * 此时评论可能已经进入平台，但本机无法确认；而 `aborted` 的语义是
     * 「确认未发出、可退配额、可重派」。若沿用 aborted，后台会退还当日配额
     * 并可能重新派单，导致同一帖子被评论两次。
     */
    private fun Outcome.asUnknownAfterSubmit(startedAt: Long): Outcome = copy(
        status = "unknown",
        reasonCode = Config.Reason.VERIFY_FAILED,
        // 带上 post_submit_ 前缀，日志里一眼可辨「这是提交之后才出现的风控」
        evidence = "post_submit_${evidence ?: "risk"}",
        startedAt = startedAt,
        finishedAt = Time.nowMs(),
    )

    /**
     * 收尾：模拟真人"发完评论之后"的行为，并最终离开抖音。
     *
     * 为什么随机化（2026-09-26 真机结论）：
     *  · 若结束时停留在抖音，视频会持续播放且**保持屏幕常亮**（用户反馈"一直播放好久了"），
     *    所以最终必须离开前台；
     *  · 但"离开"这件事本身不能固定 —— 每次都精确地在发完评论 1 秒后退出，
     *    这种规律性本身就是一个可观测的行为特征（反检测视角）。
     * 因此把「是否再看两条 / 停留多久 / 怎么离开」全部随机化。
     *
     * 行为分布（可按需调整）：
     *  · 40%  继续浏览 1~3 条视频（真人发完评论常顺手再刷几个）；
     *  · 35%  离开前退回抖音首页停留 1.5~5 秒（"顺手看一眼"）；
     *  · 返回次数 1~2 次随机，各步停顿随机。
     *
     * 全程只用 GLOBAL_ACTION_BACK / HOME，**不 force-stop 杀进程**；
     * 若用户已手动切到别的 App，则不做任何多余动作（不打扰）。
     */
    private suspend fun exitGracefully(context: Context) {
        // ⚠ 本函数在 finally 中**无条件**调用，而 ip_mismatch / duplicate_task / image_missing
        // 这类返回根本没进过抖音。若不判前台就滑动、按返回键，会直接作用在**用户正在使用的
        // 其它 App** 上（可能退掉他正在编辑的内容）—— 注释承诺的"不打扰"必须真的做到。
        if (!AutoService.douyinForeground()) {
            Log.d(TAG, "收尾跳过：当前不在抖音前台（避免打扰用户）")
            return
        }

        // ① 概率性"再看两条"
        if (Rnd.bool(0.4)) {
            val extra = Rnd.int(1, 3)
            Log.i(TAG, "收尾：继续浏览 $extra 条视频")
            repeat(extra) {
                Actions.swipeVertical(
                    screenCenterX(context),
                    screenHeight(context) * 0.72,
                    screenHeight(context) * 0.30,
                )
                delay(Rnd.long(1_500, 6_000))
            }
        }

        // ② 退出评论面板 / 详情页（返回次数随机，模拟真人的"要退几次"）
        repeat(Rnd.int(1, 2)) {
            Actions.back()
            delay(Rnd.long(300, 900))
        }

        // ③ 35%：在抖音首页停留片刻再离开
        if (Rnd.bool(0.35)) {
            Log.d(TAG, "收尾：在抖音首页停留片刻")
            delay(Rnd.long(1_500, 5_000))
        }

        // ④ 离开（用户已切走则不动，避免打扰）
        if (AutoService.douyinForeground()) {
            Actions.home()
            delay(Rnd.long(300, 900))
            // 个别 ROM 会吞掉一次 HOME，兜底再按一次
            if (AutoService.douyinForeground()) {
                Actions.home()
                delay(Rnd.long(400, 900))
            }
        }
        Log.d(TAG, "已逐级退出")
    }

    /**
     * 输入框（EditText）是否仍持有本次话术 —— 判断「提交是否真正生效」的唯一标准。
     *
     * 说明：
     *  · 不要求输入框处于聚焦态（发送后键盘可能收起），只要界面上还有 EditText
     *    且其文本含本次话术特征串，就说明提交没生效；
     *  · 找不到 EditText 时返回 false（**不重试**）——宁可少判一次，
     *    也不能因误判而重复点击发送、发出两条评论。
     */
    private fun inputStillHasScript(signature: String): Boolean {
        val edit = NodeFinder.find(DouyinLocators.editableField) ?: return false
        return edit.text?.toString().orEmpty().contains(signature)
    }

    /**
     * 读取当前页面的评论数（抖音按钮 desc 形如「评论7，按钮」，评论面板展开/收起态都存在）。
     *
     * 背景：抖音的评论正文与昵称**不暴露给无障碍服务** —— 2026-09-26 真机实测
     * （uiautomator 全页 dump 仅 212 个节点，无任何评论文本、无昵称，id/content 节点 text 为空；
     *   而截图里评论肉眼可见）。因此"在列表里读到自己的评论"这条路不可靠，
     * 「评论数 +1」是唯一可读的正向证据。
     *
     * @return 读到的评论数；读不到返回 null（此时不做任何正向判定，保持保守的 unknown）
     */
    private fun readCommentCount(): Int? {
        // 抖音两种呈现都见过：
        //  · 详情页底部按钮：desc="评论12，按钮"；
        //  · 评论面板真正展开后：标题变成"共 12 条评论" / "12 条评论"（"评论N"按钮被面板遮住）。
        // 只认第一种时，一旦面板真正展开就恒读不到 —— 实测 2026-09-28：基线=null->null，
        // 正向判据退化成只靠"评论文本可见"。
        val patterns = listOf(Regex("评论(\\d+)"), Regex("(\\d+)\\s*条评论"))
        val texts = NodeFinder.snapshotTexts()
        for (re in patterns) {
            val hit = texts.firstNotNullOfOrNull { s ->
                re.find(s)?.groupValues?.getOrNull(1)?.toIntOrNull()
            }
            if (hit != null) return hit
        }

        // 都不命中时，区分「**确定是 0 条**」与「读不到」—— 后者返回 null（不做任何判定）。
        //
        // ⚠ 这里是修一个真实缺口（2026-09-28 实测）：抖音在 **0 条评论时不给「评论N」角标**，
        //    于是基线恒为 null。而「评论数 +1」正是评论正文不可读时**唯一**可用的正向证据，
        //    基线为 null 等于这条证据直接作废：
        //      一条 0 评论视频的纯文字评论**明明发出去了**（0→1），
        //      却因 null->1 无法比较而被判 unknown（保守，但白白多出一条人工核实项）。
        if (texts.any { s -> ZERO_COMMENT_MARKERS.any { s.contains(it) } } ||
            texts.any { s -> isCountlessCommentEntry(s) }
        ) {
            return 0
        }
        return null
    }

    /**
     * 「0 条评论」时才会出现的文案（有评论时不会出现）。
     *
     * 面板**真正展开**且一条评论都没有时，列表标题就是「暂无评论」
     * （真机实测 2026-09-28 / 抖音 39.7.0 / 图文帖：`TextView id:title text="暂无评论"`，
     *  同屏还有「期待你的评论」「去评论」按钮）；输入框占位「抢首评」是同类信号。
     */
    private val ZERO_COMMENT_MARKERS = listOf("暂无评论", "还没有评论", "抢首评")

    /**
     * 评论入口按钮是否**不含数字** —— 即 0 条评论。
     *
     * ⚠ 不能锚定整串去匹配。实测 0 条评论时 uiautomator 给出的 desc 是
     *   **「评论评论，按钮」**（节点的 contentDescription 与其子节点文本被拼在一起），
     *   而锚定正则 `^评论，?按钮$` 匹配不上 —— 整个修复会**静默失效**。
     *   改用「含『评论』且含『按钮』且不含任何数字」的宽松判据：
     *     · 有评论时是「评论7，按钮」→ 含数字，排除；
     *     · 其它含「评论」的节点（如「语音评论」「发条评论…」）不含「按钮」→ 排除。
     */
    private fun isCountlessCommentEntry(s: String): Boolean =
        s.contains("评论") && s.contains("按钮") && s.none { it.isDigit() }

    /** 评论数是否增加（前后两个值都必须读到，否则视为不可判定 → 不产生正向结论） */
    private fun commentCountGrew(before: Int?, after: Int?): Boolean =
        before != null && after != null && after > before

    /** 记录终态并上报回执 */
    private suspend fun finish(outcome: Outcome, task: TaskPackageDto, reporter: Reporter): Outcome {
        val started = outcome.startedAt ?: 0L
        val finished = outcome.finishedAt ?: Time.nowMs()
        Log.i(
            TAG,
            "任务 ${task.taskId} 终态=${outcome.status} reason=${outcome.reasonCode ?: "-"} " +
                "耗时=${finished - started}ms",
        )
        val context = AppContextHolder.context
        if (context != null) {
            val state = when (outcome.status) {
                "succeeded" -> LocalState.SUCCESS
                "failed" -> LocalState.FAILED
                "aborted" -> LocalState.ABORTED
                else -> LocalState.UNKNOWN
            }
            runCatching {
                AgentDb.get(context).taskDao().markFinished(
                    task.taskId, state, outcome.reasonCode,
                    outcome.finishedAt ?: Time.nowMs(),
                )
            }.onFailure { Log.w(TAG, "落盘终态失败：${it.message}") }
        }

        runCatching { reporter.onFinished(task, outcome) }
            .onFailure { Log.w(TAG, "回执上报失败（已入本地队列，稍后重传）：${it.message}") }

        return outcome
    }

    private fun screenHeight(context: Context): Double =
        context.resources.displayMetrics.heightPixels.toDouble()

    private fun screenCenterX(context: Context): Double =
        context.resources.displayMetrics.widthPixels / 2.0 + Rnd.double(-30.0, 30.0)
}

/**
 * 极简的上下文持有者：执行器需要 ApplicationContext 来落盘与清理素材，
 * 但不应持有 Activity/Service 引用（避免泄漏）。
 */
object AppContextHolder {
    @Volatile
    var context: Context? = null
}

/** 便捷构造（诊断详情） */
fun buildDetail(vararg pairs: Pair<String, Any?>): JsonObject = buildJsonObject {
    pairs.forEach { (k, v) ->
        when (v) {
            null -> put(k, "")
            is String -> put(k, v)
            is Int -> put(k, v)
            is Long -> put(k, v)
            is Boolean -> put(k, v)
            else -> put(k, v.toString())
        }
    }
}
