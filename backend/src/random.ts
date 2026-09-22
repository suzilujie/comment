/**
 * 随机工具（服务端权威随机）。
 *
 * 分工（设计文档 §4.4「抖动的生成规则」）：
 *  - **业务相关的随机**（完成间隔、任务与素材选择）→ 在服务端生成，可审计、可复现；
 *  - **纯节拍的随机**（心跳抖动、切 IP 计时抖动）→ 在设备端生成。
 * 承诺给设备的随机值一律由服务端算出，避免"两端各算一套"造成节奏错乱。
 */
import { randomInt as cryptoRandomInt } from 'node:crypto'

/** 整数随机 [min, max]（含两端；使用 crypto 强随机，避免可预测） */
export function randomInt(min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0
  const lo = Math.ceil(Math.min(min, max))
  const hi = Math.floor(Math.max(min, max))
  if (hi <= lo) return lo
  return cryptoRandomInt(lo, hi + 1)
}

/** 浮点随机 [min, max) */
export function randomFloat(min: number, max: number): number {
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  return lo + Math.random() * (hi - lo)
}

/** 布尔随机（概率 p 为真） */
export function randomBool(p: number): boolean {
  return Math.random() < p
}

/** 从数组随机取一个（空数组返回 undefined） */
export function pickOne<T>(list: readonly T[]): T | undefined {
  if (list.length === 0) return undefined
  return list[randomInt(0, list.length - 1)]
}

/** 从数组随机取 n 个（不重复；n 超长则返回全部打乱） */
export function pickMany<T>(list: readonly T[], n: number): T[] {
  const arr = shuffle(list)
  if (n <= 0) return []
  return arr.slice(0, Math.min(n, arr.length))
}

/** Fisher–Yates 洗牌（返回新数组） */
export function shuffle<T>(list: readonly T[]): T[] {
  const arr = [...list]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(0, i)
    const a = arr[i] as T
    const b = arr[j] as T
    arr[i] = b
    arr[j] = a
  }
  return arr
}

/**
 * 排除法随机：从候选里排除若干值后随机取一个。
 * 用于"切城时排除当前城市"。
 */
export function pickExcluding<T>(list: readonly T[], exclude: readonly T[]): T | undefined {
  const blocked = new Set(exclude)
  const candidates = list.filter((x) => !blocked.has(x))
  return pickOne(candidates)
}

/** 生成带前缀的业务 ID：plan_<ts>_<rand>（沿用参考项目的 ID 风格） */
export function makeId(prefix: string): string {
  const ts = Date.now().toString(36)
  const rand = cryptoRandomInt(0, 0xffffff).toString(36).padStart(5, '0')
  return `${prefix}_${ts}_${rand}`
}
