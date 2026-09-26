-- ═══════════════════════════════════════════════════════════════════════════
-- unknown 任务的人工订正模板
--   设计约定：unknown = "可能已发出"，一律禁止自动重试，转人工确认。
--   用途：人工核实后在 succeeded / failed 之间订正，并写入 task_events 留痕。
--   用法：把 'task_xxx' 替换为实际任务 id，取消注释后执行对应的一段。
--   注意：task_events.actor 取值受约束（platform / device / manual），detail 为 json 列。
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 情况 A：核实"评论已发出" → 订正为 succeeded（名额保持占用）───────────────
-- UPDATE tasks
-- SET status = 'succeeded', reason_code = NULL,
--     evidence = 'manual_verify:comment_visible_in_douyin',
--     finished_at = COALESCE(finished_at, NOW())
-- WHERE id = 'task_xxx';
--
-- INSERT INTO task_events (task_id, event, actor, reason_code, detail)
-- VALUES ('task_xxx', 'succeeded', 'manual', 'manual_verify',
--         '{"source":"manual_verify","rule":"unknown_to_manual","verdict":"comment_visible"}'::json);

-- ── 情况 B：核实"评论未发出" → 订正为 failed（释放当天该帖名额）─────────────
-- UPDATE tasks
-- SET status = 'failed', reason_code = 'submit_failed',
--     evidence = 'manual_verify:comment_not_found',
--     finished_at = COALESCE(finished_at, NOW())
-- WHERE id = 'task_xxx';
--
-- INSERT INTO task_events (task_id, event, actor, reason_code, detail)
-- VALUES ('task_xxx', 'failed', 'manual', 'manual_verify',
--         '{"source":"manual_verify","rule":"unknown_to_manual","verdict":"comment_not_found"}'::json);
--
-- -- failed 不占用「同设备 × 同帖每天一次」（见 config.dispatch.unknownOccupiesPostSlot），
-- -- 名额即刻释放；同时把配额还回设备（后台对 failed 自动退还，人工订正需手动补）：
-- UPDATE devices d
-- SET daily_done = GREATEST(d.daily_done - 1, 0), updated_at = NOW()
-- WHERE d.id = (SELECT device_id FROM tasks WHERE id = 'task_xxx');

-- ── 查看当前 unknown 任务（先看再定）────────────────────────────────────────
SELECT id, device_id, post_id, status, reason_code, evidence, dispatched_at, finished_at
FROM tasks WHERE status = 'unknown'
ORDER BY dispatched_at DESC LIMIT 20;

-- ── 查看某任务的事件链 ────────────────────────────────────────────────────
-- SELECT id, task_id, event, actor, reason_code, detail, created_at
-- FROM task_events WHERE task_id = 'task_xxx' ORDER BY created_at;
