/**
 * 时间工具。
 *
 * 硬约定（设计文档 §4.4 / 项目约定）：
 *  1. 数据库统一存 timestamptz（UTC）；
 *  2. **判定与展示统一转 UTC+8**（含"日计数""投放时段窗口"这类业务判定）；
 *  3. **禁止用格式化字符串直接比较时间**，一律用毫秒数比较
 *     （历史教训：曾出现"心跳 24 秒被判为 8 小时前离线"）。
 */

/** 本地时区偏移：中国标准时间 UTC+8 */
export const LOCAL_OFFSET_MS = 8 * 60 * 60 * 1000

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

/** 当前时间戳（毫秒） */
export function nowMs(): number {
  return Date.now()
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0')
}

/**
 * 本地（UTC+8）自然日键：YYYY-MM-DD。
 * 用于"今日已完成条数"这类按自然日重置的计数。
 */
export function localDateKey(at: Date | number = Date.now()): string {
  const ms = typeof at === 'number' ? at : at.getTime()
  const d = new Date(ms + LOCAL_OFFSET_MS)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** 本地（UTC+8）当天第几分钟（0..1439），用于投放时段窗口判定 */
export function localMinuteOfDay(at: Date | number = Date.now()): number {
  const ms = typeof at === 'number' ? at : at.getTime()
  const d = new Date(ms + LOCAL_OFFSET_MS)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/** 本地（UTC+8）时间串：YYYY-MM-DD HH:mm:ss */
export function localText(at: Date | number = Date.now()): string {
  const ms = typeof at === 'number' ? at : at.getTime()
  const d = new Date(ms + LOCAL_OFFSET_MS)
  return `${localDateKey(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/** 转为带 +08:00 偏移的 ISO 串（用于接口返回，前端可直接显示） */
export function toLocalIso(at: Date | string | number | null | undefined): string | null {
  if (at === null || at === undefined) return null
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms + LOCAL_OFFSET_MS)
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+08:00`
  )
}

/** 相对时间描述（用于日志与看板）："12 秒前""3 分钟前""2 小时前" */
export function humanAgo(then: Date | string | number, now = Date.now()): string {
  const ms = then instanceof Date ? then.getTime() : typeof then === 'number' ? then : Date.parse(then)
  if (!Number.isFinite(ms)) return 'unknown'
  const diff = now - ms
  if (diff < 0) return '未来'
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`
  return `${Math.floor(diff / DAY_MS)} 天前`
}

/** 解析数据库时间值为毫秒（兼容 Date / string / number） */
export function parseMs(v: Date | string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

export function addMinutes(at: Date | number, minutes: number): Date {
  const ms = typeof at === 'number' ? at : at.getTime()
  return new Date(ms + minutes * MINUTE_MS)
}

export function addDays(at: Date | number, days: number): Date {
  const ms = typeof at === 'number' ? at : at.getTime()
  return new Date(ms + days * DAY_MS)
}

/** 判断当前是否落在投放时段窗口内（支持跨天窗口，如 22:00 → 02:00） */
export function inTimeWindow(
  minute: number,
  startMinute: number,
  endMinute: number,
): boolean {
  if (startMinute === endMinute) return true
  if (startMinute < endMinute) return minute >= startMinute && minute < endMinute
  return minute >= startMinute || minute < endMinute
}
