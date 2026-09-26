/**
 * 管理台 API 客户端。
 *
 * 统一走 /api/admin 前缀（dev 由 vite 代理到后端，生产由反向代理同域转发），
 * 因此前端代码里不出现 host，也不需要处理跨域。
 */

const BASE = '/api/admin'

export interface Overview {
  devicesTotal: number
  devicesOnline: number
  devicesBusy: number
  tasksToday: number
  tasksSucceeded: number
  tasksUnknown: number
  tasksFailed: number
  postsActive: number
  postsPaused: number
  scriptsEnabled: number
  citiesActive: number
  onlineThresholdSeconds: number
}

export interface DeviceItem {
  id: string
  admin_state: string
  last_seen_at: string | null
  last_ip: string | null
  last_ip_city: string | null
  accessibility_ok: boolean | null
  foreground_ok: boolean | null
  proxy_ok: boolean | null
  busy_task_id: string | null
  agent_version: string | null
  douyin_version: string | null
  model: string | null
  daily_done: number
  daily_done_date: string | null
  next_eligible_at: string | null
  fail_streak: number
  total_success: number
  total_fail: number
  total_unknown: number
  online: boolean
  lastSeenGapSec: number | null
}

export interface TaskItem {
  id: string
  device_id: string | null
  post_id: string
  status: string
  script_text: string | null
  comment_type: string | null
  reason_code: string | null
  evidence: string | null
  dispatched_at: string
  deadline_at: string
  started_at: string | null
  finished_at: string | null
  dispatch_ip_city: string | null
}

export interface PostItem {
  id: string
  url: string
  city: string
  post_type: string | null
  status: string
  title: string | null
  target_count: number
  committed: number
  today_used: number
  last_comment_at: string | null
  total_tasks: number
  succeeded: number
  unknown: number
  failed: number
}

export interface EventItem {
  id: number
  task_id: string
  event: string
  actor: string
  reason_code: string | null
  detail: unknown
  created_at: string
  post_id: string | null
  device_id: string | null
  task_status: string | null
  evidence: string | null
}

export interface OpResult {
  ok: boolean
  error?: string
  detail?: Record<string, unknown>
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: text.slice(0, 300) }
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data as T
}

export const api = {
  overview: () => req<Overview>('/overview'),
  devices: () => req<{ items: DeviceItem[]; onlineThresholdSeconds: number }>('/devices'),
  tasks: (limit = 100) => req<{ items: TaskItem[] }>(`/tasks?limit=${limit}`),
  unknownTasks: (limit = 50) => req<{ items: TaskItem[] }>(`/unknown-tasks?limit=${limit}`),
  posts: (limit = 200) => req<{ items: PostItem[] }>(`/posts?limit=${limit}`),
  events: (limit = 100) => req<{ items: EventItem[] }>(`/events?limit=${limit}`),

  resetCounters: (deviceId: string) =>
    req<OpResult>(`/devices/${encodeURIComponent(deviceId)}/reset-counters`, { method: 'POST' }),

  releaseSlot: (postId: string, body: { deviceId?: string; resetPacing?: boolean } = {}) =>
    req<OpResult>(`/posts/${encodeURIComponent(postId)}/release-slot`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  resolveTask: (taskId: string, verdict: 'succeeded' | 'failed', note?: string) =>
    req<OpResult>(`/tasks/${encodeURIComponent(taskId)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ verdict, note }),
    }),
}

// ── 展示格式化 ─────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')

/** 本地时间 MM-DD HH:mm:ss */
export function fmtTime(v: string | Date | null | undefined): string {
  if (!v) return '-'
  const d = typeof v === 'string' ? new Date(v) : v
  if (Number.isNaN(d.getTime())) return '-'
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 距今多久 */
export function fmtGap(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '从未'
  if (sec < 0) return '刚刚'
  if (sec < 60) return `${sec} 秒前`
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`
  return `${Math.floor(sec / 86400)} 天前`
}

/** 状态 → 语义色（badge tone） */
export function statusTone(status: string): 'ok' | 'warn' | 'err' | 'info' | 'muted' {
  switch (status) {
    case 'succeeded':
      return 'ok'
    case 'unknown':
      return 'warn'
    case 'failed':
    case 'aborted':
      return 'err'
    case 'dispatched':
    case 'executing':
      return 'info'
    case 'active':
      return 'ok'
    case 'paused':
      return 'muted'
    default:
      return 'muted'
  }
}
