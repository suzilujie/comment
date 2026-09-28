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
import { getDevice } from '../device/device_store.js'
import {
  createTask,
  findInFlightByDevice,
  countTodayDone,
  getTask,
} from '../task/task_store.js'
import {
  findDispatchablePost,
  getPost,
  markMaterialUsed,
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

/** 主入口：尝试为设备派发一条任务 */
export async function dispatchTo(deviceId: string): Promise<DispatchOutcome> {
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
  const city = device.last_ip_city
  if (!city) {
    log.info(`dispatch reject device=${deviceId} stage=city reason=no_last_ip_city`)
    return { task: null, reason: NO_DISPATCH_REASONS.NO_POST_IN_CITY, retryAfterSeconds: 300 }
  }
  // ── 12-16 + 第 4 条：**一次查询**求出可派发候选 ──
  // ⚠ 原实现是「取 20 个候选帖，再逐个执行 6~9 条检查」—— 单次 claim 最坏约 198 条
  //    串行 SQL。200 台并发领取时会把连接池排空、按串行化放大长尾，心跳跟着排队。
  //    现在全部约束（帖余量 / 单帖节奏 / 同设备同帖当日 / 素材可用 / 图文配比）
  //    下推到一条 SQL，见 post_store.findDispatchablePost。
  const candidate = await findDispatchablePost(
    device.id,
    city,
    localDateKey(),
    config.dispatch.unknownOccupiesPostSlot,
  )
  if (!candidate) {
    log.info(`dispatch reject device=${deviceId} city=${city} stage=candidate reason=no_post_available`)
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
    WHERE id = ${device.id} AND daily_done < ${config.dispatch.dailyQuotaPerAccount}
    RETURNING daily_done
  `) as unknown as { daily_done: number }[]
  if (claimedQuota.length === 0) {
    // 配额在 checkQuota 之后被并发用完 → 回滚刚占的帖子名额
    await sql`UPDATE posts SET committed = GREATEST(committed - 1, 0) WHERE id = ${candidate.id}`
    log.info(`dispatch race device=${deviceId} reason=daily_quota`)
    return { task: null, reason: NO_DISPATCH_REASONS.ACCOUNT_DAILY_QUOTA, retryAfterSeconds: 1800 }
  }

  // ── 建任务 ──
  let taskId: string
  try {
    const task = await createTask({
      deviceId: device.id,
      postId: candidate.id,
      scriptId: candidate.script_id,
      scriptText: candidate.script_text,
      commentType,
      imageHash: candidate.image_hash ?? undefined,
      imagePath: candidate.image_path ?? undefined,
      dispatchIpCity: city,
    })
    taskId = task.id
  } catch (e) {
    // 部分唯一索引 `uq_tasks_device_inflight` 兜住「一台设备两条在途任务」的并发窗口：
    // 命中唯一冲突说明本设备已经拿到别的任务了 —— 回滚刚占的配额与帖子名额。
    await sql`UPDATE posts SET committed = GREATEST(committed - 1, 0) WHERE id = ${candidate.id}`
    await sql`UPDATE devices SET daily_done = GREATEST(daily_done - 1, 0) WHERE id = ${device.id}`
    log.warn(
      `dispatch create-failed device=${deviceId} post=${candidate.id} err=${(e as Error).message} ` +
        `（已回滚配额与帖子名额）`,
    )
    return { task: null, reason: NO_DISPATCH_REASONS.DEVICE_BUSY, retryAfterSeconds: 60 }
  }

  const refs = [`script:${candidate.script_id}`]
  if (commentType === 'image' && candidate.image_hash) refs.push(`image:${candidate.image_hash}`)
  await markMaterialUsed(candidate.id, refs, taskId)
  await recordDispatch(device.id, city)

  const pkg = await toTaskPackage(taskId)
  if (!pkg) {
    // 原来这里不判空就返回 `{ task: pkg }`，会让设备收到 null 任务包而超时转 unknown，
    // 同时配额与素材已被占用 —— 现在显式失败，让设备稍后重试。
    log.error(`dispatch taskPackage null task=${taskId}`)
    return { task: null, reason: NO_DISPATCH_REASONS.NO_POST_AVAILABLE, retryAfterSeconds: 60 }
  }
  log.info(
    `dispatched task=${taskId} device=${device.id} post=${candidate.id} city=${city} ` +
      `type=${commentType} today=${claimedQuota[0]?.daily_done ?? '-'}/${config.dispatch.dailyQuotaPerAccount}`,
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

/** 该设备当前是否"可以接单"（仅用于心跳里的提示，不做最终裁决） */
export async function eligibleForTask(deviceId: string | null): Promise<boolean> {
  if (!deviceId) return false
  const d = await getDevice(deviceId)
  if (!d || d.admin_state !== 'enabled' || d.fail_streak >= 3) return false
  const next = parseMs(d.next_eligible_at)
  if (next !== null && nowMs() < next) return false
  const done = await countTodayDone(deviceId)
  return done < config.dispatch.dailyQuotaPerAccount
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
