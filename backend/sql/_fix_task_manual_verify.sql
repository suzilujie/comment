-- 人工核实订正的审计事件补写（detail 为 json 列，必须传 JSON）
INSERT INTO task_events (task_id, event, actor, reason_code, detail)
VALUES (
    'task_mui6crgt_37knr',
    'succeeded',
    'admin',
    'manual_verify',
    '{"source":"manual_verify","rule":"unknown_to_manual","note":"抖音评论区可见 内容扎实，没有一句废话（3分钟前/河北/本机账号）","verified_by":"ai_agent_adb"}'::json
);

SELECT id, task_id, event, actor, reason_code, detail, created_at
FROM task_events WHERE task_id = 'task_mui6crgt_37knr' ORDER BY created_at DESC LIMIT 2;
