/**
 * ④ 回执接口（POST /agent/receipt）
 * 独立于心跳即时上报；幂等（重复回执不重复记账）。
 *
 * 状态规则（设计文档 §5.4）：
 *  - succeeded：计入配额消耗，刷新 next_eligible_at；
 *  - failed / aborted（**确认未发出**）：退还当日配额；
 *  - unknown：不退还，转人工确认，**禁止自动重试**。
 */
import { Hono } from 'hono'
import { createLogger } from '../logger.js'
import { nowMs } from '../datetime.js'
import { ReceiptRequestSchema } from '../contracts/agent.js'
import { buildAck } from '../contracts/assembler.js'
import { appendEvent, finishTask, getTask } from '../task/task_store.js'
import { guard } from './guard.js'

const log = createLogger('receipt')
const route = new Hono()

route.post('/', async (c) => {
  const g = await guard(c, ReceiptRequestSchema)
  if (!g) return c.res

  const { device, data } = g
  const task = await getTask(data.taskId)
  if (!task) {
    return c.json({ ...buildAck({ ok: false, serverTimeMs: nowMs(), message: 'task not found' }) }, 404)
  }

  // ⚠ 归属校验：只允许**任务所属的那台设备**上报该任务的回执。
  //    早期只校验"设备已登记"，于是任一设备都能终结**别人**的任务 —— 会污染对方的
  //    计数与帖子名额（把别人的任务改成 succeeded/failed），且事后极难归因到"谁改的"。
  if (task.device_id && task.device_id !== device.id) {
    log.warn(
      `receipt device mismatch task=${data.taskId} owner=${task.device_id} sender=${device.id} → reject`,
    )
    return c.json(
      { ...buildAck({ ok: false, serverTimeMs: nowMs(), message: 'task not owned by this device' }) },
      403,
    )
  }

  // 幂等：已是终态则只记录事件，不重复记账。
  // ⚠ 这里**不含 unknown** —— unknown 不是终态，迟到的真回执应当能把它收敛成确定结论
  //    （finishTask 内部有原子守卫，重复/并发终结不会重复记账）。
  if (['succeeded', 'failed', 'aborted'].includes(task.status)) {
    log.warn(`receipt duplicate task=${data.taskId} current=${task.status} ignore`)
    await appendEvent(data.taskId, 'receipt_duplicate', 'device', data.reasonCode, {
      reported: data.status,
      current: task.status,
    })
    return c.json(
      buildAck({ ok: true, serverTimeMs: nowMs(), walDecision: 'none', message: 'already terminal' }),
    )
  }

  await finishTask(data.taskId, data.status, {
    reasonCode: data.reasonCode,
    evidence: data.evidence,
    actor: 'device',
    detail: data.detail,
  })

  log.info(
    `receipt task=${data.taskId} device=${device.id} status=${data.status}` +
      `${data.reasonCode ? ` reason=${data.reasonCode}` : ''}` +
      `${data.evidence ? ` evidence=${data.evidence}` : ''}`,
  )

  return c.json(
    buildAck({
      ok: true,
      serverTimeMs: nowMs(),
      // 设备若报告 unknown，明确告知禁止重试（幂等底线）
      walDecision: data.status === 'unknown' ? 'unknown_no_retry' : 'none',
    }),
  )
})

export default route
