/**
 * 后台定时任务（Scheduler）。
 *
 * 只做三件事，都不是"提前排程"（派单是即时求解，见 dispatch/dispatcher.ts）：
 *  1. 超期任务扫描 → unknown（禁止自动重试，转人工确认）；
 *  2. 设备离线检测 → 写 device_events + 发告警；
 *  3. 城市池计数刷新（供设备端随机选择与空跑统计）。
 */
import { config } from './config.js'
import { createLogger } from './logger.js'
import { emit, EVENTS } from './bus.js'
import { db } from './db_pg.js'
import { finishTask, findOverdueTasks } from './task/task_store.js'
import { humanAgo, nowMs, parseMs } from './datetime.js'

const log = createLogger('scheduler')

let timer: ReturnType<typeof setInterval> | null = null

/** 1. 超期任务 → unknown（§5.4 规则 2：不确定一律 unknown） */
export async function scanOverdueTasks(): Promise<number> {
  const overdue = await findOverdueTasks(50)
  for (const task of overdue) {
    await finishTask(task.id, 'unknown', {
      reasonCode: 'receipt_timeout',
      actor: 'platform',
      detail: { deadlineAt: task.deadline_at, note: 'no receipt before deadline; manual review required' },
    })
    emit(EVENTS.TASK_TIMEOUT, { taskId: task.id })
    emit(EVENTS.ALERT, {
      level: 'warn',
      code: 'task_timeout',
      message: `任务 ${task.id} 超期无回执，已置 unknown（禁止自动重试）`,
      taskId: task.id,
      deviceId: task.device_id ?? undefined,
    })
  }
  if (overdue.length > 0) log.warn(`overdue tasks → unknown: ${overdue.length}`)
  return overdue.length
}

/** 2. 设备离线检测（基于心跳新鲜度；离线且带在途任务时只告警，不回收重派） */
export async function scanOfflineDevices(): Promise<number> {
  const sql = db()
  const rows = (await sql`
    SELECT d.id, d.last_seen_at, d.busy_task_id,
           (SELECT COUNT(*)::int FROM tasks t
            WHERE t.device_id = d.id AND t.status IN ('dispatched','executing')) AS inflight
    FROM devices d
    WHERE d.admin_state <> 'disabled'
      AND (d.last_seen_at IS NULL
           OR d.last_seen_at < NOW() - ${`${config.heartbeat.offlineAlertThresholdSeconds} seconds`}::interval)
  `) as unknown as {
    id: string
    last_seen_at: Date | null
    busy_task_id: string | null
    inflight: number
  }[]

  let n = 0
  const now = nowMs()
  for (const d of rows) {
    const seen = parseMs(d.last_seen_at)
    const gapSec = seen === null ? Number.POSITIVE_INFINITY : Math.floor((now - seen) / 1000)
    const manual = gapSec >= config.heartbeat.offlineManualThresholdSeconds
    await sql`
      INSERT INTO device_events (device_id, event, reason, detail)
      VALUES (${d.id}, 'offline', ${`gap=${gapSec === Number.POSITIVE_INFINITY ? 'never' : `${gapSec}s`}`},
              ${JSON.stringify({ inflight: d.inflight, lastSeen: d.last_seen_at })}::jsonb)
    `
    emit(EVENTS.DEVICE_PRESENCE, { deviceId: d.id, from: 'online', to: 'offline' })
    emit(EVENTS.ALERT, {
      level: manual ? 'error' : 'warn',
      code: manual ? 'device_offline_manual' : 'device_offline',
      message: `设备 ${d.id} 离线（最后心跳 ${humanAgo(d.last_seen_at ?? now) }）` +
        (d.inflight > 0 ? `，且有 ${d.inflight} 条在途任务（不自动重派）` : ''),
      deviceId: d.id,
    })
    n++
  }
  return n
}

/** 3. 城市池刷新：重算每城可评帖子数，并给出空跑提示 */
export async function refreshCityPool(): Promise<void> {
  const sql = db()
  const cities = (await sql`SELECT city FROM city_pools WHERE active = TRUE`) as unknown as {
    city: string
  }[]
  for (const { city } of cities) {
    const rows = (await sql`
      SELECT COUNT(*)::int AS n FROM posts WHERE city = ${city} AND status = 'active'
    `) as unknown as { n: number }[]
    const n = rows[0]?.n ?? 0
    await sql`
      UPDATE city_pools SET post_count = ${n}, updated_at = NOW() WHERE city = ${city}
    `
    if (n === 0) log.warn(`city pool: ${city} has no active post (设备切到该城将空跑)`)
  }
}

/** 启动定时器 */
export function startScheduler(): void {
  if (timer) return
  const every30s = 30_000
  const every5min = 5 * 60_000
  let tick = 0

  timer = setInterval(() => {
    tick++
    void (async () => {
      try {
        await scanOverdueTasks()
        await scanOfflineDevices()
        if (tick % 10 === 0) await refreshCityPool()
      } catch (e) {
        log.error('scheduler tick failed:', e)
      }
    })()
  }, every30s)

  // 启动时立刻跑一轮，避免等待首个周期
  void (async () => {
    try {
      await scanOverdueTasks()
      await scanOfflineDevices()
      await refreshCityPool()
    } catch (e) {
      log.error('scheduler warmup failed:', e)
    }
  })()

  log.info(`scheduler started (task scan ${every30s / 1000}s, city pool ${every5min / 60_000}min)`)
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
