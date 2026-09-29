/**
 * 后台控制平台入口（Bun + Hono）。
 *
 * 路由分组：
 *   /agent/*      设备端接口（注册 / 心跳 / 领取 / 事件 / 回执）
 *   /api/*        看板数据（前端待确认后开发；当前返回 JSON）
 *   /materials/*  素材下载（内网直连通道，不走代理）
 *   /providers/*  Clash proxy-providers 文件（P2 实现，当前返回 501）
 *   /health       健康检查
 */
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { serveStatic } from 'hono/bun'
import { config, configWarnings } from './config.js'
import { loadSettings, settings } from './settings/settings_store.js'
import { createLogger } from './logger.js'
import { on, EVENTS } from './bus.js'
import { closePg, ensureSchema, ping } from './db_pg.js'
import { startScheduler, stopScheduler } from './scheduler.js'
import { listDevices } from './device/device_store.js'
import { listTasks } from './task/task_store.js'
import { listCityPool } from './post/post_store.js'
import adminRoute from './admin/admin_routes.js'
import { tokenOf, verify } from './admin/admin_auth.js'
import heartbeatRoute from './agent_api/heartbeat_api.js'
import claimRoute from './agent_api/claim_api.js'
import eventRoute from './agent_api/event_api.js'
import receiptRoute from './agent_api/receipt_api.js'

const log = createLogger('main')
const app = new Hono()

/** 「当天第几分钟」→ "HH:MM"（启动日志用，与页面上的写法一致） */
function minuteText(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

// 启动期配置告警（见 config.ts 的 configWarnings）。
// 这些配置问题**不会让进程起不来**，只会在运行时表现成"说不通的怪现象"
// （密钥是公开默认值 → 谁都能伪造登录；时段写成 "8" → 窗口从零点开始）。
for (const w of configWarnings) log.warn(`⚠ 配置：${w}`)
if (config.admin.password === 'admin') {
  log.warn(
    '⚠ 配置：ADMIN_PASSWORD 仍是默认值 admin —— 请务必在 .env 里改掉' +
      '（管理台可以下发指令、增删帖子与素材，等同后台控制权）',
  )
}

/**
 * 旧看板接口的鉴权守卫。
 *
 * ⚠ `/api/devices`、`/api/tasks`、`/api/city-pool` 是早期看板留下的兼容接口，
 *   此前**没有任何鉴权**：任何能访问到端口的人都能拉走全量设备清单与任务历史
 *   （含帖子短链、话术、设备 IP 与属地）。新前端只走 `/api/admin/*`，这几个已无人使用，
 *   因此直接补上与管理台一致的 Bearer 校验。
 *
 * 注：`/materials/*` 仍保持开放 —— 设备端靠它拉取图片素材（任务包里只有 URL，
 *   没有管理台 token），属于**有意为之**；素材本身是待发布的评论配图，敏感度低。
 */
async function requireAdmin(c: Context, next: Next): Promise<Response | void> {
  if (!verify(tokenOf(c.req.header('Authorization')))) {
    return c.json({ ok: false, error: '未登录或登录已过期' }, 401)
  }
  await next()
}

// ⚠ 必须注册 ALERT 订阅者。
// `bus` 是「只发不收」的进程内事件总线，而全项目原本**零订阅者** ——
// 于是设备离线 / 任务超期 / IPv6 泄露这些告警全部被静默丢弃，
// 200 台设备上线后出故障将完全无人知晓。这里先落到日志（告警页可后续增强）。
on(EVENTS.ALERT, (payload) => {
  const p = payload as {
    level?: string
    code?: string
    message?: string
    deviceId?: string
    taskId?: string
  }
  const line =
    `[ALERT] code=${p.code ?? '-'} ${p.message ?? ''} ` +
    `device=${p.deviceId ?? '-'} task=${p.taskId ?? '-'}`
  if (p.level === 'error') log.error(line)
  else log.warn(line)
})

// ── CORS ─────────────────────────────────────────────────────
// ⚠ 原来是 `cors()`，等价于 `Access-Control-Allow-Origin: *` —— 任何网页都能跨域读取本服务的
//    响应。与下面几个未鉴权的旧接口叠加，等于"打开一个恶意页面就能把设备清单拖走"。
//    现在只放行三类来源：
//      · 同源（浏览器不发 Origin 头，例如后台自带的前端）；
//      · 本机（localhost / 127.0.0.1 / ::1，任意端口，覆盖 Vite 调试端口）；
//      · 与请求 Host **同一台机器**的来源 —— 内网里常从另一台电脑用 IP 直连后台，
//        这种情况下 Origin 的 host 与 Host 头一致；
//    另可用 `CORS_ALLOWED_ORIGINS`（逗号分隔）显式追加。
const extraOrigins = new Set(
  (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)

app.use('*', async (c, next) => {
  const origin = c.req.header('Origin')
  if (origin) {
    let originHost = ''
    try {
      originHost = new URL(origin).hostname
    } catch {
      originHost = ''
    }
    const reqHost = (c.req.header('Host') ?? '').split(':')[0] ?? ''
    const isLocal = originHost === 'localhost' || originHost === '127.0.0.1' || originHost === '::1'
    const sameMachine = reqHost !== '' && originHost === reqHost
    if (isLocal || sameMachine || extraOrigins.has(origin)) {
      c.header('Access-Control-Allow-Origin', origin)
      c.header('Vary', 'Origin')
      c.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS')
      c.header('Access-Control-Allow-Headers', 'Authorization,Content-Type')
      c.header('Access-Control-Max-Age', '600')
    } else if (c.req.method === 'OPTIONS') {
      // 不在白名单：不回任何 CORS 头 → 浏览器侧直接拦掉
      return c.body(null, 403)
    }
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

// 访问日志（debug 级别，避免刷屏）
app.use('*', async (c, next) => {
  const t0 = performance.now()
  await next()
  log.debug(`${c.req.method} ${c.req.path} → ${c.res.status} (${(performance.now() - t0).toFixed(1)}ms)`)
})

// ── 设备端接口（四通道；无注册，设备首启心跳自动登记）──────────
app.route('/agent/heartbeat', heartbeatRoute)
app.route('/agent/task/claim', claimRoute)
app.route('/agent/event', eventRoute)
app.route('/agent/receipt', receiptRoute)

// ── 健康检查 ─────────────────────────────────────────────────
app.get('/health', async (c) => {
  const dbOk = await ping()
  return c.json(
    {
      ok: dbOk,
      db: dbOk,
      serverTimeMs: Date.now(),
      heartbeatSeconds: settings.heartbeat.seconds,
      port: config.server.port,
    },
    dbOk ? 200 : 503,
  )
})

// ── 管理台 API（独立前端 comment/admin-web 调用；见 admin/admin_routes.ts）──
app.route('/api/admin', adminRoute)

// ── 看板数据（旧接口，保留兼容；新前端统一用 /api/admin/*）──────
// ⚠ 这三个接口此前完全裸奔（见 requireAdmin 的说明），现统一要求管理台 token。
app.get('/api/devices', requireAdmin, async (c) => {
  const items = await listDevices()
  const now = Date.now()
  return c.json({
    items: items.map((d) => {
      const seen = d.last_seen_at ? new Date(d.last_seen_at).getTime() : null
      const gapSec = seen === null ? null : Math.floor((now - seen) / 1000)
      const online = gapSec !== null && gapSec <= settings.heartbeat.onlineThresholdSeconds
      return { ...d, online, lastSeenGapSec: gapSec }
    }),
  })
})

app.get('/api/tasks', requireAdmin, async (c) => {
  const limit = Number.parseInt(c.req.query('limit') ?? '100', 10)
  return c.json({ items: await listTasks(Number.isFinite(limit) ? limit : 100) })
})

app.get('/api/city-pool', requireAdmin, async (c) => c.json({ items: await listCityPool() }))

// ── 素材下载（内网通道）──────────────────────────────────────
// ⚠ Hono 的 serveStatic 是 `root + 完整请求路径` 拼接的：不剥掉挂载前缀的话，
//    /materials/x.jpg 会去找 <root>/materials/x.jpg，而文件实际在 <root>/x.jpg
//    —— 结果是**素材下载通道全量 404**（设备永远拉不到图，图文评论必然失败，
//    而设备侧只会报 material_download_failed，看不出是后台路由配错了）。
app.use(
  '/materials/*',
  serveStatic({
    root: config.material.dir,
    rewriteRequestPath: (p) => p.replace(/^\/materials/, ''),
  }),
)

// ── Clash provider 文件（P2：节点定义下发；当前未实现）───────
app.get('/providers/*', (c) =>
  c.json(
    {
      error: 'provider endpoint not implemented yet',
      note: 'P2 实现：从节点配置生成 city-<slug>.yaml，供 Clash proxy-providers 拉取',
      requested: c.req.path,
    },
    501,
  ),
)

// ── 兜底 ────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'not found', path: c.req.path }, 404))
app.onError((err, c) => {
  log.error(`unhandled error ${c.req.method} ${c.req.path}:`, err)
  return c.json({ error: err.message }, 500)
})

// ── 启动 ────────────────────────────────────────────────────
try {
  await ensureSchema()
} catch (e) {
  log.error('ensureSchema failed — 请确认 PostgreSQL 已启动且 PG_URL 正确：', e)
}

if (!(await ping())) {
  log.error('数据库不可达：服务仍会启动，但设备接口将报错。请检查 .env 的 PG_URL。')
}

// 系统设置要在 startScheduler 之前加载：调度器与设备接口都读 settings 的生效值。
// 顺序是「模块加载时先套用 .env 默认值 → 这里再用库里的覆盖值覆盖」，
// 所以下面这行打出来的就是**当前真正生效**的参数（含页面上改过的）。
const loadedSettings = await loadSettings()

startScheduler()

log.info(`backend listening on http://${config.server.host}:${config.server.port}`)
log.info(
  `生效参数：心跳=${settings.heartbeat.seconds}s 在线判定=${settings.heartbeat.onlineThresholdSeconds}s ` +
    `单设备日上限=${settings.dispatch.dailyQuotaPerDevice} ` +
    `完成间隔=${settings.dispatch.intervalMinMinutes}-${settings.dispatch.intervalMaxMinutes}min ` +
    `投放窗口=${minuteText(settings.dispatch.windowStartMinute)}-${minuteText(settings.dispatch.windowEndMinute)} ` +
    `单帖间隔=${settings.dispatch.perPostMinIntervalMinutes}min ` +
    `同帖冷却=${settings.dispatch.devicePostCooldownDays}天`,
)
// 把关键参数打出来：这个系统吃过「改了 config.ts 默认值却因为 .env 优先而不生效」的亏。
// 现在多了一层"页面设置"，所以更要把**谁在起作用**说清楚，否则同一类坑会再踩一次。
log.info(
  `（其中 ${loadedSettings.overrides} 项来自管理台「系统设置」页；未被页面覆盖的跟随 .env / 默认值）`,
)
log.info(`pg pool=${config.pg.poolMax} statement_timeout=${
  process.env.PG_STATEMENT_TIMEOUT_MS ?? '15000(default)'}ms`)

async function shutdown(signal: string): Promise<void> {
  log.info(`received ${signal}, shutting down ...`)
  stopScheduler()
  await closePg()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

export default {
  port: config.server.port,
  hostname: config.server.host,
  fetch: app.fetch,
}
