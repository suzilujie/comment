import { api, fmtTime } from '../api'
import { Badge, Btn, Card, Empty, ErrorBox, Pager, Spinner, Table, Td, useFetch, usePaging } from '../ui'

interface Props {
  autoMs: number
  refreshKey: number
  notify: (text: string, tone?: 'ok' | 'err' | 'info') => void
}

const statusTone = (s: string): 'ok' | 'warn' | 'err' | 'info' | 'muted' => {
  switch (s) {
    case 'done':
      return 'ok'
    case 'failed':
      return 'err'
    case 'delivered':
      return 'info'
    case 'pending':
      return 'warn'
    default:
      return 'muted'
  }
}

/**
 * 指令记录。
 *
 * 指令通道：管理台下发 → 写入 `device_commands(pending)` → 设备**下一次心跳**取走
 * 并标记 `delivered` → 设备执行后上报 `command_result` 事件 → 后台标记 `done`。
 * 所以「下发了但一直是 pending」= 设备没在上报心跳（离线或服务未运行）。
 */
export default function Commands({ autoMs, refreshKey, notify }: Props) {
  const pg = usePaging()
  const cmds = useFetch(
    () => api.commands({ limit: pg.pageSize, offset: pg.offset }),
    [refreshKey, pg.page, pg.pageSize],
    autoMs,
  )

  const items = cmds.data?.items ?? []
  const pending = items.filter((c) => c.status === 'pending').length

  return (
    <Card
      title="指令记录"
      subtitle={
        `最近 ${items.length} 条` +
        (pending > 0
          ? ` · ⚠ ${pending} 条仍为 pending（设备未取走 —— 检查它是否在上报心跳）`
          : ' · 指令会随设备下一次心跳送达（约 30 秒内）')
      }
      actions={
        <Btn onClick={cmds.reload} disabled={cmds.loading}>
          刷新
        </Btn>
      }
    >
      {cmds.loading && !cmds.data && <Spinner />}
      {cmds.error && <ErrorBox msg={cmds.error} onRetry={cmds.reload} />}
      {cmds.data && items.length === 0 && <Empty text="还没有下发过指令（在「设备」页可以对某台设备下发）" />}
      {items.length > 0 && (
        <Table head={['指令', '设备', '下发时间', '送达', '完成', '状态', '结果']}>
          {items.map((c) => (
            <tr key={c.id} className="hover:bg-slate-800/30">
              <Td>
                <span className="text-slate-300">{c.kind}</span>
                <div className="mt-0.5 font-mono text-[11px] text-slate-600">{c.id}</div>
              </Td>
              <Td className="font-mono text-[11px] text-slate-400">
                {c.device_id.length > 12 ? `${c.device_id.slice(0, 8)}…` : c.device_id}
              </Td>
              <Td className="text-slate-400">{fmtTime(c.created_at)}</Td>
              <Td className="text-slate-400">{fmtTime(c.delivered_at)}</Td>
              <Td className="text-slate-400">{fmtTime(c.finished_at)}</Td>
              <Td>
                <Badge tone={statusTone(c.status)}>{c.status}</Badge>
              </Td>
              <Td className="max-w-[240px] truncate text-[11px] text-slate-500" title={JSON.stringify(c.result ?? {})}>
                {c.result ? JSON.stringify(c.result) : '-'}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {cmds.data && (
        <Pager
          total={cmds.data.total}
          page={pg.page}
          pageSize={pg.pageSize}
          onPage={pg.setPage}
          onPageSize={pg.setPageSize}
        />
      )}
    </Card>
  )
}
