/**
 * 配置单一来源（Single Source of Truth）。
 *
 * 说明：Bun 会自动加载项目根目录的 .env（无需 dotenv），
 * 因此这里只做「类型收敛 + 默认值 + 单位换算」，不做文件解析。
 * 所有端口、阈值一律来自这里，代码中不允许散落硬编码。
 */
import { randomBytes } from 'node:crypto'

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

/**
 * 读整数（新键优先，旧键兜底）。
 *
 * 用于字段改名后的平滑过渡：`DAILY_QUOTA_PER_ACCOUNT` 是账号实体存在时的旧名，
 * 现在叫 `DAILY_QUOTA_PER_DEVICE`。两者都读是为了**不打断已部署的 .env** ——
 * 只认新键的话，老部署会静默回到默认值（"改配置不生效"是最难查的一类问题）。
 */
function intAlias(newKey: string, oldKey: string, fallback: number): number {
  const v = process.env[newKey]
  if (v !== undefined && v !== '') return int(newKey, fallback)
  if (process.env[oldKey] !== undefined && process.env[oldKey] !== '') {
    configWarnings.push(`${oldKey} 已改名，请改用 ${newKey}（当前仍兼容读取旧键）`)
    return int(oldKey, fallback)
  }
  return fallback
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

/**
 * 启动期告警（由 main.ts 在建好 logger 后统一打印）。
 *
 * 存在的意义：这些配置问题**不会让进程起不来**，只会在运行时表现成"说不通的怪现象"
 * （例如密钥是公开默认值 → 任何人可伪造登录；时段写成 "8" → 窗口从 0 点开始）。
 * 静默降级是最难排查的一类问题，所以宁可吵一点。
 */
export const configWarnings: string[] = []

/**
 * 管理台 token 的签名密钥。
 *
 * ⚠ 早期是一个**写在仓库里**的默认值 `comment-admin-dev-secret-please-change`：
 *   部署时只要忘了设 `ADMIN_TOKEN_SECRET`，任何人拿这个公开字符串就能离线伪造一个
 *   未过期 token 直接通过校验（签名算法与过期校验本身都是对的，问题在于密钥人人皆知）。
 *   现在：没配、或配的正是那个旧默认值 → **每个进程随机生成一把**并告警。
 *   代价是重启后旧登录失效 —— 这本就是"没配密钥"应有的行为，比默默裸奔好得多。
 */
function adminSecret(): string {
  const WEAK = 'comment-admin-dev-secret-please-change'
  const raw = (process.env.ADMIN_TOKEN_SECRET ?? '').trim()
  if (raw && raw !== WEAK) return raw
  configWarnings.push(
    raw
      ? 'ADMIN_TOKEN_SECRET 仍是仓库里的默认值 → 已改用本次运行随机生成的密钥（重启后需重新登录）。请在 .env 里设置一个私有密钥。'
      : '未设置 ADMIN_TOKEN_SECRET → 已改用本次运行随机生成的密钥（重启后需重新登录）。请在 .env 里设置一个私有密钥。',
  )
  return randomBytes(32).toString('base64url')
}

/**
 * "08:30" → 510（当天第几分钟）。
 *
 * ⚠ 解析失败时返回 0 并**告警**：早期是静默返回 0，于是 `DISPATCH_WINDOW_START=8`
 *   （漏了冒号）会变成"窗口从 00:00 开始"—— 看上去一切正常，实际全时段都在发评论。
 */
function timeToMinute(key: string, v: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) {
    configWarnings.push(`${key}="${v}" 不是 HH:MM 格式，已按 00:00 处理（投产前请修正）`)
    return 0
  }
  const h = Number.parseInt(m[1] ?? '0', 10)
  const min = Number.parseInt(m[2] ?? '0', 10)
  return Math.max(0, Math.min(1439, h * 60 + min))
}

export interface DispatchConfig {
  /**
   * **单设备**日评论上限（需求：「单设备评论上限是 20 条」）。
   *
   * ⚠ 名字里的"账号"是 2026-09-26 账号实体移除之前的遗留叫法。一机一号，配额早已下沉到
   *   设备维度（落库在 `devices.daily_done`），这里改名只是为了让代码与需求措辞一致 ——
   *   这套系统已经因为"字段名与实际语义不符"（post_type vs comment_type）踩过一次大坑。
   */
  dailyQuotaPerDevice: number
  /**
   * 与上次**成功完成**之间的随机间隔区间（分钟）—— 即需求里的「可配置时间间隔」。
   *
   * 默认 30~60 分钟的依据：投放窗口 08:00–22:00 共 14 小时，要在窗口内做满 20 条，
   * 平均间隔必须 ≤ 42 分钟，所以取 30~60 的随机区间（既够得上 20 条，又不像固定节拍）。
   * 想要「1 小时/条」就把两个值都设成 60（代价：14 小时窗口内最多 14 条/设备）；
   * 想「半小时/条」设 30/30。
   *
   * ⚠ 只对**成功**的评论计时（failed / aborted 不退间隔），见 `task_store.finishTask`。
   */
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
   * unknown 是否占用「同设备 × 同帖」冷却名额。
   *  true （默认，保守）：unknown 意味着"可能已发出"，占用可避免同帖出现两条评论；
   *  false（激进）：unknown 不占名额，适合假失败已被消除、且确定不会重复评论的场景。
   */
  unknownOccupiesPostSlot: boolean
  /**
   * 同一设备对同一帖的重复评论冷却（**自然日，UTC+8**）。
   *
   * 需求原文：「单设备对同一帖子：**一天**仅允许评论 1 次」。
   *  · 1（默认）= 当天评过就不再派 —— 与 `daily_done`、管理台「今天」同一口径；
   *  · N = 最近 N 个自然日内不允许重复；
   *  · 0 = 不限制（不建议：会产生同帖重复评论）。
   *
   * ⚠ 这里曾经实现成「**永久**一次」（刻意不加日期范围，理由是切省周期 2 天、
   *   设备转回来会重复评论同一条视频）。但那与需求不符，代价也很大：
   *   每台设备对每个帖子一辈子只能评一次，帖子会静默变成"再也派不出去"，
   *   而管理台只会显示"候选为空"。现在按需求口径回到"一天一次"，
   *   同时用这个开关给"从严"留了口子（设成 IP 切省周期 2 天即可完全避免跨天重复）。
   */
  devicePostCooldownDays: number
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
    dailyQuotaPerDevice: intAlias('DAILY_QUOTA_PER_DEVICE', 'DAILY_QUOTA_PER_ACCOUNT', 20),
    intervalMinMinutes: int('INTERVAL_MIN_MINUTES', 30),
    intervalMaxMinutes: int('INTERVAL_MAX_MINUTES', 60),
    devicePostCooldownDays: int('DEVICE_POST_COOLDOWN_DAYS', 1),
    windowStartMinute: timeToMinute('DISPATCH_WINDOW_START', str('DISPATCH_WINDOW_START', '08:00')),
    windowEndMinute: timeToMinute('DISPATCH_WINDOW_END', str('DISPATCH_WINDOW_END', '22:00')),
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
    // 见 adminSecret()：绝不使用仓库里的默认密钥（那是可以离线伪造 token 的）
    secret: adminSecret(),
    tokenTtlHours: int('ADMIN_TOKEN_TTL_HOURS', 12),
  } satisfies AdminConfig,
} as const

export type Config = typeof config
