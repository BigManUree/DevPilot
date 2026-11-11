/* update-check 三态验证（自包含） */
const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const call = (method, path) => new Promise((res) => {
  const req = http.request({ host: '127.0.0.1', port: 37100, path: '/api/v1' + path, method }, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res({ code: r.statusCode, body: d })); });
  req.on('error', (e) => res({ code: 0, body: String(e) }));
  req.end();
});
const stopBackend = () => { try { execSync('powershell -NoProfile -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort 37100 -State Listen)[0].OwningProcess -Force -Confirm:$false"', { stdio: 'ignore' }); } catch {} };
(async () => {
  const MAN = 'C:/Users/administer/WorkBuddy/DevPilot/.update-manifest-test.json';
  const startBackend = async (env) => {
    stopBackend();
    await new Promise((r) => setTimeout(r, 1200));
    const b = spawn('node', ['dist/main.js'], { cwd: 'C:/Users/administer/WorkBuddy/DevPilot/apps/backend', stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } });
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); const h = await call('GET', '/health'); if (h.code === 200) break; }
    return b;
  };
  const backends = [];

  backends.push(await startBackend({}));
  console.log('1 无清单:', (await call('GET', '/system/update-check')).body);

  fs.writeFileSync(MAN, JSON.stringify({ latestVersion: '0.2.0', downloadUrl: 'https://example.com/devpilot-0.2.0.zip', notes: '测试更新' }));
  backends.push(await startBackend({ DEVIPILOT_UPDATE_MANIFEST: MAN }));
  console.log('2 有新版本:', (await call('GET', '/system/update-check')).body);

  fs.writeFileSync(MAN, JSON.stringify({ latestVersion: '0.1.0' }));
  backends.push(await startBackend({ DEVIPILOT_UPDATE_MANIFEST: MAN }));
  console.log('3 同版本（不提示）:', (await call('GET', '/system/update-check')).body);

  fs.unlinkSync(MAN);
  for (const b of backends) { try { execSync('taskkill /pid ' + b.pid + ' /T /F', { stdio: 'ignore' }); } catch {} }
  console.log('cleaned');
  process.exit(0);
})();
