# 评论投放 · 管理台（独立前端）

`comment/admin-web` 是**独立**的管理前端项目（与 `agent/`、`backend/` 平级），
只通过后端 `/api/admin/*` 交互，不集成进后端代码、不入后端构建。

## 技术栈

- Vite 8 + React 19 + TypeScript（严格模式）
- Tailwind CSS 4（通过 `@tailwindcss/vite`，无 `tailwind.config.js`）
- 无第三方组件库 / 状态库 / 请求库 —— 页面规模不大，手写更少黑盒

## 快速开始

```bash
# 依赖安装（本仓库用 npm；如网络受限可换 bun install）
npm install

# 开发（dev server: http://127.0.0.1:5273，已配置 /api 代理）
npm run dev

# 类型检查 + 生产构建（产物在 dist/）
npm run build
```

后端地址在 `vite.config.ts` 的常量里（默认 `http://127.0.0.1:15650`）：

```ts
const BACKEND = 'http://127.0.0.1:15650'
```

> 刻意不用 `process.env`：避免为配置文件引入 `@types/node` 依赖。

## 页面与能力

| 页面 | 内容 | 写操作 |
|---|---|---|
| 概览 | 后端健康、设备在线、今日派单、成功率、`unknown` 待处理数、帖子/话术/城市池 | - |
| 设备 | 在线状态、出口属地、无障碍/前台/代理三项健康、今日配额、成功/失败/待确认、下次可领 | **复位计数**（日计数 / 下次可领取 / 连续失败归零） |
| 任务 | 派发时间、帖子、设备、状态、`evidence`、原因码、耗时；可只看 `unknown` | **订正**（已发出 → succeeded；未发出 → failed） |
| 帖子池 | `committed / target`、`today_used`、最近评论时间、累计成功/待确认/失败 | **释放今日名额**（删当天占用 + 事件 + 素材占用，并清 `last_comment_at`） |
| 事件流 | `task_events` 追加流，含 `actor=manual` 的人工操作留痕与 detail | - |

写操作都会落到 `task_events`（`actor=manual`），可在事件流页追溯。

## 三个写操作到底改了什么

**1. 复位设备计数** `POST /api/admin/devices/:id/reset-counters`

```
devices.daily_done = 0
devices.daily_done_date = NULL
devices.next_eligible_at = NULL      -- 立刻可领取
devices.fail_streak = 0
（total_success / total_fail / total_unknown 保留）
```

**2. 释放帖子今日名额** `POST /api/admin/posts/:id/release-slot`

```
删除：该帖「今天」的 tasks、对应 task_events、对应 post_material_usage
可选：posts.last_comment_at = NULL   -- 默认执行，解除单帖 15 分钟节奏
```

> ⚠ 会删除当天的任务审计记录，只应在人工核实「评论确实没发出去」后使用。
> 若只想释放某台设备，body 传 `{"deviceId":"..."}`。

**3. 订正 unknown 任务** `POST /api/admin/tasks/:id/resolve`

```
body: { "verdict": "succeeded" | "failed", "note": "可选说明" }

succeeded → 复用 task_store.finishTask 正向记账：
            设备 total_success+1、fail_streak 归零、重排 next_eligible_at、
            刷新 posts.last_comment_at；该帖当天占用保持不变
failed    → 失败记账：退还设备当日配额；
            「同设备 × 同帖每天一次」名额自动释放（failed 不计入占用）
两者都会：写 task_events(actor=manual)，并把该设备的 total_unknown 扣回 1（避免重复统计）
```

仅 `status = 'unknown'` 的任务可订正，其他状态返回 `409`。

## 生产部署

构建产物是纯静态文件，需要一个反向代理把 `/api` 转到后端（同域，天然无跨域）：

```nginx
server {
  listen 80;
  server_name admin.example.internal;

  location / {
    root /srv/comment/admin-web/dist;
    try_files $uri $uri/ /index.html;
  }

  # 必须与前端同域，前端只请求相对路径 /api/*
  location /api/ {
    proxy_pass http://127.0.0.1:15650;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
  }
}
```

后端已开启宽松 CORS（`app.use('*', cors())`），因此直接跨域访问也能工作，
但生产建议仍走同域反向代理。

## 安全说明（重要）

- `/api/admin/*` 已内置登录鉴权：除 `POST /login` 外，全部接口都要求
  `Authorization: Bearer <token>`。token 由后端 `admin_auth.ts` 用 HMAC 签发（无状态），
  默认凭据 **admin / admin**，可用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 覆盖；
  改 `ADMIN_TOKEN_SECRET` 会让所有已登录会话立即失效。
- 该鉴权是**内网级**：明文 HTTP 下 token 仍可能被嗅探。对外暴露前应改 HTTPS，
  并在反向代理层限制来源。
- 写操作具有破坏性（删除任务记录、改状态），请勿开放公网。

## 待办 / TODO

- [x] 管理端鉴权（HMAC 无状态 token + 登录页；默认 admin/admin）
- [ ] 任务与事件的分页与筛选（当前按 limit 拉取）
- [ ] 设备详情页（历史任务、事件时间线）
- [ ] 帖子池批量启停、批量改城市
- [ ] 概览页的趋势图（按天成功率）
- [ ] 移动端适配优化（当前表格横向滚动）
