/**
 * 契约：后台 → 设备（Platform → Agent）
 * 依据设计文档 §4.1（任务包）、§4.4（心跳/领取响应）、§4.5（指令）。
 * 注意：**响应里没有"计划执行时间"**——拿到即执行（设计文档 §5.1）。
 */
import { z } from 'zod'

/** 动作原语（按顺序执行） */
export const ActionSchema = z.enum(['browse', 'like', 'favorite', 'comment'])
export type Action = z.infer<typeof ActionSchema>

/** 图片素材（随任务携带，内网通道下载） */
export const TaskImageSchema = z.object({
  hash: z.string().min(1),
  url: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
})

/** 任务包（§4.1） */
export const TaskPackageSchema = z.object({
  taskId: z.string().min(1),
  postId: z.string().min(1),
  postUrl: z.string().min(1),
  accountId: z.string().min(1),
  actions: z.array(ActionSchema).min(1),
  commentType: z.enum(['text', 'image']),
  scriptText: z.string().min(1),
  scriptId: z.string().optional(),
  image: TaskImageSchema.optional(),
  /** 回执截止时间（ISO，带 +08:00），超期由后台判 unknown */
  deadlineAt: z.string().min(1),
  /** 派单时刻的出口城市（设备端执行前需自查一致） */
  ipCityTarget: z.string().min(1),
})
export type TaskPackage = z.infer<typeof TaskPackageSchema>

/** 设备指令（commandId 幂等） */
export const CommandSchema = z.object({
  commandId: z.string().min(1),
  kind: z.enum(['probe', 'switch_node', 'pause', 'resume', 'upgrade', 'restart', 'refresh_pool']),
  payload: z.record(z.unknown()).optional(),
  expireAt: z.string().optional(),
})
export type Command = z.infer<typeof CommandSchema>

/** 城市池条目（设备端只读缓存；slug 即 Clash 的 provider 名与 group 名） */
export const CityPoolItemSchema = z.object({
  city: z.string().min(1),
  slug: z.string().min(1),
})

/** 人格档案（§6.5；人格层长期稳定，波动层在设备端抽样） */
export const PersonalitySchema = z.object({
  version: z.number().int().positive(),
  profile: z.record(z.unknown()),
})

/** ① 心跳响应 */
export const HeartbeatResponseSchema = z.object({
  /** 服务端时间（毫秒）+ ISO 文本：设备据此校准 clockOffset */
  serverTimeMs: z.number().int(),
  serverTime: z.string().min(1),
  /** 设备端按此值（±10% 抖动）安排下一次心跳 */
  nextHeartbeatSeconds: z.number().int().positive(),
  commands: z.array(CommandSchema),
  /** 城市池（内容未变化时后台可省略，设备继续用旧缓存） */
  cityPool: z.array(CityPoolItemSchema).optional(),
  cityPoolVersion: z.string().optional(),
  personality: PersonalitySchema.optional(),
  rulePackVersion: z.string().optional(),
  /** 服务端对该设备"是否具备派单资格"的提示（仅供设备端决定要不要去领；最终由 claim 裁决） */
  eligibleForTask: z.boolean(),
})
export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>

/** ② 领取响应 */
export const ClaimResponseSchema = z.object({
  serverTimeMs: z.number().int(),
  serverTime: z.string().min(1),
  task: TaskPackageSchema.nullable(),
  /** 未领到任务时：建议多久后再来（秒） */
  retryAfterSeconds: z.number().int().positive().optional(),
  /** 未派单原因（诊断与统计用，见 types.NO_DISPATCH_REASONS） */
  reason: z.string().optional(),
})
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>

/** ③ 事件 / ④ 回执的通用响应 */
export const AckResponseSchema = z.object({
  ok: z.boolean(),
  serverTimeMs: z.number().int(),
  /** 后台对未决记录的裁决（未知态任务禁止重试） */
  walDecision: z.enum(['unknown_no_retry', 'retry_allowed', 'none']).optional(),
  message: z.string().optional(),
})
export type AckResponse = z.infer<typeof AckResponseSchema>
