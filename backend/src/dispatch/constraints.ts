/**
 * 派单约束（设计文档 §5.1 的 20 条）。
 *
 * 分五组：账号(1-6) / 设备(7-11) / 帖子(12-16) / 时段(17-18) / 系统(19-20)。
 * 全部在「领取接口被调用时」求解；调用顺序为「先廉价后昂贵」：
 *   账号 + 设备 + 时段 + 密度（廉价，绝大多数请求在这里被挡掉）
 *   → 帖子与素材（需要多次查询）
 */
import { db } from '../db_pg.js'
import { config } from '../config.js'
import { inTimeWindow, localDateKey, localMinuteOfDay, nowMs, parseMs } from '../datetime.js'
import { createLogger } from '../logger.js'
import type { ConstraintCheck } from '../types.js'
import { NO_DISPATCH_REASONS } from '../types.js'
import type { DeviceRow } from '../device/device_store.js'
import { evaluateAvailability } from '../device/device_store.js'

const log = createLogger('constraint')

export interface AccountRow {
  id: string
  status: 'active' | 'paused' | 'banned'
  daily_done: number
  daily_done_date: string | null
  next_eligible_at: Date | null
  fail_streak: number
}

export async function getAccount(accountId: string): Promise<AccountRow | null> {
  const sql = db()
  const rows = (await sql`
    SELECT id, status, daily_done, daily_done_date, next_eligible_at, fail_streak
    FROM accounts WHERE id = ${accountId} LIMIT 1
  `) as unknown as AccountRow[]
  return rows[0] ?? null
}

/** 跨日重置日计数（按 UTC+8 自然日） */
export async function ensureDailyCounter(account: AccountRow): Promise<number> {
  const today = localDateKey()
  if (account.daily_done_date === today) return account.daily_done
  const sql = db()
  await sql`
    UPDATE accounts SET daily_done = 0, daily_done_date = ${today}::date, updated_at = NOW()
    WHERE id = ${account.id}
  `
  return 0
}

// ── 设备组（7-11）─────────────────────────────────────────────
/** 7-11：在线 / 健康（无障碍+前台服务+代理）/ 空闲 / 属地 / 版本达标 */
export async function checkDevice(device: DeviceRow): Promise<ConstraintCheck> {
  const avail = await evaluateAvailability(device)
  if (avail.dispatchable) return { pass: true }
  // 打印全部不可用原因（而非只取第一个），便于一眼定位是哪条健康度不达标
  log.info(`device ${device.id} unavailable reasons=[${avail.reasons.join(', ')}]`)
  const first = avail.reasons[0] ?? 'unknown'
  if (first === 'offline') return { pass: false, reason: NO_DISPATCH_REASONS.DEVICE_NOT_ONLINE }
  if (first === 'busy' || first === 'in_flight_task') {
    return { pass: false, reason: NO_DISPATCH_REASONS.DEVICE_BUSY }
  }
  if (first.startsWith('admin_state')) return { pass: false, reason: NO_DISPATCH_REASONS.DEVICE_PAUSED }
  return { pass: false, reason: NO_DISPATCH_REASONS.DEVICE_UNHEALTHY }
}

// ── 账号组（1-3、5、6）────────────────────────────────────────
/** 1、2、3、5、6：状态 / 日上限 / 完成间隔 / 健康度 / 在途唯一 */
export async function checkAccount(account: AccountRow): Promise<ConstraintCheck & { retryAfterSeconds?: number }> {
  if (account.status !== 'active') {
    return { pass: false, reason: NO_DISPATCH_REASONS.ACCOUNT_NOT_ELIGIBLE }
  }
  // 第 5 条：连续失败降额（连续 3 次后暂停派单，转人工）
  if (account.fail_streak >= 3) {
    return { pass: false, reason: NO_DISPATCH_REASONS.ACCOUNT_NOT_ELIGIBLE }
  }
  // 第 2 条：日上限
  const done = await ensureDailyCounter(account)
  if (done >= config.dispatch.dailyQuotaPerAccount) {
    return { pass: false, reason: NO_DISPATCH_REASONS.ACCOUNT_DAILY_QUOTA, retryAfterSeconds: 1800 }
  }
  // 第 3 条：与上次「完成」的间隔（服务端权威）
  const next = parseMs(account.next_eligible_at)
  if (next !== null && nowMs() < next) {
    return {
      pass: false,
      reason: NO_DISPATCH_REASONS.ACCOUNT_INTERVAL,
      retryAfterSeconds: Math.max(30, Math.ceil((next - nowMs()) / 1000)),
    }
  }
  return { pass: true }
}

/** 第 4 条：同账号 × 同帖（今日未评论过） */
export async function checkAccountPostOnce(
  accountId: string,
  postId: string,
): Promise<ConstraintCheck> {
  const sql = db()
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM tasks
    WHERE account_id = ${accountId} AND post_id = ${postId}
      AND status IN ('succeeded', 'dispatched', 'executing', 'unknown')
      AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date = ${localDateKey()}::date
  `) as unknown as { n: number }[]
  return (rows[0]?.n ?? 0) === 0
    ? { pass: true }
    : { pass: false, reason: 'account_post_already_commented' }
}

// ── 时段组（17-18）───────────────────────────────────────────
/** 17：投放时段窗口（深夜发评论是极明显的异常特征） */
export function checkTimeWindow(): ConstraintCheck {
  const minute = localMinuteOfDay()
  const ok = inTimeWindow(minute, config.dispatch.windowStartMinute, config.dispatch.windowEndMinute)
  return ok ? { pass: true } : { pass: false, reason: NO_DISPATCH_REASONS.OUTSIDE_TIME_WINDOW }
}

// ── 系统组（19-20）───────────────────────────────────────────
/** 19：全局派单密度（滑动窗口计数，防止多设备同时扎堆执行） */
export async function checkGlobalDensity(): Promise<ConstraintCheck> {
  const sql = db()
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM dispatch_tokens
    WHERE created_at > NOW() - ${`${config.dispatch.globalWindowSeconds} seconds`}::interval
  `) as unknown as { n: number }[]
  const n = rows[0]?.n ?? 0
  return n < config.dispatch.globalLimit
    ? { pass: true }
    : { pass: false, reason: NO_DISPATCH_REASONS.GLOBAL_DENSITY }
}

/** 记录一次派单（写入密度窗口） */
export async function recordDispatch(deviceId: string, city: string | null): Promise<void> {
  const sql = db()
  await sql`
    INSERT INTO dispatch_tokens (device_id, city) VALUES (${deviceId}, ${city ?? null})
  `
  // 顺手清理过期 token，避免表无限增长
  await sql`
    DELETE FROM dispatch_tokens
    WHERE created_at < NOW() - ${`${config.dispatch.globalWindowSeconds * 4} seconds`}::interval
  `
}

// ── 帖子组（12-16）───────────────────────────────────────────
/** 12、13：帖子仍有缺口且状态有效（候选查询已在 SQL 侧过滤，这里做二次确认） */
export async function checkPostQuota(postId: string): Promise<ConstraintCheck> {
  const sql = db()
  const rows = (await sql`
    SELECT p.status, p.target_count,
           (SELECT COUNT(*)::int FROM tasks t
            WHERE t.post_id = p.id
              AND t.status IN ('succeeded', 'dispatched', 'executing', 'unknown')) AS committed
    FROM posts p WHERE p.id = ${postId} LIMIT 1
  `) as unknown as { status: string; target_count: number; committed: number }[]
  const row = rows[0]
  if (!row) return { pass: false, reason: NO_DISPATCH_REASONS.NO_POST_AVAILABLE }
  if (row.status !== 'active') return { pass: false, reason: NO_DISPATCH_REASONS.NO_POST_AVAILABLE }
  if (row.committed >= row.target_count) {
    return { pass: false, reason: NO_DISPATCH_REASONS.NO_POST_AVAILABLE }
  }
  return { pass: true }
}

/** 14：单帖节奏（距该帖上一条评论 ≥ perPostMinIntervalMinutes） */
export async function checkPostPacing(postId: string): Promise<ConstraintCheck> {
  const sql = db()
  const rows = (await sql`
    SELECT last_comment_at FROM posts WHERE id = ${postId} LIMIT 1
  `) as unknown as { last_comment_at: Date | null }[]
  const last = parseMs(rows[0]?.last_comment_at ?? null)
  if (last === null) return { pass: true }
  const minGapMs = config.dispatch.perPostMinIntervalMinutes * 60_000
  return nowMs() - last >= minGapMs ? { pass: true } : { pass: false, reason: 'post_pacing' }
}

/** 15：素材可用（同帖仍有未使用过的话术与图片） */
export async function checkMaterialAvailable(
  postId: string,
  needImage: boolean,
): Promise<ConstraintCheck> {
  const sql = db()
  const scripts = (await sql`
    SELECT COUNT(*)::int AS n FROM scripts s
    WHERE s.enabled = TRUE AND NOT EXISTS (
      SELECT 1 FROM post_material_usage u
      WHERE u.post_id = ${postId} AND u.material_ref = 'script:' || s.id
    )
  `) as unknown as { n: number }[]
  if ((scripts[0]?.n ?? 0) === 0) {
    return { pass: false, reason: NO_DISPATCH_REASONS.NO_MATERIAL }
  }
  if (!needImage) return { pass: true }
  const images = (await sql`
    SELECT COUNT(*)::int AS n FROM materials m
    WHERE m.enabled = TRUE AND NOT EXISTS (
      SELECT 1 FROM post_material_usage u
      WHERE u.post_id = ${postId} AND u.material_ref = 'image:' || m.hash
    )
  `) as unknown as { n: number }[]
  return (images[0]?.n ?? 0) > 0
    ? { pass: true }
    : { pass: false, reason: NO_DISPATCH_REASONS.NO_MATERIAL }
}

/** 打印未派单原因（便于排查"为什么没派单"） */
export function logNoDispatch(deviceId: string, reason: string): void {
  log.debug(`no dispatch device=${deviceId} reason=${reason}`)
}
