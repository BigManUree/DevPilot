/* 桌面壳生产模式 e2e：杀现有后端 → electron 拉起 → 验证链路（架构债 #11） */
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

  const electron = spawn('node_modules/electron/dist/electron.exe', ['.'], {
    cwd: 'C:/Users/administer/WorkBuddy/DevPilot/apps/desktop',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // 宿主（WorkBuddy）注入 ELECTRON_RUN_AS_NODE=1 会把 electron.exe 降级为纯 Node，
    // 必须从子进程环境里删除该变量，否则 require('electron') 返回二进制路径字符串
    env: (() => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; return e; })(),
  });
  let outBuf = '';
  electron.stdout.on('data', (d) => { outBuf += String(d); });
  electron.stderr.on('data', (d) => { outBuf += String(d); });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    up = await portUp();
    if (up) break;
  }
  console.log('step2 BackendManager 拉起后端（应 true）:', up);
  if (up) {
    const h = await fetch('http://127.0.0.1:37100/api/v1/health').then((r) => r.json());
    console.log('step3 health:', JSON.stringify(h));
  }
  await new Promise((r) => setTimeout(r, 3000));
  console.log('step4 electron 3s 后仍存活:', electron.exitCode === null);
  console.log('=== electron 全量输出 ===');
  console.log(outBuf.slice(0, 3000));
  try { execSync('taskkill /pid ' + electron.pid + ' /T /F', { stdio: 'ignore' }); } catch {}
  console.log('cleaned');
  process.exit(0);
})();
