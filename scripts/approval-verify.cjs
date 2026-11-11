/* 审批放行链路验证（自包含）：起后端 → approve → retry run-external → 放行 → 清理 */
const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const call = (method, path, body) => new Promise((res) => {
  const req = http.request({ host: '127.0.0.1', port: 37100, path: '/api/v1' + path, method, headers: { 'Content-Type': 'application/json' } }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ code: r.statusCode, body: d })); });
  req.on('error', (e) => res({ code: 0, body: String(e) }));
  req.end(body ? JSON.stringify(body) : undefined);
});
(async () => {
  const backend = spawn('node', ['dist/main.js'], { cwd: 'C:/Users/administer/WorkBuddy/DevPilot/apps/backend', stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); const h = await call('GET', '/health'); if (h.code === 200) break; }
  console.log('backend up');
  const Database = require('C:/Users/administer/WorkBuddy/DevPilot/apps/backend/node_modules/better-sqlite3');
  const db = new Database(process.env.APPDATA + '/devpilot/data/devpilot.db');
  const t = db.prepare("SELECT id FROM tasks WHERE input_summary LIKE '%__mcp_test__%' ORDER BY rowid DESC LIMIT 1").get();
  const appr = db.prepare("SELECT id FROM approvals WHERE approval_status='pending' AND requester='external:mcp-client' ORDER BY rowid DESC LIMIT 1").get();
  console.log('task:', t.id.slice(0, 8), 'pending approval:', appr.id.slice(0, 8));
  const ap = await call('POST', '/approvals/' + appr.id + '/approve', {});
  console.log('1 approve:', ap.code, ap.body.slice(0, 60));
  const run = await call('POST', '/tasks/' + t.id + '/run-external', {});
  console.log('2 retry run-external（放行）:', run.code, run.body.slice(0, 60));
  await new Promise((r) => setTimeout(r, 1500));
  const st = db.prepare('SELECT status FROM tasks WHERE id=?').get(t.id);
  console.log('3 任务状态:', st.status);
  db.prepare("DELETE FROM permissions WHERE subject_type=? AND subject_id=? AND category=?").run('external', 'mcp-client', 'task.run');
  db.prepare('DELETE FROM approvals WHERE requester=?').run('external:mcp-client');
  db.prepare('DELETE FROM subtasks WHERE task_id=?').run(t.id);
  db.prepare('DELETE FROM checkpoints WHERE task_id=?').run(t.id);
  db.prepare('DELETE FROM agent_executions WHERE task_id=?').run(t.id);
  db.prepare('DELETE FROM tool_calls WHERE execution_id IN (SELECT id FROM agent_executions WHERE task_id=?)').run(t.id);
  db.prepare('DELETE FROM tasks WHERE id=?').run(t.id);
  db.close();
  try { execSync('taskkill /pid ' + backend.pid + ' /T /F', { stdio: 'ignore' }); } catch {}
  console.log('cleaned');
  process.exit(0);
})();
