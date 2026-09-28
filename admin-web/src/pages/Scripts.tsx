import { useState } from 'react'
import { api, fmtTime } from '../api'
import { Badge, Btn, Card, Empty, ErrorBox, Spinner, Table, Td, useFetch } from '../ui'

interface Props {
  autoMs: number
  refreshKey: number
  notify: (text: string, tone?: 'ok' | 'err' | 'info') => void
}

/**
 * 话术管理。
 *
 * 派单时按「同帖不重复」挑话术（`findDispatchablePost` 里的 LATERAL 子查询），
 * 所以给某个帖子加话术要保证话术池里还有它没用过的 —— 加得越多，同一个帖子
 * 能撑起的评论条数越多。
 */
export default function Scripts({ autoMs, refreshKey, notify }: Props) {
  const scripts = useFetch(() => api.scripts(), [refreshKey], autoMs)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)

  const add = async () => {
    const text = draft.trim()
    if (!text) return
    try {
      const r = await api.createScript(text)
      notify(r.ok ? '已新增话术' : `新增失败：${r.error}`, r.ok ? 'ok' : 'err')
      if (r.ok) {
        setDraft('')
        scripts.reload()
      }
    } catch (e) {
      notify(`新增失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  const saveEdit = async () => {
    if (!editing) return
    try {
      const r = await api.updateScript(editing.id, { text: editing.text })
      notify(r.ok ? '已保存' : `保存失败：${r.error}`, r.ok ? 'ok' : 'err')
      if (r.ok) {
        setEditing(null)
        scripts.reload()
      }
    } catch (e) {
      notify(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  const toggle = async (id: string, enabled: boolean) => {
    try {
      const r = await api.updateScript(id, { enabled })
      notify(r.ok ? `已${enabled ? '启用' : '停用'}` : `操作失败：${r.error}`, r.ok ? 'ok' : 'err')
      scripts.reload()
    } catch (e) {
      notify(`操作失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  const remove = async (id: string, text: string, usedBy: number) => {
    const ok = window.confirm(
      `删除话术「${text.slice(0, 30)}${text.length > 30 ? '…' : ''}」？\n\n` +
        `将删除：话术本身 + 所有帖子的使用记录\n` +
        (usedBy > 0
          ? `⚠ 当前有 ${usedBy} 个帖子用过它，删除后这些帖子可以重新用到这句话术（可能造成同帖重复文案）。\n\n`
          : '\n') +
        '此操作不可撤销。',
    )
    if (!ok) return
    try {
      const r = await api.deleteScript(id)
      notify(r.ok ? '已删除' : `删除失败：${r.error}`, r.ok ? 'ok' : 'err')
      scripts.reload()
    } catch (e) {
      notify(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  const enabledCount = scripts.data?.items.filter((s) => s.enabled).length ?? 0

  return (
    <Card
      title="话术管理"
      subtitle={`共 ${scripts.data?.items.length ?? 0} 条，启用 ${enabledCount} 条 · 派单时按「同帖不重复」挑选`}
      actions={
        <Btn onClick={scripts.reload} disabled={scripts.loading}>
          刷新
        </Btn>
      }
    >
      <div className="mb-4 flex items-end gap-2">
        <div className="flex-1">
          <div className="mb-1 text-[11px] text-slate-500">新增话术</div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            placeholder="例如：看完感觉收获满满，谢谢分享"
            className="w-full resize-y rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-600"
          />
        </div>
        <Btn onClick={() => void add()} disabled={!draft.trim()}>
          新增
        </Btn>
      </div>

      {scripts.loading && !scripts.data && <Spinner />}
      {scripts.error && <ErrorBox msg={scripts.error} onRetry={scripts.reload} />}
      {scripts.data && scripts.data.items.length === 0 && <Empty text="话术池为空 —— 没有话术就派不出任务" />}
      {scripts.data && scripts.data.items.length > 0 && (
        <Table head={['话术', '被引用', '状态', '创建时间', '操作']}>
          {scripts.data.items.map((s) => (
            <tr key={s.id} className="hover:bg-slate-800/30">
              <Td>
                {editing?.id === s.id ? (
                  <textarea
                    value={editing.text}
                    onChange={(e) => setEditing({ id: s.id, text: e.target.value })}
                    rows={2}
                    className="w-full min-w-[280px] resize-y rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 outline-none focus:border-sky-600"
                  />
                ) : (
                  <span className="whitespace-normal text-slate-300">{s.text}</span>
                )}
                <div className="mt-0.5 font-mono text-[11px] text-slate-600">{s.id}</div>
              </Td>
              <Td className="tabular-nums text-slate-400">
                {s.used_by_posts > 0 ? `${s.used_by_posts} 个帖子` : '未使用'}
              </Td>
              <Td>
                <Badge tone={s.enabled ? 'ok' : 'muted'}>{s.enabled ? '启用' : '停用'}</Badge>
              </Td>
              <Td className="text-slate-400">{fmtTime(s.created_at)}</Td>
              <Td>
                <div className="flex gap-1">
                  {editing?.id === s.id ? (
                    <>
                      <Btn small onClick={() => void saveEdit()}>
                        保存
                      </Btn>
                      <Btn small onClick={() => setEditing(null)}>
                        取消
                      </Btn>
                    </>
                  ) : (
                    <Btn small onClick={() => setEditing({ id: s.id, text: s.text })}>
                      编辑
                    </Btn>
                  )}
                  <Btn small onClick={() => void toggle(s.id, !s.enabled)}>
                    {s.enabled ? '停用' : '启用'}
                  </Btn>
                  <Btn small onClick={() => void remove(s.id, s.text, s.used_by_posts)}>
                    删除
                  </Btn>
                </div>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  )
}
