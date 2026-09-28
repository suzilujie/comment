/**
 * 轻量日志器：控制台 + 按天滚动文件。
 * 约定：时间戳按本地时区（UTC+8）输出，便于与业务时间对齐。
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { config } from './config.js'

/** 日志保留天数（可被 env 覆盖）；日志约 90~260MB/天，不清理会把磁盘写满 */
const KEEP_LOG_DAYS = Number(process.env.LOG_KEEP_DAYS ?? 7)

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** 本地（UTC+8）日期串 YYYY-MM-DD */
function localDayKey(d = new Date()): string {
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

/** 本地（UTC+8）时间戳 YYYY-MM-DD HH:mm:ss.mmm */
export function localTs(d = new Date()): string {
  const shifted = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  const hh = String(shifted.getUTCHours()).padStart(2, '0')
  const mi = String(shifted.getUTCMinutes()).padStart(2, '0')
  const ss = String(shifted.getUTCSeconds()).padStart(2, '0')
  const ms = String(shifted.getUTCMilliseconds()).padStart(3, '0')
  return `${localDayKey(d)} ${hh}:${mi}:${ss}.${ms}`
}

/** 按天滚动的日志文件路径：logs/backend.log → logs/backend-2026-09-20.log */
function logFilePath(): string {
  const file = config.log.file
  const dir = dirname(file)
  const base = file.slice(dir.length + 1).replace(/\.log$/i, '')
  return join(dir, `${base}-${localDayKey()}.log`)
}

let fileReady = false
function ensureFile(): void {
  if (fileReady) return
  const dir = dirname(config.log.file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  fileReady = true
}

/**
 * 当前日志写入流（按天缓存）。
 *
 * ⚠ 早期每条日志都 `appendFileSync` —— 那是**同步** IO，内部 open+write+close 三次系统调用，
 * 直接阻塞 Bun 的单线程事件循环。按 200 台设备的心跳规模估算（~7 QPS，每请求 1~3 条日志）
 * 就是 7~20 次同步落盘/秒；磁盘或网络盘一抖动，**所有请求的延迟都会跟着抖**。
 * 改为按天持有 write stream：异步写、不阻塞，跨天才重新打开。
 */
let stream: WriteStream | null = null
let streamPath = ''

function getStream(): WriteStream | null {
  const path = logFilePath()
  if (stream && streamPath === path) return stream
  try {
    stream?.end()
    stream = createWriteStream(path, { flags: 'a' })
    stream.on('error', () => {}) // 落盘错误不影响主流程
    streamPath = path
    pruneOldLogs()
  } catch {
    stream = null
    streamPath = ''
  }
  return stream
}

/** 只保留最近 KEEP_LOG_DAYS 天的日志文件（跨天首次写时执行一次） */
function pruneOldLogs(): void {
  try {
    const dir = dirname(config.log.file)
    const base = config.log.file.slice(dir.length + 1).replace(/\.log$/i, '')
    const cutoff = Date.now() - KEEP_LOG_DAYS * 24 * 3600_000
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`${base}-`) || !name.endsWith('.log')) continue
      const p = join(dir, name)
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
    }
  } catch {
    // 清理失败不影响日志写入
  }
}

function write(level: Level, tag: string, args: unknown[]): void {
  const threshold = LEVEL_ORDER[(config.log.level as Level) ?? 'info'] ?? LEVEL_ORDER.info
  if (LEVEL_ORDER[level] < threshold) return

  const head = `[${localTs()}] ${level.toUpperCase().padEnd(5)} [${tag}]`
  const text = args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ''}`
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')

  const line = `${head} ${text}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  try {
    ensureFile()
    getStream()?.write(`${line}\n`)
  } catch {
    // 落盘失败不影响主流程（例如只读环境）
  }
}

export interface Logger {
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

/** 创建带标签的日志器；tag 建议用模块名，如 'heartbeat' */
export function createLogger(tag: string): Logger {
  return {
    debug: (...a: unknown[]) => write('debug', tag, a),
    info: (...a: unknown[]) => write('info', tag, a),
    warn: (...a: unknown[]) => write('warn', tag, a),
    error: (...a: unknown[]) => write('error', tag, a),
  }
}

export const logger = createLogger('app')
