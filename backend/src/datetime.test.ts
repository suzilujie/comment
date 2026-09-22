/**
 * datetime 单元测试。
 *
 * 重点锁定两个历史风险：
 *  1. **UTC+8 自然日边界**（跨日重置日计数）：UTC 的 16:00 才是北京时间的次日 0 点；
 *  2. **跨天投放时段窗口**（如 22:00 → 02:00），普通 `start < end` 判断会失效。
 */
import { describe, expect, it } from 'bun:test'
import {
  DAY_MS,
  HOUR_MS,
  LOCAL_OFFSET_MS,
  addDays,
  addMinutes,
  humanAgo,
  inTimeWindow,
  localDateKey,
  localMinuteOfDay,
  localText,
  parseMs,
  toLocalIso,
} from './datetime.js'

describe('localDateKey（UTC+8 自然日）', () => {
  it('UTC 15:59:59 仍是北京时间同日 23:59:59', () => {
    const at = Date.UTC(2026, 0, 1, 15, 59, 59)
    expect(localDateKey(at)).toBe('2026-01-01')
  })

  it('UTC 16:00:00 已跨到北京时间次日 0 点', () => {
    const at = Date.UTC(2026, 0, 1, 16, 0, 0)
    expect(localDateKey(at)).toBe('2026-01-02')
  })

  it('整点边界：北京时间 2026-01-01 00:00:00', () => {
    const at = Date.UTC(2025, 11, 31, 16, 0, 0)
    expect(localDateKey(at)).toBe('2026-01-01')
  })

  it('默认参数使用当前时间且格式合法', () => {
    expect(localDateKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('localMinuteOfDay（当天第几分钟）', () => {
  it('北京时间 00:00 → 0', () => {
    expect(localMinuteOfDay(Date.UTC(2026, 0, 1, 16, 0, 0))).toBe(0)
  })

  it('北京时间 08:00 → 480', () => {
    expect(localMinuteOfDay(Date.UTC(2026, 0, 2, 0, 0, 0))).toBe(480)
  })

  it('北京时间 22:00 → 1320', () => {
    expect(localMinuteOfDay(Date.UTC(2026, 0, 2, 14, 0, 0))).toBe(1320)
  })

  it('北京时间 23:59 → 1439', () => {
    expect(localMinuteOfDay(Date.UTC(2026, 0, 2, 15, 59, 0))).toBe(1439)
  })
})

describe('inTimeWindow（投放时段窗口）', () => {
  it('普通窗口 08:00–22:00（480–1320）', () => {
    expect(inTimeWindow(480, 480, 1320)).toBe(true)
    expect(inTimeWindow(479, 480, 1320)).toBe(false)
    expect(inTimeWindow(1319, 480, 1320)).toBe(true)
    expect(inTimeWindow(1320, 480, 1320)).toBe(false)
  })

  it('跨天窗口 22:00–02:00（1320–120）', () => {
    expect(inTimeWindow(1320, 1320, 120)).toBe(true)
    expect(inTimeWindow(1439, 1320, 120)).toBe(true)
    expect(inTimeWindow(0, 1320, 120)).toBe(true)
    expect(inTimeWindow(119, 1320, 120)).toBe(true)
    expect(inTimeWindow(120, 1320, 120)).toBe(false)
    expect(inTimeWindow(600, 1320, 120)).toBe(false)
  })

  it('全时段（start == end）恒为真', () => {
    expect(inTimeWindow(0, 0, 0)).toBe(true)
    expect(inTimeWindow(1234, 500, 500)).toBe(true)
  })
})

describe('toLocalIso（带 +08:00 偏移）', () => {
  it('UTC 16:00:00 → 次日 00:00:00+08:00', () => {
    expect(toLocalIso(Date.UTC(2026, 0, 1, 16, 0, 0))).toBe('2026-01-02T00:00:00+08:00')
  })

  it('null / 非法输入返回 null', () => {
    expect(toLocalIso(null)).toBeNull()
    expect(toLocalIso(undefined)).toBeNull()
    expect(toLocalIso('not-a-date')).toBeNull()
  })
})

describe('parseMs（时间解析为毫秒）', () => {
  it('Date / number / ISO 字符串 / 非法输入', () => {
    const d = new Date(1000)
    expect(parseMs(d)).toBe(1000)
    expect(parseMs(123456)).toBe(123456)
    expect(parseMs('2026-01-02T00:00:00+08:00')).toBe(Date.parse('2026-01-02T00:00:00+08:00'))
    expect(parseMs('invalid')).toBeNull()
    expect(parseMs(null)).toBeNull()
    expect(parseMs(undefined)).toBeNull()
  })
})

describe('localText / humanAgo（展示）', () => {
  it('localText 使用 UTC+8 且带日期时间', () => {
    expect(localText(Date.UTC(2026, 0, 1, 16, 0, 0))).toBe('2026-01-02 00:00:00')
  })

  it('humanAgo 分档', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0)
    expect(humanAgo(now - 5_000, now)).toBe('5 秒前')
    expect(humanAgo(now - 3 * 60_000, now)).toBe('3 分钟前')
    expect(humanAgo(now - 2 * HOUR_MS, now)).toBe('2 小时前')
    expect(humanAgo(now - 3 * DAY_MS, now)).toBe('3 天前')
    expect(humanAgo(now + 1000, now)).toBe('未来')
    expect(humanAgo('invalid')).toBe('unknown')
  })
})

describe('addMinutes / addDays', () => {
  it('跨小时与跨日正确累加', () => {
    const base = Date.UTC(2026, 0, 1, 23, 30, 0)
    expect(addMinutes(base, 45).getTime()).toBe(Date.UTC(2026, 0, 2, 0, 15, 0))
    expect(addDays(base, 1).getTime()).toBe(Date.UTC(2026, 0, 2, 23, 30, 0))
  })
})

describe('时区常量自洽', () => {
  it('LOCAL_OFFSET_MS 等于 8 小时', () => {
    expect(LOCAL_OFFSET_MS).toBe(8 * HOUR_MS)
  })
})
