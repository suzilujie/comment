# comment — 手机端 Agent（Android / Kotlin）

常驻 Android 真机的 `设备端 Agent`：**感知 + 执行 + 回执**，不含业务决策（薄 Agent）。
设计依据：同目录上级的 `设计文档.html` §3.6（Agent 架构）、§4.4（心跳/通信模型）、§5.1（派单约束）、§5.4（任务状态机）、§5.3（设备自治切城）、§6.3（逐步拟人化）、§6.5（行为人格）。

---

## 一、四条主链（与后台的关系）

| # | 链路 | 触发 | 说明 |
|---|---|---|---|
| 1 | **心跳** Heartbeat | 固定 30 秒（±10% 抖动） | `POST /agent/heartbeat`，**只同步状态**，不领任务 |
| 2 | **获取任务包** Fetch Task | 空闲时按需 | `POST /agent/task/claim`，设备只猜时机，后台做裁决 |
| 3 | **回传执行状态** Report Status | 开工前 + 结束后 | `POST /agent/event`（`task_started`/`task_aborted`）+ `POST /agent/receipt` |
| 4 | **定时切换 IP** Rotate IP | 每 2 天 ± 4 小时（设备自治） | 从后台下发的**城市池**中纯随机跨城，切完立即上报 |

支撑能力（贯穿四链）：常驻保活 · 自动化执行引擎 · 行为仿真 · 素材本地化 · 识别与自保护 · 登录态保活 · 幂等 WAL。

## 二、目录结构

```
agent/
├─ settings.gradle.kts / build.gradle.kts / gradle.properties
├─ gradle/libs.versions.toml          版本目录
├─ start.bat                          构建 + 安装（含 gradle 命令说明）
└─ app/
   ├─ build.gradle.kts
   └─ src/main/
      ├─ AndroidManifest.xml
      ├─ res/xml/accessibility_service_config.xml
      ├─ res/values/strings.xml, themes.xml
      └─ java/com/xfish/comment/agent/
         ├─ App.kt                     Application：初始化 + 启动常驻服务
         ├─ MainActivity.kt            状态面板 + 权限引导 + 自检
         ├─ core/                      配置 / 日志 / 时钟 / 随机 / 事件总线
         ├─ net/                       契约 DTO + OkHttp 客户端 + 四个接口
         ├─ data/                      Room（WAL / 回执队列 / 日志）+ DataStore
         ├─ runtime/                   前台服务 / 心跳 / 领取 / Watchdog / 开机自启
         ├─ accessibility/             无障碍服务 / 定位器回退链 / 动作原语 / 行为仿真
         ├─ exec/                      任务状态机（定位 → 动作 → 验证）
         └─ netlink/                   出口 IP 探测 / Clash 切换 / 城市池随机轮换
```

## 三、技术栈

| 项 | 选型 |
|---|---|
| 语言 | Kotlin（协程） |
| SDK | minSdk 29（Android 10），target 34 |
| 网络 | OkHttp + kotlinx.serialization（契约字段与后台 Zod 一一对应） |
| 本地存储 | Room（WAL 意图日志 / 回执队列 / 运行日志）+ DataStore（设备身份与设置） |
| 依赖注入 | 手工单例（不引 Hilt） |
| 关键 API | `AccessibilityService`、`dispatchGesture`、`ClipboardManager`+`ACTION_PASTE`、`MediaStore`、MediaProjection（低频可选） |

## 四、构建与安装

```bat
:: 一键（构建 + 安装到已连接设备）
start.bat

:: 或手动
gradlew.bat :app:assembleDebug
adb install -r app\build\outputs\apk\debug\app-debug.apk
:: 华为/小米等需先允许 USB 安装，并开启"USB 调试（安全设置）"
```

> **注意**：本项目路径含中文字符（`发评论`）。Gradle 在 Windows 下对非 ASCII 路径偶有异常，
> 已在 `gradle.properties` 显式设置 `-Dfile.encoding=UTF-8`；若构建报编码相关错误，
> 可将项目复制到纯 ASCII 路径下构建（如 `C:\work\comment\agent`）。

## 五、首次上机配置清单（每台设备一次）

1. 安装 APK → 打开 App → 填写后台地址（默认 `http://<内网IP>:15650`）并点「保存后台地址」；
2. **无注册环节**：设备首启心跳即自动登记（UUID 作为设备唯一号，存 DataStore）；
3. 授权：**无障碍服务**、**电池优化忽略**、**自启动白名单**、**后台弹出界面**（MIUI / HyperOS）；
4. 关闭抖音自动更新（版本锁定），安装 Clash 系客户端并导入节点配置；
5. 点「自检」跑一遍：无障碍 / 前台服务 / 代理连通 / 出口 IP 与属地 / IPv6 泄露 / 版本。

## 六、关键约定（与后台一致，改一处必须同步另一处）

| 约定 | 值 |
|---|---|
| 心跳间隔 | 30 秒 ± 10% 抖动（`SecureRandom`，不用默认 `Random()`） |
| 领取时机 | 距上次**完成** + 本机随机 30–60 分钟（被拒按 `retryAfterSeconds` 退避） |
| 切 IP 周期 | 2 天 ± 4 小时（本地计时，`elapsedRealtime` 单调时钟） |
| 幂等底线 | 允许漏发，**绝不允许重发**；无法确认是否已发出 → 一律 `unknown`，**禁止自动重试** |
| 时间 | 与后台校时（`serverTimeMs`），间隔计时一律用单调时钟；展示用 UTC+8 |
| 输入方式 | 剪贴板 + `ACTION_PASTE`（兜底：长按输入框 → 点「粘贴」气泡） |
| 识别 | L1 控件树为主（免截屏）；L2/L3 可选 |

## 七、与后台的接口（端口 15650）

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/agent/heartbeat` | 心跳（状态 + 指令 + 城市池 + 人格；首启即自动登记） |
| POST | `/agent/task/claim` | 领取任务 |
| POST | `/agent/event` | 事件（`task_started` / `task_aborted` / `ip_switched` / `command_result` / `probe_result` / `device_offline_notice`） |
| POST | `/agent/receipt` | 回执（任务终态） |
