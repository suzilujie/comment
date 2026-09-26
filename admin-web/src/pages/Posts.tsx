import { api, fmtTime, statusTone } from '../api'
import { Badge, Btn, Card, Empty, ErrorBox, Spinner, Table, Td, useFetch } from '../ui'

interface Props {
  autoMs: number
  refreshKey: number
  notify: (text: string, tone?: 'ok' | 'err' | 'info') => void
}

export default function Posts({ autoMs, refreshKey, notify }: Props) {
  const posts = useFetch(() => api.posts(200), [refreshKey], autoMs)

  const release = async (postId: string, city: string) => {
    const ok = window.confirm(
      `释放「${postId}」${city ? `（${city}）` : ''} 今天的占位？\n\n` +
        '将删除：该帖今天产生的任务记录与事件、素材占用，并清空「最近评论时间」\n' +
        '（即解除单帖 15 分钟节奏限制，设备可立刻重新派到这条帖子）\n\n' +
        '⚠ 这会丢失今天的任务审计记录，仅在人工核实「确实没发出去」后使用。',
    )
    if (!ok) return
    try {
      const r = await api.releaseSlot(postId, { resetPacing: true })
      const d = r.detail as
        | { removedTasks?: number; removedEvents?: number; removedMaterials?: number }
        | undefined
      notify(
        r.ok
          ? `已释放：删除任务 ${d?.removedTasks ?? 0} / 事件 ${d?.removedEvents ?? 0} / 素材占用 ${d?.removedMaterials ?? 0}`
          : `释放失败：${r.error}`,
        r.ok ? 'ok' : 'err',
      )
      posts.reload()
    } catch (e) {
      notify(`释放失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  return (
    <Card
      title="帖子池"
      subtitle="committed = 已占用条数（成功 + 在途 + unknown）；today_used > 0 表示今天该帖已被占用过"
      actions={
        <Btn onClick={posts.reload} disabled={posts.loading}>
          刷新
        </Btn>
      }
    >
      {posts.loading && !posts.data && <Spinner />}
      {posts.error && <ErrorBox msg={posts.error} onRetry={posts.reload} />}
      {posts.data && posts.data.items.length === 0 && <Empty text="帖子池为空" />}
      {posts.data && posts.data.items.length > 0 && (
        <Table head={['帖子', '城市', '状态', '进度', '今占', '最近评论', '累计（成功/待确认/失败）', '操作']}>
          {posts.data.items.map((p) => {
            const pct = p.target_count > 0 ? Math.min(100, Math.round((p.committed / p.target_count) * 100)) : 0
            return (
              <tr key={p.id} className="hover:bg-slate-800/30">
                <Td>
                  <span className="font-mono text-[11px] text-slate-300">{p.id}</span>
                  {p.post_type && <span className="ml-1 text-slate-600">{p.post_type}</span>}
                  {p.url && (
                    <div className="mt-0.5 max-w-[240px] truncate text-[11px] text-slate-600" title={p.url}>
                      {p.url}
                    </div>
                  )}
                </Td>
                <Td className="text-slate-400">{p.city}</Td>
                <Td>
                  <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                </Td>
                <Td>
                  <div className="flex items-center gap-2">
                    <span className="tabular-nums text-slate-300">
                      {p.committed} / {p.target_count}
                    </span>
                    <span className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-800">
                      <span
                        className="block h-full rounded-full bg-sky-600"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                  </div>
                </Td>
                <Td>
                  {p.today_used > 0 ? (
                    <Badge tone="warn">已占 {p.today_used}</Badge>
                  ) : (
                    <span className="text-slate-600">0</span>
                  )}
                </Td>
                <Td className="text-slate-400" title={fmtTime(p.last_comment_at)}>
                  {fmtTime(p.last_comment_at)}
                </Td>
                <Td className="tabular-nums">
                  <span className="text-emerald-300">{p.succeeded}</span>
                  <span className="text-slate-600"> / </span>
                  <span className="text-amber-300">{p.unknown}</span>
                  <span className="text-slate-600"> / </span>
                  <span className="text-rose-300">{p.failed}</span>
                  <span className="ml-1 text-slate-600">（共 {p.total_tasks}）</span>
                </Td>
                <Td>
                  <Btn small onClick={() => void release(p.id, p.city)} disabled={p.today_used === 0}>
                    释放今日名额
                  </Btn>
                </Td>
              </tr>
            )
          })}
        </Table>
      )}
    </Card>
  )
}
