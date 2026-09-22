/**
 * random 单元测试。
 *
 * 锁定的关键契约：
 *  1. randomInt 在 [min, max] 闭区间内（含两端），且对 min > max 安全；
 *  2. pickExcluding 绝不含被排除项；全部被排除时返回 undefined；
 *  3. shuffle / pickMany 不改变元素集合（只打乱顺序）。
 */
import { describe, expect, it } from 'bun:test'
import {
  makeId,
  pickExcluding,
  pickMany,
  pickOne,
  randomFloat,
  randomInt,
  shuffle,
} from './random.js'

describe('randomInt', () => {
  it('落在闭区间内（大量抽样）', () => {
    for (let i = 0; i < 2000; i++) {
      const v = randomInt(3, 7)
      expect(v).toBeGreaterThanOrEqual(3)
      expect(v).toBeLessThanOrEqual(7)
    }
  })

  it('min == max 恒返回该值', () => {
    expect(randomInt(5, 5)).toBe(5)
  })

  it('min > max 时安全（自动交换）', () => {
    for (let i = 0; i < 500; i++) {
      const v = randomInt(9, 4)
      expect(v).toBeGreaterThanOrEqual(4)
      expect(v).toBeLessThanOrEqual(9)
    }
  })

  it('非数值输入返回 0（防御）', () => {
    expect(randomInt(Number.NaN, 10)).toBe(0)
    expect(randomInt(0, Number.NaN)).toBe(0)
  })
})

describe('randomFloat', () => {
  it('落在 [min, max) 内', () => {
    for (let i = 0; i < 1000; i++) {
      const v = randomFloat(1.5, 4.5)
      expect(v).toBeGreaterThanOrEqual(1.5)
      expect(v).toBeLessThan(4.5)
    }
  })
})

describe('pickOne / pickMany / shuffle', () => {
  it('pickOne 空数组返回 undefined', () => {
    expect(pickOne([])).toBeUndefined()
  })

  it('pickOne 单元素恒返回它', () => {
    expect(pickOne(['a'])).toBe('a')
  })

  it('pickMany 数量不超原集合且不重复', () => {
    const src = [1, 2, 3, 4, 5]
    const out = pickMany(src, 3)
    expect(out).toHaveLength(3)
    expect(new Set(out).size).toBe(3)
    for (const x of out) expect(src).toContain(x)
  })

  it('pickMany n 超过长度时返回全部打乱', () => {
    const src = [1, 2, 3]
    const out = pickMany(src, 10)
    expect(out).toHaveLength(3)
    expect([...out].sort()).toEqual([1, 2, 3])
  })

  it('shuffle 不改变元素集合', () => {
    const src = [1, 2, 3, 4, 5]
    const out = shuffle(src)
    expect(out).toHaveLength(src.length)
    expect([...out].sort()).toEqual(src)
    expect(src).toEqual([1, 2, 3, 4, 5]) // 原数组不被改动
  })
})

describe('pickExcluding（切城排除当前城市）', () => {
  it('绝不返回被排除项', () => {
    for (let i = 0; i < 500; i++) {
      const v = pickExcluding([1, 2, 3, 4], [2])
      expect(v).not.toBe(2)
      expect([1, 3, 4]).toContain(v as number)
    }
  })

  it('全部被排除时返回 undefined', () => {
    expect(pickExcluding([1], [1])).toBeUndefined()
  })
})

describe('makeId', () => {
  it('带前缀且两次生成不重复', () => {
    const a = makeId('task')
    const b = makeId('task')
    expect(a.startsWith('task_')).toBe(true)
    expect(a).not.toBe(b)
  })
})
