import { useState } from 'react'
import { api, fmtTime, statusTone } from '../api'
import {
  Badge,
  Btn,
  Card,
  Empty,
  ErrorBox,
  FilterSelect,
  Pager,
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
  // ── 筛选（全部服务端；前端过滤在分页下只作用于当前页）──
  const [fStatus, setFStatus] = useState('all')
  const [fCity, setFCity] = useState('all')
  const [fType, setFType] = useState('all')
  const [fBlocked, setFBlocked] = useState('all')
  const dirty = fStatus !== 'all' || fCity !== 'all' || fType !== 'all' || fBlocked !== 'all'
  const pg = usePaging()
  const posts = useFetch(
    () =>
      api.posts({
        limit: pg.pageSize,
        offset: pg.offset,
        status: fStatus === 'all' ? undefined : fStatus,
        city: fCity === 'all' ? undefined : fCity,
        postType: fType === 'all' ? undefined : fType,
        // 只看「有余量却派不出去」的 —— 这是需要人工补素材的待办清单
        blocked: fBlocked === 'blocked' ? true : undefined,
      }),
    [refreshKey, pg.page, pg.pageSize, fStatus, fCity, fType, fBlocked],
    autoMs,
  )
  // 省份池：属地是**精确匹配**的硬条件 —— 自由文本打错一个字（如「河北省」）帖子就
  // 永远派不出去，而且不会有任何报错，只会在后台表现为「怎么一直没任务」。
  // 不轮询（autoMs 默认 0）：省份池几乎不变，跟着 refreshKey 走即可。
  //
  // ⚠ 必须显式要一个大 limit：这是给「省份下拉」供全量选项用的，不是列表页 ——
  //    用默认分页（20 条）会把省份截断，导致部分省份在下拉里选不到。
  const cities = useFetch(() => api.cities({ limit: 500 }), [refreshKey])
  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  /** 表单内联「新增省份」的状态（见 addCity） */
  const [newCityOpen, setNewCityOpen] = useState(false)
  const [newCity, setNewCity] = useState('')
  const [addingCity, setAddingCity] = useState(false)

  /**
   * 省份下拉选项：池中省份 +（编辑时）该帖当前值。
   *
   * ⚠ 必须把当前值也保留：历史数据里可能存在池中没有的省份（改名、停用、早期手工录入）。
   * 若不保留，下拉会默认落到第一项 —— 用户只想改个标题，却把属地**静默改掉了**。
   */
  const cityOptions = (current: string | undefined) => {
    const opts = (cities.data?.items ?? []).map((c) => ({
      value: c.city,
      label: c.active ? c.city : `${c.city}（省份池中已停用）`,
    }))
    const cur = (current ?? '').trim()
    if (cur && !opts.some((o) => o.value === cur)) {
      opts.unshift({ value: cur, label: `${cur}（不在省份池中）` })
    }
    return opts
  }

  /** 尚未入池的标准省份名（后台下发），用于表单内联新增 */
  const availableProvinces = cities.data?.availableProvinces ?? []

  /**
   * 内联新增省份 —— 省得为了加一个省在「帖子池 / 省份池」两个页签之间来回跳。
   *
   * 下拉只列**标准省名**（后台 `PROVINCE_SLUGS`），所以不会有错别字：池里一旦出现
   * 「河北省」，该省帖子就永远匹配不上设备上报的「河北」，而症状只是"怎么一直没任务"，
   * 几乎无法归因。slug 也由后台按省名推导，不需要人工填写。
   */
  const addCity = async () => {
    const name = newCity.trim()
    if (!name) return
    setAddingCity(true)
    try {
      const r = await api.createCity(name)
      if (!r.ok) {
        notify(`新增省份失败：${r.error}`, 'err')
        return
      }
      cities.reload()
      // 立刻选中：即便池子还没刷新回来，cityOptions() 也会把当前值兜底列为候选项
      setForm((f) => (f ? { ...f, city: name } : f))
      setNewCityOpen(false)
      setNewCity('')
      notify(`已新增省份「${name}」并选中`, 'ok')
    } catch (e) {
      notify(`新增省份失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setAddingCity(false)
    }
  }

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
      notify('请选择省份（属地是精确匹配条件，设备出口属地必须与之一致）', 'err')
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
      subtitle="committed = 已占用条数（成功 + 在途 + unknown）；状态旁的黄色标记 = 该帖有余量但派不出去（需补素材）"
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
              { value: 'active', label: 'active' },
              { value: 'paused', label: 'paused' },
              { value: 'done', label: 'done' },
              { value: 'invalid', label: 'invalid' },
            ]}
          />
          <FilterSelect
            label="省份"
            value={fCity}
            onChange={(v) => {
              setFCity(v)
              pg.setPage(0)
            }}
            options={[
              { value: 'all', label: '全部省份' },
              ...(cities.data?.items ?? []).map((c) => ({ value: c.city, label: c.city })),
            ]}
          />
          {/* 筛的是**帖子**类型（post_type）。「纯文字/图文」是评论形态（comment_type）的
              措辞，用在这里等于筛错了轴 —— 视频帖同样会有纯文字评论，两者不是一回事。 */}
          <FilterSelect
            label="帖子类型"
            value={fType}
            onChange={(v) => {
              setFType(v)
              pg.setPage(0)
            }}
            options={[
              { value: 'all', label: '全部' },
              { value: 'video', label: '视频帖' },
              { value: 'image', label: '图文帖' },
            ]}
          />
          <FilterSelect
            label=""
            value={fBlocked}
            onChange={(v) => {
              setFBlocked(v)
              pg.setPage(0)
            }}
            options={[
              { value: 'all', label: '全部帖子' },
              { value: 'blocked', label: '只看派不出去的' },
            ]}
          />
          {dirty && (
            <Btn
              small
              tone="ghost"
              onClick={() => {
                setFStatus('all')
                setFCity('all')
                setFType('all')
                setFBlocked('all')
                pg.setPage(0)
              }}
              title="清空全部筛选"
            >
              重置
            </Btn>
          )}
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
                省份 <span className="text-slate-600">（须与设备出口属地一致）</span>
              </div>
              <select
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                className={inputCls}
              >
                <option value="">请选择省份…</option>
                {cityOptions(form.city).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {/* 内联新增省份：省得为了加一个省在「帖子池 / 省份池」之间来回跳 */}
              {newCityOpen ? (
                <div className="mt-1.5 flex gap-1">
                  <select
                    value={newCity}
                    onChange={(e) => setNewCity(e.target.value)}
                    className={inputCls}
                  >
                    <option value="">选择要新增的省份…</option>
                    {availableProvinces.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                  <Btn small onClick={() => void addCity()} disabled={addingCity || !newCity}>
                    {addingCity ? '加入中…' : '加入'}
                  </Btn>
                  <Btn
                    small
                    tone="ghost"
                    onClick={() => {
                      setNewCityOpen(false)
                      setNewCity('')
                    }}
                    disabled={addingCity}
                  >
                    取消
                  </Btn>
                </div>
              ) : (
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-slate-600">
                    选自「省份池」；属地是精确匹配，不匹配不会被派单
                  </span>
                  {availableProvinces.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setNewCityOpen(true)}
                      className="shrink-0 text-[10px] text-sky-400 hover:text-sky-300"
                    >
                      ＋ 新增省份
                    </button>
                  )}
                </div>
              )}
            </div>
            <div>
              <div className="mb-1 text-[11px] text-slate-500">帖子类型</div>
              <select
                value={form.postType}
                onChange={(e) => setForm({ ...form, postType: e.target.value as 'video' | 'image' })}
                className={inputCls}
              >
                {/* ⚠ 这里只是**帖子本身**的分类（视频帖 / 图文帖），**不影响评论形态**：
                    无论哪种帖子，评论都可以是图文评论或纯文字评论。
                    「图文 1/4、纯文字 3/4」是按**每帖**的配比自动决定的（见
                    post_store.findDispatchablePost），与帖子类型无关。
                    原文案「video（纯文字评论）」把帖子类型与评论形态混写成一行，
                    等于凭空给视频帖加了一条"只能纯文字"的限制。 */}
                <option value="video">视频帖</option>
                <option value="image">图文帖</option>
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
        <Empty
          text={
            dirty ? '没有符合筛选条件的帖子' : '帖子池为空 —— 点「新增帖子」加一个真实抖音链接'
          }
        />
      )}
      {posts.data && posts.data.items.length > 0 && (
        <Table head={['帖子', '省份', '状态', '进度', '今占', '最近评论', '累计（成功/待确认/失败）', '操作']}>
          {posts.data.items.map((p) => {
            const pct = p.target_count > 0 ? Math.min(100, Math.round((p.committed / p.target_count) * 100)) : 0
            return (
              <tr key={p.id} className="hover:bg-slate-800/30">
                <Td>
                  <span className="font-mono text-[11px] text-slate-300">{p.id}</span>
                  {/* 显示中文而非裸 `video`/`image`：这一列是**帖子**类型 */}
                  {p.post_type && (
                    <span className="ml-1 text-slate-600">
                      {p.post_type === 'image' ? '图文帖' : '视频帖'}
                    </span>
                  )}
                  {p.url && (
                    <div className="mt-0.5 max-w-[240px] truncate text-[11px] text-slate-600" title={p.url}>
                      {p.url}
                    </div>
                  )}
                </Td>
                <Td className="text-slate-400">{p.city}</Td>
                <Td>
                  <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                  {/* 有余量却派不出去 → 多半是缺素材，必须让人一眼看见（否则只会表现为"一直没有任务"） */}
                  {p.blocked_reason && (
                    <div className="mt-0.5">
                      <Badge tone="warn">{p.blocked_reason}</Badge>
                    </div>
                  )}
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
      {posts.data && (
        <Pager
          total={posts.data.total}
          page={pg.page}
          pageSize={pg.pageSize}
          onPage={pg.setPage}
          onPageSize={pg.setPageSize}
        />
      )}
    </Card>
  )
}
