/**
 * 设备存储与状态派生（设计文档 §3.8）。
 * 原则：设备只上报「事实」，是否可用（dispatchable）由后台计算。
 */
import { db } from '../db_pg.js'
import { emit, EVENTS } from '../bus.js'
import { createLogger } from '../logger.js'
import { config } from '../config.js'
import { nowMs, parseMs } from '../datetime.js'
import type { AdminState, DeviceAvailability } from '../types.js'
import type { HeartbeatRequest } from '../contracts/agent.js'

const log = createLogger('device')

/** devices 表行（只列出代码用到的列） */
export interface DeviceRow {
  id: string
  admin_state: AdminState
  last_seen_at: Date | null
  last_ip: string | null
  last_ip_city: string | null
  accessibility_ok: boolean | null
  foreground_ok: boolean | null
  proxy_ok: boolean | null
  busy_task_id: string | null
  agent_version: string | null
  rule_pack_version: string | null
  douyin_version: string | null
  clock_offset_sec: number | null
  model: string | null
  resolution: string | null
  // ── 配额与计数（2026-09-26 由 accounts 表迁入设备维度）──
  daily_done: number
  daily_done_date: string | Date | null
  next_eligible_at: Date | null
  fail_streak: number
  total_success: number
  total_fail: number
  total_unknown: number
}

export async function getDevice(deviceId: string): Promise<DeviceRow | null> {
  const sql = db()
  const found = (await sql`SELECT * FROM devices WHERE id = ${deviceId} LIMIT 1`) as unknown as DeviceRow[]
  return found[0] ?? null
}

/**
 * 心跳写入（UPSERT）：刷新状态快照并派发在线事件。
 * **陌生 deviceId 首次心跳即自动登记**（Trust on First Use，默认 enabled），
 * 不再有独立的注册环节——设备身份 = UUID，无 token 鉴权。
 */
export async function applyHeartbeat(req: HeartbeatRequest): Promise<DeviceRow> {
  const sql = db()
  const prev = await getDevice(req.deviceId)
  const prevSeenMs = parseMs(prev?.last_seen_at ?? null)
  const wasOnline =
    prev !== null &&
    prevSeenMs !== null &&
    nowMs() - prevSeenMs <= config.heartbeat.offlineAlertThresholdSeconds * 1000

  const s = req.state
  // ⚠ UPSERT 直接 RETURNING * ：原实现写完之后又 `getDevice` 查了一次，
  // 而心跳路径上 guard / applyHeartbeat / eligibleForTask 各读一次 —— 同一行读 3 次。
  const upserted = (await sql`
    INSERT INTO devices (id, model, resolution, dpi, os_version, rom_version,
                         font_scale, dark_mode, agent_version, admin_state,
                         last_seen_at, last_ip, last_ip_city, ipv6_leak,
                         accessibility_ok, foreground_ok, proxy_ok, battery,
                         storage_free_mb, clock_offset_sec, rule_pack_version,
                         douyin_version, busy_task_id, state, presence, created_at, updated_at)
    VALUES (${req.deviceId}, ${req.profile?.model ?? null}, ${req.profile?.resolution ?? null},
            ${req.profile?.dpi ?? null}, ${req.profile?.osVersion ?? null}, ${req.profile?.romVersion ?? null},
            ${req.profile?.fontScale ?? null}, ${req.profile?.darkMode ?? null}, ${s.agentVersion},
            'enabled', NOW(), ${s.ip}, ${s.ipCity}, ${s.ipv6Leak ?? null},
            ${s.accessibilityOk}, ${s.foregroundOk}, ${s.proxyOk}, ${s.battery ?? null},
            ${s.storageFreeMb ?? null}, ${s.clockOffsetSec ?? null}, ${s.rulePackVersion ?? null},
            ${s.douyinVersion ?? null}, ${req.busyTaskId ?? null}, ${JSON.stringify(s)}::jsonb,
            'online', NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      last_seen_at = EXCLUDED.last_seen_at,
      last_ip = EXCLUDED.last_ip,
      last_ip_city = EXCLUDED.last_ip_city,
      ipv6_leak = EXCLUDED.ipv6_leak,
      accessibility_ok = EXCLUDED.accessibility_ok,
      foreground_ok = EXCLUDED.foreground_ok,
      proxy_ok = EXCLUDED.proxy_ok,
      battery = EXCLUDED.battery,
      storage_free_mb = EXCLUDED.storage_free_mb,
      clock_offset_sec = EXCLUDED.clock_offset_sec,
      agent_version = EXCLUDED.agent_version,
      rule_pack_version = EXCLUDED.rule_pack_version,
      douyin_version = EXCLUDED.douyin_version,
      busy_task_id = EXCLUDED.busy_task_id,
      model = COALESCE(EXCLUDED.model, devices.model),
      resolution = COALESCE(EXCLUDED.resolution, devices.resolution),
      dpi = COALESCE(EXCLUDED.dpi, devices.dpi),
      os_version = COALESCE(EXCLUDED.os_version, devices.os_version),
      rom_version = COALESCE(EXCLUDED.rom_version, devices.rom_version),
      font_scale = COALESCE(EXCLUDED.font_scale, devices.font_scale),
      dark_mode = COALESCE(EXCLUDED.dark_mode, devices.dark_mode),
      state = EXCLUDED.state,
      -- 心跳即在线：把离线扫描置上的 presence 复位（离线判定见 scheduler.scanOfflineDevices）
      presence = 'online',
      updated_at = NOW()
    RETURNING *
  `) as unknown as DeviceRow[]

  const row = upserted[0]
  if (!row) throw new Error(`device not found after heartbeat: ${req.deviceId}`)

  if (!wasOnline) {
    await sql`
      INSERT INTO device_events (device_id, event, detail)
      VALUES (${req.deviceId}, 'online', ${JSON.stringify({ ip: s.ip, city: s.ipCity })}::jsonb)
    `
    emit(EVENTS.DEVICE_PRESENCE, { deviceId: req.deviceId, from: 'offline', to: 'online' })
  }
  emit(EVENTS.HEARTBEAT, { deviceId: req.deviceId, atMs: nowMs() })
  return row
}

/** 在线判定（心跳新鲜度，三级阈值见 §3.8） */
export function isOnline(device: DeviceRow): boolean {
  const seen = parseMs(device.last_seen_at)
  if (seen === null) return false
  return nowMs() - seen <= config.heartbeat.onlineThresholdSeconds * 1000
}

/** 派生可用性：设备报事实，后台算准入（§3.8 第 5 条原则） */
export async function evaluateAvailability(device: DeviceRow): Promise<DeviceAvailability> {
  const sql = db()
  const reasons: string[] = []
  const online = isOnline(device)
  if (!online) reasons.push('offline')
  if (device.admin_state !== 'enabled') reasons.push(`admin_state:${device.admin_state}`)
  if (device.accessibility_ok !== true) reasons.push('accessibility_off')
  if (device.foreground_ok !== true) reasons.push('foreground_dead')
  if (device.proxy_ok !== true) reasons.push('proxy_down')
  if (device.busy_task_id) reasons.push('busy')

  const inflight = (await sql`
    SELECT id FROM tasks
    WHERE device_id = ${device.id} AND status IN ('dispatched', 'executing')
    LIMIT 1
  `) as unknown as { id: string }[]
  if (inflight.length > 0) reasons.push('in_flight_task')

  return { online, dispatchable: reasons.length === 0, reasons }
}

/** 清空设备的在途任务标记（任务终态后调用） */
export async function clearBusy(deviceId: string, taskId: string): Promise<void> {
  const sql = db()
  await sql`
    UPDATE devices SET busy_task_id = NULL, updated_at = NOW()
    WHERE id = ${deviceId} AND (busy_task_id = ${taskId} OR busy_task_id IS NULL)
  `
}

/** 设备列表筛选（管理台） */
export interface DeviceFilter {
  /** 在线：true=在线 / false=离线 / undefined=全部（口径同 isOnline） */
  online?: boolean
  /** 健康：'ok'=三项自检全绿 / 'problem'=任一异常 / undefined=全部 */
  health?: 'ok' | 'problem'
  /** 属地（省级，精确匹配） */
  city?: string
  /** 关键词：设备 ID / 机型 */
  q?: string
}

/**
 * 组装设备筛选 WHERE。
 *
 * ⚠ 列表与计数**必须共用这一段** —— 两边口径一旦不一致，翻到最后一页会看到空白页
 * （total 说还有几百条，items 却已经取空了），而且极难归因。
 * 所有筛选都下推到 SQL：前端过滤在分页下只作用于当前页。
 */
function deviceWhere(f: DeviceFilter) {
  const sql = db()
  const parts = [sql`TRUE`]
  if (f.online !== undefined) {
    const online = sql`(last_seen_at IS NOT NULL AND last_seen_at >= NOW() - ${config.heartbeat.onlineThresholdSeconds} * INTERVAL '1 second')`
    parts.push(f.online ? online : sql`NOT ${online}`)
  }
  if (f.health === 'ok') {
    parts.push(sql`(accessibility_ok IS TRUE AND foreground_ok IS TRUE AND proxy_ok IS TRUE)`)
  } else if (f.health === 'problem') {
    parts.push(
      sql`(accessibility_ok IS NOT TRUE OR foreground_ok IS NOT TRUE OR proxy_ok IS NOT TRUE)`,
    )
  }
  if (f.city) parts.push(sql`last_ip_city = ${f.city}`)
  if (f.q) {
    const like = `%${f.q}%`
    parts.push(sql`(id ILIKE ${like} OR model ILIKE ${like})`)
  }
  return parts.reduce((acc, p) => sql`${acc} AND ${p}`)
}

/** 设备列表（看板用；分页：limit + offset） */
export async function listDevices(
  limit = 200,
  offset = 0,
  filter: DeviceFilter = {},
): Promise<DeviceRow[]> {
  const sql = db()
  const where = deviceWhere(filter)
  return (await sql`
    SELECT id, admin_state, last_seen_at, last_ip, last_ip_city,
           accessibility_ok, foreground_ok, proxy_ok, busy_task_id,
           agent_version, rule_pack_version, douyin_version, clock_offset_sec,
           model, resolution,
           daily_done, daily_done_date, next_eligible_at, fail_streak,
           total_success, total_fail, total_unknown
    FROM devices
    WHERE ${where}
    ORDER BY last_seen_at DESC NULLS LAST
    LIMIT ${limit} OFFSET ${offset}
  `) as unknown as DeviceRow[]
}

/** 设备总数（管理台分页用；口径与 [listDevices] 完全一致） */
export async function countDevices(filter: DeviceFilter = {}): Promise<number> {
  const sql = db()
  const where = deviceWhere(filter)
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM devices WHERE ${where}
  `) as unknown as { n: number }[]
  return rows[0]?.n ?? 0
}
