import { useState } from 'react'
import { api, fmtTime, statusTone } from '../api'
import { Badge, Btn, Card, Empty, ErrorBox, Spinner, Table, Td, useFetch } from '../ui'

interface Props {
  autoMs: number
  refreshKey: number
  notify: (text: string, tone?: 'ok' | 'err' | 'info') => void
}

const shortId = (id: string | null) => (!id ? '-' : id.length > 12 ? `${id.slice(0, 8)}…` : id)

function detailText(detail: unknown): string {
  if (detail === null || detail === undefined) return ''
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

export default function Events({ autoMs, refreshKey, notify }: Props) {
  const [limit, setLimit] = useState(100)
  const events = useFetch(() => api.events(limit), [refreshKey, limit], autoMs)

  return (
    <Card
      title="事件流"
      subtitle="task_events 追加写、永不修改；actor = manual 的记录来自本管理台的人工操作"
      actions={
        <>
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
          >
            {[50, 100, 200, 500].map((n) => (
              <option key={n} value={n}>
                最近 {n} 条
              </option>
            ))}
          </select>
          <Btn onClick={events.reload} disabled={events.loading}>
            刷新
          </Btn>
        </>
      }
    >
      {events.loading && !events.data && <Spinner />}
      {events.error && <ErrorBox msg={events.error} onRetry={events.reload} />}
      {events.data && events.data.items.length === 0 && <Empty text="暂无事件" />}
      {events.data && events.data.items.length > 0 && (
        <Table head={['时间', '事件', '发起方', '任务', '帖子', '当前状态', '原因', '详情']}>
          {events.data.items.map((e) => {
            const d = detailText(e.detail)
            return (
              <tr key={e.id} className="hover:bg-slate-800/30">
                <Td className="text-slate-400">{fmtTime(e.created_at)}</Td>
                <Td>
                  <Badge tone={statusTone(e.event)}>{e.event}</Badge>
                </Td>
                <Td>
                  <Badge tone={e.actor === 'manual' ? 'info' : 'muted'}>{e.actor}</Badge>
                </Td>
                <Td className="font-mono text-[11px] text-slate-400" >
                  <span title={e.task_id}>{shortId(e.task_id)}</span>
                </Td>
                <Td className="font-mono text-[11px] text-slate-500">{e.post_id ?? '-'}</Td>
                <Td>
                  {e.task_status ? (
                    <Badge tone={statusTone(e.task_status)}>{e.task_status}</Badge>
                  ) : (
                    <span className="text-slate-600">-</span>
                  )}
                </Td>
                <Td className="text-slate-400">
                  {e.reason_code ? <span className="text-rose-300">{e.reason_code}</span> : '-'}
                </Td>
                <Td className="max-w-[360px]">
                  {d ? (
                    <span className="block truncate font-mono text-[11px] text-slate-500" title={d}>
                      {d}
                    </span>
                  ) : (
                    <span className="text-slate-700">-</span>
                  )}
                </Td>
              </tr>
            )
          })}
        </Table>
      )}
    </Card>
  )
}
