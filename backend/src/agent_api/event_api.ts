/**
 * ③ 事件上报接口（POST /agent/event）
 * 独立于心跳、即时上报：开工信号、本地中止、切 IP 完成、指令结果、自检结果。
 */
import { Hono } from 'hono'
import { db } from '../db_pg.js'
import { createLogger } from '../logger.js'
import { nowMs } from '../datetime.js'
import { emit, EVENTS } from '../bus.js'
import { EventRequestSchema } from '../contracts/agent.js'
import { buildAck } from '../contracts/assembler.js'
import { markStarted, finishTask, getTask } from '../task/task_store.js'
import { completeCommand } from '../device/command_store.js'
import { guard } from './guard.js'

const log = createLogger('event')
const route = new Hono()

route.post('/', async (c) => {
  const g = await guard(c, EventRequestSchema)
  if (!g) return c.res

  const { device, data } = g
  const sql = db()

  switch (data.event) {
    // ── 开工信号：任务 → executing（提升 unknown 判定精度）──
    case 'task_started': {
      if (!data.taskId) break
      const ok = await markStarted(data.taskId)
      log.info(`task_started device=${device.id} task=${data.taskId} accepted=${ok}`)
      break
    }

    // ── 本地校验不通过或安全类中止：立即落终态 aborted（不得静默丢弃）──
    case 'task_aborted': {
      if (!data.taskId) break
      const task = await getTask(data.taskId)
      if (task && task.status !== 'succeeded' && task.status !== 'failed') {
        await finishTask(data.taskId, 'aborted', {
          reasonCode: data.reasonCode ?? 'aborted_by_device',
          actor: 'device',
          detail: data.detail,
        })
      }
      log.warn(`task_aborted device=${device.id} task=${data.taskId} reason=${data.reasonCode ?? '-'}`)
      break
    }

    // ── 切 IP 完成：更新属地 + 事件流 + 告警（属地为空或泄露要提示）──
    case 'ip_switched': {
      await sql`
        UPDATE devices SET last_ip = COALESCE(${data.ip ?? null}, last_ip),
                           last_ip_city = COALESCE(${data.ipCity ?? null}, last_ip_city),
                           ipv6_leak = COALESCE(${data.ipv6Leak ?? null}, ipv6_leak),
                           updated_at = NOW()
        WHERE id = ${device.id}
      `
      await sql`
        INSERT INTO device_events (device_id, event, detail)
        VALUES (${device.id}, 'ip_switched',
                ${JSON.stringify({ ip: data.ip, city: data.ipCity, ipv6Leak: data.ipv6Leak, detail: data.detail })}::jsonb)
      `
      emit(EVENTS.DEVICE_IP_SWITCHED, { deviceId: device.id, ip: data.ip, city: data.ipCity })
      if (data.ipv6Leak === true) {
        emit(EVENTS.ALERT, {
          level: 'error',
          code: 'ipv6_leak',
          message: `设备 ${device.id} 存在 IPv6 泄露，属地可能闪现实地址`,
          deviceId: device.id,
        })
      }
      log.info(`ip_switched device=${device.id} ip=${data.ip ?? '-'} city=${data.ipCity ?? '-'}`)
      break
    }

    // ── 指令结果 ──
    case 'command_result': {
      if (!data.commandId) break
      const ok = (data.detail?.ok as boolean | undefined) ?? true
      await completeCommand(data.commandId, ok, data.detail)
      break
    }

    // ── 自检结果（用于新机型门禁适配，见 §3.7）──
    case 'probe_result': {
      await sql`
        INSERT INTO device_events (device_id, event, detail)
        VALUES (${device.id}, 'probe_result', ${JSON.stringify(data.detail ?? {})}::jsonb)
      `
      log.info(`probe_result device=${device.id}`)
      break
    }

    // ── 本地发现无网络（告警，不改任务状态）──
    case 'device_offline_notice': {
      await sql`
        INSERT INTO device_events (device_id, event, reason, detail)
        VALUES (${device.id}, 'warn', 'device_offline_notice', ${JSON.stringify(data.detail ?? {})}::jsonb)
      `
      break
    }

    default:
      break
  }

  return c.json(
    buildAck({
      ok: true,
      serverTimeMs: nowMs(),
      walDecision: 'none',
    }),
  )
})

export default route
