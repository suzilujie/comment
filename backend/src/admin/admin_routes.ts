/**
 * 管理台 API（/api/admin/*）—— 供独立前端（comment/admin-web）调用。
 *
 * 鉴权：除 `POST /login` 外，其余接口都要求 `Authorization: Bearer <token>`；
 *      token 由 admin_auth.ts 用 HMAC 签发（无状态，改 ADMIN_TOKEN_SECRET 即全量失效）。
 *      默认凭据 admin/admin，可用 ADMIN_USERNAME / ADMIN_PASSWORD 覆盖。
 * 部署前提：内网使用；对外暴露前需换 HTTPS 并加固（见 admin-web/README 待办）。
 * 注意：**不要**把这里和 /agent/*（设备端）混用，两者契约完全不同。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { config } from '../config.js'
import { countDevices, listDevices } from '../device/device_store.js'
import type { DeviceFilter } from '../device/device_store.js'
import { countTasks, listTasks } from '../task/task_store.js'
import { login, tokenOf, verify } from './admin_auth.js'
import {
  countCities,
  countCommands,
  countMaterials,
  countPosts,
  countScripts,
  countTaskEvents,
  countUnknownTasks,
  createCity,
  createMaterial,
  createPost,
  createScript,
  deleteCity,
  deleteMaterial,
  deletePost,
  deleteScript,
  getOverview,
  listAvailableProvinces,
  listCitiesAdmin,
  listCommands,
  type PostFilter,
  listMaterials,
  listPostsWithStats,
  listScripts,
  listTaskEvents,
  listUnknownTasks,
  releasePostSlot,
  resetDeviceCounters,
  resolveTask,
  sendCommand,
  updateCity,
  updateMaterial,
  updatePost,
  updateScript,
} from './admin_store.js'
import type { Command } from '../contracts/platform.js'

const admin = new Hono()

// ── 登录（唯一免鉴权接口；必须注册在下面的鉴权中间件之前）──────
admin.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const token = login(username, password)
  if (!token) return c.json({ ok: false, error: '用户名或密码错误' }, 401)
  return c.json({ ok: true, token, username, expiresInHours: config.admin.tokenTtlHours })
})

// ── 鉴权中间件：从此往下注册的接口都要求 Bearer token ──────────
admin.use('*', async (c, next) => {
  if (!verify(tokenOf(c.req.header('Authorization')))) {
    return c.json({ ok: false, error: '未登录或登录已过期' }, 401)
  }
  await next()
})

/**
 * 管理台列表的**统一分页口径**。
 *
 * · `limit` 夹在 [1, 500]：一次渲染几千行既卡浏览器也没意义，要看全量请翻页；
 * · `offset` 为负/非法一律按 0 处理（否则 Postgres 会直接报错）；
 * · 所有列表接口都返回 `total`，前端据此算总页数。
 */
/**
 * 列表默认每页条数。
 *
 * ⚠ 必须与前端 `ui.tsx` 的 `DEFAULT_PAGE_SIZE` 保持一致 —— 前端不传 `limit` 时由这里兜底，
 * 两边不一致会出现"页面上写着 10 条/页，实际回来 20 条"这种很难归因的错位。
 */
const DEFAULT_PAGE_LIMIT = 10

function pageOf(
  q: { limit?: string; offset?: string },
  defLimit: number,
  maxLimit = 500,
): { limit: number; offset: number } {
  const l = Number.parseInt(q.limit ?? '', 10)
  const o = Number.parseInt(q.offset ?? '', 10)
  return {
    limit: Number.isFinite(l) && l > 0 ? Math.min(l, maxLimit) : defLimit,
    offset: Number.isFinite(o) && o > 0 ? o : 0,
  }
}

/**
 * 布尔筛选参数解析：`true/1` → true，`false/0` → false，其余（含缺省）→ undefined。
 *
 * ⚠ 必须区分「没传」与「传了 false」：设备的「在线状态」筛选里 `online=false`（只看离线）
 * 与不传（全部都看）是两个不同的语义，用 `if (raw)` 判断会把前者吞掉。
 */
function boolOf(raw: string | undefined): boolean | undefined {
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  return undefined
}

// ── 查询 ────────────────────────────────────────────────────

admin.get('/overview', async (c) => c.json(await getOverview()))

admin.get('/devices', async (c) => {
  const raw = c.req.query()
  const { limit, offset } = pageOf(raw, DEFAULT_PAGE_LIMIT)
  const filter: DeviceFilter = {
    online: boolOf(raw.online),
    health: raw.health === 'ok' || raw.health === 'problem' ? raw.health : undefined,
    city: raw.city || undefined,
    q: raw.q || undefined,
  }
  const [items, total] = await Promise.all([
    listDevices(limit, offset, filter),
    countDevices(filter),
  ])
  const now = Date.now()
  return c.json({
    items: items.map((d) => {
      const seen = d.last_seen_at ? new Date(d.last_seen_at).getTime() : null
      const gapSec = seen === null ? null : Math.floor((now - seen) / 1000)
      return {
        ...d,
        online: gapSec !== null && gapSec <= config.heartbeat.onlineThresholdSeconds,
        lastSeenGapSec: gapSec,
      }
    }),
    total,
    onlineThresholdSeconds: config.heartbeat.onlineThresholdSeconds,
  })
})

admin.get('/tasks', async (c) => {
  const raw = c.req.query()
  const { limit, offset } = pageOf(raw, DEFAULT_PAGE_LIMIT)
  // 过滤必须走服务端：前端过滤只会作用于当前页，页码与 total 会全部对不上
  const status = raw.status || undefined
  const q = raw.q || undefined
  const [items, total] = await Promise.all([
    listTasks(limit, offset, status, q),
    countTasks(status, q),
  ])
  return c.json({ items, total })
})

admin.get('/unknown-tasks', async (c) => {
  const { limit, offset } = pageOf(c.req.query(), DEFAULT_PAGE_LIMIT)
  const [items, total] = await Promise.all([listUnknownTasks(limit, offset), countUnknownTasks()])
  return c.json({ items, total })
})

admin.get('/posts', async (c) => {
  const raw = c.req.query()
  const { limit, offset } = pageOf(raw, DEFAULT_PAGE_LIMIT)
  const filter: PostFilter = {
    status: raw.status || undefined,
    city: raw.city || undefined,
    postType: raw.postType || undefined,
    blockedOnly: boolOf(raw.blocked),
  }
  const [items, total] = await Promise.all([
    listPostsWithStats(limit, offset, filter),
    countPosts(filter),
  ])
  return c.json({ items, total })
})

admin.get('/events', async (c) => {
  const { limit, offset } = pageOf(c.req.query(), DEFAULT_PAGE_LIMIT)
  const [items, total] = await Promise.all([listTaskEvents(limit, offset), countTaskEvents()])
  return c.json({ items, total })
})

admin.get('/city-pools', async (c) => {
  const { limit, offset } = pageOf(c.req.query(), DEFAULT_PAGE_LIMIT)
  const [items, total, availableProvinces] = await Promise.all([
    listCitiesAdmin(limit, offset),
    countCities(),
    // 尚未入池的标准省份名：前端「新增省份」下拉用它，从源头杜绝手输错别字
    // （池里出现「河北省」这类值，设备上报「河北」将永远匹配不上，且无从归因）
    listAvailableProvinces(),
  ])
  return c.json({ items, total, availableProvinces })
})

admin.get('/materials', async (c) => {
  const { limit, offset } = pageOf(c.req.query(), DEFAULT_PAGE_LIMIT)
  const [items, total] = await Promise.all([listMaterials(limit, offset), countMaterials()])
  return c.json({ items, total })
})

admin.get('/scripts', async (c) => {
  const { limit, offset } = pageOf(c.req.query(), DEFAULT_PAGE_LIMIT)
  const [items, total] = await Promise.all([listScripts(limit, offset), countScripts()])
  return c.json({ items, total })
})

admin.get('/commands', async (c) => {
  const { limit, offset } = pageOf(c.req.query(), DEFAULT_PAGE_LIMIT)
  const [items, total] = await Promise.all([listCommands(limit, offset), countCommands()])
  return c.json({ items, total })
})

// ── 写操作（人工把手）────────────────────────────────────────

admin.post('/devices/:id/reset-counters', async (c) => {
  const r = await resetDeviceCounters(c.req.param('id'))
  return c.json(r, r.ok ? 200 : 404)
})

admin.post('/posts/:id/release-slot', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const r = await releasePostSlot(c.req.param('id'), {
    deviceId: typeof body.deviceId === 'string' && body.deviceId ? body.deviceId : undefined,
    resetPacing: body.resetPacing !== false,
  })
  return c.json(r, r.ok ? 200 : 404)
})

admin.post('/tasks/:id/resolve', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const verdict = body.verdict
  if (verdict !== 'succeeded' && verdict !== 'failed') {
    return c.json({ ok: false, error: 'verdict must be "succeeded" | "failed"' }, 400)
  }
  const r = await resolveTask(
    c.req.param('id'),
    verdict,
    typeof body.note === 'string' ? body.note : undefined,
  )
  return c.json(r, r.ok ? 200 : 409)
})

// ── 帖子 CRUD ───────────────────────────────────────────────

admin.post('/posts', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const r = await createPost({
    id: typeof body.id === 'string' ? body.id : undefined,
    url: typeof body.url === 'string' ? body.url : '',
    city: typeof body.city === 'string' ? body.city : '',
    postType: body.postType === 'image' ? 'image' : body.postType === 'video' ? 'video' : null,
    title: typeof body.title === 'string' ? body.title : null,
    targetCount: typeof body.targetCount === 'number' ? body.targetCount : undefined,
    status:
      body.status === 'active' || body.status === 'paused'
        ? body.status
        : body.status === 'done' || body.status === 'invalid'
          ? body.status
          : undefined,
  })
  return c.json(r, r.ok ? 200 : 400)
})

admin.patch('/posts/:id', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const r = await updatePost(c.req.param('id'), {
    url: typeof body.url === 'string' ? body.url : undefined,
    city: typeof body.city === 'string' ? body.city : undefined,
    postType: body.postType === 'image' ? 'image' : body.postType === 'video' ? 'video' : undefined,
    title: typeof body.title === 'string' ? body.title : undefined,
    targetCount: typeof body.targetCount === 'number' ? body.targetCount : undefined,
    status:
      body.status === 'active' || body.status === 'paused'
        ? body.status
        : body.status === 'done' || body.status === 'invalid'
          ? body.status
          : undefined,
  })
  return c.json(r, r.ok ? 200 : 404)
})

admin.delete('/posts/:id', async (c) => {
  const r = await deletePost(c.req.param('id'))
  return c.json(r, r.ok ? 200 : 404)
})

// ── 素材（上传走 multipart）──────────────────────────────────

/**
 * 素材上传。
 *
 * 链路：multipart 文件 → 内容 sha1 前 16 位作 hash → 落盘 → 登记 materials 表。
 * `hash` 同时充当**设备端缓存键**与**下载 URL 路径**（`/materials/<hash>`），
 * 所以文件名必须等于 hash —— 这也是为什么用内容摘要而不是随机名（天然去重）。
 */
admin.post('/materials', async (c) => {
  const body = await c.req.parseBody().catch(() => null)
  const file = body?.['file']
  if (!(file instanceof File)) {
    return c.json({ ok: false, error: '缺少文件字段 file' }, 400)
  }

  const buf = Buffer.from(await file.arrayBuffer())
  if (buf.length === 0) return c.json({ ok: false, error: '文件为空' }, 400)
  const maxBytes = config.material.maxMb * 1024 * 1024
  if (buf.length > maxBytes) {
    return c.json({ ok: false, error: `文件 ${(buf.length / 1024 / 1024).toFixed(1)}MB 超过上限 ${config.material.maxMb}MB` }, 413)
  }

  const hashBase = createHash('sha1').update(buf).digest('hex').slice(0, 16)
  const ext = (file.name.match(/\.[A-Za-z0-9]+$/) ?? ['.jpg'])[0].toLowerCase()
  const stored = `${hashBase}${ext}`
  const dir = config.material.dir
  const abs = join(dir, stored)

  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(abs, buf)
  } catch (e) {
    return c.json({ ok: false, error: `写入素材目录失败：${(e as Error).message}` }, 500)
  }

  const r = await createMaterial(stored, stored, buf.length)
  if (!r.ok) {
    // ⚠ 只在「真的写库失败」时回滚删文件。
    //
    // 重复上传**绝不能删**：内容寻址存储下，重复内容的 `stored` 与**已登记素材是同一个
    // 文件名** —— 无条件 rmSync 会把那条素材的文件一起删掉，留下「库里有记录、磁盘上没
    // 文件」的幽灵条目，而且**不可恢复**（hash 已被占用，重传会被去重拒绝）。
    // 设备侧的表现是永久 404，日志里只会说 material_download_failed，极难归因。
    // 反过来，保留文件还能顺带修复历史上被误删的那些。
    const duplicate = r.detail?.duplicate === true
    if (!duplicate) {
      try {
        rmSync(abs)
      } catch {
        /* ignore */
      }
    }
    return c.json(r, 200)
  }
  return c.json({ ...r, detail: { ...r.detail, url: `/materials/${stored}` } })
})

admin.patch('/materials/:id', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const r = await updateMaterial(c.req.param('id'), body.enabled !== false)
  return c.json(r, r.ok ? 200 : 404)
})

admin.delete('/materials/:id', async (c) => {
  const r = await deleteMaterial(c.req.param('id'))
  return c.json(r, r.ok ? 200 : 404)
})

// ── 话术 CRUD ───────────────────────────────────────────────

admin.post('/scripts', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const r = await createScript(typeof body.text === 'string' ? body.text : '')
  return c.json(r, r.ok ? 200 : 400)
})

admin.patch('/scripts/:id', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const r = await updateScript(c.req.param('id'), {
    text: typeof body.text === 'string' ? body.text : undefined,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
  })
  return c.json(r, r.ok ? 200 : 404)
})

admin.delete('/scripts/:id', async (c) => {
  const r = await deleteScript(c.req.param('id'))
  return c.json(r, r.ok ? 200 : 404)
})

// ── 城市池 CRUD ─────────────────────────────────────────────

admin.post('/city-pools', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  // slug 已改为由省份名推导（见 admin_store.PROVINCE_SLUGS），不再从请求体接收 ——
  // 人工拼 slug 只会引入「同名不同 slug」和拼错前缀的脏数据，而它对切省毫无作用。
  const r = await createCity(
    typeof body.city === 'string' ? body.city : '',
    typeof body.remark === 'string' ? body.remark : undefined,
  )
  return c.json(r, r.ok ? 200 : 400)
})

admin.patch('/city-pools/:city', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const r = await updateCity(c.req.param('city'), body.active !== false)
  return c.json(r, r.ok ? 200 : 404)
})

admin.delete('/city-pools/:city', async (c) => {
  const r = await deleteCity(c.req.param('city'))
  return c.json(r, r.ok ? 200 : 404)
})

// ── 设备指令下发 ────────────────────────────────────────────

/** 允许从管理台下发的指令（与 contracts/platform.ts 的 CommandKind 保持一致） */
const SENDABLE_COMMANDS: Command['kind'][] = [
  'probe',
  'switch_node',
  'pause',
  'resume',
  'refresh_pool',
  'claim_now',
  'rotate_now',
  'restart',
]

admin.post('/devices/:id/commands', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
  const kind = body.kind
  if (typeof kind !== 'string' || !SENDABLE_COMMANDS.includes(kind as Command['kind'])) {
    return c.json(
      { ok: false, error: `kind 必须是以下之一：${SENDABLE_COMMANDS.join(', ')}` },
      400,
    )
  }
  const payload =
    body.payload && typeof body.payload === 'object'
      ? (body.payload as Record<string, unknown>)
      : undefined
  const r = await sendCommand(c.req.param('id'), kind as Command['kind'], payload)
  return c.json(r, r.ok ? 200 : 404)
})

export default admin
