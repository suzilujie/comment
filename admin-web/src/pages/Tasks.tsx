import { useState } from 'react'
import { api, fmtTime, statusTone } from '../api'
import type { TaskItem } from '../api'
import { Badge, Btn, Card, Empty, ErrorBox, Pager, Spinner, Table, Td, useFetch, usePaging } from '../ui'

interface Props {
  autoMs: number
  refreshKey: number
  notify: (text: string, tone?: 'ok' | 'err' | 'info') => void
}

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id)

function duration(task: TaskItem): string {
  if (!task.finished_at) return '进行中'
  const ms = new Date(task.finished_at).getTime() - new Date(task.dispatched_at).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '-'
  return `${(ms / 1000).toFixed(1)}s`
}

export default function Tasks({ autoMs, refreshKey, notify }: Props) {
  const [onlyUnknown, setOnlyUnknown] = useState(false)
  const pg = usePaging()
  // ⚠ 状态过滤必须走**服务端**（api.tasks 的 status 参数）：前端 filter 只作用于当前页，
  //    一加分页就会出现「共 N 条、但只看到几行」的错位显示。
  const tasks = useFetch(
    () =>
      api.tasks({
        limit: pg.pageSize,
        offset: pg.offset,
        status: onlyUnknown ? 'unknown' : undefined,
      }),
    [refreshKey, onlyUnknown, pg.page, pg.pageSize],
    autoMs,
  )

  const items = tasks.data?.items ?? []

  const resolve = async (taskId: string, verdict: 'succeeded' | 'failed') => {
    const isOk = verdict === 'succeeded'
    const msg = isOk
      ? `确认订正为「评论已发出」？\n\n任务：${taskId}\n\n` +
        '→ 计入成功统计，保持该帖当天占用，并刷新设备的可领取时间'
      : `确认订正为「评论未发出」？\n\n任务：${taskId}\n\n` +
        '→ 退还设备当日配额，并释放「同设备 × 同帖每天一次」占用的名额'
    if (!window.confirm(msg)) return
    try {
      const r = await api.resolveTask(taskId, verdict, 'admin_web manual verify')
      notify(r.ok ? `已订正为 ${verdict}` : `订正失败：${r.error}`, r.ok ? 'ok' : 'err')
      tasks.reload()
    } catch (e) {
      notify(`订正失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  return (
    <Card
      title="任务"
      subtitle="unknown = 可能已发出（读不到证据），必须人工核实后订正，禁止自动重试"
      actions={
        <>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-400 select-none">
            <input
              type="checkbox"
              checked={onlyUnknown}
              onChange={(e) => {
                setOnlyUnknown(e.target.checked)
                pg.setPage(0) // 换过滤条件必须回第 1 页，否则可能停在一个越界页码上
              }}
              className="h-3.5 w-3.5 accent-amber-500"
            />
            仅看 unknown
          </label>
          <Btn onClick={tasks.reload} disabled={tasks.loading}>
            刷新
          </Btn>
        </>
      }
    >
      {tasks.loading && !tasks.data && <Spinner />}
      {tasks.error && <ErrorBox msg={tasks.error} onRetry={tasks.reload} />}
      {tasks.data && items.length === 0 && <Empty text={onlyUnknown ? '没有 unknown 任务' : '暂无任务'} />}
      {items.length > 0 && (
        <Table
          head={['状态', '派发时间', '帖子', '设备', '形态', '话术 / 证据', '原因 / 耗时', '操作']}
        >
          {items.map((t) => (
            <tr key={t.id} className="hover:bg-slate-800/30">
              <Td>
                <Badge tone={statusTone(t.status)}>{t.status}</Badge>
              </Td>
              <Td className="text-slate-400" title={fmtTime(t.dispatched_at)}>
                {fmtTime(t.dispatched_at)}
              </Td>
              <Td>
                <span className="font-mono text-[11px] text-slate-300">{t.post_id}</span>
                {t.dispatch_ip_city && (
                  <span className="ml-1 text-slate-600">{t.dispatch_ip_city}</span>
                )}
              </Td>
              <Td className="font-mono text-[11px] text-slate-500" >
                {t.device_id ? shortId(t.device_id) : '-'}
              </Td>
              <Td className="text-slate-400">{t.comment_type ?? '-'}</Td>
              <Td className="max-w-[320px]">
                {t.evidence ? (
                  <span className="font-mono text-[11px] text-sky-300">{t.evidence}</span>
                ) : (
                  <span className="text-slate-600">-</span>
                )}
                {t.script_text && (
                  <div className="mt-0.5 truncate text-[11px] text-slate-500" title={t.script_text}>
                    {t.script_text}
                  </div>
                )}
              </Td>
              <Td className="text-slate-400">
                {t.reason_code ? (
                  <span className="text-rose-300">{t.reason_code}</span>
                ) : (
                  <span className="text-slate-600">-</span>
                )}
                <span className="ml-2 text-slate-600 tabular-nums">{duration(t)}</span>
              </Td>
              <Td>
                {t.status === 'unknown' ? (
                  <div className="flex gap-1">
                    <Btn small tone="primary" onClick={() => void resolve(t.id, 'succeeded')}>
                      已发出
                    </Btn>
                    <Btn small tone="danger" onClick={() => void resolve(t.id, 'failed')}>
                      未发出
                    </Btn>
                  </div>
                ) : (
                  <span className="text-slate-700">-</span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {tasks.data && (
        <Pager
          total={tasks.data.total}
          page={pg.page}
          pageSize={pg.pageSize}
          onPage={pg.setPage}
          onPageSize={pg.setPageSize}
        />
      )}
    </Card>
  )
}
