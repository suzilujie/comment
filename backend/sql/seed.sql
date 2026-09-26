-- ════════════════════════════════════════════════════════════════
-- comment backend — 种子数据（测试/联调用，幂等可重复执行）
-- 用途：让"心跳 → 领取 → 执行 → 回执"闭环能在无人工数据时立即跑通
--
-- ⚠ 说明：
--  1. 帖子 url 为占位符，需替换为真实抖音短链才能真的发出评论；
--  2. 帖子 city 必须与设备当前出口属地一致（设备端 ip-api 口径，形如 Shanghai），
--     否则派单会以 no_post_in_city 拒绝；
--  3. 2026-09-26：账号实体已移除，配额/节奏/统计都在 devices 表上，本文件不再插入账号。
-- ════════════════════════════════════════════════════════════════

-- ── 话术（纯文字 3 条） ──────────────────────────────────────
INSERT INTO scripts (id, text, enabled) VALUES
('s_test_001', '这个视频太有意思了，学到了！', TRUE),
('s_test_002', '背景音乐好好听，收藏了～', TRUE),
('s_test_003', '讲得很清楚，点赞支持一下！', TRUE)
ON CONFLICT (id) DO NOTHING;

-- ── 城市池（slug 必须与客户端 Clash 的组名一致） ─────────────
INSERT INTO city_pools (city, slug, active) VALUES
('Shanghai', 'city-pool', TRUE)
ON CONFLICT (city) DO NOTHING;

-- ── 帖子（city 需与设备出口属地一致；target_count 调小便于快速跑通） ──
INSERT INTO posts (id, url, post_type, city, title, target_count, status, created_by)
VALUES
('post_test_001', 'https://v.douyin.com/REPLACE_ME_001/', 'video', 'Shanghai', '测试帖子1', 3, 'active', 'seed'),
('post_test_002', 'https://v.douyin.com/REPLACE_ME_002/', 'video', 'Shanghai', '测试帖子2', 3, 'active', 'seed')
ON CONFLICT (id) DO NOTHING;

-- ── 复位最新活跃设备的配额与节奏（便于立即领取） ──────────────
UPDATE devices SET
  daily_done = 0, daily_done_date = NULL, next_eligible_at = NULL,
  fail_streak = 0, updated_at = NOW()
WHERE id = (
  SELECT id FROM devices
  WHERE id <> 'smoke-device-0001'
  ORDER BY last_seen_at DESC NULLS LAST
  LIMIT 1
);
