import { api, fmtGap, fmtTime } from '../api'
import { Badge, Btn, Card, Empty, ErrorBox, Spinner, Table, Td, useFetch } from '../ui'

interface Props {
  autoMs: number
  refreshKey: number
  notify: (text: string, tone?: 'ok' | 'err' | 'info') => void
}

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id)

function PermissionBadge({ label, ok }: { label: string; ok: boolean | null }) {
  if (ok === null) return <Badge tone="muted">{label} ?</Badge>
  return <Badge tone={ok ? 'ok' : 'err'}>{label}</Badge>
}

export default function Devices({ autoMs, refreshKey, notify }: Props) {
  const dev = useFetch(() => api.devices(), [refreshKey], autoMs)

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

  return (
    <Card
      title="设备"
      subtitle="按最后心跳倒序；「复位计数」用于换号或调试期归零日计数"
      actions={
        <Btn onClick={dev.reload} disabled={dev.loading}>
          刷新
        </Btn>
      }
    >
      {dev.loading && !dev.data && <Spinner />}
      {dev.error && <ErrorBox msg={dev.error} onRetry={dev.reload} />}
      {dev.data && dev.data.items.length === 0 && <Empty text="还没有设备上报心跳" />}
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
                <Btn small onClick={() => void doReset(x.id, x.model)}>
                  复位计数
                </Btn>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}
