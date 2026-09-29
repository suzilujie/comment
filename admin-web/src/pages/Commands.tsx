import { api, fmtTime } from '../api'
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

/**
 * 指令状态的配色。
 *
 * ⚠ 与 `api.ts` 里同名的 `statusTone` **不是一回事**：那个面向任务/帖子状态
 * （succeeded/failed/unknown…），这个面向指令状态（pending/delivered/done…）。
 * 两者取值集合不重叠，所以目前各自独立不会出错 —— 但名字重了容易误引入，
 * 本文件刻意只从 api 引入 `api`/`fmtTime`，不引入那个同名函数。
 */
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

  // ⚠ 与其它列表一致：总数用 total（全量），页内统计显式标注"本页"。
  //    用 items.length 当总数会让这个数字随翻页变化，看起来像指令在丢。
  const items = cmds.data?.items ?? []
  const pagePending = items.filter((c) => c.status === 'pending').length

  return (
    <Card
      title="指令记录"
      subtitle={
        `共 ${cmds.data?.total ?? 0} 条 · 本页 ${items.length} 条` +
        (pagePending > 0
          ? ` · ⚠ 本页 ${pagePending} 条仍为 pending（设备未取走 —— 检查它是否在上报心跳）`
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
              <Td className="font-mono text-[11px] text-slate-400">{shortId(c.device_id)}</Td>
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
