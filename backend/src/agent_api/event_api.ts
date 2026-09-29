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

/**
 * 事件里的任务是否属于上报设备。
 *
 * ⚠ 与回执接口同一个道理：早期只校验"设备已登记"，任一设备都能改**别人**任务的状态
 *   （开工 / 中止），会污染对方的计数与帖子名额。归属不符时拒绝并留痕 ——
 *   这类污染事后几乎无法归因（看不出是"谁"把任务改成 aborted 的）。
 */
async function ownedByDevice(taskId: string, deviceId: string): Promise<boolean> {
  const task = await getTask(taskId)
  if (!task) {
    log.warn(`event task not found task=${taskId} device=${deviceId}`)
    return false
  }
  if (task.device_id && task.device_id !== deviceId) {
    log.warn(
      `event device mismatch task=${taskId} owner=${task.device_id} sender=${deviceId} → reject`,
    )
    return false
  }
  return true
}

route.post('/', async (c) => {
  const g = await guard(c, EventRequestSchema)
  if (!g) return c.res

  const { device, data } = g
  const sql = db()

  switch (data.event) {
    // ── 开工信号：任务 → executing（提升 unknown 判定精度）──
    case 'task_started': {
      if (!data.taskId) break
      if (!(await ownedByDevice(data.taskId, device.id))) break
      const ok = await markStarted(data.taskId)
      log.info(`task_started device=${device.id} task=${data.taskId} accepted=${ok}`)
      break
    }

    // ── 本地中止：立即落终态（不得静默丢弃）。归因要分两类 ──
    //
    //  · 设备**确认未发出**的本地中止（元素未命中、属地不符、超时未提交…）→ aborted：
    //    退还当日配额、释放帖子名额与素材；
    //  · **崩溃恢复**（reasonCode 以 crash_recovery 开头）→ **unknown**：
    //    进程是在评论**可能已经发出**之后被杀掉的，绝不能当"确认未发出" ——
    //    那样名额一释放、配额一退还，同一设备会被重新派到同一帖，同帖出现两条评论。
    //    （新版设备端已改走回执通道报 unknown；这条分支是给尚未升级的旧包兜底。）
    case 'task_aborted': {
      if (!data.taskId) break
      if (!(await ownedByDevice(data.taskId, device.id))) break
      const crashRecovery = (data.reasonCode ?? '').startsWith('crash_recovery')
      const task = await getTask(data.taskId)
      if (task && !['succeeded', 'failed', 'aborted', 'unknown'].includes(task.status)) {
        await finishTask(data.taskId, crashRecovery ? 'unknown' : 'aborted', {
          reasonCode: crashRecovery
            ? 'crash_recovery_unknown'
            : (data.reasonCode ?? 'aborted_by_device'),
          actor: 'device',
          detail: data.detail,
        })
      }
      log.warn(
        `task_aborted device=${device.id} task=${data.taskId} reason=${data.reasonCode ?? '-'} ` +
          `→ ${crashRecovery ? 'unknown（可能已发出，禁止自动重试）' : 'aborted'}`,
      )
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
