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
// 回执超时 / 完成间隔读 `settings`（运行时生效值），见 settings_store 的优先级说明
import { settings } from '../settings/settings_store.js'
// 注：`countTodayDone` / `countDevicePostComments` 已删除（2026-09-29）。
// 它们是"把约束下推到一条 SQL"（findDispatchablePost）之前的旧实现，全仓无调用方，
// 却各自带着**与派单口径不一致**的写法（一个算"成功数"、一个写死"永久一次"）。
// 留着它们的唯一效果是诱导后来者照着改 —— 而它们改不动任何线上行为。
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
  /** 可选：由调用方预先给定。派单流程**必须**预先生成（见 dispatcher.dispatchTo 的说明） */
  id?: string
  deviceId: string
  postId: string
  scriptId: string
  scriptText: string
  commentType: 'text' | 'image'
  imageHash?: string
  imagePath?: string
  dispatchIpCity: string
}

/**
 * 预生成任务 ID。
 *
 * 派单需要在**抢素材占位**时就把 `task_id` 写进 `post_material_usage` —— 否则只能先占位
 * （task_id 为 NULL）、建任务后再回填，那个窗口里崩溃会让素材行永远没有 task_id，
 * 任务失败时按 task_id 回收就删不到任何行（详见 dispatcher.dispatchTo）。
 */
export function newTaskId(): string {
  return makeId('task')
}

/** 创建任务（派发那一刻创建；后台写入 dispatched） */
export async function createTask(input: CreateTaskInput): Promise<TaskRow> {
  const sql = db()
  const id = input.id ?? makeId('task')
  const deadline = addMinutes(nowMs(), settings.dispatch.receiptTimeoutMinutes)

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
 * 真正终结的状态（**不包含 unknown**）。
 *
 * unknown 是"暂时无法判断"，它还占着帖子名额与配额，等人工订正 —— 所以它**不是终态**：
 * 设备补上来的迟到回执（"其实我压根没点发送"）应当能把未知收敛成确定结论。
 */
const TERMINAL_STATUSES: readonly TaskStatus[] = ['succeeded', 'failed', 'aborted']

/**
 * 任务终态（设备回执或后台超时判定）。
 * - succeeded：计入配额消耗，刷新 next_eligible_at
 * - failed / aborted（确认未发出）：退还配额
 * - unknown：不退还（可能已发出），转人工确认
 *
 * ⚠ 状态迁移与记账必须**原子**。早期实现是「`getTask` 读 status → 判断 → `UPDATE ... WHERE id`」，
 *   而读与写之间隔着 await，UPDATE 又没有任何状态条件。于是同一任务的两个终结请求
 *   （设备回执 + 管理员订正，或两条重复回执）可以**同时**读到 `unknown`、**同时**通过判断，
 *   然后各扣一次 `posts.committed`、各加一次设备计数 —— 帖子容量被凭空放大，
 *   后续该帖会超出 target_count 继续派单。
 *   现在把条件写进 UPDATE 的 WHERE：只有一个请求能真正改到行，另一个拿到 0 行、不做任何记账。
 */
export async function finishTask(
  taskId: string,
  status: Extract<TaskStatus, 'succeeded' | 'failed' | 'aborted' | 'unknown'>,
  opts: { reasonCode?: string; evidence?: string; actor?: Actor; detail?: unknown } = {},
): Promise<TaskRow | null> {
  const sql = db()
  const task = await getTask(taskId)
  if (!task) return null

  const prev = task.status
  if (TERMINAL_STATUSES.includes(prev)) {
    log.warn(`task ${taskId} already terminal (${prev}), ignore ${status}`)
    return task
  }
  // 同态重复上报（超时扫描又跑了一轮、设备重发同一条回执）→ 直接忽略，否则计数会重复累加
  if (prev === status) {
    log.warn(`task ${taskId} already ${status}, ignore duplicate`)
    return task
  }

  const actor: Actor = opts.actor ?? (status === 'unknown' ? 'platform' : 'device')
  const updated = (await sql`
    UPDATE tasks SET
      status = ${status},
      reason_code = ${opts.reasonCode ?? null},
      evidence = ${opts.evidence ?? null},
      finished_at = NOW()
    WHERE id = ${taskId} AND status = ${prev}
    RETURNING id
  `) as unknown as { id: string }[]
  if (updated.length === 0) {
    // 被并发请求抢先终结：本次不记账，直接回读最新状态
    log.warn(`task ${taskId} 状态已被并发改写（期望 ${prev}），忽略本次 ${status}，不重复记账`)
    return getTask(taskId)
  }
  await appendEvent(taskId, status, actor, opts.reasonCode, opts.detail)

  // 从 unknown 收敛到确定结论时，要把当初记的那次 total_unknown 收回来 ——
  // 否则计数器只增不减，看板上的"待人工确认"会永远停在历史峰值。
  const fromUnknown = prev === 'unknown'
  const unknownDelta = fromUnknown ? 1 : 0

  // ── 设备侧记账（2026-09-26 起由账号维度改为设备维度）──
  const finishedAt = nowMs()
  if (task.device_id) {
    if (status === 'succeeded') {
      await sql`
        UPDATE devices SET
          total_success = total_success + 1,
          total_unknown = GREATEST(total_unknown - ${unknownDelta}, 0),
          fail_streak = 0,
          next_eligible_at = ${new Date(finishedAt + randomInt(
            settings.dispatch.intervalMinMinutes,
            settings.dispatch.intervalMaxMinutes,
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
          total_unknown = GREATEST(total_unknown - ${unknownDelta}, 0),
          fail_streak = CASE WHEN ${accountFault} THEN fail_streak + 1 ELSE fail_streak END,
          total_fail = total_fail + 1,
          updated_at = NOW()
        WHERE id = ${task.device_id}
      `
      log.info(
        `task fail ${taskId} reason=${opts.reasonCode ?? '-'} accountFault=${accountFault}` +
          `${fromUnknown ? '（由 unknown 收敛而来）' : ''}`,
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
    // 同时释放本次占用的**素材**（话术 / 图片）。
    //
    // 派单时就把素材登记为"该帖已用"了，而这里如果不回收，一次失败（打不开抖音 /
    // 属地不符 / 网络异常 —— 评论根本没发出去）也会永久吃掉一句话术。
    // 后果：`findDispatchablePost` 要求"必须还有未使用的话术"，于是该帖会在
    // `committed < target_count` 的情况下**静默地再也派不出去**。
    //
    // ⚠ `unknown` 同样**不回收**：可能已发出，回收会导致同帖复用同一句话术。
    const freed = (await sql`
      DELETE FROM post_material_usage WHERE task_id = ${taskId} RETURNING material_ref
    `) as unknown as { material_ref: string }[]
    if (freed.length > 0) {
      log.info(
        `task fail ${taskId} → 释放素材 ${freed.map((f) => f.material_ref).join(', ')}（可被同帖重新选用）`,
      )
    }
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

/**
 * 对账：把 `posts.committed` / `devices.daily_done` 拉回与真实任务数一致。
 *
 * 为什么必须有它：派单是「先原子占位（committed+1、daily_done+1）→ 再建任务」的两步
 * **非事务**操作（见 `dispatcher.dispatchTo`，中间还夹着素材抢占与多次 await）。
 * 进程正好死在两步之间时，计数会**永久多 1**，而全仓没有任何地方会把它改回来 ——
 * 于是该帖提前显示"满员"、再也派不出去（表现为"候选帖为空"，运维完全看不出原因）。
 *
 * 幂等、可随时执行（启动时 + 每 5 分钟一轮；也可由管理台手动触发）。
 * 只修正计数偏差，不动任务状态本身。
 */
export async function reconcileCounters(): Promise<{ posts: number; devices: number }> {
  const sql = db()
  const today = localDateKey()

  const posts = (await sql`
    UPDATE posts p
    SET committed = (SELECT COUNT(*)::int FROM tasks t
                      WHERE t.post_id = p.id
                        AND t.status IN ('succeeded','dispatched','executing','unknown')),
        updated_at = NOW()
    WHERE p.committed <> (SELECT COUNT(*)::int FROM tasks t
                           WHERE t.post_id = p.id
                             AND t.status IN ('succeeded','dispatched','executing','unknown'))
    RETURNING p.id
  `) as unknown as { id: string }[]

  const devices = (await sql`
    UPDATE devices d
    SET daily_done = (SELECT COUNT(*)::int FROM tasks t
                       WHERE t.device_id = d.id
                         AND (t.dispatched_at AT TIME ZONE 'Asia/Shanghai')::date = ${today}::date
                         AND t.status IN ('succeeded','dispatched','executing','unknown')),
        updated_at = NOW()
    WHERE d.daily_done_date = ${today}::date
      AND d.daily_done <> (SELECT COUNT(*)::int FROM tasks t
                            WHERE t.device_id = d.id
                              AND (t.dispatched_at AT TIME ZONE 'Asia/Shanghai')::date = ${today}::date
                              AND t.status IN ('succeeded','dispatched','executing','unknown'))
    RETURNING d.id
  `) as unknown as { id: string }[]

  if (posts.length > 0 || devices.length > 0) {
    log.warn(
      `reconcile 修正 posts.committed ${posts.length} 条 / devices.daily_done ${devices.length} 条` +
        `（派单占位与建任务之间的崩溃会留下这种偏差）`,
    )
  }
  return { posts: posts.length, devices: devices.length }
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

/**
 * 任务列表（看板用；分页：limit + offset）。
 *
 * @param status 可选状态过滤。**必须服务端过滤** —— 管理台的「只看 unknown」原本是
 *   前端 `filter`，一旦加分页就只会过滤当前页，页码与总数全对不上（看起来像"数据丢了"）。
 * @param q 关键词：任务 ID / 帖子 ID / 设备 ID 模糊匹配（排查"这个帖子派了几条"、
 *   "这台设备最近干了什么"就靠它，不必再下去翻数据库）。
 */
export async function listTasks(
  limit = 100,
  offset = 0,
  status?: string,
  q?: string,
): Promise<TaskRow[]> {
  const sql = db()
  const st = status ?? null
  const like = q ? `%${q}%` : null
  return (await sql`
    SELECT * FROM tasks
    WHERE (${st}::text IS NULL OR status = ${st})
      AND (${like}::text IS NULL
           OR id ILIKE ${like} OR post_id ILIKE ${like} OR device_id ILIKE ${like})
    ORDER BY dispatched_at DESC LIMIT ${limit} OFFSET ${offset}
  `) as unknown as TaskRow[]
}

/** 任务总数（管理台分页用）；参数口径与 [listTasks] 完全一致 */
export async function countTasks(status?: string, q?: string): Promise<number> {
  const sql = db()
  const st = status ?? null
  const like = q ? `%${q}%` : null
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM tasks
    WHERE (${st}::text IS NULL OR status = ${st})
      AND (${like}::text IS NULL
           OR id ILIKE ${like} OR post_id ILIKE ${like} OR device_id ILIKE ${like})
  `) as unknown as { n: number }[]
  return rows[0]?.n ?? 0
}
