import { api, fmtTime, statusTone } from '../api'
import {
  Badge,
  Btn,
  Card,
  Empty,
  ErrorBox,
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

function detailText(detail: unknown): string {
  if (detail === null || detail === undefined) return ''
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

export default function Events({ autoMs, refreshKey }: Props) {
  // 原来的「最近 50/100/200/500 条」下拉被分页条取代：它本质上就是"每页条数"，
  // 而且只能看前 N 条、更早的事件永远看不到。
  const pg = usePaging()
  const events = useFetch(
    () => api.events({ limit: pg.pageSize, offset: pg.offset }),
    [refreshKey, pg.page, pg.pageSize],
    autoMs,
  )

  return (
    <Card
      title="事件流"
      subtitle="task_events 追加写、永不修改；actor = manual 的记录来自本管理台的人工操作"
      actions={
        <>
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
      {events.data && (
        <Pager
          total={events.data.total}
          page={pg.page}
          pageSize={pg.pageSize}
          onPage={pg.setPage}
          onPageSize={pg.setPageSize}
        />
      )}
    </Card>
  )
}
