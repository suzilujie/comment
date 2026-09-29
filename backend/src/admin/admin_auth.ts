/**
 * 管理台鉴权（最小可用实现）。
 *
 * 设计取舍：
 *  · 凭据来自 `config.admin`（默认 admin/admin），不建用户表 —— 内网单人使用，够用；
 *  · token 是 **HMAC 签名的无状态串**（payload + 签名），服务端不存储：
 *      重启后台不影响已登录会话；改 `ADMIN_TOKEN_SECRET` 即可让全部会话失效；
 *  · 只保护 `/api/admin/*`，设备端 `/agent/*` 完全不受影响（两者契约不同）。
 *
 * ⚠ 这是**内网级**防护，不是生产级认证：明文 HTTP 下 token 仍可被嗅探。
 *   对外暴露前需 HTTPS + 更强的鉴权（见 admin-web/README 待办）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { createLogger } from '../logger.js'

const log = createLogger('admin-auth')

/** token 载荷：用户名 + 过期时间 */
interface TokenPayload {
  u: string
  /** 过期时间（epoch ms） */
  exp: number
}

function sign(payloadB64: string): string {
  return createHmac('sha256', config.admin.secret).update(payloadB64).digest('base64url')
}

/**
 * 校验用户名密码。
 * @returns 成功返回 token；失败返回 null
 */
export function login(username: string, password: string): string | null {
  const okUser = username === config.admin.username
  // 故意不做短路比较：避免"用户名不存在"与"密码错误"的响应差异
  const okPass = password === config.admin.password
  if (!okUser || !okPass) {
    log.warn(`login failed user=${username}`)
    return null
  }
  const payload: TokenPayload = {
    u: username,
    exp: Date.now() + config.admin.tokenTtlHours * 3600_000,
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  log.info(`login ok user=${username} ttl=${config.admin.tokenTtlHours}h`)
  return `${payloadB64}.${sign(payloadB64)}`
}

/** 校验 token：签名正确且未过期 */
export function verify(token: string | null | undefined): boolean {
  if (!token) return false
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return false
  const payloadB64 = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  const expect = sign(payloadB64)
  const a = Buffer.from(sig, 'utf8')
  const b = Buffer.from(expect, 'utf8')
  // 定长比较，避免时序侧信道；长度不等直接判否
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as TokenPayload
    return typeof payload.exp === 'number' && payload.exp > Date.now()
  } catch {
    return false
  }
}

/** 从 Authorization 头解析 Bearer token */
export function tokenOf(header: string | undefined | null): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m?.[1]?.trim() || null
}

/**
 * 从 token 里取出用户名（**只用于审计留痕**，不承担鉴权职责 —— 鉴权一律走 verify()）。
 *
 * 存在的意义：改设置这类动作必须能回答"是谁改的"。若把 actor 写死成 'admin'，
 * 将来多用户时审计记录就失去意义了。签名不对/无法解析时返回 null。
 */
export function userOf(token: string | null | undefined): string | null {
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return null
  const payloadB64 = token.slice(0, dot)
  if (sign(payloadB64) !== token.slice(dot + 1)) return null
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as TokenPayload
    return typeof payload.u === 'string' ? payload.u : null
  } catch {
    return null
  }
}
