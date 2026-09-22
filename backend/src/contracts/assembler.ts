/**
 * 响应组装器：统一在此构造并**用 Zod 校验**后台返回给设备的结构。
 * 好处：契约改动会立刻在运行时报错，而不是等设备端解析失败才发现。
 */
import {
  AckResponseSchema,
  ClaimResponseSchema,
  HeartbeatResponseSchema,
  type AckResponse,
  type ClaimResponse,
  type HeartbeatResponse,
  type TaskPackage,
} from './platform.js'

export function buildHeartbeatResponse(input: {
  serverTimeMs: number
  nextHeartbeatSeconds: number
  commands: HeartbeatResponse['commands']
  cityPool?: HeartbeatResponse['cityPool']
  cityPoolVersion?: string
  personality?: HeartbeatResponse['personality']
  rulePackVersion?: string
  eligibleForTask: boolean
}): HeartbeatResponse {
  return HeartbeatResponseSchema.parse({
    ...input,
    serverTime: new Date(input.serverTimeMs).toISOString(),
  })
}

export function buildClaimResponse(input: {
  serverTimeMs: number
  task: TaskPackage | null
  retryAfterSeconds?: number
  reason?: string
}): ClaimResponse {
  return ClaimResponseSchema.parse({
    serverTimeMs: input.serverTimeMs,
    serverTime: new Date(input.serverTimeMs).toISOString(),
    task: input.task,
    retryAfterSeconds: input.task ? undefined : (input.retryAfterSeconds ?? 300),
    reason: input.reason,
  })
}

export function buildAck(input: {
  ok: boolean
  serverTimeMs: number
  walDecision?: AckResponse['walDecision']
  message?: string
}): AckResponse {
  return AckResponseSchema.parse(input)
}
