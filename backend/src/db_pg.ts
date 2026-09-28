/**
 * PostgreSQL 连接池单例（postgres.js）。
 * 约定：业务模块内直接写带参模板 SQL（sql`...`），不引入 ORM；
 * 建表集中在 sql/schema.sql，启动时幂等执行。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { config } from './config.js'
import { createLogger } from './logger.js'

const log = createLogger('db')

let client: postgres.Sql | null = null

/** 获取连接池（惰性单例） */
export function getPg(): postgres.Sql {
  if (client) return client
  client = postgres(config.pg.url, {
    max: config.pg.poolMax,
    idle_timeout: 30,
    connect_timeout: 10,
    // 语句级超时：200 台规模下，一条慢查询（如全表聚合）会长时间占住连接，
    // 而连接池只有 24 个 —— 连锁反应就是心跳排队、设备被判离线。
    //
    // ⚠ 必须用 libpq 的 `options: -c name=value` 传递。
    // 直接写 `connection: { statement_timeout: 15000 }` **不会生效** ——
    // `statement_timeout` 不是连接启动参数，实测 PG 侧 `SHOW statement_timeout` 仍为 0。
    // （数据库层另有 `ALTER DATABASE ... SET statement_timeout` 兜底，见部署说明。）
    connection: {
      options: `-c statement_timeout=${Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15_000)}`,
    },
    // 忽略 NOTICE（如 CREATE TABLE IF NOT EXISTS 命中已存在的表）
    onnotice: () => {},
  })
  return client
}

/** 便捷别名：`const sql = db()` */
export function db(): postgres.Sql {
  return getPg()
}

/** 连通性检查 */
export async function ping(): Promise<boolean> {
  try {
    await getPg()`select 1 as ok`
    return true
  } catch (e) {
    log.error('ping failed:', e)
    return false
  }
}

/** 幂等建表：执行 sql/schema.sql（可重复运行） */
export async function ensureSchema(): Promise<void> {
  const file = resolve(import.meta.dir, '../sql/schema.sql')
  const text = readFileSync(file, 'utf8')
  await getPg().unsafe(text)
  log.info('schema ensured')
}

/** 关闭连接池（进程退出时调用） */
export async function closePg(): Promise<void> {
  if (!client) return
  await client.end({ timeout: 5 })
  client = null
}

/** 把 postgres.js 返回的行转成纯对象数组（避免 undefined 字段丢失语义） */
export function rows<T extends Record<string, unknown>>(data: unknown): T[] {
  return (data as T[]) ?? []
}
