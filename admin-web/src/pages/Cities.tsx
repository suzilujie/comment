import { useState } from 'react'
import { api, fmtTime } from '../api'
import { Badge, Btn, Card, Empty, ErrorBox, Pager, Spinner, Table, Td, useFetch, usePaging } from '../ui'

interface Props {
  autoMs: number
  refreshKey: number
  notify: (text: string, tone?: 'ok' | 'err' | 'info') => void
}

/**
 * 省份池管理。
 *
 * 两个用途：
 *  ① **设备切省的目标池** —— 设备端从 `active=TRUE` 的省份里随机挑一个切过去；
 *  ② **空跑预警** —— `post_count=0` 表示切到该省会领不到任务（池里有省没帖）。
 *
 * `slug` 由省份名自动推导（`province-xxx`），不再人工填写。
 * 注意它**不参与切省** —— 切省用固定组 `city-pool`，省份靠**节点名**匹配。
 */
export default function Cities({ autoMs, refreshKey, notify }: Props) {
  const pg = usePaging()
  const cities = useFetch(
    () => api.cities({ limit: pg.pageSize, offset: pg.offset }),
    [refreshKey, pg.page, pg.pageSize],
    autoMs,
  )
  // 只从「尚未入池的标准省份」里选：省份池是「精确匹配」的另一半，手输「河北省」
  // 这类值会让该省帖子永远派不出去，而症状只是"设备空转"，几乎无法归因。
  const [city, setCity] = useState('')
  const available = cities.data?.availableProvinces ?? []

  const add = async () => {
    const c = city.trim()
    if (!c) {
      notify('请选择省份', 'err')
      return
    }
    try {
      const r = await api.createCity(c)
      notify(r.ok ? `已新增：${c}` : `新增失败：${r.error}`, r.ok ? 'ok' : 'err')
      if (r.ok) {
        setCity('')
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
      `从省份池删除「${name}」？\n\n` +
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

  // ⚠ 这两个统计是**本页**的（列表接口不返回全量启用/空跑数）：分页下不能说成"启用 N 个省份"，
  //    那会被读成全量口径。这里显式标注"本页"，并给出 total 让运维知道池子有多大。
  const items = cities.data?.items ?? []
  const activeCount = items.filter((c) => c.active).length
  const emptyCount = items.filter((c) => c.active && c.post_count === 0).length

  return (
    <Card
      title="省份池"
      subtitle={
        `共 ${cities.data?.total ?? 0} 个省份 · 本页启用 ${activeCount} 个` +
        (emptyCount > 0 ? ` · ⚠ 本页 ${emptyCount} 个启用省份没有可评帖子（设备切过去会空跑）` : '')
      }
      actions={
        <Btn onClick={cities.reload} disabled={cities.loading}>
          刷新
        </Btn>
      }
    >
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div className="w-56">
          <div className="mb-1 text-[11px] text-slate-500">新增省份</div>
          <select
            value={city}
            onChange={(e) => setCity(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-sky-600"
          >
            <option value="">
              {available.length === 0 ? '标准省名已全部入池' : `选择省份…（待入池 ${available.length} 个）`}
            </option>
            {available.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <Btn onClick={() => void add()} disabled={!city.trim()}>
          新增省份
        </Btn>
        <div className="pb-1.5 text-[11px] text-slate-600">
          slug 由省份名自动推导（province-xxx），无需填写
        </div>
      </div>

      {cities.loading && !cities.data && <Spinner />}
      {cities.error && <ErrorBox msg={cities.error} onRetry={cities.reload} />}
      {cities.data && items.length === 0 && <Empty text="省份池为空 —— 设备没有可切换的目标" />}
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
      {cities.data && (
        <Pager
          total={cities.data.total}
          page={pg.page}
          pageSize={pg.pageSize}
          onPage={pg.setPage}
          onPageSize={pg.setPageSize}
        />
      )}
    </Card>
  )
}
