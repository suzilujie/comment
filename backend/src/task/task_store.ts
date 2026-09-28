/**
 * 任务存储与 5 态状态机（设计文档 §5.4）。
 *
 * 四条规则在本文件落实：
 *  1. 单写原则：后台只写 dispatched / unknown；设备只写 executing 与终态；
 *  2. 不确定一律 unknown（禁止把"可能已发出"记成 failed）；
 *  3. 配额退还：failed / aborted（确认未发出）退还；unknown 暂不退还；
 *  4. 每次迁移写 task_events 留痕。
 *
 * 2026-09-26：归属主体由「账号」改为「设备」——配额、节奏、统计一律按 device_id。
 */
import { db } from '../db_pg.js'
import { emit, EVENTS } from '../bus.js'
import { createLogger } from '../logger.js'
import { config } from '../config.js'
import { addMinutes, localDateKey, nowMs } from '../datetime.js'
import { makeId, randomInt } from '../random.js'
import type { Actor, TaskStatus } from '../types.js'

const log = createLogger('task')

/**
 * 账号类失败原因（反映投放账号健康度，需累计 fail_streak）。
 *
 * 其余原因（未唤起抖音 / 元素未命中 / 网络异常 / 属地不符 / 幂等跳过等）
 * 属**环境或适配问题**，不应惩罚投放主体——否则调试与定位器适配期会被
 * 「连续失败 3 次自动降额」快速封停。
 */
const ACCOUNT_FAULT_REASONS = new Set(['rate_limited', 'captcha', 'risk_dialog'])

function isAccountFault(reasonCode?: string): boolean {
  return reasonCode != null && ACCOUNT_FAULT_REASONS.has(reasonCode)
}

export interface TaskRow {
  id: string
  device_id: string | null
  post_id: string
  status: TaskStatus
  script_text: string | null
  script_id: string | null
  comment_type: 'text' | 'image' | null
  image_hash: string | null
  image_path: string | null
  reason_code: string | null
  evidence: string | null
  dispatched_at: Date
  deadline_at: Date
  started_at: Date | null
  finished_at: Date | null
  dispatch_ip_city: string | null
}

interface CreateTaskInput {
  deviceId: string
  postId: string
  scriptId: string
  scriptText: string
  commentType: 'text' | 'image'
  imageHash?: string
  imagePath?: string
  dispatchIpCity: string
}

/** 创建任务（派发那一刻创建；后台写入 dispatched） */
export async function createTask(input: CreateTaskInput): Promise<TaskRow> {
  const sql = db()
  const id = makeId('task')
  const deadline = addMinutes(nowMs(), config.dispatch.receiptTimeoutMinutes)

  await sql`
    INSERT INTO tasks (id, device_id, post_id, status, script_text, script_id,
                       comment_type, image_hash, image_path, dispatch_ip_city,
                       dispatched_at, deadline_at)
    VALUES (${id}, ${input.deviceId}, ${input.postId}, 'dispatched',
            ${input.scriptText}, ${input.scriptId}, ${input.commentType},
            ${input.imageHash ?? null}, ${input.imagePath ?? null}, ${input.dispatchIpCity},
            NOW(), ${deadline})
  `
  await appendEvent(id, 'dispatched', 'platform', undefined, {
    deviceId: input.deviceId,
    postId: input.postId,
    commentType: input.commentType,
  })
  emit(EVENTS.TASK_DISPATCHED, { taskId: id, deviceId: input.deviceId })
  log.info(`task created ${id} device=${input.deviceId} post=${input.postId}`)
  return (await getTask(id)) as TaskRow
}

export async function getTask(taskId: string): Promise<TaskRow | null> {
  const sql = db()
  const rows = (await sql`SELECT * FROM tasks WHERE id = ${taskId} LIMIT 1`) as unknown as TaskRow[]
  return rows[0] ?? null
}

/** 写事件流（追加写，永不修改） */
export async function appendEvent(
  taskId: string,
  event: string,
  actor: Actor,
  reasonCode?: string,
  detail?: unknown,
): Promise<void> {
  const sql = db()
  await sql`
    INSERT INTO task_events (task_id, event, actor, reason_code, detail)
    VALUES (${taskId}, ${event}, ${actor}, ${reasonCode ?? null},
            ${detail === undefined ? null : JSON.stringify(detail)}::jsonb)
  `
}

/** 设备上报开工信号 → executing（设备可写） */
export async function markStarted(taskId: string): Promise<boolean> {
  const sql = db()
  const updated = (await sql`
    UPDATE tasks SET status = 'executing', started_at = COALESCE(started_at, NOW())
    WHERE id = ${taskId} AND status = 'dispatched'
    RETURNING id
  `) as unknown as { id: string }[]
  if (updated.length === 0) return false
  await appendEvent(taskId, 'started', 'device')
  emit(EVENTS.TASK_STARTED, { taskId })
  return true
}

/**
 * 任务终态（设备回执或后台超时判定）。
 * - succeeded：计入配额消耗，刷新 next_eligible_at
 * - failed / aborted（确认未发出）：退还配额
 * - unknown：不退还（可能已发出），转人工确认
 */
export async function finishTask(
  taskId: string,
  status: Extract<TaskStatus, 'succeeded' | 'failed' | 'aborted' | 'unknown'>,
  opts: { reasonCode?: string; evidence?: string; actor?: Actor; detail?: unknown } = {},
): Promise<TaskRow | null> {
  const sql = db()
  const task = await getTask(taskId)
  if (!task) return null
  if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'aborted') {
    log.warn(`task ${taskId} already terminal (${task.status}), ignore ${status}`)
    return task
  }

  const actor: Actor = opts.actor ?? (status === 'unknown' ? 'platform' : 'device')
  await sql`
    UPDATE tasks SET
      status = ${status},
      reason_code = ${opts.reasonCode ?? null},
      evidence = ${opts.evidence ?? null},
      finished_at = NOW()
    WHERE id = ${taskId}
  `
  await appendEvent(taskId, status, actor, opts.reasonCode, opts.detail)

  // ── 设备侧记账（2026-09-26 起由账号维度改为设备维度）──
  const finishedAt = nowMs()
  if (task.device_id) {
    if (status === 'succeeded') {
      await sql`
        UPDATE devices SET
          total_success = total_success + 1,
          fail_streak = 0,
          next_eligible_at = ${new Date(finishedAt + randomInt(
            config.dispatch.intervalMinMinutes,
            config.dispatch.intervalMaxMinutes,
          ) * 60_000)},
          updated_at = NOW()
        WHERE id = ${task.device_id}
      `
    } else if (status === 'failed' || status === 'aborted') {
      // 确认未发出 → 退还当日配额。
      // ⚠ fail_streak 仅统计「账号类失败」：设备/适配类失败（未唤起抖音、元素未命中、
      // 网络异常、属地不符等）不反映投放账号健康度，若一并累计，调试/适配期会被
      // 第 5 条约束「连续失败 3 次自动降额」快速封停。
      const accountFault = isAccountFault(opts.reasonCode)
      await sql`
        UPDATE devices SET
          daily_done = GREATEST(daily_done - 1, 0),
          fail_streak = CASE WHEN ${accountFault} THEN fail_streak + 1 ELSE fail_streak END,
          total_fail = total_fail + 1,
          updated_at = NOW()
        WHERE id = ${task.device_id}
      `
      log.info(
        `task fail ${taskId} reason=${opts.reasonCode ?? '-'} accountFault=${accountFault}`,
      )
    } else {
      await sql`
        UPDATE devices SET total_unknown = total_unknown + 1, updated_at = NOW()
        WHERE id = ${task.device_id}
      `
    }
  }

  if (status === 'succeeded') {
    await sql`
      UPDATE posts SET
        last_comment_at = NOW(),
        updated_at = NOW()
      WHERE id = ${task.post_id}
    `
  } else if (status === 'failed' || status === 'aborted') {
    // 释放派单时原子占用的帖子名额（见 dispatcher 的条件 UPDATE）。
    // ⚠ `unknown` **不释放**：它的语义是「可能已发出」，占着名额才能防止同帖重复评论。
    await sql`
      UPDATE posts SET committed = GREATEST(committed - 1, 0), updated_at = NOW()
      WHERE id = ${task.post_id}
    `
  }

  if (task.device_id) {
    await sql`
      UPDATE devices SET busy_task_id = NULL, updated_at = NOW()
      WHERE id = ${task.device_id} AND busy_task_id = ${taskId}
    `
  }

  emit(EVENTS.TASK_FINISHED, { taskId, status, reasonCode: opts.reasonCode })
  log.info(`task finished ${taskId} → ${status}${opts.reasonCode ? ` (${opts.reasonCode})` : ''}`)
  return getTask(taskId)
}

/** 设备在途任务（一台设备同时只允许 1 条） */
export async function findInFlightByDevice(deviceId: string): Promise<TaskRow | null> {
  const sql = db()
  const rows = (await sql`
    SELECT * FROM tasks
    WHERE device_id = ${deviceId} AND status IN ('dispatched', 'executing')
    ORDER BY dispatched_at DESC LIMIT 1
  `) as unknown as TaskRow[]
  return rows[0] ?? null
}

/** 该设备今日已完成的条数（按 UTC+8 自然日判定） */
export async function countTodayDone(deviceId: string): Promise<number> {
  const sql = db()
  const { start, end } = localDayRange()
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM tasks
    WHERE device_id = ${deviceId}
      AND status = 'succeeded'
      AND finished_at >= ${start} AND finished_at < ${end}
  `) as unknown as { n: number }[]
  return rows[0]?.n ?? 0
}

/**
 * 该设备今日是否已评论过该帖（1 次/天）。
 *
 * 口径：
 *  · succeeded / dispatched / executing —— 恒占用（已成功或在途，占用才能防重复派单）；
 *  · unknown —— 由 includeUnknown 决定（调用方传 config.dispatch.unknownOccupiesPostSlot，默认 true）：
 *    设备上报 unknown 表示"可能已发出"，占用可避免同帖出现两条评论；
 *    若确认不会重复评论，可置 false 以不占名额（配合人工订正流程）。
 */
export async function countDevicePostComments(
  deviceId: string,
  postId: string,
  includeUnknown: boolean,
): Promise<number> {
  const sql = db()
  const { start, end } = localDayRange()
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM tasks
    WHERE device_id = ${deviceId} AND post_id = ${postId}
      AND (
        status IN ('succeeded', 'dispatched', 'executing')
        OR (${includeUnknown} AND status = 'unknown')
      )
      AND dispatched_at >= ${start} AND dispatched_at < ${end}
  `) as unknown as { n: number }[]
  return rows[0]?.n ?? 0
}

/** 超期未回执的任务（后台判定 unknown，禁止自动重试） */
export async function findOverdueTasks(limit = 50): Promise<TaskRow[]> {
  const sql = db()
  return (await sql`
    SELECT * FROM tasks
    WHERE status IN ('dispatched', 'executing') AND deadline_at < NOW()
    ORDER BY deadline_at ASC
    LIMIT ${limit}
  `) as unknown as TaskRow[]
}

/** 任务列表（看板用） */
export async function listTasks(limit = 100): Promise<TaskRow[]> {
  const sql = db()
  return (await sql`
    SELECT * FROM tasks ORDER BY dispatched_at DESC LIMIT ${limit}
  `) as unknown as TaskRow[]
}
