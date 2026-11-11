/* 打包态 e2e：杀后端 → DevPilot.exe（win-unpacked）→ BackendManager 打包态拉起 → health → 清理 */
const { spawn, execSync } = require('node:child_process');
const net = require('node:net');
const portUp = () => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port: 37100, timeout: 600 });
  s.on('connect', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
  s.on('timeout', () => { s.destroy(); res(false); });
});
(async () => {
  try { execSync('powershell -NoProfile -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort 37100 -State Listen)[0].OwningProcess -Force -Confirm:$false"', { stdio: 'ignore' }); } catch {}
  await new Promise((r) => setTimeout(r, 1500));
  console.log('step1 现有后端已杀（应 false）:', await portUp());

  const exe = 'C:/Users/administer/WorkBuddy/DevPilot/apps/desktop/release2/win-unpacked/DevPilot.exe';
  const app = spawn(exe, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: (() => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; return e; })(),
  });
  let out = '';
  app.stdout.on('data', (d) => { out += String(d); });
  app.stderr.on('data', (d) => { out += String(d); });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    up = await portUp();
    if (up) break;
  }
  console.log('step2 打包态 BackendManager 拉起后端（应 true）:', up);
  if (up) {
    const h = await fetch('http://127.0.0.1:37100/api/v1/health').then((r) => r.json());
    console.log('step3 health:', JSON.stringify(h));
    // 打包态核心验证：better-sqlite3（Electron ABI）真实读写
    const proj = await fetch('http://127.0.0.1:37100/api/v1/projects').then((r) => r.json());
    console.log('step4 DB 读（projects 数）:', proj.length);
  }
  await new Promise((r) => setTimeout(r, 3000));
  console.log('step5 DevPilot.exe 3s 后仍存活:', app.exitCode === null);
  console.log('=== 输出尾部 ===');
  console.log(out.slice(-600).replace(/\n+/g, ' | '));
  try { execSync('taskkill /pid ' + app.pid + ' /T /F', { stdio: 'ignore' }); } catch {}
  console.log('cleaned');
  process.exit(0);
})();
