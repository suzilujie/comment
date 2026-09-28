import { api, fmtTime } from '../api'
import { Badge, Card, ErrorBox, Spinner, StatCard, useFetch } from '../ui'

interface Props {
  autoMs: number
  refreshKey: number
  notify: (text: string, tone?: 'ok' | 'err' | 'info') => void
}

interface Health {
  ok: boolean
  db: boolean
  serverTimeMs: number
  heartbeatSeconds: number
  port: number
}

export default function Overview({ autoMs, refreshKey }: Props) {
  const health = useFetch<Health>(
    async () => {
      const r = await fetch('/health')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return (await r.json()) as Health
    },
    [refreshKey],
    autoMs,
  )
  const ov = useFetch(() => api.overview(), [refreshKey], autoMs)

  const d = ov.data
  const done = (d?.tasksSucceeded ?? 0) + (d?.tasksUnknown ?? 0) + (d?.tasksFailed ?? 0)
  const rate = done > 0 ? Math.round(((d?.tasksSucceeded ?? 0) / done) * 100) : 0

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="系统状态"
        subtitle="后端健康与自动刷新节奏"
        actions={
          <>
            {health.data && (
              <Badge tone={health.data.ok && health.data.db ? 'ok' : 'err'}>
                {health.data.ok && health.data.db ? '后端正常 / 数据库正常' : '异常'}
              </Badge>
            )}
            <Badge>{autoMs ? `每 ${Math.round(autoMs / 1000)}s 自动刷新` : '未开启自动刷新'}</Badge>
          </>
        }
      >
        {health.loading && !health.data && <Spinner />}
        {health.error && <ErrorBox msg={health.error} onRetry={health.reload} />}
        {health.data && (
          <div className="grid grid-cols-2 gap-3 text-xs text-slate-400 sm:grid-cols-4">
            <div>
              <div className="text-[11px] text-slate-500">服务端口</div>
              <div className="mt-0.5 text-slate-200 tabular-nums">{health.data.port}</div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500">心跳周期</div>
              <div className="mt-0.5 text-slate-200 tabular-nums">
                {health.data.heartbeatSeconds}s
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500">服务器时间</div>
              <div className="mt-0.5 text-slate-200 tabular-nums">
                {fmtTime(new Date(health.data.serverTimeMs))}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500">在线判定阈值</div>
              <div className="mt-0.5 text-slate-200 tabular-nums">
                {d?.onlineThresholdSeconds ?? '-'}s
              </div>
            </div>
          </div>
        )}
      </Card>

      {ov.error && <ErrorBox msg={ov.error} onRetry={ov.reload} />}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="设备"
          value={`${d?.devicesOnline ?? '-'} / ${d?.devicesTotal ?? '-'}`}
          hint={`在线 / 总数${d?.devicesBusy ? ` · 执行中 ${d.devicesBusy}` : ''}`}
          tone={(d?.devicesOnline ?? 0) > 0 ? 'ok' : 'err'}
        />
        <StatCard label="今日派单" value={d?.tasksToday ?? '-'} hint="按 UTC+8 自然日" />
        <StatCard
          label="累计成功"
          value={d?.tasksSucceeded ?? '-'}
          hint={`成功率 ${rate}%（含 unknown 分母）`}
          tone="ok"
        />
        <StatCard
          label="待人工确认"
          value={d?.tasksUnknown ?? '-'}
          hint="unknown 任务（禁止自动重试）"
          tone={(d?.tasksUnknown ?? 0) > 0 ? 'warn' : 'default'}
        />
        <StatCard label="累计失败" value={d?.tasksFailed ?? '-'} tone="err" hint="failed 终态" />
        <StatCard
          label="帖子池"
          value={`${d?.postsActive ?? '-'} / ${(d?.postsActive ?? 0) + (d?.postsPaused ?? 0)}`}
          hint={`启用 / 全部（暂停 ${d?.postsPaused ?? 0}）`}
        />
        <StatCard label="可用话术" value={d?.scriptsEnabled ?? '-'} hint="enabled = true" />
        <StatCard label="激活省份池" value={d?.citiesActive ?? '-'} hint="下发给设备的切省目标" />
      </div>

      {(d?.tasksUnknown ?? 0) > 0 && (
        <Card title="需要处理" subtitle="unknown 任务需要人工核实后订正">
          <p className="text-xs text-amber-300">
            当前有 <span className="font-semibold tabular-nums">{d?.tasksUnknown}</span> 条 unknown
            任务。到「任务」页核实评论是否真的发出：
            已发出 → 订正为 succeeded（保持占用）；未发出 → 订正为 failed（自动释放当天名额）。
          </p>
        </Card>
      )}
    </div>
  )
}
