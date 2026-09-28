/**
 * 契约：设备 → 后台（Agent → Platform）
 * 依据设计文档 §4.4（心跳 / 领取 / 状态上报）与 §4.5（指令与事件）。
 * 所有来自设备的输入都必须经此校验——外部输入不可信。
 */
import { z } from 'zod'

/** 设备状态快照（心跳第 1 段的载体） */
export const DeviceStateSchema = z.object({
  battery: z.number().int().min(0).max(100).optional(),
  storageFreeMb: z.number().int().nonnegative().optional(),
  /** 无障碍服务是否启用（决定能否干活） */
  accessibilityOk: z.boolean(),
  /** Agent 前台服务是否存活 */
  foregroundOk: z.boolean(),
  /** 代理是否连通 */
  proxyOk: z.boolean(),
  /** 出口 IP（必须由设备走代理请求公网探针获得，不能是内网地址） */
  ip: z.string().min(3),
  /** 出口 IP 所属城市（属地校验依据） */
  ipCity: z.string().min(1),
  /** IPv6 是否泄露（true 表示存在直连风险） */
  ipv6Leak: z.boolean().optional(),
  agentVersion: z.string().min(1),
  rulePackVersion: z.string().optional(),
  douyinVersion: z.string().optional(),
  /** 本机时钟偏移（秒，正数表示设备快） */
  clockOffsetSec: z.number().int().optional(),
})

/** 机型档案（多机型适配与规则包分槽依据，§3.7） */
export const DeviceProfileSchema = z.object({
  model: z.string().min(1),
  resolution: z.string().regex(/^\d{3,5}x\d{3,5}$/, 'resolution 形如 2400x1080'),
  dpi: z.number().int().positive().optional(),
  osVersion: z.string().min(1),
  romVersion: z.string().optional(),
  fontScale: z.number().positive().optional(),
  darkMode: z.boolean().optional(),
})

/** 本地未决记录（WAL，需后台裁决） */
export const WalPendingSchema = z.object({
  taskId: z.string().min(1),
  state: z.string().min(1),
})

/** ① 心跳请求 */
export const HeartbeatRequestSchema = z.object({
  deviceId: z.string().min(8),
  /** 单调递增序号，用于检测重复 / 乱序 */
  seq: z.number().int().nonnegative(),
  state: DeviceStateSchema,
  profile: DeviceProfileSchema.optional(),
  /** 当前正在执行的任务（无则 null） */
  busyTaskId: z.string().nullable().optional(),
  walPending: z.array(WalPendingSchema).max(50).optional(),
  /** 设备本地时间（毫秒），仅用于诊断 */
  at: z.number().int().optional(),
})
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>

/** 设备自检结果（指令 probe 的产出） */
export const ProbeResultSchema = z.object({
  nodeHits: z.record(z.boolean()).optional(),
  screenOk: z.boolean().optional(),
  actionsOk: z.record(z.boolean()).optional(),
  notes: z.string().optional(),
})

/** ② 任务领取请求 */
export const ClaimRequestSchema = z.object({
  deviceId: z.string().min(8),
  seq: z.number().int().nonnegative(),
  /** 距上次完成的秒数（设备端的猜测，仅作诊断，不作判定依据） */
  sinceLastFinishSec: z.number().int().nonnegative().optional(),
  /**
   * 领取**当下**的属地（省级、已归一化）。后台**优先**用它做属地匹配。
   *
   * 心跳最多 30 秒才刷新一次 `last_ip_city`，而被动换 IP（节点故障转移、代理重连、
   * WiFi↔4G、公网 IP 漂移）没有即时事件 —— 只用库里的值会派出一条当前属地不匹配的
   * 任务，设备执行时 ip_mismatch 白跑。缺省 / 为 'unknown' 时回退库值（兼容旧设备）。
   */
  ipCity: z.string().min(1).max(32).optional(),
})
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>

/** 设备事件类型 */
export const AgentEventTypeSchema = z.enum([
  'task_started', // 开工信号（"我要开始了"）
  'task_aborted', // 本地校验不通过或安全类中止
  'ip_switched', // 切 IP 完成（必须携带新 IP 与属地）
  'device_offline_notice', // 本地发现无网络
  'command_result', // 指令执行结果
  'probe_result', // 自检结果
])
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>

/** ③ 事件上报请求（独立于心跳，即时上报） */
export const EventRequestSchema = z.object({
  deviceId: z.string().min(8),
  event: AgentEventTypeSchema,
  taskId: z.string().optional(),
  commandId: z.string().optional(),
  reasonCode: z.string().optional(),
  /** 切 IP 事件必填 */
  ip: z.string().optional(),
  ipCity: z.string().optional(),
  ipv6Leak: z.boolean().optional(),
  detail: z.record(z.unknown()).optional(),
  at: z.number().int().optional(),
})
export type EventRequest = z.infer<typeof EventRequestSchema>

/** 任务终态（设备可写的终态） */
export const ReceiptStatusSchema = z.enum(['succeeded', 'failed', 'aborted', 'unknown'])
export type ReceiptStatus = z.infer<typeof ReceiptStatusSchema>

/** ④ 回执请求 */
export const ReceiptRequestSchema = z.object({
  deviceId: z.string().min(8),
  taskId: z.string().min(1),
  status: ReceiptStatusSchema,
  /** 失败/中止原因码（如 captcha / rate_limited / element_missing / ip_mismatch） */
  reasonCode: z.string().optional(),
  /** 证据标识（截图文件名或节点文本摘要） */
  evidence: z.string().optional(),
  /** 幂等键：同一回执重传时由后台去重 */
  idempotencyKey: z.string().optional(),
  startedAt: z.number().int().optional(),
  finishedAt: z.number().int().optional(),
  detail: z.record(z.unknown()).optional(),
})
export type ReceiptRequest = z.infer<typeof ReceiptRequestSchema>

/** 统一：把 Zod 校验错误转成简短可读文本 */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
}
