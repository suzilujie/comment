/**
 * 设备接口的公共守卫：请求体校验 + 设备登记检查。
 *
 * 设备身份 = deviceId（UUID），**无 token 鉴权**（内网信任 + 首启自动登记）。
 * 心跳接口传 `{ allowUnknown: true }`：陌生 deviceId 视为首次上线，允许通过
 * 并由 applyHeartbeat 的 UPSERT 完成自动登记；其余接口要求设备已登记。
 *
 * 通过函数重载区分返回类型：不传 opts 时 device 必非 null；allowUnknown 时可能为 null。
 */
import type { Context } from 'hono'
import type { z } from 'zod'
import { formatZodError } from '../contracts/agent.js'
import { getDevice } from '../device/device_store.js'
import type { DeviceRow } from '../device/device_store.js'
import { createLogger } from '../logger.js'

const log = createLogger('guard')

export interface Guarded<T> {
  device: DeviceRow
  data: T
}

export interface GuardedNullable<T> {
  device: DeviceRow | null
  data: T
}

export async function guard<T>(c: Context, schema: z.ZodType<T>): Promise<Guarded<T> | null>
export async function guard<T>(
  c: Context,
  schema: z.ZodType<T>,
  opts: { allowUnknown: true },
): Promise<GuardedNullable<T> | null>
export async function guard<T>(
  c: Context,
  schema: z.ZodType<T>,
  opts?: { allowUnknown?: boolean },
): Promise<(Guarded<T> | GuardedNullable<T>) | null> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return fail(c, 400, 'invalid_json', '请求体不是合法 JSON')
  }

  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const msg = formatZodError(parsed.error)
    log.warn(`schema reject path=${c.req.path} ${msg}`)
    return fail(c, 400, 'invalid_request', msg)
  }

  const body = parsed.data as unknown as { deviceId?: string }
  if (!body.deviceId) {
    return fail(c, 400, 'missing_device_id', '缺少 deviceId')
  }

  const device = await getDevice(body.deviceId)
  if (!device && !opts?.allowUnknown) {
    log.warn(`device not registered device=${body.deviceId} path=${c.req.path}`)
    return fail(c, 401, 'device_not_registered', '设备未登记（请先发送心跳）')
  }

  return { device, data: parsed.data } as Guarded<T> | GuardedNullable<T>
}

/**
 * 统一错误响应：写入 c.res 并返回 null。
 * 调用方写法：`const g = await guard(...); if (!g) return c.res`
 */
function fail(
  c: Context,
  status: 400 | 401 | 404 | 409 | 500,
  code: string,
  message: string,
): null {
  c.res = c.json({ ok: false, code, error: message }, status)
  return null
}
