/**
 * 前端基础件：数据获取 hook + 通用 UI 组件（深色 slate 风格）。
 * 刻意不引第三方组件库 —— 页面规模不大，手写更少黑盒、更好控。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

// ── 数据获取 ────────────────────────────────────────────────

export interface FetchState<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => void
}

/**
 * 极简数据获取：deps 变化或定时自动刷新时重载。
 * autoMs = 0 表示不自动刷新。
 */
export function useFetch<T>(fn: () => Promise<T>, deps: unknown[] = [], autoMs = 0): FetchState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fnRef.current()
      setData(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // deps 变化 → 立即重载
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  // 定时轮询
  useEffect(() => {
    if (!autoMs) return
    const t = setInterval(() => void load(), autoMs)
    return () => clearInterval(t)
  }, [autoMs, load])

  return { data, loading, error, reload: load }
}

// ── Toast ───────────────────────────────────────────────────

export interface ToastMsg {
  id: number
  text: string
  tone: 'ok' | 'err' | 'info'
}

export function useToasts() {
  const [items, setItems] = useState<ToastMsg[]>([])
  const seq = useRef(0)
  const push = useCallback((text: string, tone: ToastMsg['tone'] = 'info') => {
    const id = ++seq.current
    setItems((prev) => [...prev, { id, text, tone }])
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4500)
  }, [])
  return { items, push }
}

const TONE_CLS: Record<string, string> = {
  ok: 'border-emerald-600/50 bg-emerald-950/80 text-emerald-200',
  err: 'border-rose-600/50 bg-rose-950/80 text-rose-200',
  info: 'border-slate-600/60 bg-slate-900/90 text-slate-200',
}

export function ToastHost({ items }: { items: ToastMsg[] }) {
  if (items.length === 0) return null
  return (
    <div className="fixed right-4 bottom-4 z-50 flex w-[min(92vw,420px)] flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={`rounded-lg border px-3 py-2 text-sm shadow-lg backdrop-blur ${TONE_CLS[t.tone]}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}

// ── 基础组件 ────────────────────────────────────────────────

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-xl border border-slate-800 bg-slate-900/50 ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-slate-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'default' | 'ok' | 'warn' | 'err'
}) {
  const toneCls =
    tone === 'ok'
      ? 'text-emerald-300'
      : tone === 'warn'
        ? 'text-amber-300'
        : tone === 'err'
          ? 'text-rose-300'
          : 'text-slate-100'
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${toneCls}`}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  )
}

export function Badge({
  children,
  tone = 'muted',
}: {
  children: ReactNode
  tone?: 'ok' | 'warn' | 'err' | 'info' | 'muted'
}) {
  const cls: Record<string, string> = {
    ok: 'border-emerald-700/60 bg-emerald-950/60 text-emerald-300',
    warn: 'border-amber-700/60 bg-amber-950/60 text-amber-300',
    err: 'border-rose-700/60 bg-rose-950/60 text-rose-300',
    info: 'border-sky-700/60 bg-sky-950/60 text-sky-300',
    muted: 'border-slate-700/60 bg-slate-800/60 text-slate-400',
  }
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] leading-4 whitespace-nowrap ${cls[tone]}`}
    >
      {children}
    </span>
  )
}

export function Btn({
  children,
  onClick,
  tone = 'default',
  disabled = false,
  small = false,
  title,
}: {
  children: ReactNode
  onClick?: () => void
  tone?: 'default' | 'primary' | 'danger' | 'ghost'
  disabled?: boolean
  small?: boolean
  title?: string
}) {
  const base =
    'inline-flex items-center justify-center gap-1 rounded-md border font-medium transition disabled:cursor-not-allowed disabled:opacity-45'
  const size = small ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'
  const toneCls: Record<string, string> = {
    default: 'border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700',
    primary: 'border-sky-700 bg-sky-900/70 text-sky-100 hover:bg-sky-800/80',
    danger: 'border-rose-800 bg-rose-950/70 text-rose-200 hover:bg-rose-900/70',
    ghost: 'border-transparent bg-transparent text-slate-400 hover:text-slate-200',
  }
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`${base} ${size} ${toneCls[tone]}`}
    >
      {children}
    </button>
  )
}

/** 表格外壳（横向可滚动，适合窄屏） */
export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full border-collapse text-left text-xs whitespace-nowrap">
        <thead>
          <tr className="text-slate-500">
            {head.map((h, i) => (
              <th key={i} className="border-b border-slate-800 px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-slate-300">{children}</tbody>
      </table>
    </div>
  )
}

export function Td({
  children,
  className = '',
  title,
}: {
  children?: ReactNode
  className?: string
  title?: string
}) {
  return (
    <td title={title} className={`border-b border-slate-800/70 px-3 py-2 align-top ${className}`}>
      {children}
    </td>
  )
}

export function Spinner({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-xs text-slate-500">
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-600 border-t-transparent" />
      {text}
    </div>
  )
}

export function ErrorBox({ msg, onRetry }: { msg: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
      <div className="flex items-center justify-between gap-3">
        <span>请求失败：{msg}</span>
        {onRetry && (
          <Btn small onClick={onRetry}>
            重试
          </Btn>
        )}
      </div>
    </div>
  )
}

export function Empty({ text = '暂无数据' }: { text?: string }) {
  return <div className="py-8 text-center text-xs text-slate-600">{text}</div>
}

/** 小字段展示：label 在上、值在下 */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="mt-0.5 text-xs text-slate-200">{children}</div>
    </div>
  )
}

// ── 列表筛选 ────────────────────────────────────────────────
// 约定：筛选值统一用字符串，`'all'` 表示"不筛"。所有筛选都必须下推到服务端 ——
// 前端 filter 在分页下只作用于当前页，会出现"共 N 条却只看到几行"的错位。

/** 筛选下拉 */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
  width = '',
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
  width?: string
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-400">
      <span className="shrink-0 text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${width} rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-600`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * 筛选搜索框：**回车 / 失焦才提交**。
 *
 * 每敲一个字符就打一次接口会连带刷新分页与 total，既卡顿又刷屏；
 * 用"受控草稿 + 显式提交"，体验等同于表单搜索。Esc 可放弃本次输入。
 */
export function FilterSearch({
  label,
  value,
  placeholder,
  onCommit,
  width = 'w-40',
}: {
  label: string
  value: string
  placeholder?: string
  onCommit: (v: string) => void
  width?: string
}) {
  const [draft, setDraft] = useState(value)
  // 外部值变化（例如点了「重置」）时同步回草稿
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const v = draft.trim()
    if (v !== value) onCommit(v)
  }
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-400">
      <span className="shrink-0 text-slate-500">{label}</span>
      <input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setDraft(value)
        }}
        onBlur={commit}
        className={`${width} rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-600`}
      />
    </label>
  )
}

// ── 分页 ────────────────────────────────────────────────────

/**
 * 列表默认每页条数（各页 `usePaging()` 的初始值）。
 *
 * ⚠ 必须与后台 `admin_routes.ts` 的 `DEFAULT_PAGE_LIMIT` 保持一致：前端不传 `limit` 时
 * 由后台兜底，两边不一致会让"10 条/页"的选择看起来生效、实际返回 20 条。
 */
export const DEFAULT_PAGE_SIZE = 10

/**
 * 列表分页状态。
 *
 * 约定 `page` 从 **0** 开始；**改每页条数时自动回到第一页** ——
 * 否则会停在一个越界的页码上，看起来就像"数据没了"。
 */
export function usePaging(defaultSize = DEFAULT_PAGE_SIZE) {
  const [page, setPage] = useState(0)
  const [pageSize, setPageSizeRaw] = useState(defaultSize)
  const setPageSize = useCallback((n: number) => {
    setPageSizeRaw(n)
    setPage(0)
  }, [])
  return { page, pageSize, setPage, setPageSize, offset: page * pageSize }
}

const PAGE_SIZES = [10, 20, 50, 100]

/**
 * 分页条：总数 / 当前区间 / 每页条数 / 翻页。
 *
 * 总数为 0 时**不渲染**（空列表已经有 Empty 提示，再显示"共 0 条"是噪音）。
 * 页码越界时按夹住后的值显示与禁用 —— 删除数据后 `page` 可能指向不存在的页。
 */
export function Pager({
  total,
  page,
  pageSize,
  onPage,
  onPageSize,
}: {
  total: number
  page: number
  pageSize: number
  onPage: (p: number) => void
  onPageSize: (n: number) => void
}) {
  if (total === 0) return null
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const cur = Math.min(Math.max(0, page), pages - 1)
  const from = cur * pageSize + 1
  const to = Math.min(total, (cur + 1) * pageSize)
  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-3 text-[11px] text-slate-500">
      <div>
        共 <span className="tabular-nums text-slate-300">{total}</span> 条 · 当前{' '}
        <span className="tabular-nums text-slate-300">
          {from}–{to}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <select
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          className="rounded-md border border-slate-700 bg-slate-900 px-1.5 py-1 text-[11px] text-slate-300 outline-none focus:border-sky-600"
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n} 条/页
            </option>
          ))}
        </select>
        <Btn small onClick={() => onPage(0)} disabled={cur <= 0} title="第一页">
          «
        </Btn>
        <Btn small onClick={() => onPage(cur - 1)} disabled={cur <= 0}>
          上一页
        </Btn>
        <span className="px-1 tabular-nums text-slate-400">
          {cur + 1} / {pages}
        </span>
        <Btn small onClick={() => onPage(cur + 1)} disabled={cur >= pages - 1}>
          下一页
        </Btn>
        <Btn small onClick={() => onPage(pages - 1)} disabled={cur >= pages - 1} title="最后一页">
          »
        </Btn>
      </div>
    </div>
  )
}
