/**
 * 管理台 API 客户端。
 *
 * 统一走 /api/admin 前缀（dev 由 vite 代理到后端，生产由反向代理同域转发），
 * 因此前端代码里不出现 host，也不需要处理跨域。
 *
 * 鉴权：除 `/login` 外所有接口都要 `Authorization: Bearer <token>`；
 *      401 时自动清 token 并回调（由 App 跳回登录页）。
 */

const BASE = '/api/admin'

// ── 登录态 ──────────────────────────────────────────────────
// token 无状态（后端 HMAC 签发），前端只需存下来随请求带上。

const TOKEN_KEY = 'comment-admin-token'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

function saveToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* 隐私模式等场景 localStorage 不可用，忽略即可 */
  }
}

/** 退出登录：token 无状态，清本地即可，服务端无需通知 */
export function logout(): void {
  saveToken(null)
}

let onUnauthorized: (() => void) | null = null

/** 由 App 注册：收到 401 时回登录页 */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn
}

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
  /** 设备名（设备端「设置 → 设备名称」录入；未录入时为 null） */
  name: string | null
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
  /**
   * 当前派不出去的原因（`null` = 可派）。
   * 典型值：`话术已用尽` / `图文帖缺图片` —— 需要人工补素材，不是"这个省没活"。
   */
  blocked_reason: string | null
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

export interface MaterialItem {
  id: string
  hash: string
  path: string
  size_bytes: number | null
  enabled: boolean
  created_at: string
  /** 被多少个帖子用过（>0 时删除会影响这些帖子的素材占用） */
  used_by_posts: number
}

export interface ScriptItem {
  id: string
  text: string
  enabled: boolean
  created_at: string
  used_by_posts: number
}

export interface CityItem {
  city: string
  slug: string
  active: boolean
  post_count: number
  remark: string | null
  updated_at: string
}

export interface CommandItem {
  id: string
  device_id: string
  kind: string
  status: string
  created_at: string
  delivered_at: string | null
  finished_at: string | null
  result: unknown
}

/** 管理台可下发的设备指令（与后台 SENDABLE_COMMANDS 保持一致） */
export const COMMAND_KINDS = [
  { kind: 'claim_now', label: '立即领取', hint: '跳过本机 30~60 分钟等待，立刻请求派单' },
  { kind: 'rotate_now', label: '立即切省', hint: '跳过 2 天周期，立刻执行一次跨省切换' },
  { kind: 'probe', label: '运行自检', hint: '采集机型/权限/出口/元素命中情况' },
  { kind: 'pause', label: '暂停接单', hint: '设备停止领取任务' },
  { kind: 'resume', label: '恢复接单', hint: '设备恢复领取任务' },
  { kind: 'refresh_pool', label: '刷新省份池', hint: '立刻拉取一次省份池配置' },
  { kind: 'restart', label: '重启服务', hint: '重启设备端常驻服务（不影响无障碍授权）' },
] as const

export type CommandKind = (typeof COMMAND_KINDS)[number]['kind']

/**
 * 统一请求：自动携带 Bearer token。
 * `handle401: false` 用于登录接口自身 —— 否则会把「用户名或密码错误」
 * 误判成「登录已过期」，并触发一次多余的跳转。
 */
async function req<T>(
  path: string,
  init?: RequestInit,
  opts: { handle401?: boolean } = {},
): Promise<T> {
  const token = getToken()
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: text.slice(0, 300) }
  }

  if (res.status === 401) {
    const msg = (data as { error?: string } | null)?.error ?? '用户名或密码错误'
    if (opts.handle401 !== false) {
      saveToken(null)
      onUnauthorized?.()
    }
    throw new Error(msg)
  }

  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`
    throw new Error(msg)
  }
  return data as T
}

export interface LoginResult {
  ok: boolean
  token: string
  username: string
  expiresInHours: number
}

// ── 分页 ────────────────────────────────────────────────────

/** 管理台所有列表接口的统一返回：当前页条目 + 总数（用于算总页数） */
export interface Paged<T> {
  items: T[]
  total: number
}

// ── 系统设置（管理台「系统设置」页）────────────────────────────
// 优先级：**页面设置 > .env > config.ts 默认值**。页面没动过的键库里没有行，跟随 .env。

export type SettingKind = 'int' | 'bool' | 'time'
export type SettingGroup = 'dispatch' | 'heartbeat'

/** 一项可配置参数：当前值 + 来源 + 边界（边界由后端 SETTING_DEFS 给出，前端据此预校验） */
export interface SettingItem {
  key: string
  group: SettingGroup
  label: string
  hint: string
  /** time 的 value 是「当天第几分钟」，页面用 HH:MM 显示 */
  kind: SettingKind
  min: number | null
  max: number | null
  value: number | boolean
  /** db = 页面上设置过（覆盖 .env）；env = 跟随 .env / 默认值 */
  source: 'db' | 'env'
  /** 同一个键在 .env / config.ts 里的值 */
  envValue: number | boolean
  /** 是否已被页面覆盖（= 与 envValue 不同） */
  overridden: boolean
}

export interface SettingHistoryItem {
  key: string
  old_value: number | boolean | null
  new_value: number | boolean | null
  actor: string | null
  created_at: string
}

export interface SettingsResponse {
  items: SettingItem[]
  /** 只读环境信息（端口 / 连接池 / 目录…）：排障要看，但不适合在页面上改 */
  readonly: { label: string; value: string }[]
  history: SettingHistoryItem[]
}

/** 保存/恢复结果：校验失败时 detail.errors 逐字段给出原因 */
export interface SettingsSaveResult {
  ok: boolean
  error?: string
  detail?: { errors?: Record<string, string>; changed?: number; reset?: string[] }
}

export interface PageQuery {
  limit?: number
  offset?: number
}

/** 任务列表筛选（**必须服务端过滤**，否则只作用于当前页，页码与总数会错位） */
export interface TaskQuery extends PageQuery {
  /** dispatched / executing / succeeded / failed / aborted / unknown */
  status?: string
  /** 关键词：任务 ID / 帖子 ID / 设备 ID */
  q?: string
}

/** 设备列表筛选 */
export interface DeviceQuery extends PageQuery {
  /** 在线：true=在线 / false=离线 / 缺省=全部（false 与缺省语义不同，不能省略） */
  online?: boolean
  /** 'ok'=三项自检全绿 / 'problem'=任一异常 */
  health?: 'ok' | 'problem'
  /** 属地（省级，精确匹配） */
  city?: string
  /** 关键词：设备 ID / 机型 */
  q?: string
}

/** 帖子池筛选 */
export interface PostQuery extends PageQuery {
  status?: string
  /** 属地（省级，精确匹配） */
  city?: string
  /** video | image */
  postType?: string
  /** true = 只看「有余量却派不出去」（缺素材）的帖子 */
  blocked?: boolean
}

/**
 * 拼查询串：跳过 `undefined` / `null` / 空串（= 不筛），并省略 `offset=0`
 * （保持 URL 干净，排障时一眼能看出到底带了哪些筛选）。
 *
 * ⚠ **绝不能跳过 `false`** —— 设备的 `online=false`（只看离线）与根本不上报（看全部）
 * 是两个不同语义，用 `if (v)` 判断会把前者静默吞掉。
 */
function qs(p?: object): string {
  if (!p) return ''
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (v === undefined || v === null || v === '') continue
    if (k === 'offset' && v === 0) continue
    s.set(k, String(v))
  }
  const t = s.toString()
  return t ? `?${t}` : ''
}

export const api = {
  /** 登录成功即写入 token（后续请求自动携带） */
  login: async (username: string, password: string): Promise<LoginResult> => {
    const r = await req<LoginResult>(
      '/login',
      { method: 'POST', body: JSON.stringify({ username, password }) },
      { handle401: false },
    )
    saveToken(r.token)
    return r
  },

  overview: () => req<Overview>('/overview'),
  devices: (p?: DeviceQuery) =>
    req<Paged<DeviceItem> & { onlineThresholdSeconds: number }>(`/devices${qs(p)}`),
  tasks: (p?: TaskQuery) => req<Paged<TaskItem>>(`/tasks${qs(p)}`),
  unknownTasks: (p?: PageQuery) => req<Paged<TaskItem>>(`/unknown-tasks${qs(p)}`),
  posts: (p?: PostQuery) => req<Paged<PostItem>>(`/posts${qs(p)}`),
  events: (p?: PageQuery) => req<Paged<EventItem>>(`/events${qs(p)}`),

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

  // ── 帖子 CRUD ─────────────────────────────────────────────

  createPost: (input: {
    id?: string
    url: string
    city: string
    postType?: 'video' | 'image'
    title?: string
    targetCount?: number
    status?: string
  }) => req<OpResult>('/posts', { method: 'POST', body: JSON.stringify(input) }),

  updatePost: (
    id: string,
    patch: {
      url?: string
      city?: string
      postType?: 'video' | 'image'
      title?: string
      targetCount?: number
      status?: string
    },
  ) => req<OpResult>(`/posts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deletePost: (id: string) =>
    req<OpResult>(`/posts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── 素材 ──────────────────────────────────────────────────

  materials: (p?: PageQuery) => req<Paged<MaterialItem>>(`/materials${qs(p)}`),

  /**
   * 上传素材（multipart）。
   *
   * ⚠ 不能复用 `req()` —— 它固定设置 `Content-Type: application/json`，
   * 而 multipart 的 boundary 必须由浏览器生成，手写会导致后台解析失败。
   */
  uploadMaterial: async (file: File): Promise<OpResult> => {
    const token = getToken()
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch(`${BASE}/materials`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd,
    })
    const text = await res.text()
    let data: OpResult = { ok: false }
    try {
      data = (text ? JSON.parse(text) : { ok: false }) as OpResult
    } catch {
      data = { ok: false, error: text.slice(0, 200) }
    }
    if (res.status === 401) {
      saveToken(null)
      onUnauthorized?.()
      throw new Error('登录已过期')
    }
    return data
  },

  updateMaterial: (id: string, enabled: boolean) =>
    req<OpResult>(`/materials/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),

  deleteMaterial: (id: string) =>
    req<OpResult>(`/materials/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── 话术 ──────────────────────────────────────────────────

  scripts: (p?: PageQuery) => req<Paged<ScriptItem>>(`/scripts${qs(p)}`),

  createScript: (text: string) =>
    req<OpResult>('/scripts', { method: 'POST', body: JSON.stringify({ text }) }),

  updateScript: (id: string, patch: { text?: string; enabled?: boolean }) =>
    req<OpResult>(`/scripts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteScript: (id: string) =>
    req<OpResult>(`/scripts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ── 省份池（接口路径仍是 /city-pools，属既有契约，不改）──────

  /**
   * `availableProvinces` = 尚未入池的**标准**省份名。
   * 用它做下拉，避免手输错别字（池里出现「河北省」会让该省的帖子永远派不出去）。
   */
  cities: (p?: PageQuery) =>
    req<Paged<CityItem> & { availableProvinces: string[] }>(`/city-pools${qs(p)}`),

  /** slug 由后端按省份名推导（PROVINCE_SLUGS），前端不再传 */
  createCity: (city: string) =>
    req<OpResult>('/city-pools', { method: 'POST', body: JSON.stringify({ city }) }),

  updateCity: (city: string, active: boolean) =>
    req<OpResult>(`/city-pools/${encodeURIComponent(city)}`, {
      method: 'PATCH',
      body: JSON.stringify({ active }),
    }),

  deleteCity: (city: string) =>
    req<OpResult>(`/city-pools/${encodeURIComponent(city)}`, { method: 'DELETE' }),

  // ── 设备指令 ──────────────────────────────────────────────

  commands: (p?: PageQuery) => req<Paged<CommandItem>>(`/commands${qs(p)}`),

  sendCommand: (deviceId: string, kind: CommandKind, payload?: Record<string, unknown>) =>
    req<OpResult>(`/devices/${encodeURIComponent(deviceId)}/commands`, {
      method: 'POST',
      body: JSON.stringify({ kind, payload }),
    }),

  // ── 系统设置 ──────────────────────────────────────────────

  settings: () => req<SettingsResponse>('/settings'),

  /**
   * 保存设置。**只传改动过的键**：
   * 后端按「当前生效值 + 本次提交」合成视图做互斥校验，所以传全量或增量都安全，
   * 但传增量能让审计记录（settings_history）里只有真正变化的那几项。
   */
  saveSettings: (values: Record<string, number | boolean>) =>
    req<SettingsSaveResult>('/settings', { method: 'PUT', body: JSON.stringify({ values }) }),

  /** keys 传空数组 = 恢复全部默认（删掉库里的覆盖，回到 .env / config 默认值） */
  resetSettings: (keys: string[] = []) =>
    req<SettingsSaveResult>('/settings/reset', { method: 'POST', body: JSON.stringify({ keys }) }),
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
