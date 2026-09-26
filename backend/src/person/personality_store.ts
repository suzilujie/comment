/**
 * 人格档案存储与生成（设计文档 §6.5）。
 *
 * 两层随机中的「人格层」：一设备一份、长期稳定。
 * 生成用**分层抽样**（低/中/高三档按 25/50/25 分配），避免各维度取值扎堆。
 * 注意：人格不得越过硬约束（日上限、完成间隔、投放时段优先于人格偏好）。
 *
 * 2026-09-26：随账号实体移除，主键由 account_id 改为 device_id。
 */
import { db } from '../db_pg.js'
import { createLogger } from '../logger.js'
import { randomBool, randomFloat, randomInt } from '../random.js'

const log = createLogger('personality')

export interface PersonalityRow {
  device_id: string
  profile: Record<string, unknown>
  bands: Record<string, string> | null
  version: number
}

/** 维度档位定义：每个维度分低/中/高三档，落在 25/50/25 的目标比例上 */
export const BANDS = {
  dwellMedianSec: { low: [5, 10], mid: [10, 18], high: [18, 30] },
  preClickMsMedian: { low: [600, 1200], mid: [1200, 2200], high: [2200, 3500] },
  likeProbability: { low: [0.55, 0.7], mid: [0.7, 0.85], high: [0.85, 0.95] },
  favoriteProbability: { low: [0.25, 0.4], mid: [0.4, 0.65], high: [0.65, 0.85] },
  commentsToRead: { low: [1, 2], mid: [2, 4], high: [4, 6] },
  thinkPauseSec: { low: [0.8, 2], mid: [2, 4], high: [4, 6] },
  lingerAfterPostSec: { low: [1, 2], mid: [2, 4], high: [4, 6] },
} as const

export type BandKey = keyof typeof BANDS
export type BandLevel = 'low' | 'mid' | 'high'

/** 分层抽样：按 25/50/25 的目标比例取档位 */
export function sampleBand(): BandLevel {
  const r = Math.random()
  if (r < 0.25) return 'low'
  if (r < 0.75) return 'mid'
  return 'high'
}

/** 生成一份人格档案（含档位记录，便于做分布校验） */
export function generateProfile(): { profile: Record<string, unknown>; bands: Record<string, string> } {
  const bands: Record<string, string> = {}
  const profile: Record<string, unknown> = {}

  for (const [key, levels] of Object.entries(BANDS) as [BandKey, typeof BANDS[BandKey]][]) {
    const level = sampleBand()
    const [lo, hi] = levels[level] as readonly [number, number]
    bands[key] = level
    profile[key] =
      Number.isInteger(lo) && Number.isInteger(hi) ? randomInt(lo, hi) : Number(randomFloat(lo, hi).toFixed(2))
  }

  // 收尾方式与作息偏好（非数值维度）
  profile.exitMode = randomBool(0.8) ? 'back_key' : 'home'
  profile.activeHours = randomBool(0.5) ? [8, 22] : [9, 23]
  profile.driftDays = 30
  return { profile, bands }
}

export async function getPersonality(deviceId: string): Promise<PersonalityRow | null> {
  const sql = db()
  const rows = (await sql`
    SELECT device_id, profile, bands, version FROM personalities WHERE device_id = ${deviceId} LIMIT 1
  `) as unknown as PersonalityRow[]
  return rows[0] ?? null
}

/** 幂等生成：已存在则返回既有档案 */
export async function ensurePersonality(deviceId: string): Promise<PersonalityRow> {
  const existing = await getPersonality(deviceId)
  if (existing) return existing

  const { profile, bands } = generateProfile()
  const sql = db()
  await sql`
    INSERT INTO personalities (device_id, profile, bands, version)
    VALUES (${deviceId}, ${JSON.stringify(profile)}::jsonb, ${JSON.stringify(bands)}::jsonb, 1)
    ON CONFLICT (device_id) DO NOTHING
  `
  log.info(`personality generated for ${deviceId}: ${JSON.stringify(bands)}`)
  const row = await getPersonality(deviceId)
  if (!row) throw new Error('personality insert failed')
  return row
}

/**
 * 档位分布校验：检查各维度档位是否大致铺开。
 * 返回偏差超过阈值的维度（用于 §6.5 的可观测指标）。
 */
export async function checkBandDistribution(tolerance = 0.15): Promise<
  { dimension: string; level: BandLevel; actual: number; target: number }[]
> {
  const sql = db()
  const rows = (await sql`SELECT bands FROM personalities`) as unknown as {
    bands: Record<string, string> | null
  }[]
  const total = rows.length
  if (total === 0) return []

  const targets: Record<BandLevel, number> = { low: 0.25, mid: 0.5, high: 0.25 }
  const issues: { dimension: string; level: BandLevel; actual: number; target: number }[] = []

  for (const dimension of Object.keys(BANDS)) {
    const counts: Record<BandLevel, number> = { low: 0, mid: 0, high: 0 }
    for (const r of rows) {
      const level = r.bands?.[dimension] as BandLevel | undefined
      if (level && level in counts) counts[level]++
    }
    for (const level of ['low', 'mid', 'high'] as BandLevel[]) {
      const actual = counts[level] / total
      const target = targets[level]
      if (Math.abs(actual - target) > tolerance) {
        issues.push({ dimension, level, actual: Number(actual.toFixed(3)), target })
      }
    }
  }
  if (issues.length > 0) log.warn(`band distribution drift: ${JSON.stringify(issues)}`)
  return issues
}
