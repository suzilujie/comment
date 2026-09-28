-- ════════════════════════════════════════════════════════════════
-- 省级粒度迁移：把 posts.city / city_pools 从「市级」改成「省级」
--
-- 背景：抖音的 IP 属地只显示到省，市级是**多余精度** ——
--       它让「杭州组」和「宁波组」互不兼容，切城时只要落到隔壁市就算失败。
--       改为省级后，同省内任意节点都算命中，可用节点数量级提升。
--
-- 用法：
--   docker cp sql/migrate_to_region.sql xhs_pg:/tmp/m.sql
--   docker exec -i xhs_pg psql -U comment -d comment -v ON_ERROR_STOP=1 -f /tmp/m.sql
--
-- 幂等：可重复执行。
-- ════════════════════════════════════════════════════════════════

-- ① 已有帖子的城市 → 省级（未列出的保留原值，便于人工核对）
UPDATE posts SET city = CASE city
    -- 浙江
    WHEN '杭州' THEN '浙江'
    WHEN '宁波' THEN '浙江'
    WHEN '温州' THEN '浙江'
    WHEN '金华' THEN '浙江'
    WHEN 'Zhelin' THEN '浙江'
    -- 河北（保定：联调期设备曾落在保定，dev_seed 把帖子对齐到了这里）
    WHEN 'Baoding' THEN '河北'
    WHEN '保定' THEN '河北'
    WHEN '石家庄' THEN '河北'
    -- 境外
    WHEN 'Singapore' THEN '新加坡'
    WHEN '新加坡市' THEN '新加坡'
    ELSE city
END,
updated_at = NOW();

-- 设备的属地同样按省级口径修正（心跳上报已是省份，这里兜历史遗留值）
UPDATE devices SET last_ip_city = CASE last_ip_city
    WHEN 'Baoding' THEN '河北'
    WHEN 'Zhelin' THEN '浙江'
    WHEN 'Singapore' THEN '新加坡'
    ELSE last_ip_city
END,
updated_at = NOW()
WHERE last_ip_city IS NOT NULL;

-- ② 多省份联调帖子（占位 URL，用于验证「切城 → 属地校验」链路）
--    **注意**：真实发评论仍需替换为有效抖音短链；这里只是让切城有目标可选。
--    覆盖 10 个常见省份（节点里最容易出现的那批），每省 2 条。
INSERT INTO posts (id, url, post_type, city, title, target_count, status, created_by)
SELECT
    'post_region_' || lpad(i::text, 2, '0'),
    'https://v.douyin.com/REGION_ME_' || lpad(i::text, 2, '0') || '/',
    'video',
    (ARRAY['浙江', '江苏', '广东', '上海', '北京',
           '山东', '四川', '湖北', '福建', '陕西'])[1 + ((i - 1) % 10)],
    '联调帖子(省级)' || i,
    5,
    'active',
    'region_migration'
FROM generate_series(1, 20) AS i
ON CONFLICT (id) DO NOTHING;

-- ③ 重建省份池：先禁用旧的市级记录，再按「有 active 帖子的省份」写入省级记录。
--    全部 34 个省级行政区的映射都列在这里 —— 有多少省份真的入池，取决于
--    该省份是否在 posts 里有 active 帖子（下面的 EXISTS 会过滤）。
UPDATE city_pools SET active = FALSE, updated_at = NOW();

WITH prov_map(city, slug) AS (VALUES
    -- 直辖市
    ('北京',   'province-beijing'),
    ('天津',   'province-tianjin'),
    ('上海',   'province-shanghai'),
    ('重庆',   'province-chongqing'),
    -- 省
    ('河北',   'province-hebei'),
    ('山西',   'province-shanxi'),
    ('辽宁',   'province-liaoning'),
    ('吉林',   'province-jilin'),
    ('黑龙江', 'province-heilongjiang'),
    ('江苏',   'province-jiangsu'),
    ('浙江',   'province-zhejiang'),
    ('安徽',   'province-anhui'),
    ('福建',   'province-fujian'),
    ('江西',   'province-jiangxi'),
    ('山东',   'province-shandong'),
    ('河南',   'province-henan'),
    ('湖北',   'province-hubei'),
    ('湖南',   'province-hunan'),
    ('广东',   'province-guangdong'),
    ('海南',   'province-hainan'),
    ('四川',   'province-sichuan'),
    ('贵州',   'province-guizhou'),
    ('云南',   'province-yunnan'),
    ('陕西',   'province-shaanxi'),
    ('甘肃',   'province-gansu'),
    ('青海',   'province-qinghai'),
    -- 自治区
    ('内蒙古', 'province-neimenggu'),
    ('广西',   'province-guangxi'),
    ('西藏',   'province-xizang'),
    ('宁夏',   'province-ningxia'),
    ('新疆',   'province-xinjiang'),
    -- 特别行政区
    ('香港',   'province-hongkong'),
    ('澳门',   'province-macau'),
    ('台湾',   'province-taiwan'),
    -- 境外（代理节点可能落在海外）
    ('新加坡', 'province-singapore')
)
INSERT INTO city_pools (city, slug, active)
SELECT m.city, m.slug, TRUE
FROM prov_map m
WHERE EXISTS (SELECT 1 FROM posts p WHERE p.city = m.city AND p.status = 'active')
ON CONFLICT (city) DO UPDATE
    SET slug = EXCLUDED.slug, active = TRUE, updated_at = NOW();

-- ④ 刷新省份池计数
UPDATE city_pools c SET post_count = (
    SELECT COUNT(*) FROM posts p WHERE p.city = c.city AND p.status = 'active'
), updated_at = NOW();

-- ⑤ 结果速览
SELECT city, slug, active, post_count FROM city_pools ORDER BY active DESC, post_count DESC;
SELECT city, status, count(*) AS n FROM posts GROUP BY city, status ORDER BY city, status;

-- ════════════════════════════════════════════════════════════════
-- 【设备端 Clash 侧必须同步改造】
--
-- 每个省份要有一个 **select 类型** 的 proxy-group，命名与上面的 slug 一致
-- （如 province-zhejiang），用 filter 按节点名关键词聚合。
--
-- ⚠ 必须是 select —— url-test / fallback 会让 Clash 自己换节点导致 IP 漂移，
--   设备端有硬校验会拒绝切换（报 groupNotSelect）。
--
-- 【各省 filter 关键词对照表】
--   北京     : 北京|Beijing
--   天津     : 天津|Tianjin
--   上海     : 上海|Shanghai
--   重庆     : 重庆|Chongqing
--   河北     : 石家庄|唐山|保定|廊坊|河北
--   山西     : 太原|大同|山西
--   辽宁     : 沈阳|大连|鞍山|辽宁
--   吉林     : 长春|吉林
--   黑龙江   : 哈尔滨|大庆|黑龙江
--   江苏     : 南京|苏州|无锡|常州|徐州|南通|扬州|镇江|泰州|盐城|淮安|连云港|宿迁|江苏
--   浙江     : 杭州|宁波|温州|嘉兴|湖州|绍兴|金华|衢州|舟山|台州|丽水|浙江
--   安徽     : 合肥|芜湖|蚌埠|安徽
--   福建     : 福州|厦门|泉州|漳州|莆田|福建
--   江西     : 南昌|赣州|九江|江西
--   山东     : 济南|青岛|烟台|潍坊|淄博|威海|临沂|济宁|山东
--   河南     : 郑州|洛阳|开封|新乡|河南
--   湖北     : 武汉|宜昌|襄阳|荆州|湖北
--   湖南     : 长沙|株洲|湘潭|衡阳|湖南
--   广东     : 广州|深圳|东莞|佛山|珠海|中山|惠州|江门|汕头|湛江|广东
--   海南     : 海口|三亚|海南
--   四川     : 成都|绵阳|德阳|宜宾|泸州|四川
--   贵州     : 贵阳|遵义|贵州
--   云南     : 昆明|大理|丽江|云南
--   陕西     : 西安|咸阳|宝鸡|陕西
--   甘肃     : 兰州|甘肃
--   青海     : 西宁|青海
--   内蒙古   : 呼和浩特|包头|内蒙古
--   广西     : 南宁|桂林|柳州|广西
--   西藏     : 拉萨|西藏
--   宁夏     : 银川|宁夏
--   新疆     : 乌鲁木齐|新疆
--   香港     : 香港|Hong Kong|HK
--   澳门     : 澳门|Macau
--   台湾     : 台湾|台北|Taiwan
--   新加坡   : 新加坡|Singapore|SG
--
-- 示例（一个 group 的完整写法）：
--   proxy-groups:
--     - name: province-zhejiang
--       type: select
--       use: [你的机场]
--       filter: "杭州|宁波|温州|嘉兴|湖州|绍兴|金华|衢州|舟山|台州|丽水|浙江"
--     - name: province-jiangsu
--       type: select
--       use: [你的机场]
--       filter: "南京|苏州|无锡|常州|徐州|南通|扬州|镇江|泰州|盐城|淮安|连云港|宿迁|江苏"
--
-- 若某省份的 group 不存在，设备切城会记录 regionGroupMissing 并换下一个省份，
-- 不会卡死；但也切不过去，所以**至少要有 2 个省份的 group** 才能验证切城链路。
-- ════════════════════════════════════════════════════════════════
