import { useRef, useState } from 'react'
import { api, fmtTime } from '../api'
import { Badge, Btn, Card, Empty, ErrorBox, Spinner, Table, Td, useFetch } from '../ui'

interface Props {
  autoMs: number
  refreshKey: number
  notify: (text: string, tone?: 'ok' | 'err' | 'info') => void
}

const fmtSize = (n: number | null): string => {
  if (n === null || n === undefined) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/**
 * 素材管理。
 *
 * 上传链路：浏览器 multipart → 后台算内容 sha1 前 16 位作 hash → 落盘到
 * `MATERIAL_DIR` → 登记 `materials` 表。`hash` 同时是设备端的缓存键与下载路径
 * （`/materials/<hash>`），所以上传同一张图会自动去重。
 */
export default function Materials({ autoMs, refreshKey, notify }: Props) {
  const mats = useFetch(() => api.materials(), [refreshKey], autoMs)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const onPick = async (f: File | null | undefined) => {
    if (!f) return
    setUploading(true)
    try {
      const r = await api.uploadMaterial(f)
      const url = (r.detail as { url?: string } | undefined)?.url
      notify(r.ok ? `已上传并登记：${url ?? f.name}` : `上传失败：${r.error}`, r.ok ? 'ok' : 'err')
      if (r.ok) mats.reload()
    } catch (e) {
      notify(`上传失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const toggle = async (id: string, enabled: boolean) => {
    try {
      const r = await api.updateMaterial(id, enabled)
      notify(r.ok ? `已${enabled ? '启用' : '停用'}` : `操作失败：${r.error}`, r.ok ? 'ok' : 'err')
      mats.reload()
    } catch (e) {
      notify(`操作失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  const remove = async (id: string, hash: string, usedBy: number) => {
    const ok = window.confirm(
      `删除素材「${hash}」？\n\n` +
        `将删除：登记记录 + 磁盘文件 + 所有帖子的素材占用记录\n` +
        (usedBy > 0 ? `⚠ 当前有 ${usedBy} 个帖子用过它，删除后这些帖子的图文素材会变成"未使用"状态。\n\n` : '\n') +
        '此操作不可撤销。',
    )
    if (!ok) return
    try {
      const r = await api.deleteMaterial(id)
      notify(r.ok ? '已删除' : `删除失败：${r.error}`, r.ok ? 'ok' : 'err')
      mats.reload()
    } catch (e) {
      notify(`删除失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  return (
    <Card
      title="素材管理"
      subtitle="图文评论用的图片。上传后自动按内容去重（hash），设备端从 /materials/&lt;hash&gt; 下载"
      actions={
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            disabled={uploading}
            onChange={(e) => void onPick(e.target.files?.[0])}
            className="max-w-[220px] text-xs text-slate-400 file:mr-2 file:rounded-md file:border-0 file:bg-slate-700 file:px-2 file:py-1 file:text-xs file:text-slate-200 hover:file:bg-slate-600"
          />
          {uploading && <Spinner />}
          <Btn onClick={mats.reload} disabled={mats.loading}>
            刷新
          </Btn>
        </div>
      }
    >
      {mats.loading && !mats.data && <Spinner />}
      {mats.error && <ErrorBox msg={mats.error} onRetry={mats.reload} />}
      {mats.data && mats.data.items.length === 0 && (
        <Empty text="还没有素材。上传一张图片试试（只有 post_type=image 的帖子才会用到）" />
      )}
      {mats.data && mats.data.items.length > 0 && (
        <Table head={['预览', 'hash / 路径', '大小', '被引用', '状态', '上传时间', '操作']}>
          {mats.data.items.map((m) => (
            <tr key={m.id} className="hover:bg-slate-800/30">
              <Td>
                <img
                  src={`/materials/${m.hash}`}
                  alt={m.hash}
                  className="h-10 w-10 rounded border border-slate-700 object-cover"
                  loading="lazy"
                />
              </Td>
              <Td>
                <span className="font-mono text-[11px] text-slate-300">{m.hash}</span>
                <div className="mt-0.5 text-[11px] text-slate-600">{m.path}</div>
              </Td>
              <Td className="tabular-nums text-slate-400">{fmtSize(m.size_bytes)}</Td>
              <Td className="tabular-nums text-slate-400">
                {m.used_by_posts > 0 ? `${m.used_by_posts} 个帖子` : '未使用'}
              </Td>
              <Td>
                <Badge tone={m.enabled ? 'ok' : 'muted'}>{m.enabled ? '启用' : '停用'}</Badge>
              </Td>
              <Td className="text-slate-400">{fmtTime(m.created_at)}</Td>
              <Td>
                <div className="flex gap-1">
                  <Btn small onClick={() => void toggle(m.id, !m.enabled)}>
                    {m.enabled ? '停用' : '启用'}
                  </Btn>
                  <Btn small onClick={() => void remove(m.id, m.hash, m.used_by_posts)}>
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
