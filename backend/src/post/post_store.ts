/**
 * 帖子池与素材去重（设计文档 §6.2 / §6.4）。
 * 约束：同帖话术与图片不重复；图文配比 1/4；单帖目标条数 10–15。
 */
import { db } from '../db_pg.js'
import { createLogger } from '../logger.js'
import { config } from '../config.js'
import { randomInt } from '../random.js'

const log = createLogger('post')

export interface PostRow {
  id: string
  url: string
  post_type: 'video' | 'image' | null
  city: string
  title: string | null
  target_count: number
  status: 'active' | 'paused' | 'done' | 'invalid'
  last_comment_at: Date | null
}

export async function getPost(postId: string): Promise<PostRow | null> {
  const sql = db()
  const rows = (await sql`SELECT * FROM posts WHERE id = ${postId} LIMIT 1`) as unknown as PostRow[]
  return rows[0] ?? null
}

/** 该帖当前"已成功 + 在途"条数 */
export async function countPostCommitted(postId: string): Promise<number> {
  const sql = db()
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM tasks
    WHERE post_id = ${postId}
      AND status IN ('succeeded', 'dispatched', 'executing', 'unknown')
  `) as unknown as { n: number }[]
  return rows[0]?.n ?? 0
}

/** 该帖图文评论已占条数（用于 1/4 配比判断） */
export async function countPostImageComments(postId: string): Promise<number> {
  const sql = db()
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM tasks
    WHERE post_id = ${postId} AND comment_type = 'image'
      AND status IN ('succeeded', 'dispatched', 'executing')
  `) as unknown as { n: number }[]
  return rows[0]?.n ?? 0
}

/**
 * 找出「指定城市、仍缺评论、且过了单帖节奏间隔」的候选帖子。
 * 属地匹配由调用方（派单约束第 9 条）传入 city 保证。
 */
export async function listCandidatePosts(city: string, limit = 20): Promise<PostRow[]> {
  const sql = db()
  return (await sql`
    SELECT p.* FROM posts p
    WHERE p.status = 'active'
      AND p.city = ${city}
      AND (
        p.last_comment_at IS NULL
        OR p.last_comment_at < NOW() - ${`${config.dispatch.perPostMinIntervalMinutes} minutes`}::interval
      )
      AND (
        SELECT COUNT(*) FROM tasks t
        WHERE t.post_id = p.id
          AND t.status IN ('succeeded', 'dispatched', 'executing', 'unknown')
      ) < p.target_count
    ORDER BY p.last_comment_at ASC NULLS FIRST
    LIMIT ${limit}
  `) as unknown as PostRow[]
}

/** 该帖尚未使用过的话术（同帖不重复） */
export async function pickUnusedScript(postId: string): Promise<{ id: string; text: string } | null> {
  const sql = db()
  const rows = (await sql`
    SELECT s.id, s.text FROM scripts s
    WHERE s.enabled = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM post_material_usage u
        WHERE u.post_id = ${postId} AND u.material_ref = 'script:' || s.id
      )
    ORDER BY random()
    LIMIT 1
  `) as unknown as { id: string; text: string }[]
  return rows[0] ?? null
}

/** 该帖尚未使用过的图片（同帖不重复） */
export async function pickUnusedImage(
  postId: string,
): Promise<{ id: string; hash: string; path: string } | null> {
  const sql = db()
  const rows = (await sql`
    SELECT m.id, m.hash, m.path FROM materials m
    WHERE m.enabled = TRUE
      AND NOT EXISTS (
        SELECT 1 FROM post_material_usage u
        WHERE u.post_id = ${postId} AND u.material_ref = 'image:' || m.hash
      )
    ORDER BY random()
    LIMIT 1
  `) as unknown as { id: string; hash: string; path: string }[]
  return rows[0] ?? null
}

/**
 * ⚠ 已移除 `markMaterialUsed`。
 *
 * 它把「登记素材占用」放在**建任务之后**，且只用 `ON CONFLICT DO NOTHING` 吞掉冲突 ——
 * 两台设备并发 claim 同一个帖子时会**都选中同一句未被占用的话术**，第二台静默失败，
 * 但任务已经带着这句话术发出去了 → 同帖出现两条一模一样的话术。
 *
 * 现在由 `dispatcher` 用 `INSERT ... ON CONFLICT DO NOTHING RETURNING` **在派发前抢占**
 * （与 `posts.committed` 同一套路），抢不到就回滚重试。
 */

/**
 * 决定本次评论形态：图文 1/4 配比。
 * 已发出的图文占比低于 1/4 时，本次用图文；否则纯文字。
 */
export async function decideCommentType(
  postId: string,
  isImagePost: boolean,
): Promise<'text' | 'image'> {
  if (!isImagePost) return 'text'
  const [committed, imageCount] = await Promise.all([
    countPostCommitted(postId),
    countPostImageComments(postId),
  ])
  const plannedTotal = committed + 1
  const targetImage = Math.max(1, Math.round(plannedTotal / 4))
  return imageCount < targetImage ? 'image' : 'text'
}

/** 可派发候选（一次查询求解出帖子 + 话术 + 图片 + 是否需要配图） */
export interface DispatchCandidate {
  id: string
  url: string
  post_type: string | null
  script_id: string
  script_text: string
  image_hash: string | null
  image_path: string | null
  need_image: boolean
}

/**
 * **一次查询**求出「本设备此刻可派发的帖子」（200 台规模的关键优化）。
 *
 * 背景：原实现是 `listCandidatePosts(city)` 取最多 20 个候选，再对**每个**候选帖
 * 依次执行 `checkDevicePostOnce` / `checkPostQuota` / `checkPostPacing` /
 * `decideCommentType` / `checkMaterialAvailable` / `pickUnusedScript` / `pickUnusedImage`
 * —— 单次 claim 最坏 **20 × 9 + 18 ≈ 198 条串行 SQL**。200 台并发领取时会把连接池
 * 瞬间排空并按「串行化」放大长尾，心跳跟着排队。
 *
 * 现在把全部约束下推到一条 SQL（全部是 EXISTS / 标量子查询，PostgreSQL 可以走索引）：
 *  · 12/13 帖有余量（用 `committed` 计数，与原子占位同一口径）
 *  · 14   单帖节奏
 *  · 4    同设备 × 同帖**永久**未评论过（不设日期范围，隔天也不允许重复）
 *  · 15   还有未使用的话术；若本次需要配图，还必须有未使用的图片
 *  · 形态 1/4 图文配比（口径同 `decideCommentType`，含 unknown 计占用）
 *
 * @param unknownOccupiesPostSlot 同 `config.dispatch.unknownOccupiesPostSlot`
 */
export async function findDispatchablePost(
  deviceId: string,
  city: string,
  unknownOccupiesPostSlot: boolean,
): Promise<DispatchCandidate | null> {
  const sql = db()
  const rows = (await sql`
    WITH candidate AS (
      SELECT p.id, p.url, p.post_type, p.committed, p.target_count, p.last_comment_at,
             (SELECT COUNT(*)::int FROM tasks t1
               WHERE t1.post_id = p.id AND t1.comment_type = 'image'
                 AND t1.status IN ('succeeded', 'dispatched', 'executing')) AS image_count
      FROM posts p
      WHERE p.status = 'active'
        AND p.city = ${city}
        -- 12/13：仍有缺口
        AND p.committed < p.target_count
        -- 14：单帖节奏
        AND (
          p.last_comment_at IS NULL
          OR p.last_comment_at < NOW() - ${`${config.dispatch.perPostMinIntervalMinutes} minutes`}::interval
        )
        -- 4：同设备 × 同帖 **永久一次**。
        --    ⚠ 这里刻意**不加日期范围**：早期实现只限"当日"，导致同一台设备隔天可以
        --    再评同一个帖子 —— 切省周期是 2 天，设备转回来就会重复评论同一条视频。
        --    去掉日期条件后正好命中 idx_tasks_device_post (device_id, post_id)，
        --    比原来的日期区间更快（区间写法用不上这个复合索引）。
        AND NOT EXISTS (
          SELECT 1 FROM tasks t2
          WHERE t2.device_id = ${deviceId} AND t2.post_id = p.id
            AND (
              t2.status IN ('succeeded', 'dispatched', 'executing')
              OR (${unknownOccupiesPostSlot} AND t2.status = 'unknown')
            )
        )
        -- 15：必须还有未使用的话术
        AND EXISTS (
          SELECT 1 FROM scripts s
          WHERE s.enabled = TRUE
            AND NOT EXISTS (SELECT 1 FROM post_material_usage u
                            WHERE u.post_id = p.id AND u.material_ref = 'script:' || s.id)
        )
      ORDER BY p.last_comment_at ASC NULLS FIRST
      LIMIT 30
    )
    SELECT c.id, c.url, c.post_type,
           sc.id AS script_id, sc.text AS script_text,
           im.hash AS image_hash, im.path AS image_path,
           (
             c.post_type = 'image'
             AND c.image_count < GREATEST(1, ROUND((c.committed + 1)::numeric / 4))
           ) AS need_image
    FROM candidate c
    LEFT JOIN LATERAL (
      SELECT s.id, s.text FROM scripts s
      WHERE s.enabled = TRUE
        AND NOT EXISTS (SELECT 1 FROM post_material_usage u
                        WHERE u.post_id = c.id AND u.material_ref = 'script:' || s.id)
      ORDER BY random() LIMIT 1
    ) sc ON TRUE
    LEFT JOIN LATERAL (
      SELECT m.hash, m.path FROM materials m
      WHERE m.enabled = TRUE
        AND NOT EXISTS (SELECT 1 FROM post_material_usage u
                        WHERE u.post_id = c.id AND u.material_ref = 'image:' || m.hash)
      ORDER BY random() LIMIT 1
    ) im ON TRUE
    WHERE sc.id IS NOT NULL
  `) as unknown as DispatchCandidate[]

  // 需要配图但没有可用图片的候选要跳过（原 checkMaterialAvailable + pickUnusedImage 的语义）
  return rows.find((r) => !r.need_image || r.image_hash !== null) ?? null
}

/** `diagnoseNoCandidate` 的归因结果 */
export interface NoCandidateDiagnosis {
  /** 该城市里「帖有余量、且本设备未评过」的候选帖数 */
  postsInCity: number
  /** 其中因**缺素材**而选不出来的帖数（需要人工补素材） */
  blockedByMaterial: number
}

/**
 * 候选为空时的**归因**。
 *
 * 为什么需要它：`findDispatchablePost` 返回 null 时，调用方一律回 `no_post_available`，
 * 但这个原因码混了两种性质完全不同的情况：
 *   ① 「这个省暂时没活」—— 无需处理，等下一轮；
 *   ② 「帖可派，但选不出素材」—— **必须人工补素材**，否则该帖永远派不出去。
 *
 * ② 的典型形态（早期实现里完全静默）：
 *   · 图文帖（`post_type='image'`）在前 1/4 条必须是图文，而 `materials` 里没有可用图片
 *     → `need_image=true` 但 `image_hash=null` → 候选被 `rows.find(...)` 丢弃；
 *   · 该帖的可用话术已全部用过（被历史失败任务吃掉、或话术库本身不够）
 *     → `AND EXISTS (...未使用的话术...)` 直接把它排除。
 *
 * 这两种只会表现为「怎么一直没有任务」，运维看不出要去补素材 —— 所以这里把它查出来，
 * 由调用方打 WARN 日志并回一个**专门的原因码**。
 */
export async function diagnoseNoCandidate(
  deviceId: string,
  city: string,
  unknownOccupiesPostSlot: boolean,
): Promise<NoCandidateDiagnosis> {
  const sql = db()
  const rows = (await sql`
    SELECT
      COUNT(*)::int AS posts_in_city,
      COUNT(*) FILTER (
        WHERE
          -- 话术已用尽
          NOT EXISTS (
            SELECT 1 FROM scripts s
            WHERE s.enabled = TRUE
              AND NOT EXISTS (SELECT 1 FROM post_material_usage u
                              WHERE u.post_id = p.id AND u.material_ref = 'script:' || s.id)
          )
          -- 或：图文帖却没有可用图片
          OR (
            p.post_type = 'image'
            AND NOT EXISTS (
              SELECT 1 FROM materials m
              WHERE m.enabled = TRUE
                AND NOT EXISTS (SELECT 1 FROM post_material_usage u
                                WHERE u.post_id = p.id AND u.material_ref = 'image:' || m.hash)
            )
          )
      )::int AS blocked_by_material
    FROM posts p
    WHERE p.status = 'active'
      AND p.city = ${city}
      AND p.committed < p.target_count
      AND NOT EXISTS (
        SELECT 1 FROM tasks t2
        WHERE t2.device_id = ${deviceId} AND t2.post_id = p.id
          AND (t2.status IN ('succeeded', 'dispatched', 'executing')
               OR (${unknownOccupiesPostSlot} AND t2.status = 'unknown'))
      )
  `) as unknown as { posts_in_city: number; blocked_by_material: number }[]

  return {
    postsInCity: rows[0]?.posts_in_city ?? 0,
    blockedByMaterial: rows[0]?.blocked_by_material ?? 0,
  }
}

/** 城市池：当前有帖子可评的城市（active） */
export async function listCityPool(): Promise<{ city: string; slug: string }[]> {
  const sql = db()
  return (await sql`
    SELECT city, slug FROM city_pools WHERE active = TRUE ORDER BY city
  `) as unknown as { city: string; slug: string }[]
}

/** 刷新城市池的帖子计数（定时任务调用） */
export async function refreshCityPoolCounts(): Promise<void> {
  const sql = db()
  await sql`
    UPDATE city_pools c SET post_count = (
      SELECT COUNT(*) FROM posts p WHERE p.city = c.city AND p.status = 'active'
    ), updated_at = NOW()
  `
  const empty = (await sql`
    SELECT city FROM city_pools WHERE active = TRUE AND post_count = 0
  `) as unknown as { city: string }[]
  if (empty.length > 0) {
    log.warn(`cities with no active post: ${empty.map((r) => r.city).join(', ')}`)
  }
}

/** 话术库/素材数量检查（派单前的素材可用性约束） */
export async function countMaterials(): Promise<{ scripts: number; images: number }> {
  const sql = db()
  const s = (await sql`SELECT COUNT(*)::int AS n FROM scripts WHERE enabled = TRUE`) as unknown as {
    n: number
  }[]
  const m = (await sql`SELECT COUNT(*)::int AS n FROM materials WHERE enabled = TRUE`) as unknown as {
    n: number
  }[]
  return { scripts: s[0]?.n ?? 0, images: m[0]?.n ?? 0 }
}

/** 随机等待时长（用于人工工具/测试数据生成） */
export function randomIntervalMinutes(): number {
  return randomInt(config.dispatch.intervalMinMinutes, config.dispatch.intervalMaxMinutes)
}
