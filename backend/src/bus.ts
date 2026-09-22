/**
 * 进程内事件总线（Event Bus）：模块之间通过事件解耦，不互相 import 业务逻辑。
 * 例：回执入库后 emit('task.finished')，由统计/告警模块自行订阅。
 */
import { createLogger } from './logger.js'

const log = createLogger('bus')

export type Handler<T = unknown> = (payload: T) => void | Promise<void>

type AnyHandler = (payload: unknown) => void | Promise<void>

const handlers = new Map<string, Set<AnyHandler>>()

/** 订阅 */
export function on<T = unknown>(event: string, handler: Handler<T>): () => void {
  let set = handlers.get(event)
  if (!set) {
    set = new Set()
    handlers.set(event, set)
  }
  set.add(handler as AnyHandler)
  return () => off(event, handler)
}

/** 取消订阅 */
export function off<T = unknown>(event: string, handler: Handler<T>): void {
  const set = handlers.get(event)
  if (!set) return
  set.delete(handler as AnyHandler)
  if (set.size === 0) handlers.delete(event)
}

/** 发布（异步派发；单个订阅者异常不影响其他订阅者） */
export function emit<T = unknown>(event: string, payload?: T): void {
  const set = handlers.get(event)
  if (!set || set.size === 0) return
  for (const handler of set) {
    try {
      const r = (handler as AnyHandler)(payload)
      if (r && typeof (r as Promise<void>).then === 'function') {
        ;(r as Promise<void>).catch((e) => log.error(`handler error event=${event}`, e))
      }
    } catch (e) {
      log.error(`handler error event=${event}`, e)
    }
  }
}

/** 已注册的事件名（调试用） */
export function eventNames(): string[] {
  return [...handlers.keys()].sort()
}

/** 事件名常量（避免手写字符串拼错） */
export const EVENTS = {
  /** 设备心跳到达（payload: { deviceId, atMs }） */
  HEARTBEAT: 'device.heartbeat',
  /** 设备上线 / 离线（payload: { deviceId, from, to }） */
  DEVICE_PRESENCE: 'device.presence',
  /** 设备切 IP 完成（payload: { deviceId, ip, city }） */
  DEVICE_IP_SWITCHED: 'device.ip_switched',
  /** 任务已派发（payload: { taskId, deviceId }） */
  TASK_DISPATCHED: 'task.dispatched',
  /** 任务开始执行（payload: { taskId }） */
  TASK_STARTED: 'task.started',
  /** 任务终态（payload: { taskId, status, reasonCode }） */
  TASK_FINISHED: 'task.finished',
  /** 任务超期转 unknown（payload: { taskId }） */
  TASK_TIMEOUT: 'task.timeout',
  /** 需要告警（payload: { level, code, message, deviceId? }） */
  ALERT: 'alert.raised',
} as const
