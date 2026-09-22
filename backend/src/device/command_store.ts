/**
 * 设备指令存储（随心跳响应下发；commandId 幂等）。
 * 见设计文档 §4.5：指令 = 自检 / 切节点 / 暂停 / 恢复 / 升级 / 重启 / 刷新城市池。
 */
import { db } from '../db_pg.js'
import { createLogger } from '../logger.js'
import { makeId } from '../random.js'
import type { Command } from '../contracts/platform.js'

const log = createLogger('command')

type CommandKind = Command['kind']

/** 创建指令 */
export async function createCommand(
  deviceId: string,
  kind: CommandKind,
  payload?: Record<string, unknown>,
  ttlMinutes = 30,
): Promise<string> {
  const sql = db()
  const id = makeId('cmd')
  await sql`
    INSERT INTO device_commands (id, device_id, kind, payload, status, expire_at)
    VALUES (${id}, ${deviceId}, ${kind},
            ${payload === undefined ? null : JSON.stringify(payload)}::jsonb,
            'pending', NOW() + ${`${ttlMinutes} minutes`}::interval)
  `
  log.info(`command created ${id} device=${deviceId} kind=${kind}`)
  return id
}

/** 取出待下发指令并标记 delivered（幂等：同一指令不会重复下发） */
export async function takePendingCommands(deviceId: string, limit = 5): Promise<Command[]> {
  const sql = db()
  const rows = (await sql`
    WITH picked AS (
      SELECT id FROM device_commands
      WHERE device_id = ${deviceId} AND status = 'pending' AND (expire_at IS NULL OR expire_at > NOW())
      ORDER BY created_at ASC
      LIMIT ${limit}
    )
    UPDATE device_commands c SET status = 'delivered', delivered_at = NOW()
    FROM picked
    WHERE c.id = picked.id
    RETURNING c.id, c.kind, c.payload, c.expire_at
  `) as unknown as { id: string; kind: CommandKind; payload: unknown; expire_at: Date | null }[]

  // 过期未下发的指令顺手标记 expired
  await sql`
    UPDATE device_commands SET status = 'expired'
    WHERE device_id = ${deviceId} AND status = 'pending' AND expire_at IS NOT NULL AND expire_at <= NOW()
  `

  return rows.map((r) => ({
    commandId: r.id,
    kind: r.kind,
    payload: (r.payload as Record<string, unknown> | null) ?? undefined,
    expireAt: r.expire_at ? new Date(r.expire_at).toISOString() : undefined,
  }))
}

/** 记录指令执行结果（设备通过事件上报） */
export async function completeCommand(
  commandId: string,
  ok: boolean,
  result?: unknown,
): Promise<void> {
  const sql = db()
  await sql`
    UPDATE device_commands SET
      status = ${ok ? 'done' : 'failed'},
      finished_at = NOW(),
      result = ${result === undefined ? null : JSON.stringify(result)}::jsonb
    WHERE id = ${commandId}
  `
  log.info(`command finished ${commandId} ok=${ok}`)
}

/** 待处理指令数（看板用） */
export async function countPendingCommands(deviceId?: string): Promise<number> {
  const sql = db()
  const rows = deviceId
    ? ((await sql`
        SELECT COUNT(*)::int AS n FROM device_commands WHERE status = 'pending' AND device_id = ${deviceId}
      `) as unknown as { n: number }[])
    : ((await sql`SELECT COUNT(*)::int AS n FROM device_commands WHERE status = 'pending'`) as unknown as {
        n: number
      }[])
  return rows[0]?.n ?? 0
}
