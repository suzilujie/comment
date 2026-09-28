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
import { listDevices } from '../device/device_store.js'
import { listTasks } from '../task/task_store.js'
import { login, tokenOf, verify } from './admin_auth.js'
import {
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

function limitOf(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 && n <= 1000 ? n : fallback
}

// ── 查询 ────────────────────────────────────────────────────

admin.get('/overview', async (c) => c.json(await getOverview()))

admin.get('/devices', async (c) => {
  const items = await listDevices()
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
    onlineThresholdSeconds: config.heartbeat.onlineThresholdSeconds,
  })
})

admin.get('/tasks', async (c) =>
  c.json({ items: await listTasks(limitOf(c.req.query('limit'), 100)) }),
)

admin.get('/unknown-tasks', async (c) =>
  c.json({ items: await listUnknownTasks(limitOf(c.req.query('limit'), 50)) }),
)

admin.get('/posts', async (c) =>
  c.json({ items: await listPostsWithStats(limitOf(c.req.query('limit'), 200)) }),
)

admin.get('/events', async (c) =>
  c.json({ items: await listTaskEvents(limitOf(c.req.query('limit'), 100)) }),
)

admin.get('/city-pools', async (c) =>
  c.json({
    items: await listCitiesAdmin(),
    // 尚未入池的标准省份名：前端「新增省份」下拉用它，从源头杜绝手输错别字
    // （池里出现「河北省」这类值，设备上报「河北」将永远匹配不上，且无从归因）
    availableProvinces: await listAvailableProvinces(),
  }),
)

admin.get('/materials', async (c) => c.json({ items: await listMaterials() }))

admin.get('/scripts', async (c) => c.json({ items: await listScripts() }))

admin.get('/commands', async (c) =>
  c.json({ items: await listCommands(limitOf(c.req.query('limit'), 50)) }),
)

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
