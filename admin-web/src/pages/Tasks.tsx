import { useState } from 'react'
import { api, fmtTime, statusTone } from '../api'
import type { TaskItem } from '../api'
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

function duration(task: TaskItem): string {
  if (!task.finished_at) return '进行中'
  const ms = new Date(task.finished_at).getTime() - new Date(task.dispatched_at).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '-'
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * 评论形态（`tasks.comment_type`）→ 中文。
 *
 * ⚠ 别与帖子池的「帖子类型」（`posts.post_type`）混为一谈：
 * 那个说的是帖子是视频帖还是图文帖；这个说的是**这一条评论**带不带图，
 * 由派单时按「图文 1/4、纯文字 3/4」的配比自动算出（见 `decideCommentType`）。
 */
const commentTypeLabel = (v: string | null): string =>
  v === 'image' ? '图文评论' : v === 'text' ? '纯文字评论' : '-'

export default function Tasks({ autoMs, refreshKey, notify }: Props) {
  // ── 筛选（全部服务端；前端 filter 在分页下只作用于当前页）──
  // 原来的「仅看 unknown」复选框被状态下拉取代：语义等价（选 unknown 即可），
  // 但顺带能筛 failed / aborted / succeeded，不必再靠肉眼扫全表。
  const [fStatus, setFStatus] = useState('all')
  const [fQ, setFQ] = useState('')
  const pg = usePaging()
  const tasks = useFetch(
    () =>
      api.tasks({
        limit: pg.pageSize,
        offset: pg.offset,
        status: fStatus === 'all' ? undefined : fStatus,
        q: fQ || undefined,
      }),
    [refreshKey, fStatus, fQ, pg.page, pg.pageSize],
    autoMs,
  )

  const items = tasks.data?.items ?? []
  const dirty = fStatus !== 'all' || fQ !== ''

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
        <div className="flex flex-wrap items-center gap-2">
          {/* 筛选一律走服务端，且每次变更都回第 1 页（否则会停在越界页码上） */}
          <FilterSelect
            label="状态"
            value={fStatus}
            onChange={(v) => {
              setFStatus(v)
              pg.setPage(0)
            }}
            options={[
              { value: 'all', label: '全部' },
              { value: 'unknown', label: 'unknown（待人工确认）' },
              { value: 'dispatched', label: 'dispatched' },
              { value: 'executing', label: 'executing' },
              { value: 'succeeded', label: 'succeeded' },
              { value: 'failed', label: 'failed' },
              { value: 'aborted', label: 'aborted' },
            ]}
          />
          <FilterSearch
            label="搜索"
            value={fQ}
            placeholder="任务 / 帖子 / 设备 ID"
            onCommit={(v) => {
              setFQ(v)
              pg.setPage(0)
            }}
          />
          {dirty && (
            <Btn
              small
              tone="ghost"
              onClick={() => {
                setFStatus('all')
                setFQ('')
                pg.setPage(0)
              }}
              title="清空全部筛选"
            >
              重置
            </Btn>
          )}
          <Btn onClick={tasks.reload} disabled={tasks.loading}>
            刷新
          </Btn>
        </div>
      }
    >
      {tasks.loading && !tasks.data && <Spinner />}
      {tasks.error && <ErrorBox msg={tasks.error} onRetry={tasks.reload} />}
      {tasks.data && items.length === 0 && (
        <Empty text={dirty ? '没有符合筛选条件的任务' : '暂无任务'} />
      )}
      {items.length > 0 && (
        <Table
          head={[
            '状态',
            '派发时间',
            '帖子',
            '设备',
            '评论形态',
            '话术 / 证据',
            '原因 / 耗时',
            '操作',
          ]}
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
              <Td className="text-slate-400">{commentTypeLabel(t.comment_type)}</Td>
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
