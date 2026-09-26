/**
 * 管理台数据层（仅供 /api/admin/* 使用，与设备端业务链路隔离）。
 *
 * 定位：把「目前只能靠手写 SQL 完成」的人工操作，收敛成三个受控动作 ——
 *   ① 复位设备计数（换号 / 调试期归零）；
 *   ② 释放帖子当天名额（假失败占位、需要立刻重派）；
 *   ③ 订正 unknown 任务（设计约定：unknown = 转人工确认，禁止自动重试）。
 *
 * 约束：
 *  · 查询一律只读；
 *  · 写操作必须留痕（订正走 task_store.appendEvent，actor=manual）；
 *  · 不在此处实现业务规则（配额、去重等仍归 dispatch/task_store 管）。
 */
import { db } from '../db_pg.js'
import { config } from '../config.js'
import { localDateKey } from '../datetime.js'
import { createLogger } from '../logger.js'
import { getPost } from '../post/post_store.js'
import { finishTask, getTask } from '../task/task_store.js'

const log = createLogger('admin')

// ══════════════════════════════════════════════════════════
// 查询
// ══════════════════════════════════════════════════════════

export interface Overview {
  devicesTotal: number
  devicesOnline: number
  devicesBusy: number
  tasksToday: number
  tasksSucceeded: number
  tasksUnknown: number
  tasksFailed: number
  postsActive: number
  postsPaused: number
  scriptsEnabled: number
  citiesActive: number
  onlineThresholdSeconds: number
}

export async function getOverview(): Promise<Overview> {
  const sql = db()
  const today = localDateKey()
  const rows = (await sql`
    SELECT
      (SELECT COUNT(*)::int FROM devices) AS devices_total,
      (SELECT COUNT(*)::int FROM devices
         WHERE last_seen_at > NOW() - ${`${config.heartbeat.onlineThresholdSeconds} seconds`}::interval
      ) AS devices_online,
      (SELECT COUNT(*)::int FROM devices WHERE busy_task_id IS NOT NULL) AS devices_busy,
      (SELECT COUNT(*)::int FROM tasks
         WHERE (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date = ${today}::date
      ) AS tasks_today,
      (SELECT COUNT(*)::int FROM tasks WHERE status = 'succeeded') AS tasks_succeeded,
      (SELECT COUNT(*)::int FROM tasks WHERE status = 'unknown')   AS tasks_unknown,
      (SELECT COUNT(*)::int FROM tasks WHERE status = 'failed')    AS tasks_failed,
      (SELECT COUNT(*)::int FROM posts WHERE status = 'active')    AS posts_active,
      (SELECT COUNT(*)::int FROM posts WHERE status = 'paused')    AS posts_paused,
      (SELECT COUNT(*)::int FROM scripts WHERE enabled = TRUE)     AS scripts_enabled,
      (SELECT COUNT(*)::int FROM city_pools WHERE active = TRUE)   AS cities_active
  `) as unknown as Record<string, number>[]
  const r = rows[0] ?? {}
  return {
    devicesTotal: r.devices_total ?? 0,
    devicesOnline: r.devices_online ?? 0,
    devicesBusy: r.devices_busy ?? 0,
    tasksToday: r.tasks_today ?? 0,
    tasksSucceeded: r.tasks_succeeded ?? 0,
    tasksUnknown: r.tasks_unknown ?? 0,
    tasksFailed: r.tasks_failed ?? 0,
    postsActive: r.posts_active ?? 0,
    postsPaused: r.posts_paused ?? 0,
    scriptsEnabled: r.scripts_enabled ?? 0,
    citiesActive: r.cities_active ?? 0,
    onlineThresholdSeconds: config.heartbeat.onlineThresholdSeconds,
  }
}

export interface AdminPostRow {
  id: string
  url: string
  city: string
  post_type: string | null
  status: string
  title: string | null
  target_count: number
  /** 已占用条数（succeeded + dispatched + executing + unknown） */
  committed: number
  /** 今天已派发条数（决定「同设备 × 同帖每天一次」是否还占着名额） */
  today_used: number
  last_comment_at: Date | null
  total_tasks: number
  succeeded: number
  unknown: number
  failed: number
}

/** 帖子池 + 统计（管理台首屏要看"为什么领不到"） */
export async function listPostsWithStats(limit = 200): Promise<AdminPostRow[]> {
  const sql = db()
  const today = localDateKey()
  return (await sql`
    SELECT
      p.id, p.url, p.city, p.post_type, p.status, p.title, p.target_count, p.last_comment_at,
      (SELECT COUNT(*)::int FROM tasks t
         WHERE t.post_id = p.id
           AND t.status IN ('succeeded','dispatched','executing','unknown')) AS committed,
      (SELECT COUNT(*)::int FROM tasks t
         WHERE t.post_id = p.id
           AND (t.dispatched_at AT TIME ZONE 'Asia/Shanghai')::date = ${today}::date) AS today_used,
      (SELECT COUNT(*)::int FROM tasks t WHERE t.post_id = p.id) AS total_tasks,
      (SELECT COUNT(*)::int FROM tasks t WHERE t.post_id = p.id AND t.status = 'succeeded') AS succeeded,
      (SELECT COUNT(*)::int FROM tasks t WHERE t.post_id = p.id AND t.status = 'unknown')   AS unknown,
      (SELECT COUNT(*)::int FROM tasks t WHERE t.post_id = p.id AND t.status = 'failed')    AS failed
    FROM posts p
    ORDER BY
      CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
      p.city, p.id
    LIMIT ${limit}
  `) as unknown as AdminPostRow[]
}

export interface AdminTaskEventRow {
  id: number
  task_id: string
  event: string
  actor: string
  reason_code: string | null
  detail: unknown
  created_at: Date
  post_id: string | null
  device_id: string | null
  task_status: string | null
  evidence: string | null
}

/** 事件流（含任务快照，用于一眼看出 unknown 及其 evidence） */
export async function listTaskEvents(limit = 100): Promise<AdminTaskEventRow[]> {
  const sql = db()
  return (await sql`
    SELECT e.id, e.task_id, e.event, e.actor, e.reason_code, e.detail, e.created_at,
           t.post_id, t.device_id, t.status AS task_status, t.evidence
    FROM task_events e
    LEFT JOIN tasks t ON t.id = e.task_id
    ORDER BY e.id DESC
    LIMIT ${limit}
  `) as unknown as AdminTaskEventRow[]
}

/** unknown 任务清单（待人工确认，管理台的核心待办列表） */
export async function listUnknownTasks(limit = 50): Promise<Record<string, unknown>[]> {
  const sql = db()
  return (await sql`
    SELECT id, device_id, post_id, dispatched_at, finished_at, reason_code, evidence
    FROM tasks WHERE status = 'unknown'
    ORDER BY dispatched_at DESC LIMIT ${limit}
  `) as unknown as Record<string, unknown>[]
}

// ══════════════════════════════════════════════════════════
// 写操作（人工把手）
// ══════════════════════════════════════════════════════════

export interface OpResult {
  ok: boolean
  error?: string
  detail?: Record<string, unknown>
}

/** ① 复位设备计数（换号 / 调试期归零；包括日计数、下次可领取、连续失败） */
export async function resetDeviceCounters(deviceId: string): Promise<OpResult> {
  const sql = db()
  const rows = (await sql`
    UPDATE devices
    SET daily_done = 0, daily_done_date = NULL, next_eligible_at = NULL,
        fail_streak = 0, updated_at = NOW()
    WHERE id = ${deviceId}
    RETURNING id
  `) as unknown as { id: string }[]
  if (rows.length === 0) return { ok: false, error: 'device not found' }
  log.info(`admin reset-counters device=${deviceId}`)
  return { ok: true, detail: { deviceId } }
}

/**
 * ② 释放帖子当天名额。
 *
 * 场景：某条任务被判 unknown（可能已发出但读不到）→ 当天该帖被占位，
 *      人工核实"确实没发出去"后，用这里把占位清掉，让设备能重新派到这条帖子。
 *
 * 参数：
 *  · deviceId  ：只清该设备在该帖的当天占用（不传=清该帖当天所有占用）；
 *  · resetPacing：是否同时清「单帖节奏」的 last_comment_at（默认清，否则还要等 15 分钟）。
 */
export async function releasePostSlot(
  postId: string,
  opts: { deviceId?: string; resetPacing?: boolean } = {},
): Promise<OpResult> {
  const sql = db()
  const post = await getPost(postId)
  if (!post) return { ok: false, error: 'post not found' }
  const today = localDateKey()
  const resetPacing = opts.resetPacing !== false

  const targets = (await sql`
    SELECT id FROM tasks
    WHERE post_id = ${postId}
      AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date = ${today}::date
      ${opts.deviceId ? sql`AND device_id = ${opts.deviceId}` : sql``}
  `) as unknown as { id: string }[]
  const ids = targets.map((t) => t.id)

  let removedEvents = 0
  let removedMaterials = 0
  if (ids.length > 0) {
    const ev = (await sql`
      DELETE FROM task_events WHERE task_id IN ${sql(ids)} RETURNING id
    `) as unknown as { id: number }[]
    removedEvents = ev.length

    // 素材占用按 task_id 精确回收（post_material_usage.task_id 有落库）
    const mu = (await sql`
      DELETE FROM post_material_usage WHERE task_id IN ${sql(ids)} RETURNING post_id
    `) as unknown as { post_id: string }[]
    removedMaterials = mu.length

    await sql`DELETE FROM tasks WHERE id IN ${sql(ids)}`
  }

  if (resetPacing) {
    await sql`UPDATE posts SET last_comment_at = NULL, updated_at = NOW() WHERE id = ${postId}`
  }

  log.info(
    `admin release-slot post=${postId} device=${opts.deviceId ?? '*'} ` +
      `tasks=${ids.length} events=${removedEvents} materials=${removedMaterials} resetPacing=${resetPacing}`,
  )
  return {
    ok: true,
    detail: {
      postId,
      deviceId: opts.deviceId ?? null,
      removedTasks: ids.length,
      removedEvents,
      removedMaterials,
      resetPacing,
    },
  }
}

/**
 * ③ 订正 unknown 任务（人工核实后给出结论）。
 *
 *  · verdict = 'succeeded'：评论确实已发出 → 复用它走 finishTask 的正向记账
 *    （设备 total_success+1、fail_streak 归零、重排 next_eligible_at、刷新帖子 last_comment_at）；
 *  · verdict = 'failed'    ：确认未发出 → 走 finishTask 的失败记账（退还当日配额），
 *    同时「同设备 × 同帖每天一次」的名额自然释放（failed 不计入占用）。
 *
 * 注意：unknown 判定时已给设备累加过 total_unknown，订正后需把该计数扣回，避免重复统计。
 */
export async function resolveTask(
  taskId: string,
  verdict: 'succeeded' | 'failed',
  note?: string,
): Promise<OpResult> {
  const sql = db()
  const task = await getTask(taskId)
  if (!task) return { ok: false, error: 'task not found' }
  if (task.status !== 'unknown') {
    return { ok: false, error: `task status is '${task.status}', only 'unknown' can be resolved` }
  }

  const evidence =
    verdict === 'succeeded' ? 'manual_verify:comment_visible' : 'manual_verify:comment_not_found'

  const updated = await finishTask(taskId, verdict, {
    actor: 'manual',
    reasonCode: verdict === 'failed' ? 'submit_failed' : undefined,
    evidence,
    detail: { source: 'admin_web', rule: 'unknown_to_manual', verdict, note: note ?? null },
  })

  // 扣回 unknown 计数（finishTask 已按终态记账，不再重复统计）
  if (task.device_id) {
    await sql`
      UPDATE devices SET total_unknown = GREATEST(total_unknown - 1, 0), updated_at = NOW()
      WHERE id = ${task.device_id}
    `
  }

  log.info(`admin resolve task=${taskId} verdict=${verdict} device=${task.device_id ?? '-'}`)
  return { ok: true, detail: { taskId, verdict, status: updated?.status ?? null, evidence } }
}
