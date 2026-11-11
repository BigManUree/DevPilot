/* 工作流接口验证（自包含）：起后端 → 建/跑/断言 → 清理 */
const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const call = (method, path, body) => new Promise((res) => {
  const req = http.request({ host: '127.0.0.1', port: 37100, path: '/api/v1' + path, method, headers: { 'Content-Type': 'application/json' } }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ code: r.statusCode, body: d })); });
  req.on('error', (e) => res({ code: 0, body: String(e) }));
  req.end(body ? JSON.stringify(body) : undefined);
});
(async () => {
  try { execSync('powershell -NoProfile -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort 37100 -State Listen)[0].OwningProcess -Force -Confirm:$false"', { stdio: 'ignore' }); } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  const backend = spawn('node', ['dist/main.js'], { cwd: 'C:/Users/administer/WorkBuddy/DevPilot/apps/backend', stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); const h = await call('GET', '/health'); if (h.code === 200) break; }
  console.log('backend up');

  const definition = {
    name: 'wf-e2e-' + Date.now(),
    steps: [
      { id: 'ver', type: 'command', command: 'node --version' },
      { id: 'check', type: 'condition', left: '${ver.exitCode}', op: 'eq', right: '0', gotoOnTrue: 'good', gotoOnFalse: 'bad' },
      { id: 'good', type: 'notify', title: '健康检查通过（${ver.output}）' },
      { id: 'finish', type: 'condition', left: '1', op: 'eq', right: '1', gotoOnTrue: 'end' },
      { id: 'bad', type: 'notify', title: '异常分支' },
    ],
  };
  const cr = JSON.parse((await call('POST', '/workflows', { name: definition.name, definition })).body);
  console.log('1 创建:', cr.code, JSON.stringify(cr).slice(0, 160));

  const run = JSON.parse((await call('POST', `/workflows/${cr.id}/run`)).body);
  console.log('2 执行:', run.status, '| ver.exitCode=' + run.context.ver.exitCode, '| good.notified=' + run.context.good.notified, '| bad=' + run.context.bad);

  const dup = await call('POST', '/workflows', { name: definition.name, definition });
  console.log('3 同名拒绝:', dup.code, JSON.parse(dup.body).message?.slice(0, 30));

  const bad = await call('POST', '/workflows', { name: 'wf-bad', definition: { name: 'bad', steps: [{ id: 'x', type: 'evil' }] } });
  console.log('4 非法定义拒绝:', bad.code, JSON.parse(bad.body).message?.slice(0, 40));

  const runs = JSON.parse((await call('GET', `/workflows/${cr.id}/runs`)).body);
  console.log('5 运行历史:', runs.length, '条，状态=' + runs[0].status);

  const dis = await call('POST', `/workflows/${cr.id}/disable`, {});
  const runDis = await call('POST', `/workflows/${cr.id}/run`);
  console.log('6 停用后禁跑:', dis.code, runDis.code, JSON.parse(runDis.body).message?.slice(0, 30));

  const del = await call('DELETE', `/workflows/${cr.id}`);
  console.log('7 删除:', del.code);
  // 清理通知
  const Database = require('C:/Users/administer/WorkBuddy/DevPilot/apps/backend/node_modules/better-sqlite3');
  const db = new Database(process.env.APPDATA + '/devpilot/data/devpilot.db');
  db.prepare("DELETE FROM notifications WHERE type='workflow.notify'").run();
  db.close();
  try { execSync('taskkill /pid ' + backend.pid + ' /T /F', { stdio: 'ignore' }); } catch {}
  console.log('cleaned');
  process.exit(0);
})();
