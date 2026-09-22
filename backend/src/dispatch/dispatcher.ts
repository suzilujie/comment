/**
 * 派单求解与派发（设计文档 §5.1「约束驱动的即时派单」）。
 *
 * 关键点：
 *  - **不预先排程**：任务在派发那一刻创建，拿到即执行，没有 plannedAt；
 *  - **设备只猜时机，后台做裁决**：设备调用领取接口，后台按 20 条约束求解；
 *  - 未派单时返回原因码与建议重试秒数（设备按此退避，避免高频空问）。
 */
import { config } from '../config.js'
import { createLogger } from '../logger.js'
import { addMinutes, nowMs } from '../datetime.js'
import { randomInt } from '../random.js'
import { db } from '../db_pg.js'
import { getDevice } from '../device/device_store.js'
import {
  createTask,
  findInFlightByAccount,
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
  checkAccount,
  checkAccountPostOnce,
  checkDevice,
  checkGlobalDensity,
  checkMaterialAvailable,
  checkPostPacing,
  checkPostQuota,
  checkTimeWindow,
  getAccount,
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

  if (!device.account_id) {
    log.info(`dispatch reject device=${deviceId} stage=account_bind reason=account_id_empty`)
    return { task: null, reason: NO_DISPATCH_REASONS.ACCOUNT_NOT_ELIGIBLE, retryAfterSeconds: 600 }
  }

  // ── 第 1、2、3、5、6 条：账号侧 ──
  const account = await getAccount(device.account_id)
  if (!account) {
    log.info(
      `dispatch reject device=${deviceId} account=${device.account_id} stage=account reason=account_not_found`,
    )
    return { task: null, reason: NO_DISPATCH_REASONS.ACCOUNT_NOT_ELIGIBLE, retryAfterSeconds: 600 }
  }
  const accCheck = await checkAccount(account)
  if (!accCheck.pass) {
    log.info(
      `dispatch reject device=${deviceId} account=${account.id} stage=account ` +
        `reason=${accCheck.reason} retry=${accCheck.retryAfterSeconds ?? 300}s`,
    )
    return {
      task: null,
      reason: accCheck.reason,
      retryAfterSeconds: accCheck.retryAfterSeconds ?? 300,
    }
  }
  const inflight = await findInFlightByAccount(account.id)
  if (inflight) {
    log.info(`dispatch reject device=${deviceId} account=${account.id} stage=account_inflight reason=busy`)
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

    const once = await checkAccountPostOnce(account.id, post.id)
    if (!once.pass) { skip(`account_post_once:${once.reason}`); continue }

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
      accountId: account.id,
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
      UPDATE accounts SET daily_done = daily_done + 1, updated_at = NOW()
      WHERE id = ${account.id}
    `
    await markMaterialUsed(post.id, [`script:${script.id}`, ...(image ? [`image:${image.hash}`] : [])], task.id)
    await recordDispatch(device.id, city)

    const pkg = await toTaskPackage(task.id)
    const done = await countTodayDone(account.id)
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

/** 组装任务包（设备端契约，见 §4.1） */
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
    accountId: task.account_id,
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

/** 账号当前是否"可以接单"（仅用于心跳里的提示，不做最终裁决） */
export async function eligibleForTask(accountId: string | null): Promise<boolean> {
  if (!accountId) return false
  const account = await getAccount(accountId)
  if (!account || account.status !== 'active' || account.fail_streak >= 3) return false
  const next = account.next_eligible_at ? new Date(account.next_eligible_at).getTime() : null
  if (next !== null && nowMs() < next) return false
  const done = await countTodayDone(accountId)
  return done < config.dispatch.dailyQuotaPerAccount
}

/** 计算该账号的下次可派单时间（供看板与诊断） */
export async function nextEligibleAt(accountId: string): Promise<Date | null> {
  const account = await getAccount(accountId)
  const next = account?.next_eligible_at ? new Date(account.next_eligible_at) : null
  if (next) return next
  return addMinutes(nowMs(), randomInt(config.dispatch.intervalMinMinutes, config.dispatch.intervalMaxMinutes))
}

/** 未派单结果构造（便于单测与调试） */
export function noDispatch(reason: string, retryAfterSeconds = 300): DispatchResult {
  return { ok: false, reason }
}
