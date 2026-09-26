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
import { addMinutes, nowMs, parseMs } from '../datetime.js'
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
  decideCommentType,
  getPost,
  listCandidatePosts,
  markMaterialUsed,
  pickUnusedImage,
  pickUnusedScript,
} from '../post/post_store.js'
import type { DispatchResult } from '../types.js'
import { NO_DISPATCH_REASONS } from '../types.js'
import type { TaskPackage } from '../contracts/platform.js'
import {
  checkDevice,
  checkDevicePostOnce,
  checkGlobalDensity,
  checkMaterialAvailable,
  checkPostPacing,
  checkPostQuota,
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
  const candidates = await listCandidatePosts(city)
  if (candidates.length === 0) {
    log.info(`dispatch reject device=${deviceId} city=${city} stage=city reason=no_candidate_posts`)
    return { task: null, reason: NO_DISPATCH_REASONS.NO_POST_IN_CITY, retryAfterSeconds: 600 }
  }
  log.info(`dispatch device=${deviceId} city=${city} candidates=${candidates.length}`)

  // ── 逐候选帖求解（12-16 + 第 4 条）──
  for (const post of candidates) {
    const skip = (why: string) => log.info(`dispatch skip device=${deviceId} post=${post.id} reason=${why}`)

    const once = await checkDevicePostOnce(device.id, post.id)
    if (!once.pass) { skip(`device_post_once:${once.reason}`); continue }

    const quota = await checkPostQuota(post.id)
    if (!quota.pass) { skip(`post_quota:${quota.reason}`); continue }

    const pacing = await checkPostPacing(post.id)
    if (!pacing.pass) { skip('post_pacing'); continue }

    const commentType = await decideCommentType(post.id, post.post_type === 'image')
    const needImage = commentType === 'image'
    const material = await checkMaterialAvailable(post.id, needImage)
    if (!material.pass) { skip(`material:${material.reason}`); continue }

    const script = await pickUnusedScript(post.id)
    if (!script) { skip('no_unused_script'); continue }
    const image = needImage ? await pickUnusedImage(post.id) : null
    if (needImage && !image) { skip('no_unused_image'); continue }

    // ── 派发：创建任务 + 扣配额 + 记录素材占用 + 记录密度 ──
    const task = await createTask({
      deviceId: device.id,
      postId: post.id,
      scriptId: script.id,
      scriptText: script.text,
      commentType,
      imageHash: image?.hash,
      imagePath: image?.path,
      dispatchIpCity: city,
    })

    // 扣减当日配额（在派单时扣，避免并发超额）
    const sql = db()
    await sql`
      UPDATE devices SET daily_done = daily_done + 1, updated_at = NOW()
      WHERE id = ${device.id}
    `
    await markMaterialUsed(post.id, [`script:${script.id}`, ...(image ? [`image:${image.hash}`] : [])], task.id)
    await recordDispatch(device.id, city)

    const pkg = await toTaskPackage(task.id)
    const done = await countTodayDone(device.id)
    log.info(
      `dispatched task=${task.id} device=${device.id} post=${post.id} city=${city} ` +
        `type=${commentType} today=${done}/${config.dispatch.dailyQuotaPerAccount}`,
    )
    return { task: pkg }
  }

  log.info(
    `dispatch reject device=${deviceId} city=${city} stage=post_loop reason=no_post_available ` +
      `candidates=${candidates.length}`,
  )
  return { task: null, reason: NO_DISPATCH_REASONS.NO_POST_AVAILABLE, retryAfterSeconds: 300 }
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
