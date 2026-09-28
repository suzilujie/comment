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
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/bun'
import { config } from './config.js'
import { createLogger } from './logger.js'
import { on, EVENTS } from './bus.js'
import { closePg, ensureSchema, ping } from './db_pg.js'
import { startScheduler, stopScheduler } from './scheduler.js'
import { listDevices } from './device/device_store.js'
import { listTasks } from './task/task_store.js'
import { listCityPool } from './post/post_store.js'
import adminRoute from './admin/admin_routes.js'
import heartbeatRoute from './agent_api/heartbeat_api.js'
import claimRoute from './agent_api/claim_api.js'
import eventRoute from './agent_api/event_api.js'
import receiptRoute from './agent_api/receipt_api.js'

const log = createLogger('main')
const app = new Hono()

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

app.use('*', cors())

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
      heartbeatSeconds: config.heartbeat.seconds,
      port: config.server.port,
    },
    dbOk ? 200 : 503,
  )
})

// ── 管理台 API（独立前端 comment/admin-web 调用；见 admin/admin_routes.ts）──
app.route('/api/admin', adminRoute)

// ── 看板数据（旧接口，保留兼容；新前端统一用 /api/admin/*）──────
app.get('/api/devices', async (c) => {
  const items = await listDevices()
  const now = Date.now()
  return c.json({
    items: items.map((d) => {
      const seen = d.last_seen_at ? new Date(d.last_seen_at).getTime() : null
      const gapSec = seen === null ? null : Math.floor((now - seen) / 1000)
      const online = gapSec !== null && gapSec <= config.heartbeat.onlineThresholdSeconds
      return { ...d, online, lastSeenGapSec: gapSec }
    }),
  })
})

app.get('/api/tasks', async (c) => {
  const limit = Number.parseInt(c.req.query('limit') ?? '100', 10)
  return c.json({ items: await listTasks(Number.isFinite(limit) ? limit : 100) })
})

app.get('/api/city-pool', async (c) => c.json({ items: await listCityPool() }))

// ── 素材下载（内网通道）──────────────────────────────────────
app.use('/materials/*', serveStatic({ root: config.material.dir }))

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

startScheduler()

log.info(`backend listening on http://${config.server.host}:${config.server.port}`)
log.info(`heartbeat=${config.heartbeat.seconds}s quota/day=${config.dispatch.dailyQuotaPerAccount} ` +
  `interval=${config.dispatch.intervalMinMinutes}-${config.dispatch.intervalMaxMinutes}min ` +
  `window=${config.dispatch.windowStartMinute}-${config.dispatch.windowEndMinute}(local minute of day)`)
// 把关键容量参数打出来：200 台规模下「连接池被 .env 里的旧值覆盖」是很容易漏的坑
// （改 config.ts 默认值不等于生效 —— .env 优先），启动时显式确认一次。
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
