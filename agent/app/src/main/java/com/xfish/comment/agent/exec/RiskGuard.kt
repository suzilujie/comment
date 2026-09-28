package com.xfish.comment.agent.exec

import com.xfish.comment.agent.accessibility.NodeFinder
import com.xfish.comment.agent.core.Config
import com.xfish.comment.agent.core.Log

/**
 * 风险守卫：识别限流 / 验证码 / 风控弹窗，**本地秒级中止**。
 *
 * 为什么必须本地决策（设计文档 §3.6 职责边界）：
 *  这类信号具有强时效性——等后台往返再决策，期间可能已经误触或继续执行，
 *  反而加重风控。因此这是「业务决策不下放」原则的唯一例外。
 *
 * 判定策略：不依赖单一关键词，采用**多特征联合判定**（多个关键词 + 顶层弹窗结构），
 * 降低误报（抖音正文里出现"网络繁忙"不属于风控）。
 */
object RiskGuard {

    private const val TAG = "risk"

    enum class Signal(val reasonCode: String, val severe: Boolean) {
        NONE("", false),
        RATE_LIMIT(Config.Reason.RATE_LIMITED, false),
        CAPTCHA(Config.Reason.CAPTCHA, true),
        RISK_DIALOG(Config.Reason.RISK_DIALOG, true),
    }

    /**
     * 检查当前界面是否出现风险信号。
     *
     * 判定顺序：验证码 → 严重风控 → 限流。
     * 只有「命中的关键词出现在**可点击/弹窗类节点**上」时才判定，
     * 避免把正文内容误判为风控（例如视频文案里出现"验证"二字）。
     */
    /** 浮层关闭类文案（用于判定「是否为弹窗样式」） */
    private val DISMISS_TEXTS = listOf("知道了", "确定", "好的", "我知道了", "取消")

    /**
     * 检查当前界面是否出现风险信号。
     *
     * ⚠ 性能要点：无障碍节点读取是**跨进程 IPC**，全树遍历一次开销很大。
     * 原实现对列表里每个关键词各遍历一次（3 组共 15 个关键词 + 1 次浮层判定
     * = 16 次全树扫描），实测单次调用可拖到数十秒，直接导致任务超时。
     * 现改为「**一次遍历抓取全部文本，再在内存里匹配**」。
     */
    fun check(): Signal {
        val texts = NodeFinder.snapshotTexts()
        if (texts.isEmpty()) return Signal.NONE

        fun firstHit(keywords: List<String>): String? =
            keywords.firstOrNull { k -> texts.any { it.contains(k) } }

        // 「是否弹窗样式」：存在关闭类按钮文案
        val overlay = texts.any { t -> DISMISS_TEXTS.any { d -> t == d || t.contains(d) } }

        // 1) 验证码 / 安全验证
        //    强特征（"拖动滑块"/"安全验证"…）命中即判定：滑块验证页往往**只有滑块**，
        //    没有任何「确定/取消」按钮，早期统一要求 overlay → 滑块验证被漏检 →
        //    然后在验证页上继续点发送（典型的「该中止却继续」，风控风险最高的一类）。
        //    弱特征（正文里也可能出现的「验证」二字）仍要求弹窗结构，避免误报。
        firstHit(DouyinLocators.captchaStrongKeywords)?.let { hit ->
            Log.w(TAG, "检测到验证页（强特征）：$hit")
            return Signal.CAPTCHA
        }
        firstHit(DouyinLocators.captchaKeywords)?.let { hit ->
            if (overlay) {
                Log.w(TAG, "检测到验证类提示：$hit")
                return Signal.CAPTCHA
            }
        }

        // 2) 严重风控
        firstHit(DouyinLocators.riskKeywordsSevere)?.let { hit ->
            Log.w(TAG, "检测到风控提示：$hit")
            return Signal.RISK_DIALOG
        }

        // 3) 限流
        //    强特征（"操作频繁"/"操作太快"）正文里几乎不会出现，命中即判定；
        //    弱特征（"网络繁忙"/"稍后再试"）可能只是普通网络提示，仍要求弹窗结构。
        firstHit(DouyinLocators.rateLimitStrongKeywords)?.let { hit ->
            Log.w(TAG, "检测到限流（强特征）：$hit")
            return Signal.RATE_LIMIT
        }
        firstHit(DouyinLocators.rateLimitKeywords)?.let { hit ->
            if (overlay) {
                Log.w(TAG, "检测到限流提示：$hit")
                return Signal.RATE_LIMIT
            }
        }

        return Signal.NONE
    }

    /** 尝试关闭提示浮层（仅对非严重信号使用；严重信号交给人工） */
    suspend fun tryDismiss(): Boolean {
        val dismiss = NodeFinder.find(
            NodeFinder.Locator(textExact = listOf("知道了", "确定", "好的", "我知道了")),
        ) ?: return false
        return com.xfish.comment.agent.accessibility.Actions.click(dismiss)
    }

    /** 供自检使用：当前是否处于异常浮层 */
    fun describeCurrent(): String {
        val texts = NodeFinder.snapshotTexts()
        return DouyinLocators.riskKeywords.firstOrNull { k -> texts.any { it.contains(k) } } ?: "无"
    }
}
