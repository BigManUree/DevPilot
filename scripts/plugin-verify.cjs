/* 插件运行时接口验证（自包含：同调用内起后端 → 验证 → 清理） */
const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const call = (method, path, body) => new Promise((res) => {
  const req = http.request({ host: '127.0.0.1', port: 37100, path: '/api/v1' + path, method, headers: { 'Content-Type': 'application/json' } }, (r) => {
    let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ code: r.statusCode, body: d }));
  });
  req.on('error', (e) => res({ code: 0, body: String(e) }));
  req.end(body ? JSON.stringify(body) : undefined);
});
(async () => {
  try { execSync('powershell -NoProfile -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort 37100 -State Listen)[0].OwningProcess -Force -Confirm:$false"', { stdio: 'ignore' }); } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  const backend = spawn('node', ['dist/main.js'], { cwd: 'C:/Users/administer/WorkBuddy/DevPilot/apps/backend', stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const h = await call('GET', '/health');
    if (h.code === 200) break;
  }
  console.log('1 reload:', JSON.stringify(await call('POST', '/plugins/reload', {})));
  console.log('2 list:', (await call('GET', '/plugins')).body.slice(0, 250));
  console.log('3 enable:', JSON.stringify(await call('POST', '/plugins/echo-hook/enable', {})));
  // 触发 notification.new → log hook 应落插件日志
  const n = await call('POST', '/notifications', { type: 'plugin.probe', title: '插件钩子验证', priority: 5 });
  console.log('4 通知触发:', n.code, n.body.slice(0, 80));
  await new Promise((r) => setTimeout(r, 800));
  const logs = await call('GET', '/logs?limit=30');
  const hit = (logs.body.match(/plugin:echo-hook/g) || []).length;
  console.log('5 插件日志命中（log hook）:', hit, '条');
  // task.failed → notify hook 转发；观察事件广播在 daemon log 之外——用 audit/后续日志核
  console.log('6 404 边界:', (await call('POST', '/plugins/no-such/enable', {})).code);
  const dup = await call('POST', '/plugins/reload', {});
  console.log('7 幂等 reload（不重复装、保留 enabled）:', dup.body);
  const lst = JSON.parse((await call('GET', '/plugins')).body);
  console.log('8 reload 后状态:', lst.map((p) => `${p.id}:${p.status}`).join(','));
  try { execSync('taskkill /pid ' + backend.pid + ' /T /F', { stdio: 'ignore' }); } catch {}
  console.log('cleaned');
  process.exit(0);
})();
