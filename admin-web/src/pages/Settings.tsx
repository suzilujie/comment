/**
 * 系统设置 —— 运行时可配置参数（过去只能改 .env 再重启后台）。
 *
 * ⚠ 这一页**刻意不做自动刷新**：编辑中的草稿会被定时拉取的服务端值冲掉，
 *   那正是"我正在改，它自己跳回去了"这类困惑的来源。要重新拉取请点右上角「立即刷新」，
 *   保存成功后也会自动重载。
 *
 * 优先级：**页面设置 > .env > config.ts 默认值**。
 *  · 页面上没动过的项 → 库里没有行 → 跟随 .env（来源标「跟随 .env」）；
 *  · 页面上改过的项 → 落库覆盖 .env（来源标「页面设置」），随时可「恢复默认」退回 .env。
 */
import { useEffect, useMemo, useState } from 'react'
import { api, fmtTime } from '../api'
import type { SettingItem } from '../api'
import { Badge, Btn, Card, ErrorBox, Spinner, useFetch } from '../ui'

interface Props {
  autoMs: number
  refreshKey: number
  notify: (text: string, tone?: 'ok' | 'err' | 'info') => void
}

const inputCls =
  'rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-600'

/** 分钟数 → "HH:MM" */
const toHHMM = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

/** "HH:MM" → 分钟数；格式非法返回 null（不静默当成 00:00） */
function toMinute(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h > 23 || mm > 59) return null
  return h * 60 + mm
}

/** 按类型显示取值（.env 值 / 变更历史里都要用） */
function fmtValue(kind: string, v: number | boolean | null): string {
  if (v === null) return '-'
  if (kind === 'bool') return v ? '开' : '关'
  if (kind === 'time') return toHHMM(Number(v))
  return String(v)
}

export default function Settings({ refreshKey, notify }: Props) {
  // 不传 autoMs：见文件头说明（避免把编辑中的草稿冲掉）
  const st = useFetch(() => api.settings(), [refreshKey])
  const [draft, setDraft] = useState<Record<string, number | boolean>>({})
  const [saving, setSaving] = useState(false)
  /** 服务端返回的逐字段错误（客户端预校验漏掉的、或并发改动引起的） */
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})

  const items = st.data?.items ?? []

  // 拉到数据（首次 / 手动刷新 / 保存后重载）→ 重置草稿
  useEffect(() => {
    if (!st.data) return
    const d: Record<string, number | boolean> = {}
    for (const it of st.data.items) d[it.key] = it.value
    setDraft(d)
    setServerErrors({})
  }, [st.data])

  const changed = useMemo(
    () => Object.keys(draft).filter((k) => items.some((i) => i.key === k && i.value !== draft[k])),
    [draft, items],
  )

  /**
   * 客户端预校验（即时反馈）。
   * 服务端还会用「当前生效值 + 本次提交」再验一遍 —— 这里只是为了不让用户提交必然失败的改动。
   */
  const localErrors = useMemo(() => {
    const errs: Record<string, string> = {}
    for (const it of items) {
      const v = draft[it.key]
      if (it.kind === 'bool') continue
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        errs[it.key] = '必须是整数'
        continue
      }
      if (it.min !== null && v < it.min) errs[it.key] = `不能小于 ${it.min}`
      if (it.max !== null && v > it.max) errs[it.key] = `不能大于 ${it.max}`
    }
    const n = (k: string) => Number(draft[k] ?? 0)
    if (n('dispatch.intervalMaxMinutes') < n('dispatch.intervalMinMinutes')) {
      errs['dispatch.intervalMaxMinutes'] = '不能小于「完成间隔 · 下限」'
    }
    if (n('dispatch.windowStartMinute') === n('dispatch.windowEndMinute')) {
      errs['dispatch.windowEndMinute'] = '不能等于「投放窗口 · 开始」（那等于全天开窗）'
    }
    if (
      items.some((i) => i.key === 'heartbeat.onlineThresholdSeconds') &&
      n('heartbeat.onlineThresholdSeconds') < n('heartbeat.seconds')
    ) {
      errs['heartbeat.onlineThresholdSeconds'] = '必须 ≥ 心跳间隔，否则设备会被误判离线'
    }
    if (n('heartbeat.offlineAlertThresholdSeconds') < n('heartbeat.onlineThresholdSeconds')) {
      errs['heartbeat.offlineAlertThresholdSeconds'] = '必须 ≥ 在线判定阈值'
    }
    if (n('heartbeat.offlineManualThresholdSeconds') < n('heartbeat.offlineAlertThresholdSeconds')) {
      errs['heartbeat.offlineManualThresholdSeconds'] = '必须 ≥ 离线告警阈值'
    }
    return errs
  }, [draft, items])

  const errors: Record<string, string> = { ...localErrors, ...serverErrors }
  const canSave = changed.length > 0 && Object.keys(localErrors).length === 0 && !saving

  /**
   * 按当前设置估算「每台设备每天最多能发多少条」。
   *
   * 这是这一页最该给的反馈：日上限、完成间隔、投放窗口三个参数互相牵制，
   * 只看单个数字永远不知道"我设的 20 条到底达不达得到"。
   */
  const impact = useMemo(() => {
    const n = (k: string) => Number(draft[k] ?? 0)
    const start = n('dispatch.windowStartMinute')
    const end = n('dispatch.windowEndMinute')
    const win = end > start ? end - start : 1440 - start + end
    const avg = (n('dispatch.intervalMinMinutes') + n('dispatch.intervalMaxMinutes')) / 2
    const cap = n('dispatch.dailyQuotaPerDevice')
    const byInterval = avg > 0 ? Math.floor(win / avg) : 0
    return { win, avg, cap, byInterval, effective: Math.min(cap, byInterval) }
  }, [draft])

  const set = (key: string, v: number | boolean) => setDraft((d) => ({ ...d, [key]: v }))

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setServerErrors({})
    try {
      // 只提交改动过的键：审计记录里就只会出现真正变化的那几项
      const values: Record<string, number | boolean> = {}
      for (const k of changed) values[k] = draft[k]!
      const r = await api.saveSettings(values)
      if (!r.ok) {
        setServerErrors(r.detail?.errors ?? {})
        notify(r.error ?? '保存失败', 'err')
        return
      }
      notify(`已保存 ${changed.length} 项设置，立即生效（无需重启）`, 'ok')
      st.reload()
    } catch (e) {
      // 400 会走到这里：后端把逐字段原因拼进了 error 文本，所以 toast 也能看清是哪一项
      notify(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setSaving(false)
    }
  }

  const reset = async (keys: string[], label: string) => {
    if (keys.length === 0) {
      notify('这些项本来就跟随 .env，无需恢复', 'info')
      return
    }
    if (!window.confirm(`把「${label}」恢复为 .env / 默认值？\n\n将删除 ${keys.length} 项页面覆盖：\n${keys.join('\n')}`)) {
      return
    }
    setSaving(true)
    try {
      const r = await api.resetSettings(keys)
      notify(r.ok ? '已恢复默认（回到 .env 的值）' : `恢复失败：${r.error}`, r.ok ? 'ok' : 'err')
      st.reload()
    } catch (e) {
      notify(`恢复失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setSaving(false)
    }
  }

  const groupItems = (g: string) => items.filter((i) => i.group === g)
  const overriddenIn = (g: string) => groupItems(g).filter((i) => i.overridden).map((i) => i.key)

  const renderRow = (it: SettingItem) => {
    const v = draft[it.key]
    const err = errors[it.key]
    const dirty = changed.includes(it.key)
    return (
      <div key={it.key} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-[260px] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-slate-200">{it.label}</span>
            {it.source === 'db' ? (
              <Badge tone="info">页面设置</Badge>
            ) : (
              <Badge tone="muted">跟随 .env</Badge>
            )}
            {dirty && <Badge tone="warn">未保存</Badge>}
          </div>
          <div className="mt-1 text-[11px] leading-5 text-slate-500">{it.hint}</div>
          {it.overridden && (
            <div className="mt-0.5 text-[11px] text-slate-600">
              .env 里的值是 {fmtValue(it.kind, it.envValue)}；「恢复默认」可退回
            </div>
          )}
          {err && <div className="mt-1 text-[11px] text-rose-300">{err}</div>}
        </div>
        <div className="flex items-center gap-2">
          {it.kind === 'bool' ? (
            <select
              value={v ? 'on' : 'off'}
              onChange={(e) => set(it.key, e.target.value === 'on')}
              className={inputCls}
            >
              <option value="on">开</option>
              <option value="off">关</option>
            </select>
          ) : it.kind === 'time' ? (
            <input
              type="time"
              value={toHHMM(Number(v ?? 0))}
              onChange={(e) => {
                const m = toMinute(e.target.value)
                if (m !== null) set(it.key, m)
              }}
              className={inputCls}
            />
          ) : (
            <>
              <input
                type="number"
                value={Number(v ?? 0)}
                min={it.min ?? undefined}
                max={it.max ?? undefined}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  // 空输入不要变成 NaN（会让"必须 ≥ 下限"这类校验失去意义）
                  set(it.key, Number.isFinite(n) ? n : 0)
                }}
                className={`${inputCls} w-24 text-right tabular-nums`}
              />
              {it.min !== null && (
                <span className="w-20 text-[11px] text-slate-600">
                  {it.min}~{it.max}
                </span>
              )}
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="系统设置"
        subtitle={
          <>
            这些参数原本只能改 <span className="font-mono">.env</span> 再重启后台，现在可以直接在页面上调，
            <span className="text-slate-300">保存即生效（无需重启）</span>。
            <span className="text-slate-600">
              {' '}
              优先级：页面设置 &gt; .env &gt; 默认值；未在页面改过的项一直跟随 .env。
            </span>
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <Btn small tone="ghost" onClick={() => void reset(overriddenIn('dispatch').concat(overriddenIn('heartbeat')), '全部有覆盖的项')} disabled={saving}>
              恢复全部默认
            </Btn>
            <Btn onClick={() => void save()} disabled={!canSave}>
              {saving ? '保存中…' : changed.length > 0 ? `保存 ${changed.length} 项修改` : '保存修改'}
            </Btn>
          </div>
        }
      >
        {st.loading && !st.data && <Spinner />}
        {st.error && <ErrorBox msg={st.error} onRetry={st.reload} />}
        {st.data && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-[11px] text-slate-400">
            <span>
              按当前设置估算：投放窗口{' '}
              <span className="tabular-nums text-slate-300">{impact.win}</span> 分钟 · 平均间隔{' '}
              <span className="tabular-nums text-slate-300">{impact.avg.toFixed(0)}</span> 分钟
            </span>
            <span>
              → 每台设备每天最多约{' '}
              <span className="font-semibold tabular-nums text-slate-100">{impact.effective}</span> 条
              （日上限 {impact.cap} 条）
            </span>
            {impact.byInterval < impact.cap && (
              <span className="text-amber-300">
                ⚠ 间隔把窗口占满了：想达到日上限 {impact.cap} 条，需要平均间隔 ≤{' '}
                {Math.floor(impact.win / Math.max(impact.cap, 1))} 分钟
              </span>
            )}
          </div>
        )}
      </Card>

      {st.data && (
        <>
          <Card
            title="投放规则"
            subtitle="直接影响派单：日上限、间隔、时段、密度、冷却。改错会带来账号风险，所以有变更留痕。"
            actions={
              <Btn small tone="ghost" disabled={saving} onClick={() => void reset(overriddenIn('dispatch'), '投放规则')}>
                恢复本组默认
              </Btn>
            }
          >
            <div className="divide-y divide-slate-800">{groupItems('dispatch').map(renderRow)}</div>
          </Card>

          <Card
            title="心跳与在线判定"
            subtitle="影响设备上报频率与「在线/离线」的判定；调大会让故障发现变慢。"
            actions={
              <Btn small tone="ghost" disabled={saving} onClick={() => void reset(overriddenIn('heartbeat'), '心跳与在线判定')}>
                恢复本组默认
              </Btn>
            }
          >
            <div className="divide-y divide-slate-800">{groupItems('heartbeat').map(renderRow)}</div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="其它配置（只读）" subtitle="来自 .env，改这些会影响服务本身能否正常启动，因此不在页面上改。">
              <div className="divide-y divide-slate-800">
                {st.data.readonly.map((r) => (
                  <div key={r.label} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
                    <span className="text-slate-500">{r.label}</span>
                    <span className="font-mono text-slate-300">{r.value}</span>
                  </div>
                ))}
              </div>
            </Card>

            <Card title="最近变更" subtitle="谁在什么时候把哪一项从什么改成了什么（最多 20 条）。">
              {st.data.history.length === 0 ? (
                <div className="px-4 py-3 text-xs text-slate-500">还没有任何变更 —— 全部参数都跟随 .env。</div>
              ) : (
                <div className="divide-y divide-slate-800">
                  {st.data.history.map((h, idx) => {
                    const def = items.find((i) => i.key === h.key)
                    return (
                      <div key={`${h.key}-${idx}`} className="flex items-center justify-between gap-3 px-4 py-2 text-[11px]">
                        <span className="text-slate-400">{def?.label ?? h.key}</span>
                        <span className="font-mono text-slate-300">
                          {fmtValue(def?.kind ?? 'int', h.old_value)} → {fmtValue(def?.kind ?? 'int', h.new_value)}
                        </span>
                        <span className="text-slate-600">
                          {h.actor ?? '-'} · {fmtTime(h.created_at)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
