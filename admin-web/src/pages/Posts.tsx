import { useState } from 'react'
import { api, fmtTime, statusTone } from '../api'
import { Badge, Btn, Card, Empty, ErrorBox, Spinner, Table, Td, useFetch } from '../ui'

interface Props {
  autoMs: number
  refreshKey: number
  notify: (text: string, tone?: 'ok' | 'err' | 'info') => void
}

interface FormState {
  /** 有值 = 编辑既有帖子；空 = 新增 */
  id?: string
  url: string
  city: string
  postType: 'video' | 'image'
  title: string
  targetCount: number
  status: string
}

const emptyForm = (): FormState => ({
  url: '',
  city: '',
  postType: 'video',
  title: '',
  targetCount: 5,
  status: 'active',
})

const inputCls =
  'w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-600'

/**
 * 帖子池。
 *
 * `committed` = 已占用条数（成功 + 在途 + unknown），由派单时的**原子占位**维护；
 * `today_used > 0` 表示今天该帖已被占用过（受「同设备 × 同帖每天一次」限制）。
 */
export default function Posts({ autoMs, refreshKey, notify }: Props) {
  const posts = useFetch(() => api.posts(200), [refreshKey], autoMs)
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)

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

  const save = async () => {
    if (!form) return
    if (!form.url.trim()) {
      notify('抖音链接不能为空', 'err')
      return
    }
    if (!form.city.trim()) {
      notify('城市不能为空（要与设备出口属地一致，如「河北」）', 'err')
      return
    }
    setSaving(true)
    try {
      const payload = {
        url: form.url.trim(),
        city: form.city.trim(),
        postType: form.postType,
        title: form.title.trim(),
        targetCount: Number(form.targetCount) || 1,
        status: form.status,
      }
      const r = form.id ? await api.updatePost(form.id, payload) : await api.createPost(payload)
      notify(r.ok ? (form.id ? '已保存' : '已新增帖子') : `保存失败：${r.error}`, r.ok ? 'ok' : 'err')
      if (r.ok) {
        setForm(null)
        posts.reload()
      }
    } catch (e) {
      notify(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string, city: string, totalTasks: number) => {
    const ok = window.confirm(
      `删除帖子「${id}」（${city}）？\n\n` +
        `将连带删除：该帖的所有任务（${totalTasks} 条）、任务事件、素材占用记录。\n\n` +
        '⚠ 审计记录会一并丢失；如果只是想停用，请改用「暂停」状态。\n' +
        '此操作不可撤销。',
    )
    if (!ok) return
    try {
      const r = await api.deletePost(id)
      const d = r.detail as { removedTasks?: number } | undefined
      notify(r.ok ? `已删除（连带任务 ${d?.removedTasks ?? 0} 条）` : `删除失败：${r.error}`, r.ok ? 'ok' : 'err')
      posts.reload()
    } catch (e) {
      notify(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  return (
    <Card
      title="帖子池"
      subtitle="committed = 已占用条数（成功 + 在途 + unknown）；today_used > 0 表示今天该帖已被占用过"
      actions={
        <div className="flex gap-2">
          <Btn onClick={() => setForm(emptyForm())} disabled={form !== null}>
            新增帖子
          </Btn>
          <Btn onClick={posts.reload} disabled={posts.loading}>
            刷新
          </Btn>
        </div>
      }
    >
      {form && (
        <div className="mb-4 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
          <div className="mb-2 text-xs font-medium text-slate-300">
            {form.id ? `编辑帖子 ${form.id}` : '新增帖子'}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2">
              <div className="mb-1 text-[11px] text-slate-500">抖音链接（短链或分享链接）</div>
              <input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://v.douyin.com/xxxx/"
                className={inputCls}
              />
            </div>
            <div>
              <div className="mb-1 text-[11px] text-slate-500">
                城市/省份 <span className="text-slate-600">（须与设备出口属地一致）</span>
              </div>
              <input
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                placeholder="河北"
                className={inputCls}
              />
            </div>
            <div>
              <div className="mb-1 text-[11px] text-slate-500">形态</div>
              <select
                value={form.postType}
                onChange={(e) => setForm({ ...form, postType: e.target.value as 'video' | 'image' })}
                className={inputCls}
              >
                <option value="video">video（纯文字评论）</option>
                <option value="image">image（图文评论，需有素材）</option>
              </select>
            </div>
            <div>
              <div className="mb-1 text-[11px] text-slate-500">目标评论数</div>
              <input
                type="number"
                min={1}
                value={form.targetCount}
                onChange={(e) => setForm({ ...form, targetCount: Number(e.target.value) })}
                className={inputCls}
              />
            </div>
            <div>
              <div className="mb-1 text-[11px] text-slate-500">状态</div>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
                className={inputCls}
              >
                <option value="active">active（可派单）</option>
                <option value="paused">paused（暂停）</option>
                <option value="done">done（已完成）</option>
                <option value="invalid">invalid（无效）</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <div className="mb-1 text-[11px] text-slate-500">标题（可选，仅备注）</div>
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className={inputCls}
              />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Btn onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Btn>
            <Btn tone="ghost" onClick={() => setForm(null)} disabled={saving}>
              取消
            </Btn>
          </div>
        </div>
      )}

      {posts.loading && !posts.data && <Spinner />}
      {posts.error && <ErrorBox msg={posts.error} onRetry={posts.reload} />}
      {posts.data && posts.data.items.length === 0 && (
        <Empty text="帖子池为空 —— 点「新增帖子」加一个真实抖音链接" />
      )}
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
                  <div className="flex gap-1">
                    <Btn
                      small
                      onClick={() =>
                        setForm({
                          id: p.id,
                          url: p.url ?? '',
                          city: p.city ?? '',
                          postType: p.post_type === 'image' ? 'image' : 'video',
                          title: p.title ?? '',
                          targetCount: p.target_count,
                          status: p.status,
                        })
                      }
                    >
                      编辑
                    </Btn>
                    <Btn small onClick={() => void release(p.id, p.city)} disabled={p.today_used === 0}>
                      释放今日名额
                    </Btn>
                    <Btn small onClick={() => void remove(p.id, p.city, p.total_tasks)}>
                      删除
                    </Btn>
                  </div>
                </Td>
              </tr>
            )
          })}
        </Table>
      )}
    </Card>
  )
}
