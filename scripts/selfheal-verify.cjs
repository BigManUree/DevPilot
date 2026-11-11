/* 自愈验证（自包含）：起后端 → 建服务 → 设 on-failure → 启动 → 杀子进程 → 断言自动重启 */
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

  const projects = JSON.parse((await call('GET', '/projects')).body);
  const pid = projects.find((p) => p.name.includes('demo')).id;
  const name = 'selfheal-probe-' + Date.now();
  const svc = JSON.parse((await call('POST', `/projects/${pid}/services`, { name, service_type: 'backend', workdir: 'C:/Users/administer/WorkBuddy/DevPilot/tests/fixtures/keepalive', start_command: 'node keepalive.js' })).body);
  console.log('service created:', svc.serviceId.slice(0, 8));

  const pol = await call('POST', `/services/${svc.serviceId}/policy`, { policy: 'on-failure' });
  console.log('1 设置策略:', pol.code, pol.body);

  const started = JSON.parse((await call('POST', `/services/${svc.serviceId}/start`)).body);
  console.log('2 启动:', JSON.stringify(started));
  await new Promise((r) => setTimeout(r, 1500));

  // 模拟崩溃：taskkill keepalive 子进程（非零退出）
  const child = spawn('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'keepalive.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }`], { windowsHide: true });
  await new Promise((r) => child.on('close', r));
  console.log('3 子进程已强杀（模拟崩溃）');

  await new Promise((r) => setTimeout(r, 4000));
  const Database = require('C:/Users/administer/WorkBuddy/DevPilot/apps/backend/node_modules/better-sqlite3');
  const db = new Database(process.env.APPDATA + '/devpilot/data/devpilot.db', { readonly: true });
  const st = db.prepare('SELECT status FROM project_services WHERE id=?').get(svc.serviceId);
  const notes = db.prepare("SELECT title FROM notifications WHERE type='service.restarted' ORDER BY rowid DESC LIMIT 2").all();
  console.log('4 崩溃后状态（应 Running = 已自动重启）:', st.status);
  console.log('5 自愈通知:', notes.map((n) => n.title.slice(0, 50)));

  // 清理
  db.close();
  await call('POST', `/services/${svc.serviceId}/stop`, {});
  await call('POST', `/services/${svc.serviceId}/policy`, { policy: 'off' });
  const db2 = new Database(process.env.APPDATA + '/devpilot/data/devpilot.db');
  db2.prepare('DELETE FROM project_services WHERE id=?').run(svc.serviceId);
  db2.close();
  try { execSync('taskkill /pid ' + backend.pid + ' /T /F', { stdio: 'ignore' }); } catch {}
  console.log('cleaned');
  process.exit(0);
})();
