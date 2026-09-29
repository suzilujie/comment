import { useState } from 'react'
import { api, COMMAND_KINDS, fmtGap, fmtTime } from '../api'
import type { CommandKind } from '../api'
import {
  Badge,
  Btn,
  Card,
  Empty,
  ErrorBox,
  FilterSearch,
  FilterSelect,
  Pager,
  shortId,
  Spinner,
  Table,
  Td,
  useFetch,
  usePaging,
} from '../ui'

interface Props {
  autoMs: number
  refreshKey: number
  notify: (text: string, tone?: 'ok' | 'err' | 'info') => void
}

function PermissionBadge({ label, ok }: { label: string; ok: boolean | null }) {
  if (ok === null) return <Badge tone="muted">{label} ?</Badge>
  return <Badge tone={ok ? 'ok' : 'err'}>{label}</Badge>
}

export default function Devices({ autoMs, refreshKey, notify }: Props) {
  // ── 筛选（全部下推到服务端；前端过滤在分页下只会作用于当前页）──
  const [fOnline, setFOnline] = useState('all')
  const [fHealth, setFHealth] = useState('all')
  const [fCity, setFCity] = useState('all')
  const [fQ, setFQ] = useState('')
  const pg = usePaging()
  const dev = useFetch(
    () =>
      api.devices({
        limit: pg.pageSize,
        offset: pg.offset,
        online: fOnline === 'all' ? undefined : fOnline === 'online',
        health: fHealth === 'all' ? undefined : (fHealth as 'ok' | 'problem'),
        city: fCity === 'all' ? undefined : fCity,
        q: fQ || undefined,
      }),
    [refreshKey, pg.page, pg.pageSize, fOnline, fHealth, fCity, fQ],
    autoMs,
  )
  // 属地候选取省份池（与帖子池同一份口径，避免出现池中没有的属地名）
  const cities = useFetch(() => api.cities({ limit: 500 }), [refreshKey])
  const cityOptions = [
    { value: 'all', label: '全部属地' },
    ...(cities.data?.items ?? []).map((c) => ({ value: c.city, label: c.city })),
  ]
  const dirty = fOnline !== 'all' || fHealth !== 'all' || fCity !== 'all' || fQ !== ''
  const reset = () => {
    setFOnline('all')
    setFHealth('all')
    setFCity('all')
    setFQ('')
    pg.setPage(0)
  }


  const doReset = async (id: string, model: string | null) => {
    const ok = window.confirm(
      `确认复位这台设备的计数？\n\n设备：${id}\n机型：${model ?? '-'}\n\n` +
        '将归零：日计数 / 下次可领取时间 / 连续失败次数\n' +
        '（累计成功、失败、unknown 统计保留）',
    )
    if (!ok) return
    try {
      const r = await api.resetCounters(id)
      notify(r.ok ? '已复位设备计数' : `复位失败：${r.error}`, r.ok ? 'ok' : 'err')
      dev.reload()
    } catch (e) {
      notify(`复位失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  /**
   * 下发指令：写入 device_commands(pending)，随该设备**下一次心跳**送达（约 30 秒内），
   * 设备执行后上报 command_result → 后台标记 done。可在「指令」页看进度。
   */
  const send = async (deviceId: string, kind: CommandKind) => {
    const meta = COMMAND_KINDS.find((c) => c.kind === kind)
    const ok = window.confirm(
      `向设备下发「${meta?.label ?? kind}」？\n\n${meta?.hint ?? ''}\n\n` +
        '指令会随该设备下一次心跳（约 30 秒内）送达；可在「指令」页查看是否执行成功。',
    )
    if (!ok) return
    try {
      const r = await api.sendCommand(deviceId, kind)
      const cmdId = (r.detail as { commandId?: string } | undefined)?.commandId
      notify(
        r.ok ? `已下发「${meta?.label ?? kind}」${cmdId ? `（${cmdId}）` : ''}` : `下发失败：${r.error}`,
        r.ok ? 'ok' : 'err',
      )
    } catch (e) {
      notify(`下发失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  return (
    <Card
      title="设备"
      subtitle="按最后心跳倒序；「复位计数」归零日计数，「下发指令」可触发领取/切省/自检/暂停等"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {/* 筛选一律走服务端，且每次变更都回第 1 页（否则会停在越界页码上） */}
          <FilterSelect
            label="状态"
            value={fOnline}
            onChange={(v) => {
              setFOnline(v)
              pg.setPage(0)
            }}
            options={[
              { value: 'all', label: '全部' },
              { value: 'online', label: '在线' },
              { value: 'offline', label: '离线' },
            ]}
          />
          <FilterSelect
            label="健康"
            value={fHealth}
            onChange={(v) => {
              setFHealth(v)
              pg.setPage(0)
            }}
            options={[
              { value: 'all', label: '全部' },
              { value: 'problem', label: '有异常' },
              { value: 'ok', label: '全绿' },
            ]}
          />
          <FilterSelect
            label="属地"
            value={fCity}
            onChange={(v) => {
              setFCity(v)
              pg.setPage(0)
            }}
            options={cityOptions}
          />
          <FilterSearch
            label="搜索"
            value={fQ}
            placeholder="设备 ID / 机型"
            onCommit={(v) => {
              setFQ(v)
              pg.setPage(0)
            }}
          />
          {dirty && (
            <Btn small tone="ghost" onClick={reset} title="清空全部筛选">
              重置
            </Btn>
          )}
          <Btn onClick={dev.reload} disabled={dev.loading}>
            刷新
          </Btn>
        </div>
      }
    >
      {dev.loading && !dev.data && <Spinner />}
      {dev.error && <ErrorBox msg={dev.error} onRetry={dev.reload} />}
      {dev.data && dev.data.items.length === 0 && (
        <Empty text={dirty ? '没有符合筛选条件的设备' : '还没有设备上报心跳'} />
      )}
      {dev.data && dev.data.items.length > 0 && (
        <Table
          head={[
            '状态',
            '设备',
            '机型',
            '出口属地',
            '系统权限',
            '今日配额',
            '成功 / 失败 / 待确认',
            '最后心跳',
            '下次可领',
            '操作',
          ]}
        >
          {dev.data.items.map((x) => (
            <tr key={x.id} className="hover:bg-slate-800/30">
              <Td>
                <Badge tone={x.online ? 'ok' : 'muted'}>{x.online ? '在线' : '离线'}</Badge>
                {x.admin_state !== 'enabled' && (
                  <span className="ml-1">
                    <Badge tone="warn">{x.admin_state}</Badge>
                  </span>
                )}
                {x.busy_task_id && (
                  <span className="ml-1">
                    <Badge tone="info">执行中</Badge>
                  </span>
                )}
              </Td>
              <Td className="font-mono text-[11px] text-slate-400" >
                <span title={x.id}>{shortId(x.id)}</span>
              </Td>
              <Td className="text-slate-400">
                {x.model ?? '-'}
                {x.agent_version && <span className="ml-1 text-slate-600">v{x.agent_version}</span>}
              </Td>
              <Td>
                {x.last_ip_city ?? '-'}
                {x.last_ip && <span className="ml-1 text-slate-600">{x.last_ip}</span>}
              </Td>
              <Td>
                <div className="flex gap-1">
                  <PermissionBadge label="无障碍" ok={x.accessibility_ok} />
                  <PermissionBadge label="前台" ok={x.foreground_ok} />
                  <PermissionBadge label="代理" ok={x.proxy_ok} />
                </div>
              </Td>
              <Td className="tabular-nums">
                <span className={x.daily_done > 0 ? 'text-slate-100' : 'text-slate-500'}>
                  {x.daily_done}
                </span>
                {x.fail_streak > 0 && (
                  <span className="ml-1">
                    <Badge tone="warn">连败 {x.fail_streak}</Badge>
                  </span>
                )}
              </Td>
              <Td className="tabular-nums">
                <span className="text-emerald-300">{x.total_success}</span>
                <span className="text-slate-600"> / </span>
                <span className="text-rose-300">{x.total_fail}</span>
                <span className="text-slate-600"> / </span>
                <span className="text-amber-300">{x.total_unknown}</span>
              </Td>
              <Td className="text-slate-400" title={fmtTime(x.last_seen_at)}>
                {fmtGap(x.lastSeenGapSec)}
              </Td>
              <Td className="text-slate-400" title={fmtTime(x.next_eligible_at)}>
                {x.next_eligible_at ? fmtTime(x.next_eligible_at) : '可领取'}
              </Td>
              <Td>
                <div className="flex items-center gap-1">
                  <Btn small onClick={() => void doReset(x.id, x.model)}>
                    复位计数
                  </Btn>
                  <select
                    value=""
                    disabled={!x.online}
                    title={x.online ? '选择要下发的指令' : '设备离线 —— 指令会一直 pending，等它恢复心跳后才送达'}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v) void send(x.id, v as CommandKind)
                      e.target.value = ''
                    }}
                    className="rounded-md border border-slate-700 bg-slate-800 px-1.5 py-1 text-[11px] text-slate-300 disabled:opacity-40"
                  >
                    <option value="">下发指令…</option>
                    {COMMAND_KINDS.map((c) => (
                      <option key={c.kind} value={c.kind}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {dev.data && (
        <Pager
          total={dev.data.total}
          page={pg.page}
          pageSize={pg.pageSize}
          onPage={pg.setPage}
          onPageSize={pg.setPageSize}
        />
      )}
    </Card>
  )
}
