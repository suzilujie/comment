package com.xfish.comment.agent

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.bottomnavigation.BottomNavigationView
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
import com.xfish.comment.agent.netlink.RegionName
import com.xfish.comment.agent.runtime.AgentService
import com.xfish.comment.agent.runtime.SelfCheck
import com.xfish.comment.agent.runtime.Watchdog
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 设备面板（运维用，非业务界面）。
 *
 * 页面结构 —— 底部导航 4 个 Tab，功能不再全堆一屏：
 *  · 首页 —— 服务启停 + 当前状态明细 + 权限异常告警
 *  · 诊断 —— 立即领取 / 立即切城 / 自检 / 连通性测试
 *  · 设置 —— 后台地址 / Clash 控制器 / 权限引导（带实时状态）
 *  · 日志 —— 全屏日志 + 刷新 / 复制
 *
 * 实现要点：4 个页面**一次性创建并常驻**，切 Tab 只替换容器内容而不销毁重建，
 * 所以 2 秒一次的 refreshStatus() 能持续更新各页面内的控件，不会因切页丢状态。
 * 界面全部代码构建（无 XML layout），减少资源文件与机型适配面。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAB_HOME = 1
        private const val TAB_DIAG = 2
        private const val TAB_SETTINGS = 3
        private const val TAB_LOGS = 4
    }

    // ── 外壳 ──
    private lateinit var pageContainer: FrameLayout
    private lateinit var pages: List<View>
    private lateinit var bottomNav: BottomNavigationView

    // ── 首页控件 ──
    private lateinit var serviceDot: View
    private lateinit var serviceState: TextView
    private lateinit var serviceBtn: Button
    private lateinit var statusCard: LinearLayout
    private lateinit var permBanner: TextView

    // ── 设置页控件 ──
    private lateinit var serverInput: EditText
    private lateinit var clashInput: EditText
    private lateinit var clashSecretInput: EditText
    private lateinit var permList: LinearLayout

    // ── 日志页控件 ──
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
            runCatching { pageContainer.post { lifecycleScope.launch { refreshStatus() } } }
        }
    }

    // ── 外壳：顶栏 + 页面容器 + 底部导航 ───────────────────────

    private fun buildUi(): View {
        // 先建 4 个页面（内部初始化各自的控件引用）
        pages = listOf(buildHomePage(), buildDiagPage(), buildSettingsPage(), buildLogsPage())

        pageContainer = FrameLayout(this)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(color(R.color.bg))
        }

        // 顶栏
        root.addView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(18), dp(16), dp(18), dp(12))
                addView(
                    TextView(this@MainActivity).apply {
                        text = "评论 Agent"
                        textSize = 18f
                        setTextColor(color(R.color.fg))
                        setTypeface(typeface, Typeface.BOLD)
                    },
                )
                addView(
                    TextView(this@MainActivity).apply {
                        text = "设备面板 · v${BuildConfig.VERSION_NAME}"
                        textSize = 11.5f
                        setTextColor(color(R.color.fg_dim))
                        setPadding(0, dp(2), 0, 0)
                    },
                )
            },
        )

        // 页面容器（占满剩余高度）
        root.addView(
            pageContainer,
            LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
        )

        // 底部导航（上方加一条细分隔线，与内容区分开）
        bottomNav = buildBottomNav()
        root.addView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                addView(divider())
                addView(
                    bottomNav,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ),
                )
            },
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )

        showPage(0)
        return root
    }

    private fun buildBottomNav(): BottomNavigationView =
        BottomNavigationView(this).apply {
            setBackgroundColor(color(R.color.card_bg))
            val tint = ContextCompat.getColorStateList(this@MainActivity, R.color.nav_item_color)
            itemIconTintList = tint
            itemTextColor = tint
            labelVisibilityMode = BottomNavigationView.LABEL_VISIBILITY_LABELED
            elevation = dp(8).toFloat()
            menu.add(0, TAB_HOME, 0, "首页").setIcon(R.drawable.ic_nav_home)
            menu.add(0, TAB_DIAG, 1, "诊断").setIcon(R.drawable.ic_nav_diag)
            menu.add(0, TAB_SETTINGS, 2, "设置").setIcon(R.drawable.ic_nav_settings)
            menu.add(0, TAB_LOGS, 3, "日志").setIcon(R.drawable.ic_nav_logs)
            setOnItemSelectedListener { item ->
                when (item.itemId) {
                    TAB_HOME -> showPage(0)
                    TAB_DIAG -> showPage(1)
                    TAB_SETTINGS -> showPage(2)
                    TAB_LOGS -> showPage(3)
                }
                true
            }
        }

    /**
     * 切页：只替换容器内容。
     * 页面 View 常驻（不销毁重建），因此控件引用始终有效 —— 这是
     * refreshStatus() 能跨页面持续更新的前提。
     */
    private fun showPage(index: Int) {
        val p = pages.getOrNull(index) ?: return
        (p.parent as? ViewGroup)?.removeView(p)
        pageContainer.removeAllViews()
        pageContainer.addView(
            p,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
    }

    /** 页面外壳：可滚动 + 统一内边距 */
    private fun pageScroll(block: LinearLayout.() -> Unit): ScrollView =
        ScrollView(this).apply {
            isFillViewport = true
            addView(
                LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(14), dp(12), dp(14), dp(20))
                    block()
                },
            )
        }

    // ── ① 首页 ───────────────────────────────────────────────

    private fun buildHomePage(): View = pageScroll {
        serviceDot = View(this@MainActivity).apply {
            layoutParams = LinearLayout.LayoutParams(dp(10), dp(10)).apply {
                setMargins(0, 0, dp(10), 0)
            }
            background = oval(color(R.color.fg_dim))
        }
        serviceState = TextView(this@MainActivity).apply {
            text = "…"
            textSize = 12.5f
            setTextColor(color(R.color.warn))
            setPadding(dp(9), dp(4), dp(9), dp(4))
            background = rounded(7, color(R.color.warn_soft))
        }
        serviceBtn = Button(this@MainActivity).apply {
            isAllCaps = false
            gravity = Gravity.CENTER
            textSize = 15f
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(46),
            ).apply { setMargins(0, dp(14), 0, 0) }
        }
        statusCard = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }

        // 权限异常告警条：默认隐藏，出现时点它直接跳设置页
        permBanner = TextView(this@MainActivity).apply {
            textSize = 12.5f
            setTextColor(color(R.color.warn))
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = rounded(12, color(R.color.card_bg), color(R.color.warn))
            visibility = View.GONE
            isClickable = true
            setOnClickListener { bottomNav.selectedItemId = TAB_SETTINGS }
        }
        addView(
            permBanner,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { setMargins(0, 0, 0, dp(12)) },
        )

        // 服务状态大卡
        addView(card {
            addView(
                LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    addView(serviceDot)
                    addView(
                        TextView(this@MainActivity).apply {
                            text = "常驻服务"
                            textSize = 16f
                            setTextColor(color(R.color.fg))
                            setTypeface(typeface, Typeface.BOLD)
                            layoutParams = LinearLayout.LayoutParams(
                                0,
                                ViewGroup.LayoutParams.WRAP_CONTENT,
                                1f,
                            )
                        },
                    )
                    addView(serviceState)
                },
            )
            addView(serviceBtn)
        })

        // 当前状态明细
        addView(card {
            addView(sectionTitle("当前状态"))
            addView(statusCard)
        })
    }

    // ── ② 诊断页 ─────────────────────────────────────────────

    private fun buildDiagPage(): View = pageScroll {
        addView(card {
            addView(sectionTitle("任务操作"))
            addView(primaryButton("立即领取一次") { claimNow() })
            addView(primaryButton("立即切城") { rotateNow() })
            addView(
                hint(
                    "两者都会跳过设备端的常规等待（领取 30~60 分钟 / 切城 2 天周期）；" +
                        "后台约束照常生效，返回空属正常结果。",
                ),
            )
        })

        addView(card {
            addView(sectionTitle("连通性测试"))
            addView(ghostButton("测试 Clash 控制器") { testClash() })
            addView(ghostButton("测试出口 IP 与属地") { testIp() })
        })

        addView(card {
            addView(sectionTitle("设备自检"))
            addView(ghostButton("运行自检（含元素命中）") { selfCheck() })
            addView(
                hint("自检会自动唤起抖音并打开评论面板，用于确认关键控件是否命中 —— 新机型适配必做。"),
            )
        })
    }

    // ── ③ 设置页 ─────────────────────────────────────────────

    private fun buildSettingsPage(): View = pageScroll {
        serverInput = inputField("http://192.168.1.10:15650")
        clashInput = inputField("http://127.0.0.1:9090")
        clashSecretInput = inputField("控制器密钥（可空）")
        permList = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL }

        addView(card {
            addView(sectionTitle("后台地址"))
            addView(serverInput)
            addView(primaryButton("保存并启动服务") { saveServer() })
        })

        addView(card {
            addView(sectionTitle("Clash 控制器 · 切城用"))
            addView(clashInput)
            addView(clashSecretInput)
            addView(ghostButton("自动探测控制器") { autoDetectClash() })
            addView(ghostButton("保存并测试连通") { saveClash() })
            addView(
                hint(
                    "需先在 Clash Meta 里开启「外部控制」" +
                        "（覆写 → External Controller → 127.0.0.1:9090），否则切城会失败。",
                ),
            )
        })

        addView(card {
            addView(sectionTitle("权限引导 · 每台设备一次"))
            addView(permList)
            addView(hint("点任意一行可跳转到对应系统设置页。"))
        })
    }

    // ── ④ 日志页 ─────────────────────────────────────────────

    private fun buildLogsPage(): View = pageScroll {
        logView = TextView(this@MainActivity).apply {
            textSize = 11f
            typeface = Typeface.MONOSPACE
            setTextColor(color(R.color.fg_dim))
            setPadding(dp(12), dp(12), dp(12), dp(12))
            background = rounded(12, color(R.color.log_bg))
            setTextIsSelectable(true)
        }

        addView(
            LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(flexButton("刷新") { lifecycleScope.launch { refreshStatus() } })
                addView(flexButton("复制全部") { copyLogs() })
            },
        )
        addView(card {
            addView(sectionTitle("最近日志"))
            addView(logView)
        })
    }

    /** 复制最近日志到剪贴板（运维反馈问题时直接贴给开发） */
    private fun copyLogs() {
        val lines = Log.tail(200)
        runCatching {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("agent-log", lines.joinToString("\n")))
            toast("已复制 ${lines.size} 行日志")
        }.onFailure { toast("复制失败：${it.message}") }
    }

    // ── 动作 ─────────────────────────────────────────────────

    private fun saveServer() {
        lifecycleScope.launch {
            // 去掉所有空白字符：粘贴地址时很容易混入 Tab / 换行，而 trim 只能去掉首尾
            val server = serverInput.text.toString().filterNot { it.isWhitespace() }.trimEnd('/')
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
            val url = clashInput.text.toString().filterNot { it.isWhitespace() }.trimEnd('/')
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
                // 显示**省级**属地（归一成中文），城市放括号里做辅助 —— 属地匹配用的是省份
                val region = RegionName.normalize(r.region)
                toast("出口 ${r.ip} · $region（${r.city.ifBlank { "-" }}）")
                Log.i(
                    "ui",
                    "出口探测：ip=${r.ip} region=${r.region}→$region city=${r.city} " +
                        "ipv6Leak=${r.ipv6Leak} via ${r.source}",
                )
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
        // 悬浮窗权限：后台启动 Activity（唤起抖音）的前提，禁用会导致任务全部卡在「抖音未进前台」
        val overlay = Actions.hasOverlayPermission(ctx)

        // ── 服务状态（首页大卡）──
        val running = AgentService.running
        serviceDot.background = oval(color(if (running) R.color.ok else R.color.fg_dim))
        serviceState.text = if (running) "运行中" else "已停止"
        serviceState.setTextColor(color(if (running) R.color.ok else R.color.warn))
        serviceState.background =
            rounded(7, color(if (running) R.color.ok_soft else R.color.warn_soft))
        if (running) {
            serviceBtn.text = "停止服务"
            styleButton(serviceBtn, color(R.color.err), color(R.color.white))
            serviceBtn.setOnClickListener {
                AgentService.stop(ctx)
                toast("服务已停止")
            }
        } else {
            serviceBtn.text = "启动服务"
            styleButton(serviceBtn, color(R.color.brand), color(R.color.white))
            serviceBtn.setOnClickListener {
                AgentService.start(ctx)
                toast("服务启动请求已发送")
            }
        }

        // ── 当前状态明细（首页；重建成本低，2 秒一次无感）──
        statusCard.removeAllViews()

        statusCard.addView(groupLabel("设备"))
        statusCard.addView(kvRow("设备号", "${deviceId.take(8)}…${deviceId.takeLast(4)}"))
        statusCard.addView(
            kvRow(
                "接单状态",
                if (paused) "已暂停" else "正常",
                color(if (paused) R.color.warn else R.color.ok),
            ),
        )
        statusCard.addView(kvRow("看护状态", Watchdog.describe(ctx)))

        statusCard.addView(groupLabel("网络"))
        statusCard.addView(kvRow("最近心跳", Time.humanAgo(lastHb.takeIf { it > 0 })))
        statusCard.addView(kvRow("出口 IP", lastIp ?: "-"))
        // 归一成中文省份显示：探测源返回的是英文（如 Hebei），直接显示会让人误以为没切成功
        statusCard.addView(
            kvRow(
                "出口属地",
                lastCity?.takeIf { it.isNotBlank() }?.let { RegionName.normalize(it) } ?: "-",
            ),
        )
        statusCard.addView(
            kvRow(
                "时钟偏移",
                "${Time.clockOffsetSec()} 秒${if (Time.synced) "（已校时）" else "（未校时）"}",
            ),
        )

        statusCard.addView(groupLabel("节奏与版本"))
        statusCard.addView(
            kvRow("下次可领取", if (nextEligible <= 0) "立即可领" else Time.localText(nextEligible)),
        )
        statusCard.addView(kvRow("下次切城", nextSwitch))
        statusCard.addView(kvRow("城市池版本", poolVersion ?: "未下发"))
        statusCard.addView(kvRow("人格版本", if (personaVersion > 0) "v$personaVersion" else "未下发"))
        statusCard.addView(kvRow("待重传队列", "回执 $receipts / 事件 $events"))

        // ── 权限告警条（首页）：只列会导致任务失败的项 ──
        val blockers = buildList {
            if (!a11y) add("无障碍服务")
            if (!overlay) add("悬浮窗权限")
        }
        if (blockers.isEmpty()) {
            permBanner.visibility = View.GONE
        } else {
            permBanner.text = "⚠ 缺少 ${blockers.joinToString("、")}，任务会全部失败 → 点此去设置"
            permBanner.visibility = View.VISIBLE
        }

        // ── 权限列表（设置页；可点击跳转对应系统页）──
        permList.removeAllViews()
        permList.addView(permRow("无障碍服务 · 必需", if (a11y) "已开启" else "未开启", a11y) {
            Actions.openSettings(ctx, Settings.ACTION_ACCESSIBILITY_SETTINGS)
        })
        permList.addView(
            permRow(
                "显示在其他应用上层 · 必需",
                if (overlay) "已授权" else "未授权",
                overlay,
            ) { Actions.requestOverlayPermission(ctx) },
        )
        val ignoringBattery = runCatching {
            (getSystemService(POWER_SERVICE) as PowerManager)
                .isIgnoringBatteryOptimizations(packageName)
        }.getOrDefault(false)
        permList.addView(
            permRow(
                "电池优化",
                if (ignoringBattery) "已忽略" else "未忽略",
                ignoringBattery,
            ) { Actions.requestIgnoreBatteryOptimization(ctx) },
        )
        val notifOk = notifGranted()
        permList.addView(permRow("通知权限", if (notifOk) "已授权" else "未授权", notifOk) {
            requestNotificationPermissionIfNeeded()
        })

        // ── 日志（日志页）──
        logView.text = Log.tail(120).joinToString("\n")
    }

    /** 通知权限是否已授（Android 13 以下视为已授） */
    private fun notifGranted(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    // ── 权限 ─────────────────────────────────────────────────

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (notifGranted()) return
        notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
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

    /** 区块标题：左侧品牌色竖条 + 标题（比纯文字更有层次感） */
    private fun sectionTitle(t: String): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(0, 0, 0, dp(12))
        addView(
            View(this@MainActivity).apply {
                layoutParams = LinearLayout.LayoutParams(dp(3), dp(13)).apply {
                    setMargins(0, 0, dp(8), 0)
                }
                background = rounded(2, color(R.color.brand))
            },
        )
        addView(
            TextView(this@MainActivity).apply {
                text = t
                textSize = 13f
                setTextColor(color(R.color.fg))
                setTypeface(typeface, Typeface.BOLD)
                letterSpacing = 0.03f
            },
        )
    }

    /** 状态徽标：圆角浅底 + 状态色文字（比纯彩色文字更醒目） */
    private fun badge(text: String, fgRes: Int, bgRes: Int): TextView = TextView(this).apply {
        this.text = text
        textSize = 11.5f
        setTextColor(color(fgRes))
        setPadding(dp(9), dp(4), dp(9), dp(4))
        background = rounded(7, color(bgRes))
    }

    /** 状态分组小标题（灰色小字，用于把长列表分块） */
    private fun groupLabel(t: String): TextView = TextView(this).apply {
        text = t
        textSize = 11.5f
        setTextColor(color(R.color.fg_dim))
        setPadding(0, dp(12), 0, dp(2))
        letterSpacing = 0.05f
    }

    /** 1dp 分隔线 */
    private fun divider(): View = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(1),
        )
        setBackgroundColor(color(R.color.stroke_soft))
    }

    /** 卡片内说明文字（灰色小字） */
    private fun hint(t: String): TextView = TextView(this).apply {
        text = t
        textSize = 11.5f
        setTextColor(color(R.color.fg_dim))
        setPadding(0, dp(10), 0, 0)
        setLineSpacing(dp(2).toFloat(), 1f)
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

    /** 带按压波纹的按钮背景（深色界面里点击反馈很重要） */
    private fun rippleBg(radiusDp: Int, fill: Int, strokeColor: Int? = null): RippleDrawable =
        RippleDrawable(
            ColorStateList.valueOf(Color.argb(56, 255, 255, 255)),
            rounded(radiusDp, fill, strokeColor),
            null,
        )

    /** 实心主按钮 */
    private fun primaryButton(text: String, onClick: () -> Unit): Button = Button(this).apply {
        this.text = text
        isAllCaps = false
        gravity = Gravity.CENTER
        textSize = 14f
        setTextColor(color(R.color.white))
        background = rippleBg(11, color(R.color.brand))
        elevation = dp(2).toFloat()
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(46),
        ).apply { setMargins(0, dp(6), 0, dp(6)) }
    }

    /** 描边次按钮 */
    private fun ghostButton(text: String, onClick: () -> Unit): Button = Button(this).apply {
        this.text = text
        isAllCaps = false
        gravity = Gravity.CENTER
        textSize = 13f
        setTextColor(color(R.color.fg_mid))
        background = rippleBg(11, Color.TRANSPARENT, color(R.color.stroke))
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(44),
        ).apply { setMargins(0, dp(5), 0, dp(5)) }
    }

    /** 次按钮（等分宽度，用于并排排布） */
    private fun flexButton(text: String, onClick: () -> Unit): Button =
        ghostButton(text, onClick).apply {
            layoutParams = LinearLayout.LayoutParams(0, dp(44), 1f).apply {
                setMargins(dp(4), dp(4), dp(4), dp(4))
            }
        }

    /** 动态改按钮填充 / 文字色（服务启停切换用） */
    private fun styleButton(btn: Button, fill: Int, textColor: Int) {
        btn.setTextColor(textColor)
        btn.background = rounded(10, fill)
    }

    /** 状态键值行：左键灰、右值白（可着色），带底部细分隔线 */
    private fun kvRow(k: String, v: String, vColor: Int = color(R.color.fg)): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(
                LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, dp(9), 0, dp(9))
                    addView(
                        TextView(this@MainActivity).apply {
                            text = k
                            textSize = 13f
                            setTextColor(color(R.color.fg_dim))
                            layoutParams = LinearLayout.LayoutParams(
                                0,
                                ViewGroup.LayoutParams.WRAP_CONTENT,
                                1f,
                            )
                        },
                    )
                    addView(
                        TextView(this@MainActivity).apply {
                            text = v
                            textSize = 13f
                            setTextColor(vColor)
                            gravity = Gravity.END
                            layoutParams = LinearLayout.LayoutParams(
                                0,
                                ViewGroup.LayoutParams.WRAP_CONTENT,
                                1.2f,
                            )
                        },
                    )
                },
            )
            addView(divider())
        }

    /** 权限行：名称 + 状态徽标 + 「›」，整行可点（跳系统设置） */
    private fun permRow(name: String, status: String, ok: Boolean, onClick: () -> Unit): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), dp(10), 0, dp(10))
            isClickable = true
            setOnClickListener { onClick() }
            addView(
                TextView(this@MainActivity).apply {
                    text = name
                    textSize = 13.5f
                    setTextColor(color(R.color.fg))
                    layoutParams = LinearLayout.LayoutParams(
                        0,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                        1f,
                    )
                },
            )
            addView(
                badge(
                    status,
                    if (ok) R.color.ok else R.color.err,
                    if (ok) R.color.ok_soft else R.color.err_soft,
                ),
            )
            addView(
                TextView(this@MainActivity).apply {
                    text = "  ›"
                    textSize = 14f
                    setTextColor(color(R.color.fg_dim))
                },
            )
        }

    private fun toast(msg: String) {
        android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_SHORT).show()
    }
}
