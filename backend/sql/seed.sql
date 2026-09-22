-- ════════════════════════════════════════════════════════════════
-- comment backend — 种子数据（测试/联调用，幂等可重复执行）
-- 用途：让"心跳 → 领取 → 执行 → 回执"闭环能在无人工数据时立即跑通
--
-- ⚠ 说明：
--  1. 帖子 url 为占位符，需替换为真实抖音短链才能真的发出评论；
--  2. 帖子 city 用 "Zhelin" 临时对齐设备当前出口属地（ip-api 错译），
--     仅用于跑通闭环；正式部署应改为真实中文城市，并配合设备 Clash 切城
--     与后台城市归一化（/agent/ipgeo）解决属地匹配。
-- ════════════════════════════════════════════════════════════════

-- ── 账号 ──────────────────────────────────────────────────────
INSERT INTO accounts (id, douyin_id, phone, status, remark)
VALUES ('acc_test_001', 'test_douyin_001', '13800000000', 'active', '种子测试账号')
ON CONFLICT (id) DO NOTHING;

-- ── 话术（纯文字 3 条） ──────────────────────────────────────
INSERT INTO scripts (id, text, enabled) VALUES
('s_test_001', '这个视频太有意思了，学到了！', TRUE),
('s_test_002', '背景音乐好好听，收藏了～', TRUE),
('s_test_003', '讲得很清楚，点赞支持一下！', TRUE)
ON CONFLICT (id) DO NOTHING;

-- ── 城市池（杭州 = 正式；Zhelin = 临时对齐设备当前属地） ─────
INSERT INTO city_pools (city, slug, active) VALUES
('杭州', 'city-hangzhou', TRUE),
('Zhelin', 'city-zhelin', TRUE)
ON CONFLICT (city) DO NOTHING;

-- ── 帖子（city 临时用 Zhelin；target_count 调小便于快速跑通） ──
INSERT INTO posts (id, url, post_type, city, title, target_count, status, created_by)
VALUES
('post_test_001', 'https://v.douyin.com/REPLACE_ME_001/', 'video', 'Zhelin', '测试帖子1', 3, 'active', 'seed'),
('post_test_002', 'https://v.douyin.com/REPLACE_ME_002/', 'video', 'Zhelin', '测试帖子2', 3, 'active', 'seed')
ON CONFLICT (id) DO NOTHING;

-- ── 把最新心跳的真实设备绑定到测试账号（排除冒烟设备） ────────
UPDATE devices SET account_id = 'acc_test_001', updated_at = NOW()
WHERE id = (
  SELECT id FROM devices
  WHERE id <> 'smoke-device-0001'
  ORDER BY last_seen_at DESC NULLS LAST
  LIMIT 1
);
