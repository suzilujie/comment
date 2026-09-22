# comment — 抖音评论区自动化投放系统

后台控制平台（Platform）+ 手机端 Agent（Android）的代码工程。

设计依据：同目录上级的 `设计文档.html`（v0.4）、`开发计划.html`（v0.1）、`核心链路图.html`（v1.6）。
**文档是唯一的方案来源；代码与文档不一致时，先改文档再改代码。**

---

## 目录结构

```
comment/
├─ start.bat                 # 一键启动（本机开发：后端）
├─ backend/                  # 后台控制平台（Bun + TypeScript）
│  ├─ package.json
│  ├─ tsconfig.json
│  ├─ .env.example           # 复制为 .env 后填写
│  ├─ biome.json
│  ├─ start.bat              # 单独启动后端
│  ├─ sql/
│  │  └─ schema.sql          # 幂等建表（CREATE TABLE IF NOT EXISTS）
│  └─ src/
│     ├─ main.ts             # 入口：Hono 应用 + 路由挂载 + 启动
│     ├─ config.ts           # 配置单一来源（.env > 默认值）
│     ├─ logger.ts           # 轻量日志（控制台 + 按天滚动文件）
│     ├─ bus.ts              # 进程内事件总线（模块解耦）
│     ├─ db.ts               # PostgreSQL 连接池单例（postgres.js）
│     ├─ types.ts            # 共享类型
│     ├─ contracts/          # 设备 ↔ 后台的 Zod 契约（四通道）
│     ├─ agent_api/          # 设备端接口：心跳 / 领取 / 事件 / 回执
│     ├─ dispatch/           # 派单约束求解与调度
│     ├─ device/             # 设备状态存储与状态派生
│     ├─ task/               # 任务状态机与存储
│     └─ post/               # 帖子池与素材去重
└─ agent/                    # 手机端 Agent（Kotlin / Android）
   └─ app/src/main/java/...  # 见 agent/README.md
```

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | **Bun**（ESM） | `"type": "module"`；import 使用相对路径 + **显式 `.js` 后缀** |
| HTTP | **Hono** | 路由按模块分文件挂载（避免单文件堆积） |
| 数据库 | **PostgreSQL 16** + **postgres.js** | 原生 SQL（带参模板），无 ORM；建表用幂等 SQL |
| 校验 | **Zod** | 设备端输入一律校验（外部输入不可信） |
| 日志 | 自研 `logger.ts` | 控制台 + 按天滚动文件 |
| 解耦 | `bus.ts` 事件总线 | 模块间通过事件通信，不互相 import 业务逻辑 |
| 测试 | `bun:test` | 与源文件同目录 `*.test.ts` |
| 质量 | Biome | 单引号、省略分号、行宽 100、2 空格 |

## 端口

| 用途 | 端口 |
|---|---|
| 后台 API（心跳 / 领取 / 事件 / 回执 / 素材） | **15650** |
| Web 前端（待确认后开发） | 5180 |

## 启动

```bat
:: 首次：安装依赖
cd backend
bun install

:: 建库（一次即可，幂等）
psql -U postgres -d comment -f sql/schema.sql

:: 配置
copy .env.example .env

:: 启动（任选其一）
start.bat            :: 双击 comment\start.bat，或 backend\start.bat
bun run dev          :: 开发模式（--watch）
```

> **脚本约定**：所有启动脚本统一命名 `start`；脚本内一律使用 `%~dp0` 取自身目录，
> **不硬编码绝对路径**（本项目路径含中文字符，硬编码会触发 cmd 的路径解析缺陷）。

## 已确认的关键设计（摘要）

- **心跳**：设备每 30 秒主动上报状态（唯一职责是同步状态）；心跳与任务领取是**两个独立接口**。
- **派单**：不预先排程；设备空闲时调用领取接口，后台求解 **20 条约束**后即时派发。
- **约束上限**：单账号日 ≤ 20 条；与上次**完成**的间隔随机 30–60 分钟；投放时段窗口；全局派单密度。
- **执行状态上报**：开工前 `task_started`，结束后回执；两者独立于心跳即时上报。
- **切 IP**：设备自治，每 2 天 ± 4 小时，从后台下发的**城市池**纯随机跨城，切完立即上报新 IP 与属地。
- **幂等底线**：允许漏发，**绝不允许重发**；无法确认是否已发出的一律记 `unknown`，禁止自动重试。
- **时间**：数据库存 `timestamptz`（UTC），判定与展示统一转 **UTC+8**。

## 与文档的对应

| 代码位置 | 设计文档章节 |
|---|---|
| `contracts/` | §4.1 任务包 / §4.2 回执 / §4.4 通信模型 |
| `agent_api/` | §4.4 心跳、领取、状态上报 / §4.5 指令与事件 |
| `dispatch/` | §5.1 派单约束与流程 |
| `task/` | §5.4 任务状态机（5 态） |
| `device/` | §3.8 设备状态管理 |
| `post/` | §6.2 素材去重 / §6.4 素材通道 |
| 切 IP（agent 侧 + 城市池） | §5.3 网络身份与设备自治切城 |
| 人格档案 | §6.5 行为人格与多样性控制 |
