/**
 * ① 心跳接口（POST /agent/heartbeat）
 * 职责：同步设备状态（唯一职责）+ 下发指令 + 下发城市池/人格档案/规则包版本。
 * 注意：**心跳不派发任务**——任务走独立的领取接口（2026-09-20 拆分决定）。
 */
import { Hono } from 'hono'
import { config } from '../config.js'
import { createLogger } from '../logger.js'
import { nowMs, toLocalIso } from '../datetime.js'
import { HeartbeatRequestSchema } from '../contracts/agent.js'
import { applyHeartbeat } from '../device/device_store.js'
import { eligibleForTask } from '../dispatch/dispatcher.js'
import { listCityPool } from '../post/post_store.js'
import { takePendingCommands } from '../device/command_store.js'
import { getPersonality } from '../person/personality_store.js'
import { buildHeartbeatResponse } from '../contracts/assembler.js'
import { guard } from './guard.js'

const log = createLogger('heartbeat')
const route = new Hono()

route.post('/', async (c) => {
  // 心跳是登记入口：陌生 deviceId 允许通过，由 applyHeartbeat 的 UPSERT 自动登记
  const g = await guard(c, HeartbeatRequestSchema, { allowUnknown: true })
  if (!g) return c.res

  const { data } = g
  const row = await applyHeartbeat(data)

  // 指令：取出待下发并标记 delivered
  const commands = await takePendingCommands(row.id)

  // 城市池：仅在内容变化时下发（设备端继续用旧缓存）
  const pool = await listCityPool()
  const poolVersion = pool.map((p) => p.slug).sort().join(',')

  // 人格档案按设备下发（P3 会真正用到 profile 内容）
  const personality = await loadPersonality(row.id)

  // 是否有派单资格（仅提示；最终由 claim 裁决）
  const eligible = await eligibleForTask(row.id)

  const resp = buildHeartbeatResponse({
    serverTimeMs: nowMs(),
    nextHeartbeatSeconds: config.heartbeat.seconds,
    commands,
    cityPool: pool.length > 0 ? pool : undefined,
    cityPoolVersion: poolVersion || undefined,
    personality,
    rulePackVersion: row.rule_pack_version ?? 'base',
    eligibleForTask: eligible,
  })

  log.debug(
    `hb device=${row.id} seq=${data.seq} city=${data.state.ipCity} busy=${data.busyTaskId ?? '-'} ` +
      `cmds=${commands.length} eligible=${eligible}`,
  )

  return c.json({
    ...resp,
    serverTime: toLocalIso(resp.serverTimeMs),
  })
})

/** 载入人格档案（表可能为空；P3 之前返回 undefined） */
async function loadPersonality(
  deviceId: string | null,
): Promise<{ version: number; profile: Record<string, unknown> } | undefined> {
  if (!deviceId) return undefined
  const p = await getPersonality(deviceId)
  return p ? { version: p.version, profile: p.profile } : undefined
}

export default route
