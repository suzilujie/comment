import { useState } from 'react'
import { api, fmtTime } from '../api'
import { Badge, Btn, Card, Empty, ErrorBox, Spinner, Table, Td, useFetch } from '../ui'

interface Props {
  autoMs: number
  refreshKey: number
  notify: (text: string, tone?: 'ok' | 'err' | 'info') => void
}

/**
 * 城市池管理。
 *
 * 两个用途：
 *  ① **设备切城的目标池** —— 设备端从 `active=TRUE` 的省份里随机挑一个切过去；
 *  ② **空跑预警** —— `post_count=0` 表示切到该省会领不到任务（池里有省没帖）。
 *
 * `slug` 是 Clash 侧的 group 名（本项目的组名对所有省份相同，实际按**节点名**区分省份），
 * 因此保持一致即可，不要随意改 —— 后台会统一成 `province-xxx` 形式。
 */
export default function Cities({ autoMs, refreshKey, notify }: Props) {
  const cities = useFetch(() => api.cities(), [refreshKey], autoMs)
  const [city, setCity] = useState('')
  const [slug, setSlug] = useState('')

  const add = async () => {
    const c = city.trim()
    const s = slug.trim()
    if (!c) {
      notify('省份名不能为空', 'err')
      return
    }
    try {
      const r = await api.createCity(c, s || c)
      notify(r.ok ? `已新增：${c}` : `新增失败：${r.error}`, r.ok ? 'ok' : 'err')
      if (r.ok) {
        setCity('')
        setSlug('')
        cities.reload()
      }
    } catch (e) {
      notify(`新增失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  const toggle = async (name: string, active: boolean) => {
    try {
      const r = await api.updateCity(name, active)
      notify(r.ok ? `已${active ? '启用' : '停用'}：${name}` : `操作失败：${r.error}`, r.ok ? 'ok' : 'err')
      cities.reload()
    } catch (e) {
      notify(`操作失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  const remove = async (name: string, postCount: number) => {
    const ok = window.confirm(
      `从城市池删除「${name}」？\n\n` +
        '删除后设备不会再切到该省（但已有的帖子不受影响）。\n' +
        (postCount > 0 ? `⚠ 该省当前还有 ${postCount} 个可评帖子，删掉后这些帖子将**永远不会被派单**。\n\n` : '\n') +
        '此操作不可撤销。',
    )
    if (!ok) return
    try {
      const r = await api.deleteCity(name)
      notify(r.ok ? `已删除：${name}` : `删除失败：${r.error}`, r.ok ? 'ok' : 'err')
      cities.reload()
    } catch (e) {
      notify(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  const items = cities.data?.items ?? []
  const activeCount = items.filter((c) => c.active).length
  const emptyCount = items.filter((c) => c.active && c.post_count === 0).length

  return (
    <Card
      title="城市池"
      subtitle={
        `启用 ${activeCount} 个省份` +
        (emptyCount > 0 ? ` · ⚠ ${emptyCount} 个启用省份没有可评帖子（设备切过去会空跑）` : '')
      }
      actions={
        <Btn onClick={cities.reload} disabled={cities.loading}>
          刷新
        </Btn>
      }
    >
      <div className="mb-4 flex items-end gap-2">
        <div className="w-32">
          <div className="mb-1 text-[11px] text-slate-500">省份名（中文）</div>
          <input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="例如：河北"
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-600"
          />
        </div>
        <div className="w-48">
          <div className="mb-1 text-[11px] text-slate-500">slug（留空自动生成）</div>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="例如：province-hebei"
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-600"
          />
        </div>
        <Btn onClick={() => void add()} disabled={!city.trim()}>
          新增省份
        </Btn>
      </div>

      {cities.loading && !cities.data && <Spinner />}
      {cities.error && <ErrorBox msg={cities.error} onRetry={cities.reload} />}
      {cities.data && items.length === 0 && <Empty text="城市池为空 —— 设备没有可切换的目标" />}
      {items.length > 0 && (
        <Table head={['省份', 'slug', '可评帖子', '状态', '更新时间', '操作']}>
          {items.map((c) => (
            <tr key={c.city} className="hover:bg-slate-800/30">
              <Td className="text-slate-300">{c.city}</Td>
              <Td className="font-mono text-[11px] text-slate-400">{c.slug}</Td>
              <Td>
                {c.post_count > 0 ? (
                  <span className="tabular-nums text-emerald-300">{c.post_count}</span>
                ) : (
                  <Badge tone="warn">空跑</Badge>
                )}
              </Td>
              <Td>
                <Badge tone={c.active ? 'ok' : 'muted'}>{c.active ? '启用' : '停用'}</Badge>
              </Td>
              <Td className="text-slate-400">{fmtTime(c.updated_at)}</Td>
              <Td>
                <div className="flex gap-1">
                  <Btn small onClick={() => void toggle(c.city, !c.active)}>
                    {c.active ? '停用' : '启用'}
                  </Btn>
                  <Btn small onClick={() => void remove(c.city, c.post_count)}>
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
