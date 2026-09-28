/**
 * ② 任务领取接口（POST /agent/task/claim）
 *
 * 与心跳完全独立：设备空闲时按「上次完成 + 本机随机 30–60 分钟」猜测时机来问；
 * **设备只猜时机，后台做裁决**（20 条约束）。被拒时返回 retryAfterSeconds 退避。
 */
import { Hono } from 'hono'
import { createLogger } from '../logger.js'
import { nowMs, toLocalIso } from '../datetime.js'
import { ClaimRequestSchema } from '../contracts/agent.js'
import { dispatchTo } from '../dispatch/dispatcher.js'
import { guard } from './guard.js'

const log = createLogger('claim')
const route = new Hono()

route.post('/', async (c) => {
  const g = await guard(c, ClaimRequestSchema)
  if (!g) return c.res

  const { device, data } = g
  // 把请求里带的「领取当下属地」透传给派单：它比 devices.last_ip_city 新
  // （后者最多滞后一个心跳周期），可避免被动换 IP 时的 ip_mismatch 白跑。
  const outcome = await dispatchTo(device.id, data.ipCity)
  const serverTimeMs = nowMs()

  if (!outcome.task) {
    // 未派单是最需要诊断的路径：必须把原因与建议重试秒数打到 info 级别
    log.info(
      `claim miss device=${device.id} reason=${outcome.reason} retry=${outcome.retryAfterSeconds}s`,
    )
    return c.json({
      serverTimeMs,
      serverTime: toLocalIso(serverTimeMs),
      task: null,
      retryAfterSeconds: outcome.retryAfterSeconds ?? 300,
      reason: outcome.reason,
    })
  }

  log.info(`claim hit device=${device.id} task=${outcome.task.taskId}`)
  return c.json({
    serverTimeMs,
    serverTime: toLocalIso(serverTimeMs),
    task: outcome.task,
    reason: undefined,
  })
})

export default route
