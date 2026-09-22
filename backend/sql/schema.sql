-- ════════════════════════════════════════════════════════════════
-- comment backend — 数据库结构（幂等：可重复执行）
-- 依据：设计文档 §3.8 数据模型 / §5.1 派单约束 / §5.4 任务状态机 / §6.5 人格档案
-- 约定：实体主键 TEXT、明细主键 SERIAL、时间统一 TIMESTAMPTZ（UTC 存储）
-- ════════════════════════════════════════════════════════════════

-- ── 账号 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id                TEXT PRIMARY KEY,
  douyin_id         TEXT,
  phone             TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'banned')),
  daily_done        INTEGER NOT NULL DEFAULT 0,
  daily_done_date   DATE,
  -- 下次可派单时间 = 上次完成时间 + 随机 30~60 分钟（服务端权威）
  next_eligible_at  TIMESTAMPTZ,
  fail_streak       INTEGER NOT NULL DEFAULT 0,
  total_success     INTEGER NOT NULL DEFAULT 0,
  total_fail        INTEGER NOT NULL DEFAULT 0,
  total_unknown     INTEGER NOT NULL DEFAULT 0,
  remark            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_accounts_eligible ON accounts (status, next_eligible_at);

-- ── 设备（一期一机一账号） ────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
  id                TEXT PRIMARY KEY,              -- 设备唯一号（Agent 首启生成 UUID）
  account_id        TEXT REFERENCES accounts (id),
  -- 机型档案（多机型适配：规则包分槽依据）
  model             TEXT,
  resolution        TEXT,
  dpi               INTEGER,
  os_version        TEXT,
  rom_version       TEXT,
  font_scale        REAL,
  dark_mode         BOOLEAN,
  -- 版本
  agent_version     TEXT,
  rule_pack_version TEXT,
  douyin_version    TEXT,
  -- 管理态（仅启用/停用；停用是应急开关，非设备状态）
  admin_state       TEXT NOT NULL DEFAULT 'enabled'
                    CHECK (admin_state IN ('enabled', 'disabled')),
  -- 心跳与网络
  last_seen_at      TIMESTAMPTZ,
  last_ip           TEXT,
  last_ip_city      TEXT,
  ipv6_leak         BOOLEAN,
  clock_offset_sec  INTEGER,
  -- 健康
  accessibility_ok  BOOLEAN,
  foreground_ok     BOOLEAN,
  proxy_ok          BOOLEAN,
  battery           INTEGER,
  storage_free_mb   INTEGER,
  -- 运行时
  busy_task_id      TEXT,
  state             JSONB,                         -- 其余状态快照（原始上报）
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_city ON devices (last_ip_city);

-- ── 帖子池（人工录入，按城市分桶） ────────────────────────────
CREATE TABLE IF NOT EXISTS posts (
  id               TEXT PRIMARY KEY,
  url              TEXT NOT NULL,                  -- 人工录入的抖音短链
  post_type        TEXT CHECK (post_type IN ('video', 'image')),
  city             TEXT NOT NULL,                  -- 调度口径：城市
  title            TEXT,
  author           TEXT,
  target_count     INTEGER NOT NULL DEFAULT 12,    -- 目标评论条数（10~15）
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'paused', 'done', 'invalid')),
  last_comment_at  TIMESTAMPTZ,                    -- 单帖节奏约束依据
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_posts_url ON posts (url);
CREATE INDEX IF NOT EXISTS idx_posts_city_status ON posts (city, status);

-- ── 任务（派发那一刻创建；5 态） ──────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts (id),
  device_id        TEXT REFERENCES devices (id),
  post_id          TEXT NOT NULL REFERENCES posts (id),
  status           TEXT NOT NULL DEFAULT 'dispatched'
                   CHECK (status IN ('dispatched', 'executing', 'succeeded',
                                     'failed', 'aborted', 'unknown')),
  -- 素材（随任务携带）
  script_text      TEXT,
  script_id        TEXT,
  comment_type     TEXT CHECK (comment_type IN ('text', 'image')),
  image_hash       TEXT,
  image_path       TEXT,
  -- 结果
  reason_code      TEXT,
  evidence         TEXT,
  retry_of         TEXT,                           -- 人工重排时的前置任务
  -- 时间线（UTC 存储，展示转 UTC+8）
  dispatched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deadline_at      TIMESTAMPTZ NOT NULL,           -- 派发 + 15 分钟（回执截止）
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  dispatch_ip_city TEXT,                           -- 派单时设备属地（供归因）
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_deadline ON tasks (status, deadline_at);
CREATE INDEX IF NOT EXISTS idx_tasks_account_time ON tasks (account_id, dispatched_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_post_time ON tasks (post_id, dispatched_at DESC);

-- ── 任务事件流（追加写，用于归因与审计） ──────────────────────
CREATE TABLE IF NOT EXISTS task_events (
  id           SERIAL PRIMARY KEY,
  task_id      TEXT NOT NULL,
  event        TEXT NOT NULL,                      -- dispatched / started / succeeded / failed / aborted / unknown
  actor        TEXT NOT NULL CHECK (actor IN ('platform', 'device', 'manual')),
  reason_code  TEXT,
  detail       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events (task_id, created_at);

-- ── 设备事件流 ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_events (
  id           SERIAL PRIMARY KEY,
  device_id    TEXT NOT NULL,
  event        TEXT NOT NULL,                      -- online / offline / warn / recover / ip_switched / bind / upgrade
  reason       TEXT,
  detail       JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_device_events_device ON device_events (device_id, created_at DESC);

-- ── 设备指令（随心跳响应下发，commandId 幂等） ────────────────
CREATE TABLE IF NOT EXISTS device_commands (
  id            TEXT PRIMARY KEY,                  -- commandId
  device_id     TEXT NOT NULL,
  kind          TEXT NOT NULL
                CHECK (kind IN ('probe', 'switch_node', 'pause', 'resume',
                                'upgrade', 'restart', 'refresh_pool',
                                'claim_now', 'rotate_now')),
  payload       JSONB,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'delivered', 'done', 'failed', 'expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at  TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  expire_at     TIMESTAMPTZ,
  result        JSONB
);
CREATE INDEX IF NOT EXISTS idx_cmd_device_status ON device_commands (device_id, status);

-- ── 话术库 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scripts (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 图片素材 ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS materials (
  id          TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  path        TEXT NOT NULL,
  size_bytes  INTEGER,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_materials_hash ON materials (hash);

-- ── 帖子内素材使用记录（同帖话术/图片不重复） ─────────────────
CREATE TABLE IF NOT EXISTS post_material_usage (
  post_id      TEXT NOT NULL,
  material_ref TEXT NOT NULL,                      -- script:<id> / image:<hash>
  task_id      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, material_ref)
);

-- ── 城市池（后台维护；设备端只读，用于纯随机跨城） ────────────
CREATE TABLE IF NOT EXISTS city_pools (
  city        TEXT PRIMARY KEY,
  slug        TEXT NOT NULL,                       -- city-hangzhou（= provider 名 = group 名）
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  post_count  INTEGER NOT NULL DEFAULT 0,
  remark      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_city_pools_slug ON city_pools (slug);

-- ── 人格档案（一账号一份，长期稳定；见 §6.5） ─────────────────
CREATE TABLE IF NOT EXISTS personalities (
  account_id    TEXT PRIMARY KEY REFERENCES accounts (id),
  profile       JSONB NOT NULL,                    -- 各维度 μ/σ 与概率
  bands         JSONB,                             -- 各维度档位（用于分布校验）
  version       INTEGER NOT NULL DEFAULT 1,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  drift_at      TIMESTAMPTZ                        -- 上次缓慢漂移时间
);

-- ── 全局限流窗口（派单密度，滑动窗口计数） ────────────────────
CREATE TABLE IF NOT EXISTS dispatch_tokens (
  id          SERIAL PRIMARY KEY,
  device_id   TEXT,
  city        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dispatch_tokens_time ON dispatch_tokens (created_at DESC);
