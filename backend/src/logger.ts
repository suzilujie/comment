/**
 * 轻量日志器：控制台 + 按天滚动文件。
 * 约定：时间戳按本地时区（UTC+8）输出，便于与业务时间对齐。
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { config } from './config.js'

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
    appendFileSync(logFilePath(), `${line}\n`, 'utf8')
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
