package com.xfish.comment.agent

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.xfish.comment.agent.accessibility.A11yStatus
import com.xfish.comment.agent.accessibility.Actions
import com.xfish.comment.agent.accessibility.AutoService
import com.xfish.comment.agent.core.Bus
import com.xfish.comment.agent.core.Log
import com.xfish.comment.agent.core.Time
import com.xfish.comment.agent.data.AgentDb
import com.xfish.comment.agent.data.Prefs
import com.xfish.comment.agent.net.Api
import com.xfish.comment.agent.netlink.CityRotator
import com.xfish.comment.agent.netlink.ClashClient
import com.xfish.comment.agent.netlink.IpProbe
import com.xfish.comment.agent.runtime.AgentService
import com.xfish.comment.agent.runtime.SelfCheck
import com.xfish.comment.agent.runtime.Watchdog
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 设备面板与上机引导（运维用，非业务界面）。
 *
 * 一期只做必要功能：
 *  · 填写后台地址（设备首启心跳自动登记，无注册环节）；
 *  · 权限引导（无障碍 / 电池优化 / 通知）；
 *  · 状态展示（心跳、属地、无障碍、代理、队列积压、下次可领取 / 下次切城）；
 *  · 自检（含关键元素命中检查）与日志查看。
 *
 * 界面用代码构建（无 XML）：深色卡片式面板，减少资源文件与机型适配面。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var serverInput: EditText
    private lateinit var clashInput: EditText
    private lateinit var clashSecretInput: EditText
    private lateinit var serviceDot: View
    private lateinit var serviceState: TextView
    private lateinit var serviceBtn: Button
    private lateinit var statusCard: LinearLayout
    private lateinit var logView: TextView

    private val notifPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        requestNotificationPermissionIfNeeded()

        lifecycleScope.launch {
            serverInput.setText(Prefs.server(this@MainActivity, BuildConfig.DEFAULT_SERVER))
            Api.baseUrl = Prefs.server(this@MainActivity, BuildConfig.DEFAULT_SERVER)
            // Clash 控制器（切城用）：回填并注入客户端
            clashInput.setText(Prefs.clashController(this@MainActivity))
            clashSecretInput.setText(Prefs.clashSecret(this@MainActivity))
            ClashClient.configure(
                Prefs.clashController(this@MainActivity),
                Prefs.clashSecret(this@MainActivity),
            )
        }

        // 状态与日志定时刷新
        lifecycleScope.launch {
            while (true) {
                runCatching { refreshStatus() }
                delay(2_000)
            }
        }

        // 事件驱动刷新
        Bus.on(Bus.Events.UI_REFRESH) {
            runCatching { statusCard.post { lifecycleScope.launch { refreshStatus() } } }
        }
    }

    // ── UI 构建 ───────────────────────────────────────────────

    private fun buildUi(): View {
        // 先初始化需要动态更新的控件引用
        serviceDot = View(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(10), dp(10)).apply { setMargins(0, 0, dp(10), 0) }
            background = oval(color(R.color.fg_dim))
        }
        serviceState = TextView(this).apply {
            text = "…"
            textSize = 14f
            setTextColor(color(R.color.fg_dim))
            gravity = Gravity.END
        }
        serviceBtn = Button(this).apply {
            isAllCaps = false
            gravity = Gravity.CENTER
            textSize = 14f
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(44),
            ).apply { setMargins(0, dp(12), 0, 0) }
        }
        serverInput = inputField("http://192.168.1.10:15650")
        clashInput = inputField("http://127.0.0.1:9090")
        clashSecretInput = inputField("控制器密钥（可空）")
        statusCard = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        logView = TextView(this).apply {
            textSize = 11f
            typeface = Typeface.MONOSPACE
            setTextColor(color(R.color.fg_dim))
            setPadding(dp(12), dp(12), dp(12), dp(12))
            background = rounded(12, color(R.color.log_bg))
            minHeight = dp(220)
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(20), dp(16), dp(28))
        }

        // 标题
        root.addView(title("评论 Agent"))
        root.addView(TextView(this).apply {
            text = "设备面板 · v${BuildConfig.VERSION_NAME}"
            textSize = 13f
            setTextColor(color(R.color.fg_dim))
            setPadding(0, dp(2), 0, dp(18))
        })

        // ── 服务状态卡 ──
        root.addView(card {
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                addView(serviceDot)
                addView(TextView(this@MainActivity).apply {
                    text = "常驻服务"
                    textSize = 15f
                    setTextColor(color(R.color.fg))
                    layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                })
                addView(serviceState)
            })
            addView(serviceBtn)
        })

        // ── 后台地址卡 ──
        root.addView(card {
            addView(sectionTitle("后台地址"))
            addView(serverInput)
            addView(primaryButton("保存后台地址") { saveServer() })
        })

        // ── Clash 控制器卡 ──
        root.addView(card {
            addView(sectionTitle("Clash 控制器 · 切城用"))
            addView(clashInput)
            addView(clashSecretInput)
            addView(ghostButton("自动探测控制器") { autoDetectClash() })
            addView(ghostButton("保存并测试连通") { saveClash() })
        })

        // ── 权限引导卡 ──
        root.addView(card {
            addView(sectionTitle("权限引导 · 每台设备一次"))
            addView(ghostButton("1 · 打开无障碍设置") {
                Actions.openSettings(this@MainActivity, Settings.ACTION_ACCESSIBILITY_SETTINGS)
            })
            addView(ghostButton("2 · 忽略电池优化") {
                Actions.requestIgnoreBatteryOptimization(this@MainActivity)
            })
            addView(ghostButton("3 · 应用详情（自启动 / 后台弹出）") {
                runCatching {
                    startActivity(
                        android.content.Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            android.net.Uri.parse("package:$packageName"),
                        ),
                    )
                }.onFailure { Log.w("ui", "打开应用详情失败：${it.message}") }
            })
            addView(ghostButton("4 · 显示在其他应用上层（必需）") {
                Actions.requestOverlayPermission(this@MainActivity)
            })
        })

        // ── 诊断卡 ──
        root.addView(card {
            addView(sectionTitle("诊断"))
            addView(primaryButton("立即领取一次（调试）") { claimNow() })
            addView(primaryButton("立即切城（调试）") { rotateNow() })
            addView(ghostButton("运行自检（含元素命中）") { selfCheck() })
            addView(ghostButton("测试 Clash 控制器连通") { testClash() })
            addView(ghostButton("测试出口 IP 与属地") { testIp() })
        })

        // ── 当前状态卡 ──
        root.addView(card {
            addView(sectionTitle("当前状态"))
            addView(statusCard)
        })

        // ── 日志卡 ──
        root.addView(card {
            addView(sectionTitle("最近日志"))
            addView(logView)
        })

        return ScrollView(this).apply {
            addView(root)
            isFillViewport = true
        }
    }

    // ── 动作 ─────────────────────────────────────────────────

    private fun saveServer() {
        lifecycleScope.launch {
            val server = serverInput.text.toString().trim()
            if (server.isBlank()) {
                toast("请先填写后台地址")
                return@launch
            }
            Prefs.setServer(this@MainActivity, server)
            Api.baseUrl = server
            Log.i("ui", "后台地址已保存：$server")
            toast("已保存，正在启动服务")
            AgentService.start(this@MainActivity)
        }
    }

    /** 自动探测本机 Clash 控制器端口（含 9000-9100 全段扫描） */
    private fun autoDetectClash() {
        lifecycleScope.launch {
            toast("正在探测控制器端口…")
            val found = ClashClient.autoDetect(fullScan = true)
            if (found == null) {
                toast("未找到：请确认 Clash 已开启「外部控制器」")
                Log.w("ui", "自动探测 Clash 控制器失败")
            } else {
                clashInput.setText(found)
                Prefs.setClashController(this@MainActivity, found)
                ClashClient.configure(found, clashSecretInput.text.toString())
                toast("已找到控制器：$found")
                Log.i("ui", "自动探测到 Clash 控制器：$found")
            }
        }
    }

    /** 保存 Clash 控制器配置并立即测试连通（切城依赖它） */
    private fun saveClash() {
        lifecycleScope.launch {
            val url = clashInput.text.toString().trim()
            val secret = clashSecretInput.text.toString().trim()
            Prefs.setClashController(this@MainActivity, url)
            Prefs.setClashSecret(this@MainActivity, secret)
            ClashClient.configure(url, secret)
            Log.i("ui", "Clash 控制器已保存：${ClashClient.controllerUrl}")
            toast("已保存，测试连通中…")
            val ok = ClashClient.ping()
            toast(if (ok) "Clash 控制器可达 ✓" else "不可达：请确认已开启「外部控制器」")
            Log.i("ui", "clash ping=$ok")
        }
    }

    /** 调试：立即领取一次（跳过本机「距上次完成 + 30~60 分钟」等待，后台约束照常） */
    private fun claimNow() {
        if (!AgentService.running) {
            toast("服务未运行，已请求启动并立即领取")
        } else {
            toast("已请求立即领取（等待后台裁决）")
        }
        AgentService.claimNow(this)
        Log.i("ui", "手动触发「立即领取」")
        lifecycleScope.launch {
            delay(1_500)
            refreshStatus()
        }
    }

    /**
     * 调试：立即切城一次。
     *
     * 跳过 2 天 ± 4 小时的周期检查，完整跑一遍 rotate 流程：
     * 随机选城 → Clash 切节点 → 探测新属地 → 校验 → 立即上报。
     */
    private fun rotateNow() {
        if (!AgentService.running) {
            toast("服务未运行，已请求启动并立即切城")
        } else {
            toast("已请求立即切城（观察日志）")
        }
        AgentService.rotateNow(this)
        Log.i("ui", "手动触发「立即切城」")
        lifecycleScope.launch {
            delay(1_500)
            refreshStatus()
        }
    }

    private fun selfCheck() {
        lifecycleScope.launch {
            toast("自检中（会自动打开抖音）…")
            // 先做关键元素门禁（会自动唤起抖音并打开评论面板）
            val missing = SelfCheck.probeCriticalLocators(this@MainActivity)
            // 再采集完整状态（此时抖音已在前台，可导出节点摘要）
            val detail = SelfCheck.run(this@MainActivity)
            Log.i("ui", "自检结果：$detail")
            if (missing.isEmpty()) {
                toast("自检通过（关键元素均已命中）")
            } else {
                toast("自检未通过，缺失：${missing.joinToString("、")}")
                Log.w("ui", "关键元素未命中：${missing.joinToString("、")}")
            }
            refreshStatus()
        }
    }

    private fun testClash() {
        lifecycleScope.launch {
            val ok = ClashClient.ping()
            toast(if (ok) "Clash 控制器可达" else "Clash 控制器不可达（检查 127.0.0.1:9090 与密钥）")
            Log.i("ui", "clash ping=$ok")
        }
    }

    private fun testIp() {
        lifecycleScope.launch {
            toast("探测中…")
            val r = IpProbe.probe()
            if (r == null) {
                toast("探测失败（代理可能未连通）")
            } else {
                toast("出口 ${r.ip} · ${r.city}")
                Log.i("ui", "出口探测：${r.ip} / ${r.city} / ipv6Leak=${r.ipv6Leak} via ${r.source}")
            }
            refreshStatus()
        }
    }

    // ── 状态刷新 ─────────────────────────────────────────────

    private suspend fun refreshStatus() {
        val ctx = this@MainActivity
        val deviceId = Prefs.deviceId(ctx)
        val lastHb = Prefs.lastHeartbeatAt(ctx)
        val nextEligible = Prefs.nextEligibleAt(ctx)
        val nextSwitch = CityRotator.nextSwitchText(ctx)
        val (receipts, events) = runCatching {
            val dao = AgentDb.get(ctx)
            dao.receiptDao().count() to dao.eventDao().count()
        }.getOrDefault(0 to 0)

        val a11y = A11yStatus.enabled(ctx) && AutoService.connected
        val paused = Prefs.isPaused(ctx)
        val lastIp = Prefs.lastIp(ctx)
        val lastCity = Prefs.lastIpCity(ctx)
        val personaVersion = Prefs.personaVersion(ctx)
        val poolVersion = Prefs.cityPoolVersion(ctx)

        // 服务状态（圆点 + 文字 + 按钮）
        val running = AgentService.running
        serviceDot.background = oval(color(if (running) R.color.ok else R.color.fg_dim))
        serviceState.text = if (running) "运行中" else "已停止"
        serviceState.setTextColor(color(if (running) R.color.ok else R.color.fg_dim))
        if (running) {
            serviceBtn.text = "停止服务"
            styleButton(serviceBtn, color(R.color.err), color(R.color.white))
            serviceBtn.setOnClickListener { AgentService.stop(ctx); toast("服务已停止") }
        } else {
            serviceBtn.text = "启动服务"
            styleButton(serviceBtn, color(R.color.brand), color(R.color.white))
            serviceBtn.setOnClickListener { AgentService.start(ctx); toast("服务启动请求已发送") }
        }

        // 状态卡重建（轻量，2 秒一次无感）
        statusCard.removeAllViews()
        statusCard.addView(kvRow("设备号", "${deviceId.take(8)}…${deviceId.takeLast(4)}"))
        statusCard.addView(
            kvRow(
                "接单状态",
                if (paused) "已暂停" else "正常",
                color(if (paused) R.color.warn else R.color.ok),
            ),
        )
        statusCard.addView(
            kvRow(
                "无障碍",
                if (a11y) "已连接" else "未连接",
                color(if (a11y) R.color.ok else R.color.err),
            ),
        )
        // 悬浮窗权限：后台启动 Activity（唤起抖音）的前提，禁用会导致任务全部卡在「抖音未进前台」
        val overlay = Actions.hasOverlayPermission(ctx)
        statusCard.addView(
            kvRow(
                "悬浮窗权限",
                if (overlay) "已授权" else "未授权（唤起抖音会失败）",
                color(if (overlay) R.color.ok else R.color.err),
            ),
        )
        statusCard.addView(kvRow("最近心跳", Time.humanAgo(lastHb.takeIf { it > 0 })))
        statusCard.addView(kvRow("出口 IP", lastIp ?: "-"))
        statusCard.addView(kvRow("出口属地", lastCity?.takeIf { it.isNotBlank() } ?: "-"))
        statusCard.addView(
            kvRow(
                "时钟偏移",
                "${Time.clockOffsetSec()} 秒${if (Time.synced) "（已校时）" else "（未校时）"}",
            ),
        )
        statusCard.addView(kvRow("下次可领取", if (nextEligible <= 0) "立即可领" else Time.localText(nextEligible)))
        statusCard.addView(kvRow("下次切城", nextSwitch))
        statusCard.addView(kvRow("城市池版本", poolVersion ?: "未下发"))
        statusCard.addView(kvRow("人格版本", if (personaVersion > 0) "v$personaVersion" else "未下发"))
        statusCard.addView(kvRow("待重传队列", "回执 $receipts / 事件 $events"))
        statusCard.addView(kvRow("看护状态", Watchdog.describe(ctx)))

        logView.text = Log.tail(60).joinToString("\n")
    }

    // ── 权限 ─────────────────────────────────────────────────

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    // ── 小工具 ───────────────────────────────────────────────

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun color(res: Int): Int = ContextCompat.getColor(this, res)

    /** 圆角矩形背景（可选描边） */
    private fun rounded(radiusDp: Int, fill: Int, strokeColor: Int? = null): GradientDrawable =
        GradientDrawable().apply {
            cornerRadius = dp(radiusDp).toFloat()
            setColor(fill)
            if (strokeColor != null) setStroke(dp(1), strokeColor)
        }

    /** 实心圆点 */
    private fun oval(fill: Int): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(fill)
    }

    /** 统一输入框样式 */
    private fun inputField(hintText: String): EditText = EditText(this).apply {
        hint = hintText
        setSingleLine()
        textSize = 14f
        setTextColor(color(R.color.fg))
        setHintTextColor(color(R.color.fg_dim))
        setPadding(dp(12), 0, dp(12), 0)
        background = rounded(10, color(R.color.input_bg), color(R.color.stroke))
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(44),
        ).apply { setMargins(0, dp(4), 0, dp(8)) }
    }

    private fun title(t: String): TextView = TextView(this).apply {
        text = t
        textSize = 22f
        setTextColor(color(R.color.fg))
        setTypeface(typeface, Typeface.BOLD)
    }

    private fun sectionTitle(t: String): TextView = TextView(this).apply {
        text = t
        textSize = 13f
        setTextColor(color(R.color.fg))
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, 0, 0, dp(10))
    }

    /** 卡片容器 */
    private fun card(block: LinearLayout.() -> Unit): LinearLayout =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
            background = rounded(16, color(R.color.card_bg), color(R.color.stroke))
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { setMargins(0, 0, 0, dp(12)) }
            block()
        }

    /** 实心主按钮 */
    private fun primaryButton(text: String, onClick: () -> Unit): Button = Button(this).apply {
        this.text = text
        isAllCaps = false
        gravity = Gravity.CENTER
        textSize = 14f
        setTextColor(color(R.color.white))
        background = rounded(10, color(R.color.brand))
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(44),
        ).apply { setMargins(0, dp(4), 0, dp(4)) }
    }

    /** 描边次按钮 */
    private fun ghostButton(text: String, onClick: () -> Unit): Button = Button(this).apply {
        this.text = text
        isAllCaps = false
        gravity = Gravity.CENTER
        textSize = 13f
        setTextColor(color(R.color.fg))
        background = rounded(10, Color.TRANSPARENT, color(R.color.stroke))
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(44),
        ).apply { setMargins(0, dp(4), 0, dp(4)) }
    }

    /** 动态改按钮填充/文字色（服务启停切换用） */
    private fun styleButton(btn: Button, fill: Int, textColor: Int) {
        btn.setTextColor(textColor)
        btn.background = rounded(10, fill)
    }

    /** 状态键值行：左键灰、右值白（可着色） */
    private fun kvRow(k: String, v: String, vColor: Int = color(R.color.fg)): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, dp(6))
            addView(TextView(this@MainActivity).apply {
                text = k
                textSize = 13f
                setTextColor(color(R.color.fg_dim))
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            })
            addView(TextView(this@MainActivity).apply {
                text = v
                textSize = 13f
                setTextColor(vColor)
                gravity = Gravity.END
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.2f)
            })
        }

    private fun toast(msg: String) {
        android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show()
    }
}
