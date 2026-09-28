/**
 * 配置单一来源（Single Source of Truth）。
 *
 * 说明：Bun 会自动加载项目根目录的 .env（无需 dotenv），
 * 因此这里只做「类型收敛 + 默认值 + 单位换算」，不做文件解析。
 * 所有端口、阈值一律来自这里，代码中不允许散落硬编码。
 */

/** 读字符串 */
function str(key: string, fallback: string): string {
  const v = process.env[key]
  return v === undefined || v === '' ? fallback : v
}

/** 读整数 */
function int(key: string, fallback: number): number {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

/** 读浮点 */
function float(key: string, fallback: number): number {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

/** 读布尔（'1'/'true'/'yes'/'on' 视为真） */
function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())
}

/** "08:30" → 510（当天第几分钟） */
function timeToMinute(v: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) return 0
  const h = Number.parseInt(m[1] ?? '0', 10)
  const min = Number.parseInt(m[2] ?? '0', 10)
  return Math.max(0, Math.min(1439, h * 60 + min))
}

export interface DispatchConfig {
  /** 单账号日评论上限 */
  dailyQuotaPerAccount: number
  /** 与上次「完成」的随机间隔区间（分钟） */
  intervalMinMinutes: number
  intervalMaxMinutes: number
  /** 投放时段窗口（当天第几分钟） */
  windowStartMinute: number
  windowEndMinute: number
  /** 全局派单密度：窗口秒数内最多派单条数（防多设备扎堆） */
  globalLimit: number
  globalWindowSeconds: number
  /** 同帖相邻评论最小间隔（分钟） */
  perPostMinIntervalMinutes: number
  /** 回执截止：派发后多少分钟无回执 → unknown */
  receiptTimeoutMinutes: number
  /**
   * unknown 是否占用「同设备 × 同帖每天一次」名额。
   *  true （默认，保守）：unknown 意味着"可能已发出"，占用可避免同帖出现两条评论；
   *  false（激进）：unknown 不占名额，适合假失败已被消除、且确定不会重复评论的场景。
   */
  unknownOccupiesPostSlot: boolean
}

export interface AdminConfig {
  /** 管理台登录用户名（默认 admin） */
  username: string
  /** 管理台登录密码（默认 admin） */
  password: string
  /**
   * 签发管理台 token 的 HMAC 密钥。
   * 改动它会让**所有已登录会话立即失效**（因为签名对不上）。
   */
  secret: string
  /** token 有效期（小时） */
  tokenTtlHours: number
}

export interface HeartbeatConfig {
  seconds: number
  jitterRatio: number
  /** 判定"在线"的心跳新鲜度阈值（秒） */
  onlineThresholdSeconds: number
  /** 判定"离线"并告警的阈值（秒） */
  offlineAlertThresholdSeconds: number
  /** 需人工介入的阈值（秒） */
  offlineManualThresholdSeconds: number
}

export const config = {
  server: {
    host: str('SERVER_HOST', '0.0.0.0'),
    port: int('SERVER_PORT', 15650),
  },
  log: {
    level: str('LOG_LEVEL', 'info'),
    file: str('LOG_FILE', 'logs/backend.log'),
  },
  pg: {
    url: str('PG_URL', 'postgres://postgres:postgres@127.0.0.1:5432/comment'),
    // 200 台设备规模：连接池默认值从 10 提到 24。
  // 心跳稳态约 6.7 QPS、单请求 10 条 SQL，10 个连接在突发（批量开机、重试风暴）时
  // 会被瞬间排空并按「串行化」放大长尾 —— 而派单路径单请求更长，会被一起拖累。
  poolMax: int('PG_POOL_MAX', 24),
  },
  dispatch: {
    dailyQuotaPerAccount: int('DAILY_QUOTA_PER_ACCOUNT', 20),
    intervalMinMinutes: int('INTERVAL_MIN_MINUTES', 30),
    intervalMaxMinutes: int('INTERVAL_MAX_MINUTES', 60),
    windowStartMinute: timeToMinute(str('DISPATCH_WINDOW_START', '08:00')),
    windowEndMinute: timeToMinute(str('DISPATCH_WINDOW_END', '22:00')),
    globalLimit: int('GLOBAL_DISPATCH_LIMIT', 3),
    globalWindowSeconds: int('GLOBAL_DISPATCH_WINDOW_SECONDS', 300),
    perPostMinIntervalMinutes: int('PER_POST_MIN_INTERVAL_MINUTES', 15),
    receiptTimeoutMinutes: int('RECEIPT_TIMEOUT_MINUTES', 15),
    unknownOccupiesPostSlot: bool('UNKNOWN_OCCUPIES_POST_SLOT', true),
  } satisfies DispatchConfig,
  heartbeat: {
    seconds: int('HEARTBEAT_SECONDS', 30),
    jitterRatio: float('HEARTBEAT_JITTER_RATIO', 0.1),
    onlineThresholdSeconds: int('ONLINE_THRESHOLD_SECONDS', 90),
    offlineAlertThresholdSeconds: int('OFFLINE_ALERT_THRESHOLD_SECONDS', 300),
    offlineManualThresholdSeconds: int('OFFLINE_MANUAL_THRESHOLD_SECONDS', 1800),
  } satisfies HeartbeatConfig,
  ip: {
    rotateDays: int('IP_ROTATE_DAYS', 2),
    rotateJitterHours: int('IP_ROTATE_JITTER_HOURS', 4),
    providerBaseUrl: str('PROVIDER_BASE_URL', 'http://127.0.0.1:15650/providers'),
  },
  material: {
    dir: str('MATERIAL_DIR', 'data/materials'),
    maxMb: int('MATERIAL_MAX_MB', 20),
  },
  admin: {
    username: str('ADMIN_USERNAME', 'admin'),
    password: str('ADMIN_PASSWORD', 'admin'),
    secret: str('ADMIN_TOKEN_SECRET', 'comment-admin-dev-secret-please-change'),
    tokenTtlHours: int('ADMIN_TOKEN_TTL_HOURS', 12),
  } satisfies AdminConfig,
} as const

export type Config = typeof config
