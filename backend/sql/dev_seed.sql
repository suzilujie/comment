-- ════════════════════════════════════════════════════════════════
-- 联调专用：批量造数据 + 复位设备配额（幂等，可重复执行）
--
-- 用途：让「手动领取」能连续多次成功。原始 seed.sql 只有
--       2 个帖子 / 3 条话术，且同设备同帖每天只能评一次，
--       几轮就枯竭；本脚本把帖子扩到 20 个、话术扩到 30 条。
--
-- 2026-09-26：账号实体已移除 —— 原先的「绑定账号」「重置账号间隔」
--             两段改为「复位最新活跃设备」。
--
-- 用法：
--   docker cp sql/dev_seed.sql xhs_pg:/tmp/dev_seed.sql
--   docker exec -i xhs_pg psql -U comment -d comment -f /tmp/dev_seed.sql
-- ════════════════════════════════════════════════════════════════

-- ① 话术库扩容（30 条，同帖不重复 → 每帖最多可派 30 次）
INSERT INTO scripts (id, text, enabled) VALUES
('s_gen_001', '这个视频太有意思了，学到了！', TRUE),
('s_gen_002', '背景音乐好好听，收藏了～', TRUE),
('s_gen_003', '讲得很清楚，点赞支持一下！', TRUE),
('s_gen_004', '看完感觉收获满满，谢谢分享', TRUE),
('s_gen_005', '这个角度我之前真没想过，受教了', TRUE),
('s_gen_006', '内容很实用，已经转发给朋友了', TRUE),
('s_gen_007', '拍得真好，画面很有质感', TRUE),
('s_gen_008', '博主用心了，细节处理得很到位', TRUE),
('s_gen_009', '刚好最近在关注这个，来得太及时了', TRUE),
('s_gen_010', '说得很有道理，认同这个观点', TRUE),
('s_gen_011', '这期比上期更精彩，继续加油', TRUE),
('s_gen_012', '已经关注了，期待后续更新', TRUE),
('s_gen_013', '看完忍不住重看了一遍，太赞了', TRUE),
('s_gen_014', '这个技巧太实用了，回去就试试', TRUE),
('s_gen_015', '难得看到这么真诚的分享', TRUE),
('s_gen_016', '逻辑清晰，一步一步跟着看完全能懂', TRUE),
('s_gen_017', '画面和配乐都很舒服，很治愈', TRUE),
('s_gen_018', '感觉作者真的很专业，学习了', TRUE),
('s_gen_019', '这个思路挺新颖的，值得借鉴', TRUE),
('s_gen_020', '支持一下原创，做得很好', TRUE),
('s_gen_021', '看完心情都变好了，谢谢', TRUE),
('s_gen_022', '讲得通俗易懂，小白也能跟上', TRUE),
('s_gen_023', '这应该是我近期看过最好的一期', TRUE),
('s_gen_024', '细节讲得很透，受益匪浅', TRUE),
('s_gen_025', '收藏起来慢慢消化，谢谢博主', TRUE),
('s_gen_026', '每期都看，质量一直很稳定', TRUE),
('s_gen_027', '这个点总结得很精辟', TRUE),
('s_gen_028', '内容扎实，没有一句废话', TRUE),
('s_gen_029', '看完立刻实践了一下，确实有用', TRUE),
('s_gen_030', '期待博主出更多这样的内容', TRUE)
ON CONFLICT (id) DO NOTHING;

-- ② 帖子扩容（20 个；城市跟随「设备当前出口属地」，保证属地匹配）
--    注意：url 仍是占位短链，只能跑通「领取 → 执行」链路，
--    要真的发出评论需换成真实抖音短链。
INSERT INTO posts (id, url, post_type, city, title, target_count, status, created_by)
SELECT
  'post_gen_' || lpad(i::text, 3, '0'),
  'https://v.douyin.com/GEN_ME_' || lpad(i::text, 3, '0') || '/',
  'video',
  COALESCE(
    (SELECT last_ip_city FROM devices
     WHERE last_ip_city IS NOT NULL AND id <> 'smoke-device-0001'
     ORDER BY last_seen_at DESC NULLS LAST LIMIT 1),
    'Zhelin'
  ),
  '联调帖子' || i,
  5,
  'active',
  'dev_seed'
FROM generate_series(1, 20) AS i
ON CONFLICT DO NOTHING;

-- ③ 统一城市：测试期把所有 active 帖子对齐「设备当前属地」
--    （属地匹配是精确字符串比较，IP 探测换城后必须同步，否则必然领不到）
UPDATE posts SET
  city = COALESCE(
    (SELECT last_ip_city FROM devices
     WHERE last_ip_city IS NOT NULL AND id <> 'smoke-device-0001'
     ORDER BY last_seen_at DESC NULLS LAST LIMIT 1),
    city
  ),
  updated_at = NOW()
WHERE status = 'active';

-- ④ 复位「最新活跃设备」的配额与节奏（便于立即领取）
UPDATE devices SET
  daily_done = 0,
  daily_done_date = NULL,
  next_eligible_at = NULL,
  fail_streak = 0,
  updated_at = NOW()
WHERE id = (
  SELECT id FROM devices
  WHERE id <> 'smoke-device-0001'
  ORDER BY last_seen_at DESC NULLS LAST
  LIMIT 1
);

-- ⑤ 城市池同步（保证后台下发给设备的城/组包含当前有帖的条目）
INSERT INTO city_pools (city, slug, active)
SELECT DISTINCT
  p.city,
  'city-pool',
  TRUE
FROM posts p
WHERE p.status = 'active'
ON CONFLICT (city) DO UPDATE SET active = TRUE, updated_at = NOW();

-- ⑥ 结果速览
SELECT 'scripts' AS t, count(*) AS n FROM scripts
UNION ALL SELECT 'posts(active)', count(*) FROM posts WHERE status = 'active'
UNION ALL SELECT 'devices', count(*) FROM devices;

SELECT id, daily_done, next_eligible_at, fail_streak, last_ip_city, last_seen_at
FROM devices ORDER BY last_seen_at DESC NULLS LAST LIMIT 3;

-- ════════════════════════════════════════════════════════════════
-- ⑦【需要反复联调时手工执行】清空历史，恢复全部配额
--    取消下面注释后执行，可立刻再跑一轮：
-- DELETE FROM tasks;
-- DELETE FROM post_material_usage;
-- DELETE FROM dispatch_tokens;
-- UPDATE devices SET daily_done = 0, daily_done_date = NULL,
--        next_eligible_at = NULL, fail_streak = 0;
-- UPDATE posts SET last_comment_at = NULL;
-- ════════════════════════════════════════════════════════════════
