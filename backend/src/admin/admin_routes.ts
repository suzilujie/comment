/**
 * 管理台 API（/api/admin/*）—— 供独立前端（comment/admin-web）调用。
 *
 * 部署前提：内网使用，暂不做鉴权；对外暴露前必须加 Token / Basic Auth（见 README 待办）。
 * 注意：**不要**把这里和 /agent/*（设备端）混用，两者契约完全不同。
 */
import { Hono } from 'hono'
import { config } from '../config.js'
import { listDevices } from '../device/device_store.js'
import { listCityPool } from '../post/post_store.js'
import { listTasks } from '../task/task_store.js'
import {
  getOverview,
  listPostsWithStats,
  listTaskEvents,
  listUnknownTasks,
  releasePostSlot,
  resetDeviceCounters,
  resolveTask,
} from './admin_store.js'

const admin = new Hono()

function limitOf(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 && n <= 1000 ? n : fallback
}

// ── 查询 ────────────────────────────────────────────────────

admin.get('/overview', async (c) => c.json(await getOverview()))

admin.get('/devices', async (c) => {
  const items = await listDevices()
  const now = Date.now()
  return c.json({
    items: items.map((d) => {
      const seen = d.last_seen_at ? new Date(d.last_seen_at).getTime() : null
      const gapSec = seen === null ? null : Math.floor((now - seen) / 1000)
      return {
        ...d,
        online: gapSec !== null && gapSec <= config.heartbeat.onlineThresholdSeconds,
        lastSeenGapSec: gapSec,
      }
    }),
    onlineThresholdSeconds: config.heartbeat.onlineThresholdSeconds,
  })
})

admin.get('/tasks', async (c) =>
  c.json({ items: await listTasks(limitOf(c.req.query('limit'), 100)) }),
)

admin.get('/unknown-tasks', async (c) =>
  c.json({ items: await listUnknownTasks(limitOf(c.req.query('limit'), 50)) }),
)

admin.get('/posts', async (c) =>
  c.json({ items: await listPostsWithStats(limitOf(c.req.query('limit'), 200)) }),
)

admin.get('/events', async (c) =>
  c.json({ items: await listTaskEvents(limitOf(c.req.query('limit'), 100)) }),
)

admin.get('/city-pools', async (c) => c.json({ items: await listCityPool() }))

// ── 写操作（人工把手）────────────────────────────────────────

admin.post('/devices/:id/reset-counters', async (c) => {
  const r = await resetDeviceCounters(c.req.param('id'))
  return c.json(r, r.ok ? 200 : 404)
})

admin.post('/posts/:id/release-slot', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const r = await releasePostSlot(c.req.param('id'), {
    deviceId: typeof body.deviceId === 'string' && body.deviceId ? body.deviceId : undefined,
    resetPacing: body.resetPacing !== false,
  })
  return c.json(r, r.ok ? 200 : 404)
})

admin.post('/tasks/:id/resolve', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const verdict = body.verdict
  if (verdict !== 'succeeded' && verdict !== 'failed') {
    return c.json({ ok: false, error: 'verdict must be "succeeded" | "failed"' }, 400)
  }
  const r = await resolveTask(
    c.req.param('id'),
    verdict,
    typeof body.note === 'string' ? body.note : undefined,
  )
  return c.json(r, r.ok ? 200 : 409)
})

export default admin
