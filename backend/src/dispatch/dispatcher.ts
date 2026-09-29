/**
 * 派单求解与派发（设计文档 §5.1「约束驱动的即时派单」）。
 *
 * 关键点：
 *  - **不预先排程**：任务在派发那一刻创建，拿到即执行，没有 plannedAt；
 *  - **设备只猜时机，后台做裁决**：设备调用领取接口，后台按 20 条约束求解；
 *  - 未派单时返回原因码与建议重试秒数（设备按此退避，避免高频空问）。
 *
 * 2026-09-26：账号实体移除，配额与节奏下沉到设备维度（一机一号，语义等价）。
 */
import { config } from '../config.js'
import { createLogger } from '../logger.js'
import { addMinutes, localDateKey, nowMs, parseMs } from '../datetime.js'
import { randomInt } from '../random.js'
import { db } from '../db_pg.js'
import type { DeviceRow } from '../device/device_store.js'
import { getDevice } from '../device/device_store.js'
import {
  createTask,
  findInFlightByDevice,
  finishTask,
  getTask,
  newTaskId,
} from '../task/task_store.js'
import {
  diagnoseNoCandidate,
  findDispatchablePost,
  getPost,
} from '../post/post_store.js'
import type { DispatchResult } from '../types.js'
import { NO_DISPATCH_REASONS } from '../types.js'
import type { TaskPackage } from '../contracts/platform.js'
import {
  checkDevice,
  checkGlobalDensity,
  checkQuota,
  checkTimeWindow,
  recordDispatch,
} from './constraints.js'

const log = createLogger('dispatch')

export interface DispatchOutcome {
  task: TaskPackage | null
  reason?: string
  retryAfterSeconds?: number
}

/**
 * 主入口：尝试为设备派发一条任务。
 *
 * @param claimedCity 领取请求里带的「当下属地」（设备刚探测、已归一化）。优先于库值。
 */
export async function dispatchTo(
  deviceId: string,
  claimedCity?: string,
): Promise<DispatchOutcome> {
  const device = await getDevice(deviceId)
  if (!device) {
    return { task: null, reason: NO_DISPATCH_REASONS.DEVICE_NOT_FOUND, retryAfterSeconds: 600 }
  }

  // ── 第 7-11 条：设备可用性 ──
  const devCheck = await checkDevice(device)
  if (!devCheck.pass) {
    log.info(`dispatch reject device=${deviceId} stage=device reason=${devCheck.reason}`)
    return { task: null, reason: devCheck.reason, retryAfterSeconds: 60 }
  }

  // ── 配额与节奏（原账号组 1/2/3/5，现设备维度）──
  const quotaCheck = await checkQuota(device)
  if (!quotaCheck.pass) {
    log.info(
      `dispatch reject device=${deviceId} stage=quota reason=${quotaCheck.reason} ` +
        `retry=${quotaCheck.retryAfterSeconds ?? 300}s`,
    )
    return {
      task: null,
      reason: quotaCheck.reason,
      retryAfterSeconds: quotaCheck.retryAfterSeconds ?? 300,
    }
  }

  // 第 6 条：在途唯一（一台设备同时只允许 1 条）
  const inflight = await findInFlightByDevice(device.id)
  if (inflight) {
    log.info(`dispatch reject device=${deviceId} stage=inflight reason=busy`)
    return { task: null, reason: NO_DISPATCH_REASONS.DEVICE_BUSY, retryAfterSeconds: 60 }
  }

  // ── 第 17 条：投放时段窗口 ──
  const winCheck = checkTimeWindow()
  if (!winCheck.pass) {
    log.info(`dispatch reject device=${deviceId} stage=time_window reason=${winCheck.reason}`)
    return { task: null, reason: winCheck.reason, retryAfterSeconds: 900 }
  }

  // ── 第 19 条：全局派单密度 ──
  const densityCheck = await checkGlobalDensity()
  if (!densityCheck.pass) {
    log.info(`dispatch reject device=${deviceId} stage=global_density reason=${densityCheck.reason}`)
    return { task: null, reason: densityCheck.reason, retryAfterSeconds: 120 }
  }

  // ── 第 9 条：属地匹配（设备当前出口城市 == 帖子城市）──
  // 优先用**领取请求里带的属地**（设备刚探测过，最新），回退 devices.last_ip_city
  // （心跳最多滞后 30 秒）。两者不一致本身就是值得留痕的信号：说明发生了「被动换 IP」
  // 或心跳滞后 —— 这正是过去导致 ip_mismatch 白跑的那种情形。
  const storedCity = device.last_ip_city
  const city = claimedCity && claimedCity !== 'unknown' ? claimedCity : storedCity
  if (claimedCity && storedCity && claimedCity !== storedCity) {
    log.info(
      `dispatch city override device=${deviceId} stored=${storedCity} claimed=${claimedCity}`,
    )
  }
  if (!city) {
    log.info(`dispatch reject device=${deviceId} stage=city reason=no_last_ip_city`)
    return { task: null, reason: NO_DISPATCH_REASONS.NO_POST_IN_CITY, retryAfterSeconds: 300 }
  }
  // ── 12-16 + 第 4 条：**一次查询**求出可派发候选 ──
  // ⚠ 原实现是「取 20 个候选帖，再逐个执行 6~9 条检查」—— 单次 claim 最坏约 198 条
  //    串行 SQL。200 台并发领取时会把连接池排空、按串行化放大长尾，心跳跟着排队。
  //    现在全部约束（帖余量 / 单帖节奏 / 同设备同帖冷却 / 素材可用 / 图文配比）
  //    下推到一条 SQL，见 post_store.findDispatchablePost。
  const candidate = await findDispatchablePost(
    device.id,
    city,
    config.dispatch.unknownOccupiesPostSlot,
  )
  if (!candidate) {
    // ⚠ 不再一律回 no_post_available：这个原因码把两种性质完全不同的事混在一起 ——
    //    「这个省暂时没活」（无需处理）与「帖可派但**选不出素材**」（必须人工补素材）。
    //    后者若只回一个 no_post_available，运维完全看不出要去补素材。这里做一次归因。
    const why = await diagnoseNoCandidate(
      device.id,
      city,
      config.dispatch.unknownOccupiesPostSlot,
    )
    if (why.blockedByMaterial > 0) {
      log.warn(
        `dispatch BLOCKED BY MISSING MATERIAL device=${deviceId} city=${city} ` +
          `blocked=${why.blockedByMaterial}/${why.postsInCity} —— 这些帖子可派但选不出素材：` +
          `话术已用尽，或图文帖没有可用图片。请到「帖子池 / 素材」补话术或图片。`,
      )
      return { task: null, reason: NO_DISPATCH_REASONS.NO_MATERIAL, retryAfterSeconds: 600 }
    }
    if (why.postsInCity > 0) {
      log.info(
        `dispatch reject device=${deviceId} city=${city} stage=candidate ` +
          `reason=no_post_available 候选帖=${why.postsInCity}（均受单帖节奏/配比等约束，稍后重试）`,
      )
    } else {
      log.info(
        `dispatch reject device=${deviceId} city=${city} stage=candidate reason=no_post_available`,
      )
    }
    return { task: null, reason: NO_DISPATCH_REASONS.NO_POST_AVAILABLE, retryAfterSeconds: 300 }
  }
  const commentType: 'text' | 'image' = candidate.need_image ? 'image' : 'text'
  const sql = db()

  // ── 原子占位：帖子名额 ──
  // 替代原来的「先 checkPostQuota 读、再插任务」这种 check-then-act。
  // 200 台抢同一热帖时，那个窗口必然导致超发 target_count；
  // 「检查 + 自增」合成一条条件 UPDATE 后，抢不到就是 0 行（并发安全）。
  const claimedPost = (await sql`
    UPDATE posts SET committed = committed + 1, updated_at = NOW()
    WHERE id = ${candidate.id} AND committed < target_count
    RETURNING committed
  `) as unknown as { committed: number }[]
  if (claimedPost.length === 0) {
    log.info(`dispatch race device=${deviceId} post=${candidate.id} reason=post_full`)
    return { task: null, reason: NO_DISPATCH_REASONS.NO_POST_AVAILABLE, retryAfterSeconds: 30 }
  }

  // ── 原子扣减：当日配额 ──
  // 同理：`checkQuota` 的读与这里的写之间隔着十几次 await，并发下会超发。
  const claimedQuota = (await sql`
    UPDATE devices SET daily_done = daily_done + 1, updated_at = NOW()
    WHERE id = ${device.id} AND daily_done < ${config.dispatch.dailyQuotaPerDevice}
    RETURNING daily_done
  `) as unknown as { daily_done: number }[]
  if (claimedQuota.length === 0) {
    // 配额在 checkQuota 之后被并发用完 → 回滚刚占的帖子名额
    await sql`UPDATE posts SET committed = GREATEST(committed - 1, 0) WHERE id = ${candidate.id}`
    log.info(`dispatch race device=${deviceId} reason=daily_quota`)
    return { task: null, reason: NO_DISPATCH_REASONS.ACCOUNT_DAILY_QUOTA, retryAfterSeconds: 1800 }
  }

  // ── 原子占位：素材（话术 + 图片）──
  // ⚠ 必须在这里「抢」，不能等建任务之后再 `ON CONFLICT DO NOTHING` 登记。
  //    `findDispatchablePost` 只是**读**到一句未被占用的话术，而读与登记之间隔着十几次
  //    await —— 两台设备并发 claim 同一个帖子时会**都读到同一句**，各自建出任务；
  //    登记时第二台静默失败（DO NOTHING），但话术已经跟着任务发出去了
  //    → 同一个帖子下面出现两条一模一样的话术，正是这条约束要防的事。
  //    改用 `INSERT ... ON CONFLICT DO NOTHING RETURNING`：**插入成功才算抢到**，
  //    与 `posts.committed` 的条件 UPDATE 同一套路。
  // ⚠ 先给任务生成 ID，**再**抢素材：素材占位行要带着 task_id 一起落库。
  //    早期是「占位（task_id=NULL）→ 建任务 → 回填 task_id」，进程若恰好死在"建任务"与
  //    "回填"之间，那些素材行的 task_id 永远是 NULL —— 于是任务失败时按 task_id 回收
  //    （task_store.finishTask 的 `DELETE ... WHERE task_id = ?`）**一行都删不掉**，
  //    素材被永久吃掉：该帖可用话术越来越少，最后静默地再也派不出去。
  const taskId = newTaskId()

  const refs = [`script:${candidate.script_id}`]
  if (commentType === 'image' && candidate.image_hash) refs.push(`image:${candidate.image_hash}`)

  const claimedRefs: string[] = []
  /** 回滚本次已占的「帖子名额 / 当日配额 / 素材占位」（任一环节失败时调用） */
  const rollbackClaims = async (): Promise<void> => {
    await sql`UPDATE posts SET committed = GREATEST(committed - 1, 0) WHERE id = ${candidate.id}`
    await sql`UPDATE devices SET daily_done = GREATEST(daily_done - 1, 0) WHERE id = ${device.id}`
    if (claimedRefs.length > 0) {
      await sql`
        DELETE FROM post_material_usage
        WHERE post_id = ${candidate.id} AND material_ref IN ${sql(claimedRefs)}
      `
    }
  }

  for (const ref of refs) {
    const got = (await sql`
      INSERT INTO post_material_usage (post_id, material_ref, task_id)
      VALUES (${candidate.id}, ${ref}, ${taskId})
      ON CONFLICT (post_id, material_ref) DO NOTHING
      RETURNING material_ref
    `) as unknown as { material_ref: string }[]
    if (got.length === 0) {
      // 素材被并发的另一台设备抢走 → 回滚并让设备稍后重试（下一轮会挑到别的素材）
      await rollbackClaims()
      log.info(
        `dispatch race device=${deviceId} post=${candidate.id} reason=material_taken ref=${ref}`,
      )
      return { task: null, reason: NO_DISPATCH_REASONS.NO_MATERIAL, retryAfterSeconds: 15 }
    }
    claimedRefs.push(ref)
  }

  // ── 建任务（ID 已在抢素材之前生成，素材占位行已带上它）──
  try {
    await createTask({
      id: taskId,
      deviceId: device.id,
      postId: candidate.id,
      scriptId: candidate.script_id,
      scriptText: candidate.script_text,
      commentType,
      imageHash: candidate.image_hash ?? undefined,
      imagePath: candidate.image_path ?? undefined,
      dispatchIpCity: city,
    })
  } catch (e) {
    // 部分唯一索引 `uq_tasks_device_inflight` 兜住「一台设备两条在途任务」的并发窗口：
    // 命中唯一冲突说明本设备已经拿到别的任务了 —— 回滚帖子名额、当日配额与素材占位。
    await rollbackClaims()
    log.warn(
      `dispatch create-failed device=${deviceId} post=${candidate.id} err=${(e as Error).message} ` +
        `（已回滚帖子名额、当日配额与素材占位）`,
    )
    return { task: null, reason: NO_DISPATCH_REASONS.DEVICE_BUSY, retryAfterSeconds: 60 }
  }

  // 素材占位行在抢占时就已写入 task_id（见上面的说明），这里不再需要回填
  await recordDispatch(device.id, city)

  const pkg = await toTaskPackage(taskId)
  if (!pkg) {
    // 任务已落库、但任务包组装不出来（例如帖子刚被删掉）→ 必须**显式终结**它：
    // 否则它会一直挂在 dispatched，占着帖子名额与设备当日配额整整一个回执超时周期
    // （15 分钟），期间该帖少一个名额、该设备少一次配额，而日志只有一行 error。
    // 早期这里既不回滚也不终结，直接把上面刚占的占位漏在了那里。
    log.error(`dispatch taskPackage null task=${taskId} → 立即中止该任务并释放占位`)
    await finishTask(taskId, 'aborted', {
      actor: 'platform',
      reasonCode: 'task_package_unavailable',
      evidence: 'toTaskPackage returned null',
    })
    return { task: null, reason: NO_DISPATCH_REASONS.NO_POST_AVAILABLE, retryAfterSeconds: 60 }
  }
  log.info(
    `dispatched task=${taskId} device=${device.id} post=${candidate.id} city=${city} ` +
      `type=${commentType} today=${claimedQuota[0]?.daily_done ?? '-'}/${config.dispatch.dailyQuotaPerDevice}`,
  )
  return { task: pkg }
}

/** 组装任务包（设备端契约，见 §4.1；2026-09-26 起不含 accountId） */
export async function toTaskPackage(taskId: string): Promise<TaskPackage | null> {
  const task = await getTask(taskId)
  if (!task) return null
  const post = await getPost(task.post_id)
  if (!post) return null

  const actions: TaskPackage['actions'] = ['browse', 'like', 'favorite', 'comment']
  // 素材 URL 必须是**可下载的路径**（由 main.ts 的 serveStatic 提供），
  // 不能是服务端本地目录名（设备端无法解析本地路径）
  const imageUrl =
    task.comment_type === 'image' && task.image_hash
      ? `/materials/${task.image_hash}`
      : undefined

  return {
    taskId: task.id,
    postId: post.id,
    postUrl: post.url,
    actions,
    commentType: task.comment_type ?? 'text',
    scriptText: task.script_text ?? '',
    scriptId: task.script_id ?? undefined,
    image:
      task.comment_type === 'image' && imageUrl
        ? { hash: task.image_hash ?? '', url: imageUrl }
        : undefined,
    deadlineAt: new Date(task.deadline_at).toISOString(),
    ipCityTarget: task.dispatch_ip_city ?? post.city,
  }
}

/**
 * 该设备当前是否"可以接单"（仅用于心跳里的提示，不做最终裁决）。
 *
 * ⚠ 接受**已取到的 device 行**而不是 deviceId：早期这里又 `getDevice` 一次，
 * 加上 guard 与 applyHeartbeat 的读取，同一设备一次心跳被读 **3 次** devices。
 * 同时把「今日已用额度」从 `countTodayDone`（全表聚合）改为直接读 `daily_done` 列 ——
 * 口径还与 `checkQuota` 一致了（原来一个是"成功数"、一个是"派发数"）。
 */
export function eligibleForTask(device: DeviceRow | null): boolean {
  if (!device) return false
  if (device.admin_state !== 'enabled' || device.fail_streak >= 3) return false
  const next = parseMs(device.next_eligible_at)
  if (next !== null && nowMs() < next) return false
  const today = localDateKey()
  const raw = device.daily_done_date
  const doneDate = raw === null || raw === undefined
    ? null
    : typeof raw === 'string' ? raw.slice(0, 10) : new Date(raw as unknown as string).toISOString().slice(0, 10)
  const done = doneDate === today ? device.daily_done : 0
  return done < config.dispatch.dailyQuotaPerDevice
}

/** 计算该设备的下次可派单时间（供看板与诊断） */
export async function nextEligibleAt(deviceId: string): Promise<Date | null> {
  const d = await getDevice(deviceId)
  const next = d?.next_eligible_at ? new Date(d.next_eligible_at) : null
  if (next) return next
  return addMinutes(nowMs(), randomInt(config.dispatch.intervalMinMinutes, config.dispatch.intervalMaxMinutes))
}

/** 未派单结果构造（便于单测与调试） */
export function noDispatch(reason: string, retryAfterSeconds = 300): DispatchResult {
  return { ok: false, reason }
}
