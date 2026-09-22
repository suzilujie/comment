/**
 * 共享类型（非契约部分）。
 * 设备 ↔ 后台的请求/响应契约统一用 Zod 定义在 contracts/ 下，此处只放内部类型。
 */

/** 任务状态（5 态，设计文档 §5.4） */
export type TaskStatus =
  | 'dispatched' // 已随领取接口派发，设备持有
  | 'executing' // 设备已上报 task_started
  | 'succeeded'
  | 'failed'
  | 'aborted'
  | 'unknown' // 可能已发出 → 人工确认，禁止自动重试

/** 终态集合 */
export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  'succeeded',
  'failed',
  'aborted',
  'unknown',
]

/** 在途状态（占用账号与设备） */
export const IN_FLIGHT_STATUSES: readonly TaskStatus[] = ['dispatched', 'executing']

export function isTerminal(s: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(s)
}

export function isInFlight(s: TaskStatus): boolean {
  return IN_FLIGHT_STATUSES.includes(s)
}

/** 事件的操作方（用于 task_events.actor） */
export type Actor = 'platform' | 'device' | 'manual'

/** 设备管理态（仅"启用 / 停用"：停用是应急开关，非设备状态；在线/离线由心跳派生） */
export type AdminState = 'enabled' | 'disabled'

/** 账号状态 */
export type AccountStatus = 'active' | 'paused' | 'banned'

/** 设备指令类型（随心跳响应下发） */
export type CommandKind =
  | 'probe' // 自检：回执一份完整状态
  | 'switch_node' // 切换节点组
  | 'pause' // 暂停接单
  | 'resume'
  | 'upgrade' // 升级 Agent
  | 'restart'
  | 'refresh_pool' // 重新同步城市池

/** 设备可用性（派生量，见 §3.8） */
export interface DeviceAvailability {
  online: boolean
  dispatchable: boolean
  /** 不可派单的原因（诊断与看板展示） */
  reasons: string[]
}

/** 告警载荷（bus 事件 payload） */
export interface AlertPayload {
  level: 'info' | 'warn' | 'error'
  code: string
  message: string
  deviceId?: string
  taskId?: string
  detail?: unknown
}

/** 派单求解的候选（内部用） */
export interface DispatchCandidate {
  postId: string
  postUrl: string
  postCity: string
  postType: 'video' | 'image' | null
  commentType: 'text' | 'image'
  scriptId: string
  scriptText: string
  imageHash?: string
  imagePath?: string
}

/** 派单求解结果 */
export type DispatchResult =
  | { ok: true; candidate: DispatchCandidate }
  | { ok: false; reason: string }

/** 未派单原因码（便于统计"为什么没派单"） */
export const NO_DISPATCH_REASONS = {
  DEVICE_NOT_FOUND: 'device_not_found',
  DEVICE_NOT_ONLINE: 'device_not_online',
  DEVICE_UNHEALTHY: 'device_unhealthy',
  DEVICE_BUSY: 'device_busy',
  DEVICE_PAUSED: 'device_paused',
  ACCOUNT_NOT_ELIGIBLE: 'account_not_eligible',
  ACCOUNT_DAILY_QUOTA: 'account_daily_quota',
  ACCOUNT_INTERVAL: 'account_interval',
  OUTSIDE_TIME_WINDOW: 'outside_time_window',
  GLOBAL_DENSITY: 'global_density',
  NO_POST_IN_CITY: 'no_post_in_city',
  NO_POST_AVAILABLE: 'no_post_available',
  NO_MATERIAL: 'no_material',
} as const

export type NoDispatchReason = (typeof NO_DISPATCH_REASONS)[keyof typeof NO_DISPATCH_REASONS]

/** 派单约束检查结果 */
export interface ConstraintCheck {
  pass: boolean
  reason?: string
}
