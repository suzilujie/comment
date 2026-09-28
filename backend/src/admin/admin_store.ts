/**
 * 管理台数据层（仅供 /api/admin/* 使用，与设备端业务链路隔离）。
 *
 * 定位：把「目前只能靠手写 SQL 完成」的人工操作，收敛成三个受控动作 ——
 *   ① 复位设备计数（换号 / 调试期归零）；
 *   ② 释放帖子当天名额（假失败占位、需要立刻重派）；
 *   ③ 订正 unknown 任务（设计约定：unknown = 转人工确认，禁止自动重试）。
 *
 * 约束：
 *  · 查询一律只读；
 *  · 写操作必须留痕（订正走 task_store.appendEvent，actor=manual）；
 *  · 不在此处实现业务规则（配额、去重等仍归 dispatch/task_store 管）。
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '../db_pg.js'
import { config } from '../config.js'
import { localDateKey } from '../datetime.js'
import { createLogger } from '../logger.js'
import { getPost } from '../post/post_store.js'
import { finishTask, getTask } from '../task/task_store.js'
import { makeId } from '../random.js'
import { createCommand } from '../device/command_store.js'
import type { Command } from '../contracts/platform.js'

const log = createLogger('admin')

// ══════════════════════════════════════════════════════════
// 查询
// ══════════════════════════════════════════════════════════

export interface Overview {
  devicesTotal: number
  devicesOnline: number
  devicesBusy: number
  tasksToday: number
  tasksSucceeded: number
  tasksUnknown: number
  tasksFailed: number
  postsActive: number
  postsPaused: number
  scriptsEnabled: number
  citiesActive: number
  onlineThresholdSeconds: number
}

export async function getOverview(): Promise<Overview> {
  const sql = db()
  const today = localDateKey()
  const rows = (await sql`
    SELECT
      (SELECT COUNT(*)::int FROM devices) AS devices_total,
      (SELECT COUNT(*)::int FROM devices
         WHERE last_seen_at > NOW() - ${`${config.heartbeat.onlineThresholdSeconds} seconds`}::interval
      ) AS devices_online,
      (SELECT COUNT(*)::int FROM devices WHERE busy_task_id IS NOT NULL) AS devices_busy,
      (SELECT COUNT(*)::int FROM tasks
         WHERE (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date = ${today}::date
      ) AS tasks_today,
      (SELECT COUNT(*)::int FROM tasks WHERE status = 'succeeded') AS tasks_succeeded,
      (SELECT COUNT(*)::int FROM tasks WHERE status = 'unknown')   AS tasks_unknown,
      (SELECT COUNT(*)::int FROM tasks WHERE status = 'failed')    AS tasks_failed,
      (SELECT COUNT(*)::int FROM posts WHERE status = 'active')    AS posts_active,
      (SELECT COUNT(*)::int FROM posts WHERE status = 'paused')    AS posts_paused,
      (SELECT COUNT(*)::int FROM scripts WHERE enabled = TRUE)     AS scripts_enabled,
      (SELECT COUNT(*)::int FROM city_pools WHERE active = TRUE)   AS cities_active
  `) as unknown as Record<string, number>[]
  const r = rows[0] ?? {}
  return {
    devicesTotal: r.devices_total ?? 0,
    devicesOnline: r.devices_online ?? 0,
    devicesBusy: r.devices_busy ?? 0,
    tasksToday: r.tasks_today ?? 0,
    tasksSucceeded: r.tasks_succeeded ?? 0,
    tasksUnknown: r.tasks_unknown ?? 0,
    tasksFailed: r.tasks_failed ?? 0,
    postsActive: r.posts_active ?? 0,
    postsPaused: r.posts_paused ?? 0,
    scriptsEnabled: r.scripts_enabled ?? 0,
    citiesActive: r.cities_active ?? 0,
    onlineThresholdSeconds: config.heartbeat.onlineThresholdSeconds,
  }
}

export interface AdminPostRow {
  id: string
  url: string
  city: string
  post_type: string | null
  status: string
  title: string | null
  target_count: number
  /** 已占用条数（succeeded + dispatched + executing + unknown） */
  committed: number
  /**
   * 今天已派发条数。
   * 注意「同设备 × 同帖」的限制是**永久一次**（不再按天重置），
   * 这个字段现在只用于判断「释放今日名额」按钮是否可用。
   */
  today_used: number
  last_comment_at: Date | null
  total_tasks: number
  succeeded: number
  unknown: number
  failed: number
  /**
   * 当前为什么派不出去（`null` = 可正常派单）。
   *
   * 专门暴露「**缺素材**」这一类：帖子本身有余量、也没被同设备评过，但因为
   * 话术用尽 / 图文帖没有可用图片而永远选不出候选 —— 不显式提示的话，运维只会看到
   * "怎么一直没有任务"，完全想不到要去补话术或图片。
   */
  blocked_reason: string | null
}

/** 帖子池 + 统计（管理台首屏要看"为什么领不到"） */
export async function listPostsWithStats(limit = 200): Promise<AdminPostRow[]> {
  const sql = db()
  const today = localDateKey()
  return (await sql`
    SELECT
      p.id, p.url, p.city, p.post_type, p.status, p.title, p.target_count, p.last_comment_at,
      (SELECT COUNT(*)::int FROM tasks t
         WHERE t.post_id = p.id
           AND t.status IN ('succeeded','dispatched','executing','unknown')) AS committed,
      (SELECT COUNT(*)::int FROM tasks t
         WHERE t.post_id = p.id
           AND (t.dispatched_at AT TIME ZONE 'Asia/Shanghai')::date = ${today}::date) AS today_used,
      (SELECT COUNT(*)::int FROM tasks t WHERE t.post_id = p.id) AS total_tasks,
      (SELECT COUNT(*)::int FROM tasks t WHERE t.post_id = p.id AND t.status = 'succeeded') AS succeeded,
      (SELECT COUNT(*)::int FROM tasks t WHERE t.post_id = p.id AND t.status = 'unknown')   AS unknown,
      (SELECT COUNT(*)::int FROM tasks t WHERE t.post_id = p.id AND t.status = 'failed')    AS failed,
      -- 「派不出去」的归因：只针对"本该可派"的帖子（active 且仍有余量）
      CASE
        WHEN p.status <> 'active' THEN NULL
        WHEN p.committed >= p.target_count THEN NULL
        WHEN NOT EXISTS (
          SELECT 1 FROM scripts s
          WHERE s.enabled = TRUE
            AND NOT EXISTS (SELECT 1 FROM post_material_usage u
                            WHERE u.post_id = p.id AND u.material_ref = 'script:' || s.id)
        ) THEN '话术已用尽'
        WHEN p.post_type = 'image' AND NOT EXISTS (
          SELECT 1 FROM materials m
          WHERE m.enabled = TRUE
            AND NOT EXISTS (SELECT 1 FROM post_material_usage u
                            WHERE u.post_id = p.id AND u.material_ref = 'image:' || m.hash)
        ) THEN '图文帖缺图片'
        ELSE NULL
      END AS blocked_reason
    FROM posts p
    ORDER BY
      CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
      p.city, p.id
    LIMIT ${limit}
  `) as unknown as AdminPostRow[]
}

export interface AdminTaskEventRow {
  id: number
  task_id: string
  event: string
  actor: string
  reason_code: string | null
  detail: unknown
  created_at: Date
  post_id: string | null
  device_id: string | null
  task_status: string | null
  evidence: string | null
}

/** 事件流（含任务快照，用于一眼看出 unknown 及其 evidence） */
export async function listTaskEvents(limit = 100): Promise<AdminTaskEventRow[]> {
  const sql = db()
  return (await sql`
    SELECT e.id, e.task_id, e.event, e.actor, e.reason_code, e.detail, e.created_at,
           t.post_id, t.device_id, t.status AS task_status, t.evidence
    FROM task_events e
    LEFT JOIN tasks t ON t.id = e.task_id
    ORDER BY e.id DESC
    LIMIT ${limit}
  `) as unknown as AdminTaskEventRow[]
}

/** unknown 任务清单（待人工确认，管理台的核心待办列表） */
export async function listUnknownTasks(limit = 50): Promise<Record<string, unknown>[]> {
  const sql = db()
  return (await sql`
    SELECT id, device_id, post_id, dispatched_at, finished_at, reason_code, evidence
    FROM tasks WHERE status = 'unknown'
    ORDER BY dispatched_at DESC LIMIT ${limit}
  `) as unknown as Record<string, unknown>[]
}

// ══════════════════════════════════════════════════════════
// 写操作（人工把手）
// ══════════════════════════════════════════════════════════

export interface OpResult {
  ok: boolean
  error?: string
  detail?: Record<string, unknown>
}

/** ① 复位设备计数（换号 / 调试期归零；包括日计数、下次可领取、连续失败） */
export async function resetDeviceCounters(deviceId: string): Promise<OpResult> {
  const sql = db()
  const rows = (await sql`
    UPDATE devices
    SET daily_done = 0, daily_done_date = NULL, next_eligible_at = NULL,
        fail_streak = 0, updated_at = NOW()
    WHERE id = ${deviceId}
    RETURNING id
  `) as unknown as { id: string }[]
  if (rows.length === 0) return { ok: false, error: 'device not found' }
  log.info(`admin reset-counters device=${deviceId}`)
  return { ok: true, detail: { deviceId } }
}

/**
 * ② 释放帖子当天名额。
 *
 * 场景：某条任务被判 unknown（可能已发出但读不到）→ 当天该帖被占位，
 *      人工核实"确实没发出去"后，用这里把占位清掉，让设备能重新派到这条帖子。
 *
 * 参数：
 *  · deviceId  ：只清该设备在该帖的当天占用（不传=清该帖当天所有占用）；
 *  · resetPacing：是否同时清「单帖节奏」的 last_comment_at（默认清，否则还要等 15 分钟）。
 */
export async function releasePostSlot(
  postId: string,
  opts: { deviceId?: string; resetPacing?: boolean } = {},
): Promise<OpResult> {
  const sql = db()
  const post = await getPost(postId)
  if (!post) return { ok: false, error: 'post not found' }
  const today = localDateKey()
  const resetPacing = opts.resetPacing !== false

  const targets = (await sql`
    SELECT id FROM tasks
    WHERE post_id = ${postId}
      AND (dispatched_at AT TIME ZONE 'Asia/Shanghai')::date = ${today}::date
      ${opts.deviceId ? sql`AND device_id = ${opts.deviceId}` : sql``}
  `) as unknown as { id: string }[]
  const ids = targets.map((t) => t.id)

  let removedEvents = 0
  let removedMaterials = 0
  if (ids.length > 0) {
    const ev = (await sql`
      DELETE FROM task_events WHERE task_id IN ${sql(ids)} RETURNING id
    `) as unknown as { id: number }[]
    removedEvents = ev.length

    // 素材占用按 task_id 精确回收（post_material_usage.task_id 有落库）
    const mu = (await sql`
      DELETE FROM post_material_usage WHERE task_id IN ${sql(ids)} RETURNING post_id
    `) as unknown as { post_id: string }[]
    removedMaterials = mu.length

    await sql`DELETE FROM tasks WHERE id IN ${sql(ids)}`
  }

  if (resetPacing) {
    await sql`UPDATE posts SET last_comment_at = NULL, updated_at = NOW() WHERE id = ${postId}`
  }

  log.info(
    `admin release-slot post=${postId} device=${opts.deviceId ?? '*'} ` +
      `tasks=${ids.length} events=${removedEvents} materials=${removedMaterials} resetPacing=${resetPacing}`,
  )
  return {
    ok: true,
    detail: {
      postId,
      deviceId: opts.deviceId ?? null,
      removedTasks: ids.length,
      removedEvents,
      removedMaterials,
      resetPacing,
    },
  }
}

/**
 * ③ 订正 unknown 任务（人工核实后给出结论）。
 *
 *  · verdict = 'succeeded'：评论确实已发出 → 复用它走 finishTask 的正向记账
 *    （设备 total_success+1、fail_streak 归零、重排 next_eligible_at、刷新帖子 last_comment_at）；
 *  · verdict = 'failed'    ：确认未发出 → 走 finishTask 的失败记账（退还当日配额），
 *    同时「同设备 × 同帖每天一次」的名额自然释放（failed 不计入占用）。
 *
 * 注意：unknown 判定时已给设备累加过 total_unknown，订正后需把该计数扣回，避免重复统计。
 */
export async function resolveTask(
  taskId: string,
  verdict: 'succeeded' | 'failed',
  note?: string,
): Promise<OpResult> {
  const sql = db()
  const task = await getTask(taskId)
  if (!task) return { ok: false, error: 'task not found' }
  if (task.status !== 'unknown') {
    return { ok: false, error: `task status is '${task.status}', only 'unknown' can be resolved` }
  }

  const evidence =
    verdict === 'succeeded' ? 'manual_verify:comment_visible' : 'manual_verify:comment_not_found'

  const updated = await finishTask(taskId, verdict, {
    actor: 'manual',
    reasonCode: verdict === 'failed' ? 'submit_failed' : undefined,
    evidence,
    detail: { source: 'admin_web', rule: 'unknown_to_manual', verdict, note: note ?? null },
  })

  // 扣回 unknown 计数（finishTask 已按终态记账，不再重复统计）
  if (task.device_id) {
    await sql`
      UPDATE devices SET total_unknown = GREATEST(total_unknown - 1, 0), updated_at = NOW()
      WHERE id = ${task.device_id}
    `
  }

  log.info(`admin resolve task=${taskId} verdict=${verdict} device=${task.device_id ?? '-'}`)
  return { ok: true, detail: { taskId, verdict, status: updated?.status ?? null, evidence } }
}

// ══════════════════════════════════════════════════════════
// ④ 配置类数据的 CRUD（帖子 / 素材 / 话术 / 城市池）
//
// 背景：这些表此前**没有任何管理入口** —— 加一个真实帖子、登记一张素材、
// 改一条话术，都只能手写 SQL。下面把它们收敛成受控动作。
// ══════════════════════════════════════════════════════════

// ── 帖子 ──────────────────────────────────────────────────

export interface PostInput {
  id?: string
  url: string
  city: string
  postType?: 'video' | 'image' | null
  title?: string | null
  targetCount?: number
  status?: 'active' | 'paused' | 'done' | 'invalid'
}

/** 新增帖子 */
export async function createPost(input: PostInput): Promise<OpResult> {
  const sql = db()
  const url = (input.url ?? '').trim()
  const city = (input.city ?? '').trim()
  if (!url) return { ok: false, error: 'url 不能为空' }
  if (!city) return { ok: false, error: 'city 不能为空' }
  const id = (input.id ?? '').trim() || makeId('post')
  const target = Number.isFinite(input.targetCount) ? Number(input.targetCount) : 12
  try {
    await sql`
      INSERT INTO posts (id, url, city, post_type, title, target_count, status, created_by)
      VALUES (${id}, ${url}, ${city}, ${input.postType ?? 'video'}, ${input.title ?? null},
              ${target}, ${input.status ?? 'active'}, 'admin_web')
    `
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('uq_posts_url')) return { ok: false, error: '该 URL 已存在（posts.url 唯一）' }
    if (msg.includes('posts_pkey')) return { ok: false, error: `帖子 id 已存在：${id}` }
    return { ok: false, error: msg }
  }
  log.info(`admin create-post id=${id} city=${city} url=${url}`)
  return { ok: true, detail: { id } }
}

/** 编辑帖子（只更新传入的字段） */
export async function updatePost(id: string, patch: Partial<PostInput>): Promise<OpResult> {
  const sql = db()
  const url = patch.url?.trim() || null
  const city = patch.city?.trim() || null
  const target = Number.isFinite(patch.targetCount) ? Number(patch.targetCount) : null
  try {
    const rows = (await sql`
      UPDATE posts SET
        url = COALESCE(${url}, url),
        city = COALESCE(${city}, city),
        post_type = COALESCE(${patch.postType ?? null}, post_type),
        title = COALESCE(${patch.title ?? null}, title),
        target_count = COALESCE(${target}, target_count),
        status = COALESCE(${patch.status ?? null}, status),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING id
    `) as unknown as { id: string }[]
    if (rows.length === 0) return { ok: false, error: 'post not found' }
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('uq_posts_url')) return { ok: false, error: '该 URL 已被别的帖子占用' }
    return { ok: false, error: msg }
  }
  log.info(`admin update-post id=${id} patch=${JSON.stringify(patch)}`)
  return { ok: true, detail: { id } }
}

/**
 * 删除帖子（连同它的任务/事件/素材占用一起删）。
 *
 * ⚠ 库里没有 ON DELETE CASCADE，只能手动级联 —— 顺序必须是「子表 → 主表」。
 * 这会丢掉该帖的审计记录，因此前端会要求二次确认。
 */
export async function deletePost(id: string): Promise<OpResult> {
  const sql = db()
  const post = await getPost(id)
  if (!post) return { ok: false, error: 'post not found' }

  const ev = (await sql`
    DELETE FROM task_events
    WHERE task_id IN (SELECT id FROM tasks WHERE post_id = ${id}) RETURNING id
  `) as unknown as { id: number }[]
  // ⚠ post_material_usage 的主键是 (post_id, material_ref)，**没有 id 列** ——
  // RETURNING 必须回它实际拥有的列。
  const mu = (await sql`
    DELETE FROM post_material_usage WHERE post_id = ${id} RETURNING post_id
  `) as unknown as { post_id: string }[]
  const tk = (await sql`
    DELETE FROM tasks WHERE post_id = ${id} RETURNING id
  `) as unknown as { id: string }[]
  await sql`DELETE FROM posts WHERE id = ${id}`

  log.info(
    `admin delete-post id=${id} tasks=${tk.length} events=${ev.length} materials=${mu.length}`,
  )
  return {
    ok: true,
    detail: { id, removedTasks: tk.length, removedEvents: ev.length, removedMaterials: mu.length },
  }
}

// ── 素材 ──────────────────────────────────────────────────

export interface AdminMaterialRow {
  id: string
  hash: string
  path: string
  size_bytes: number | null
  enabled: boolean
  created_at: Date
  /** 被多少个帖子用过（判断能否安全删除） */
  used_by_posts: number
}

export async function listMaterials(): Promise<AdminMaterialRow[]> {
  const sql = db()
  return (await sql`
    SELECT m.id, m.hash, m.path, m.size_bytes, m.enabled, m.created_at,
           (SELECT COUNT(DISTINCT u.post_id)::int FROM post_material_usage u
              WHERE u.material_ref = 'image:' || m.hash) AS used_by_posts
    FROM materials m
    ORDER BY m.created_at DESC
  `) as unknown as AdminMaterialRow[]
}

/** 登记一张素材（文件由路由层写入磁盘，这里只落库） */
export async function createMaterial(
  hash: string,
  path: string,
  sizeBytes: number | null,
): Promise<OpResult> {
  const sql = db()
  const id = `mat_${hash}`
  try {
    await sql`
      INSERT INTO materials (id, hash, path, size_bytes, enabled)
      VALUES (${id}, ${hash}, ${path}, ${sizeBytes}, TRUE)
    `
  } catch (e) {
    const msg = (e as Error).message
    // ⚠ 去重实际撞的是**主键** `materials_pkey`：id 就是 `mat_<hash>`，
    //    所以同内容素材会先在 PK 上冲突，永远走不到 `uq_materials_hash` 那条分支 ——
    //    早期只判后者，导致用户看到的是原始 Postgres 报错而不是这句人话。
    if (msg.includes('materials_pkey') || msg.includes('uq_materials_hash')) {
      // `duplicate` 让调用方能区分「只是重复上传」与「真的写库失败」：
      // 前者**绝不能删文件**（那是已登记素材的文件，见 admin_routes 的回滚逻辑）
      return {
        ok: false,
        error: '相同内容的素材已存在（按内容去重，无需重复上传）',
        detail: { duplicate: true },
      }
    }
    return { ok: false, error: msg }
  }
  log.info(`admin create-material hash=${hash} size=${sizeBytes}`)
  return { ok: true, detail: { id, hash, path } }
}

export async function updateMaterial(id: string, enabled: boolean): Promise<OpResult> {
  const sql = db()
  const rows = (await sql`
    UPDATE materials SET enabled = ${enabled} WHERE id = ${id} RETURNING id
  `) as unknown as { id: string }[]
  if (rows.length === 0) return { ok: false, error: 'material not found' }
  log.info(`admin update-material id=${id} enabled=${enabled}`)
  return { ok: true, detail: { id, enabled } }
}

/** 删除素材：先删占用记录，再删库行，最后删磁盘文件 */
export async function deleteMaterial(id: string): Promise<OpResult> {
  const sql = db()
  const rows = (await sql`
    SELECT hash, path FROM materials WHERE id = ${id} LIMIT 1
  `) as unknown as { hash: string; path: string }[]
  const m = rows[0]
  if (!m) return { ok: false, error: 'material not found' }

  await sql`DELETE FROM post_material_usage WHERE material_ref = 'image:' || ${m.hash}`
  await sql`DELETE FROM materials WHERE id = ${id}`
  try {
    const file = join(config.material.dir, m.path)
    if (existsSync(file)) rmSync(file)
  } catch {
    // 文件删不掉不影响登记信息（下次上传同 hash 会覆盖）
  }
  log.info(`admin delete-material id=${id} hash=${m.hash}`)
  return { ok: true, detail: { id, hash: m.hash } }
}

// ── 话术 ──────────────────────────────────────────────────

export interface AdminScriptRow {
  id: string
  text: string
  enabled: boolean
  created_at: Date
  /** 被多少个帖子用过 */
  used_by_posts: number
}

export async function listScripts(): Promise<AdminScriptRow[]> {
  const sql = db()
  return (await sql`
    SELECT s.id, s.text, s.enabled, s.created_at,
           (SELECT COUNT(DISTINCT u.post_id)::int FROM post_material_usage u
              WHERE u.material_ref = 'script:' || s.id) AS used_by_posts
    FROM scripts s
    ORDER BY s.created_at DESC
  `) as unknown as AdminScriptRow[]
}

export async function createScript(text: string): Promise<OpResult> {
  const sql = db()
  const t = (text ?? '').trim()
  if (!t) return { ok: false, error: '话术内容不能为空' }
  const id = makeId('scr')
  await sql`
    INSERT INTO scripts (id, text, enabled) VALUES (${id}, ${t}, TRUE)
  `
  log.info(`admin create-script id=${id}`)
  return { ok: true, detail: { id } }
}

export async function updateScript(
  id: string,
  patch: { text?: string; enabled?: boolean },
): Promise<OpResult> {
  const sql = db()
  const text = patch.text?.trim() || null
  const rows = (await sql`
    UPDATE scripts SET
      text = COALESCE(${text}, text),
      enabled = COALESCE(${patch.enabled ?? null}, enabled)
    WHERE id = ${id}
    RETURNING id
  `) as unknown as { id: string }[]
  if (rows.length === 0) return { ok: false, error: 'script not found' }
  log.info(`admin update-script id=${id}`)
  return { ok: true, detail: { id } }
}

export async function deleteScript(id: string): Promise<OpResult> {
  const sql = db()
  await sql`DELETE FROM post_material_usage WHERE material_ref = 'script:' || ${id}`
  const rows = (await sql`DELETE FROM scripts WHERE id = ${id} RETURNING id`) as unknown as {
    id: string
  }[]
  if (rows.length === 0) return { ok: false, error: 'script not found' }
  log.info(`admin delete-script id=${id}`)
  return { ok: true, detail: { id } }
}

// ── 城市池 ────────────────────────────────────────────────

export interface AdminCityRow {
  city: string
  slug: string
  active: boolean
  post_count: number
  remark: string | null
  updated_at: Date
}

export async function listCitiesAdmin(): Promise<AdminCityRow[]> {
  const sql = db()
  return (await sql`
    SELECT city, slug, active, post_count, remark, updated_at
    FROM city_pools
    ORDER BY active DESC, post_count DESC, city
  `) as unknown as AdminCityRow[]
}

/**
 * 省级行政区 → 规范 slug（与 `sql/migrate_to_region.sql` 的 prov_map 保持一致）。
 *
 * 为什么需要这张表，而不是让调用方随便传 slug：
 *  1. **防错别字**。省份池是「精确匹配」的另一半 —— 池里写「河北省」，设备上报「河北」
 *     永远匹配不上，而症状只是"设备一直空转/领不到任务"，几乎无法归因（与设备端
 *     `RegionName` 的严格口径同源：宁可不加，也不带病加）。
 *  2. slug 必须**唯一**（`uq_city_pools_slug`）且**稳定**：由省份名推导，就不会出现
 *     同名不同 slug、或人工拼错前缀导致风格分裂。
 *
 * 注：当前 slug **不参与切省** —— 切省用的是固定组 `city-pool`，省份靠**节点名**表达
 * （见设备端 `Config.CLASH_CITY_GROUP` 与 `CityRotator`）。留着它是为「每省一个 select 组」
 * 的备选方案预留，因此格式仍按 `province-xxx` 统一。
 */
const PROVINCE_SLUGS: Record<string, string> = {
  // ── 直辖市 ──
  北京: 'province-beijing',
  天津: 'province-tianjin',
  上海: 'province-shanghai',
  重庆: 'province-chongqing',
  // ── 省 ──
  河北: 'province-hebei',
  山西: 'province-shanxi',
  辽宁: 'province-liaoning',
  吉林: 'province-jilin',
  黑龙江: 'province-heilongjiang',
  江苏: 'province-jiangsu',
  浙江: 'province-zhejiang',
  安徽: 'province-anhui',
  福建: 'province-fujian',
  江西: 'province-jiangxi',
  山东: 'province-shandong',
  河南: 'province-henan',
  湖北: 'province-hubei',
  湖南: 'province-hunan',
  广东: 'province-guangdong',
  海南: 'province-hainan',
  四川: 'province-sichuan',
  贵州: 'province-guizhou',
  云南: 'province-yunnan',
  陕西: 'province-shaanxi',
  甘肃: 'province-gansu',
  青海: 'province-qinghai',
  // ── 自治区 ──
  内蒙古: 'province-neimenggu',
  广西: 'province-guangxi',
  西藏: 'province-xizang',
  宁夏: 'province-ningxia',
  新疆: 'province-xinjiang',
  // ── 特别行政区 ──
  香港: 'province-hongkong',
  澳门: 'province-macau',
  台湾: 'province-taiwan',
  // ── 境外节点（代理可能落在上面）──
  新加坡: 'province-singapore',
}

/** 标准省份名（供「新增省份」下拉使用，从源头杜绝错别字） */
export function standardProvinces(): string[] {
  return Object.keys(PROVINCE_SLUGS)
}

/** 尚未入池的标准省份名 */
export async function listAvailableProvinces(): Promise<string[]> {
  const sql = db()
  const rows = (await sql`SELECT city FROM city_pools`) as unknown as { city: string }[]
  const used = new Set(rows.map((r) => r.city))
  return standardProvinces().filter((c) => !used.has(c))
}

export async function createCity(city: string, remark?: string): Promise<OpResult> {
  const sql = db()
  const c = (city ?? '').trim()
  // slug 由省份名推导 —— 不再接受调用方传入（见 PROVINCE_SLUGS 的说明）
  const slug = PROVINCE_SLUGS[c]
  if (!slug) {
    return {
      ok: false,
      error:
        `「${c}」不是标准省份名。属地是精确匹配条件，为避免错别字入池，只接受规范写法。` +
        `请在列表中选择（共 ${standardProvinces().length} 个）。`,
    }
  }
  try {
    await sql`
      INSERT INTO city_pools (city, slug, active, post_count, remark)
      VALUES (${c}, ${slug}, TRUE, 0, ${remark ?? null})
    `
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('city_pools_pkey')) return { ok: false, error: `省份已存在：${c}` }
    if (msg.includes('uq_city_pools_slug')) return { ok: false, error: `slug 已存在：${slug}` }
    return { ok: false, error: msg }
  }
  log.info(`admin create-city city=${c} slug=${slug}`)
  return { ok: true, detail: { city: c, slug } }
}

export async function updateCity(city: string, active: boolean): Promise<OpResult> {
  const sql = db()
  const rows = (await sql`
    UPDATE city_pools SET active = ${active}, updated_at = NOW()
    WHERE city = ${city} RETURNING city
  `) as unknown as { city: string }[]
  if (rows.length === 0) return { ok: false, error: 'city not found' }
  log.info(`admin update-city city=${city} active=${active}`)
  return { ok: true, detail: { city, active } }
}

export async function deleteCity(city: string): Promise<OpResult> {
  const sql = db()
  const rows = (await sql`DELETE FROM city_pools WHERE city = ${city} RETURNING city`) as unknown as {
    city: string
  }[]
  if (rows.length === 0) return { ok: false, error: 'city not found' }
  log.info(`admin delete-city city=${city}`)
  return { ok: true, detail: { city } }
}

// ── 设备指令下发 ──────────────────────────────────────────

/**
 * 下发设备指令（随该设备的下一次心跳送达）。
 *
 * 这补上了此前的缺口：`command_store.createCommand` 写好了但**全项目没有调用方**，
 * 导致 pause / resume / probe / claim_now / rotate_now 等指令根本无从下发，
 * 只能在数据库里手工 INSERT device_commands。
 */
export async function sendCommand(
  deviceId: string,
  kind: Command['kind'],
  payload?: Record<string, unknown>,
  ttlMinutes = 30,
): Promise<OpResult> {
  const sql = db()
  const rows = (await sql`SELECT id FROM devices WHERE id = ${deviceId} LIMIT 1`) as unknown as {
    id: string
  }[]
  if (rows.length === 0) return { ok: false, error: 'device not found' }
  const commandId = await createCommand(deviceId, kind, payload, ttlMinutes)
  log.info(`admin send-command device=${deviceId} kind=${kind} cmd=${commandId}`)
  return { ok: true, detail: { commandId, kind, deviceId, ttlMinutes } }
}

export interface AdminCommandRow {
  id: string
  device_id: string
  kind: string
  status: string
  created_at: Date
  delivered_at: Date | null
  finished_at: Date | null
  result: unknown
}

/** 最近的指令记录（看是否送达、是否执行成功） */
export async function listCommands(limit = 50): Promise<AdminCommandRow[]> {
  const sql = db()
  return (await sql`
    SELECT id, device_id, kind, status, created_at, delivered_at, finished_at, result
    FROM device_commands
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as unknown as AdminCommandRow[]
}
