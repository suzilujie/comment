/**
 * 系统设置（管理台「系统设置」页写入）。
 *
 * ── 为什么需要这一层 ──
 * 派单规则、时段、心跳阈值这些参数原本只能「改 .env + 重启后台」。运维想调一个
 * 单帖间隔，得停服务；而且 —— 这正是本系统已经踩过的坑 —— **改 config.ts 的默认值
 * 不等于生效**（.env 优先），于是"我明明改了却没用"极难归因。
 *
 * 现在优先级是：**数据库覆盖值 > .env > config.ts 默认值**。
 *  · 页面没动过的键 → 库里没有行 → 跟随 .env（部署时的意图仍然说话）；
 *  · 页面上改过的键 → 库里有一行 → 覆盖 .env，且能「恢复默认」把行删掉退回 .env。
 * 这样二者各司其职，不会互相静默吞掉。
 *
 * ── 实现要点 ──
 *  · 生效值放在内存对象 `settings` 里，读取与 `config` 一样是**同步**的 ——
 *    调用点（包括拼 SQL 的地方）不需要改造成异步；
 *  · 单进程：保存时立刻更新内存；调度器每 5 分钟再重载一次，将来多实例部署也能收敛；
 *  · 每次改动写 `settings_history`：谁能改坏什么、什么时候改的，必须可追溯 ——
 *    间隔/密度改错会直接造成"评论在同一分钟内集中发出"，那是账号级风险。
 */
import { config } from '../config.js'
import { db } from '../db_pg.js'
import { createLogger } from '../logger.js'

const log = createLogger('settings')

export type SettingKind = 'int' | 'bool' | 'time'
export type SettingGroup = 'dispatch' | 'heartbeat'

/** 一项可配置参数的定义（同时是**边界校验的唯一来源**） */
export interface SettingDef {
  /** 点号路径，如 `dispatch.intervalMinMinutes`；group 与 field 由它推导 */
  key: string
  group: SettingGroup
  label: string
  hint: string
  kind: SettingKind
  /** int/time 的取值范围。time 的取值是「当天第几分钟」（0..1439），页面用 HH:MM 显示 */
  min?: number
  max?: number
  /**
   * 默认值**惰性取自 config**（= .env 或 config.ts 默认值）。
   * 写成函数而不是常量，是为了保证与 config.ts 永远同源 —— 拷贝一份数字迟早会漂移。
   */
  envDefault: () => number | boolean
}

export const SETTING_DEFS: readonly SettingDef[] = [
  // ── 投放规则（需求 §5.1 的约束参数）──
  {
    key: 'dispatch.dailyQuotaPerDevice',
    group: 'dispatch',
    label: '单设备日评论上限',
    hint: '每台设备每天最多派发多少条（需求：20）。失败/中止会退还，所以它约等于"每天最多这么多条评论"。',
    kind: 'int',
    min: 1,
    max: 200,
    envDefault: () => config.dispatch.dailyQuotaPerDevice,
  },
  {
    key: 'dispatch.intervalMinMinutes',
    group: 'dispatch',
    label: '完成间隔 · 下限（分钟）',
    hint: '每条**成功**评论之后至少等这么久才派下一条（只对成功计时，失败不重排）。',
    kind: 'int',
    min: 1,
    max: 1440,
    envDefault: () => config.dispatch.intervalMinMinutes,
  },
  {
    key: 'dispatch.intervalMaxMinutes',
    group: 'dispatch',
    label: '完成间隔 · 上限（分钟）',
    hint: '随机区间的上界，必须 ≥ 下限。想要固定节奏就把两个值设成一样。',
    kind: 'int',
    min: 1,
    max: 1440,
    envDefault: () => config.dispatch.intervalMaxMinutes,
  },
  {
    key: 'dispatch.windowStartMinute',
    group: 'dispatch',
    label: '投放窗口 · 开始',
    hint: '每天从几点开始派单（设备属地按 UTC+8 判断）。深夜发评论是很明显的异常特征。',
    kind: 'time',
    min: 0,
    max: 1439,
    envDefault: () => config.dispatch.windowStartMinute,
  },
  {
    key: 'dispatch.windowEndMinute',
    group: 'dispatch',
    label: '投放窗口 · 结束',
    hint: '每天到几点停止派单。开始时间与结束时间不能相同（那等于全天开窗，多半是填错）。',
    kind: 'time',
    min: 0,
    max: 1439,
    envDefault: () => config.dispatch.windowEndMinute,
  },
  {
    key: 'dispatch.perPostMinIntervalMinutes',
    group: 'dispatch',
    label: '单帖最小间隔（分钟）',
    hint: '同一帖子两条评论之间至少间隔多久（需求：单帖 10–15 条要拉开发布间隔）。该帖有在途任务时也不再派。',
    kind: 'int',
    min: 0,
    max: 1440,
    envDefault: () => config.dispatch.perPostMinIntervalMinutes,
  },
  {
    key: 'dispatch.devicePostCooldownDays',
    group: 'dispatch',
    label: '同设备同帖冷却（自然日）',
    hint: '需求「单设备对同一帖一天仅允许评论 1 次」= 1；设 2 表示最近两天都不重复；0 = 不限制。',
    kind: 'int',
    min: 0,
    max: 30,
    envDefault: () => config.dispatch.devicePostCooldownDays,
  },
  {
    key: 'dispatch.globalLimit',
    group: 'dispatch',
    label: '全局密度 · 条数',
    hint: '在下面的密度窗口内，**全平台**最多派这么多条（防止多台设备同一秒扎堆）。',
    kind: 'int',
    min: 1,
    max: 200,
    envDefault: () => config.dispatch.globalLimit,
  },
  {
    key: 'dispatch.globalWindowSeconds',
    group: 'dispatch',
    label: '全局密度 · 窗口（秒）',
    hint: '密度统计用的时间窗。',
    kind: 'int',
    min: 10,
    max: 3600,
    envDefault: () => config.dispatch.globalWindowSeconds,
  },
  {
    key: 'dispatch.receiptTimeoutMinutes',
    group: 'dispatch',
    label: '回执超时（分钟）',
    hint: '派发后多久收不到回执就判 unknown（转人工、禁止自动重试）。它同时是任务的截止时间。',
    kind: 'int',
    min: 1,
    max: 180,
    envDefault: () => config.dispatch.receiptTimeoutMinutes,
  },
  {
    key: 'dispatch.unknownOccupiesPostSlot',
    group: 'dispatch',
    label: 'unknown 继续占用帖子名额',
    hint: '开（默认、保守）：unknown 可能已发出，继续占名额以避免同帖重复评论；关更激进，但会放开重复评论的可能。',
    kind: 'bool',
    envDefault: () => config.dispatch.unknownOccupiesPostSlot,
  },
  // ── 心跳与在线判定 ──
  {
    key: 'heartbeat.seconds',
    group: 'heartbeat',
    label: '心跳间隔（秒）',
    hint: '设备多久上报一次心跳（设备端会加 ±10% 抖动）。调大省流量，但故障发现变慢。',
    kind: 'int',
    min: 5,
    max: 300,
    envDefault: () => config.heartbeat.seconds,
  },
  {
    key: 'heartbeat.onlineThresholdSeconds',
    group: 'heartbeat',
    label: '在线判定阈值（秒）',
    hint: '超过这么久没心跳就算离线。**必须 ≥ 心跳间隔**，否则正常设备会被误判离线。',
    kind: 'int',
    min: 10,
    max: 3600,
    envDefault: () => config.heartbeat.onlineThresholdSeconds,
  },
  {
    key: 'heartbeat.offlineAlertThresholdSeconds',
    group: 'heartbeat',
    label: '离线告警阈值（秒）',
    hint: '离线超过这么久发 warn 告警。必须 ≥ 在线判定阈值。',
    kind: 'int',
    min: 10,
    max: 86400,
    envDefault: () => config.heartbeat.offlineAlertThresholdSeconds,
  },
  {
    key: 'heartbeat.offlineManualThresholdSeconds',
    group: 'heartbeat',
    label: '需人工处理阈值（秒）',
    hint: '离线超过这么久升级为 error 告警（可能真掉线了）。必须 ≥ 离线告警阈值。',
    kind: 'int',
    min: 10,
    max: 86400,
    envDefault: () => config.heartbeat.offlineManualThresholdSeconds,
  },
]

const DEF_MAP = new Map(SETTING_DEFS.map((d) => [d.key, d]))

/**
 * **生效值**（内存）。调用点直接读它，与 config 一样是同步的。
 *
 * 初值给的是"占位默认"，模块加载时会立刻被 `applyEnvDefaults()` 覆盖 ——
 * 之所以不直接引用 config 的字段值，是因为这里的对象要能被页面改动。
 */
export const settings: {
  dispatch: {
    dailyQuotaPerDevice: number
    intervalMinMinutes: number
    intervalMaxMinutes: number
    windowStartMinute: number
    windowEndMinute: number
    perPostMinIntervalMinutes: number
    devicePostCooldownDays: number
    globalLimit: number
    globalWindowSeconds: number
    receiptTimeoutMinutes: number
    unknownOccupiesPostSlot: boolean
  }
  heartbeat: {
    seconds: number
    onlineThresholdSeconds: number
    offlineAlertThresholdSeconds: number
    offlineManualThresholdSeconds: number
  }
} = {
  dispatch: {
    dailyQuotaPerDevice: 20,
    intervalMinMinutes: 30,
    intervalMaxMinutes: 60,
    windowStartMinute: 480,
    windowEndMinute: 1320,
    perPostMinIntervalMinutes: 15,
    devicePostCooldownDays: 1,
    globalLimit: 3,
    globalWindowSeconds: 300,
    receiptTimeoutMinutes: 15,
    unknownOccupiesPostSlot: true,
  },
  heartbeat: {
    seconds: 30,
    onlineThresholdSeconds: 90,
    offlineAlertThresholdSeconds: 300,
    offlineManualThresholdSeconds: 1800,
  },
}

/** 每个键当前值的来源：db = 页面设置过；env = 跟随 .env / 默认值 */
const sources = new Map<string, 'db' | 'env'>()

function slotOf(key: string): { group: SettingGroup; field: string } | null {
  const [group, field] = key.split('.')
  if ((group !== 'dispatch' && group !== 'heartbeat') || !field) return null
  return { group, field }
}

function assign(key: string, value: number | boolean): void {
  const slot = slotOf(key)
  if (!slot) return
  const bag = settings[slot.group] as unknown as Record<string, number | boolean>
  bag[slot.field] = value
}

/** 把全部字段恢复成 .env / 默认值（未覆盖的字段必须始终跟随 config） */
function applyEnvDefaults(): void {
  for (const def of SETTING_DEFS) {
    assign(def.key, def.envDefault())
    sources.set(def.key, 'env')
  }
}

/** 取值是否合法（越界/类型不符一律判非法，**不做静默截断**） */
function coerce(def: SettingDef, raw: unknown): number | boolean | null {
  if (def.kind === 'bool') {
    if (typeof raw === 'boolean') return raw
    if (raw === 'true' || raw === 1) return true
    if (raw === 'false' || raw === 0) return false
    return null
  }
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null
  if (def.min !== undefined && n < def.min) return null
  if (def.max !== undefined && n > def.max) return null
  return n
}

/** 供错误提示：把边界说清楚，而不是只说"非法" */
function rangeText(def: SettingDef): string {
  if (def.kind === 'bool') return '只能是 开/关'
  if (def.kind === 'time') return '时间格式为 HH:MM（24 小时制）'
  return `整数 ${def.min ?? '-∞'}~${def.max ?? '+∞'}`
}

/** 当前全部生效值 */
export function currentValues(): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {}
  for (const def of SETTING_DEFS) {
    const slot = slotOf(def.key)!
    out[def.key] = (settings[slot.group] as unknown as Record<string, number | boolean>)[slot.field]!
  }
  return out
}

/**
 * 跨字段互斥校验。
 *
 * ⚠ 必须把「本次提交 + 当前生效值」合成一份完整视图再验：只看单字段会放过自相矛盾的组合
 *   （例如把 intervalMax 调到小于 intervalMin，或把在线阈值调到小于心跳间隔
 *   —— 后者会让所有设备在你眼里"全部离线"）。
 */
function crossCheck(values: Record<string, number | boolean>): Record<string, string> {
  const errs: Record<string, string> = {}
  const num = (k: string): number => Number(values[k] ?? 0)

  if (num('dispatch.intervalMaxMinutes') < num('dispatch.intervalMinMinutes')) {
    errs['dispatch.intervalMaxMinutes'] = '上限不能小于下限（区间为空）'
  }
  if (num('dispatch.windowStartMinute') === num('dispatch.windowEndMinute')) {
    errs['dispatch.windowEndMinute'] = '结束时间不能等于开始时间：那会导致全天开窗（多半是填错了）'
  }
  if (num('dispatch.globalLimit') < 1) {
    errs['dispatch.globalLimit'] = '至少为 1，否则永远派不出任务'
  }
  if (num('heartbeat.onlineThresholdSeconds') < num('heartbeat.seconds')) {
    errs['heartbeat.onlineThresholdSeconds'] =
      '必须 ≥ 心跳间隔，否则设备会被误判离线（建议留 2~3 倍余量）'
  }
  if (num('heartbeat.offlineAlertThresholdSeconds') < num('heartbeat.onlineThresholdSeconds')) {
    errs['heartbeat.offlineAlertThresholdSeconds'] = '必须 ≥ 在线判定阈值'
  }
  if (num('heartbeat.offlineManualThresholdSeconds') < num('heartbeat.offlineAlertThresholdSeconds')) {
    errs['heartbeat.offlineManualThresholdSeconds'] = '必须 ≥ 离线告警阈值'
  }
  return errs
}

/**
 * 启动 / 定时：从库读取覆盖值，重算生效值。
 *
 * 幂等：先整体回到 .env 默认，再逐条套用库里的覆盖 —— 所以"删掉库里的行"就等于恢复默认，
 * 不需要任何额外的清理逻辑。
 */
export async function loadSettings(): Promise<{ overrides: number }> {
  const sql = db()
  applyEnvDefaults()
  let rows: { key: string; value: unknown }[] = []
  try {
    rows = (await sql`SELECT key, value FROM settings`) as unknown as { key: string; value: unknown }[]
  } catch (e) {
    // 表还没有（首次启动、ensureSchema 失败）→ 用默认值继续跑，不要因此起不来
    log.warn(`读取 settings 失败，暂时使用 .env 默认值：${(e as Error).message}`)
    return { overrides: 0 }
  }

  let applied = 0
  for (const row of rows) {
    const def = DEF_MAP.get(row.key)
    if (!def) {
      // 旧版本留下的键（改过名 / 删过字段）→ 忽略但留痕，否则"库里有个值却不生效"查不出来
      log.warn(`settings 中的 ${row.key} 已不是有效设置项，已忽略（可删除该行）`)
      continue
    }
    const v = coerce(def, row.value)
    if (v === null) {
      log.warn(`settings 中的 ${row.key}=${JSON.stringify(row.value)} 越界/类型不符，已回退默认值`)
      continue
    }
    assign(row.key, v)
    sources.set(row.key, 'db')
    applied++
  }
  return { overrides: applied }
}

export interface SettingsView {
  items: {
    key: string
    group: SettingGroup
    label: string
    hint: string
    kind: SettingKind
    min: number | null
    max: number | null
    value: number | boolean
    /** db = 页面设置；env = 跟随 .env / 默认值 */
    source: 'db' | 'env'
    /** 同一个键在 .env / config 里的值（用于「恢复默认」提示与对比） */
    envValue: number | boolean
    /** 与 envValue 不同（= 已被页面覆盖） */
    overridden: boolean
  }[]
  /** 只读环境信息（不属于可改设置，但排障时需要看到实际生效值） */
  readonly: { label: string; value: string }[]
}

/** 页面用的完整快照：值 + 来源 + 边界 + 只读环境信息 */
export function settingsView(): SettingsView {
  const values = currentValues()
  const items = SETTING_DEFS.map((def) => {
    const envValue = def.envDefault()
    const source = sources.get(def.key) ?? 'env'
    return {
      key: def.key,
      group: def.group,
      label: def.label,
      hint: def.hint,
      kind: def.kind,
      min: def.min ?? null,
      max: def.max ?? null,
      value: values[def.key]!,
      source,
      envValue,
      overridden: values[def.key] !== envValue,
    }
  })
  return {
    items,
    // 这些来自 .env 且**不该在页面上改**（改错会导致服务起不来/连不上库）
    readonly: [
      { label: '服务端口', value: `${config.server.host}:${config.server.port}` },
      { label: '数据库连接池', value: `${config.pg.poolMax} 连接` },
      { label: '素材目录', value: config.material.dir },
      { label: '素材大小上限', value: `${config.material.maxMb} MB` },
      { label: 'IP 切省周期', value: `${config.ip.rotateDays} 天 ± ${config.ip.rotateJitterHours} 小时` },
      { label: '管理台 token 有效期', value: `${config.admin.tokenTtlHours} 小时` },
    ],
  }
}

export interface SettingsResult {
  ok: boolean
  error?: string
  detail?: Record<string, unknown>
}

/**
 * 保存设置。
 *
 * 全部校验通过才落库（**不做部分保存**）：节奏参数之间是互相牵制的，
 * 只写一半会让系统停在一个自相矛盾的中间态（例如上限改了、下限还没改）。
 */
export async function saveSettings(
  patch: Record<string, unknown>,
  actor: string,
): Promise<SettingsResult> {
  const sql = db()
  const errors: Record<string, string> = {}
  const clean: Record<string, number | boolean> = {}

  for (const [key, raw] of Object.entries(patch)) {
    const def = DEF_MAP.get(key)
    if (!def) {
      errors[key] = '不是有效的设置项'
      continue
    }
    const v = coerce(def, raw)
    if (v === null) {
      errors[key] = `取值非法：${rangeText(def)}`
      continue
    }
    clean[key] = v
  }

  // 用「当前生效值 + 本次提交」合成完整视图做互斥校验
  const merged = { ...currentValues(), ...clean }
  for (const [k, msg] of Object.entries(crossCheck(merged))) {
    if (!(k in errors)) errors[k] = msg
  }

  if (Object.keys(errors).length > 0) {
    // 把每个字段的问题拼进 message：前端只弹一个 toast 也能看清"哪一项、为什么"
    // （前端对 4xx 只拿到 error 文本，拿不到 detail —— 见 admin-web/src/api.ts 的 req）。
    const detailText = Object.entries(errors)
      .map(([k, msg]) => `${DEF_MAP.get(k)?.label ?? k}：${msg}`)
      .join('；')
    return {
      ok: false,
      error: `设置未通过校验（未做任何修改）—— ${detailText}`,
      detail: { errors },
    }
  }
  if (Object.keys(clean).length === 0) {
    return { ok: true, detail: { changed: 0 } }
  }

  const before = currentValues()
  const changed: { key: string; from: number | boolean; to: number | boolean }[] = []

  for (const [key, value] of Object.entries(clean)) {
    if (before[key] === value) continue
    await sql`
      INSERT INTO settings (key, value, updated_by, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}::jsonb, ${actor}, NOW())
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
    `
    await sql`
      INSERT INTO settings_history (key, old_value, new_value, actor)
      VALUES (${key}, ${JSON.stringify(before[key] ?? null)}::jsonb, ${JSON.stringify(value)}::jsonb, ${actor})
    `
    changed.push({ key, from: before[key]!, to: value })
  }

  // 落库成功后立刻更新内存 —— 单进程下立即生效；多实例由 5 分钟一次的重载收敛
  for (const [key, value] of Object.entries(clean)) {
    assign(key, value)
    sources.set(key, 'db')
  }

  for (const c of changed) {
    log.warn(`设置变更 ${c.key}: ${String(c.from)} → ${String(c.to)}（by ${actor}）`)
  }
  return { ok: true, detail: { changed: changed.length, changes: changed } }
}

/**
 * 恢复默认：删掉库里的覆盖行 → 该键重新跟随 .env / config 默认值。
 * @param keys 传空数组表示恢复全部
 */
export async function resetSettings(keys: string[], actor: string): Promise<SettingsResult> {
  const sql = db()
  const target = keys.length > 0 ? keys : SETTING_DEFS.map((d) => d.key)
  for (const k of target) {
    if (!DEF_MAP.has(k)) return { ok: false, error: `不是有效的设置项：${k}` }
  }
  const before = currentValues()
  const rows = (await sql`
    DELETE FROM settings WHERE key IN ${sql(target)} RETURNING key
  `) as unknown as { key: string }[]

  for (const { key } of rows) {
    const def = DEF_MAP.get(key)!
    const envValue = def.envDefault()
    await sql`
      INSERT INTO settings_history (key, old_value, new_value, actor)
      VALUES (${key}, ${JSON.stringify(before[key] ?? null)}::jsonb,
              ${JSON.stringify(envValue)}::jsonb, ${actor})
    `
    assign(key, envValue)
    sources.set(key, 'env')
  }
  log.warn(`设置恢复默认：${rows.map((r) => r.key).join(', ') || '(无覆盖项)'}（by ${actor}）`)
  return { ok: true, detail: { reset: rows.map((r) => r.key) } }
}

export interface SettingHistoryRow {
  key: string
  old_value: unknown
  new_value: unknown
  actor: string | null
  created_at: Date
}

/** 最近变更（页面展示用） */
export async function listSettingsHistory(limit = 20): Promise<SettingHistoryRow[]> {
  const sql = db()
  return (await sql`
    SELECT key, old_value, new_value, actor, created_at
    FROM settings_history ORDER BY id DESC LIMIT ${limit}
  `) as unknown as SettingHistoryRow[]
}

// 模块加载即套用 .env 默认值：这样即使调用方忘了 await loadSettings()（或 DB 不可达），
// 读到的也是"与 config 一致"的值，而不是上面那份占位数字。
applyEnvDefaults()
