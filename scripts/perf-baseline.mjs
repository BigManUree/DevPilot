/**
 * 性能基线实测（测试方案 §4，架构债 #6）。
 * 运行前提：后端已启动（scripts/backend-daemon.cmd）。
 * 用法：node scripts/perf-baseline.mjs
 */
const API = 'http://127.0.0.1:37100/api/v1';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('C:/Users/administer/WorkBuddy/DevPilot/node_modules/.pnpm/node_modules/ws');

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
async function timeFetch(url, opts) {
  const t0 = performance.now();
  await fetch(url, opts);
  return performance.now() - t0;
}

async function main() {
  const report = { date: new Date().toISOString(), machine: 'Windows (target hardware: local dev machine)' };

  // 自包含模式：脚本自己拉起后端（前台子进程，会话内存活稳定），测量结束统一清理。
  // 不依赖外部 daemon——沙箱会延迟回收一切派生进程（P8/P9 观察）。
  const killPs0 = spawn('powershell.exe', ['-NoProfile', '-Command', "try { Stop-Process -Id (Get-NetTCPConnection -LocalPort 37100 -State Listen)[0].OwningProcess -Force -Confirm:$false } catch {}"], { windowsHide: true });
  await new Promise((r) => killPs0.on('close', r));
  await new Promise((r) => setTimeout(r, 1200));
  const backend = spawn('node', ['dist/main.js'], { cwd: 'C:/Users/administer/WorkBuddy/DevPilot/apps/backend', stdio: 'ignore', windowsHide: true });
  let backendUp = false;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { const h = await fetch(`${API}/health`, { signal: AbortSignal.timeout(500) }); if (h.ok) { backendUp = true; break; } } catch { /* 未就绪 */ }
  }
  if (!backendUp) { console.error('FATAL: 自起后端失败'); process.exit(1); }
  console.log('backend up (pid=' + backend.pid + ')');

  // 1) API 延迟：health / projects / notifications 各 100 次
  const lat = {};
  for (const [name, path] of [['health', '/health'], ['projects', '/projects'], ['notifications', '/notifications']]) {
    const arr = [];
    for (let i = 0; i < 100; i++) arr.push(await timeFetch(API + path));
    lat[name] = { avg: Math.round(arr.reduce((a, b) => a + b) / arr.length), p50: Math.round(pct(arr, 50)), p95: Math.round(pct(arr, 95)), p99: Math.round(pct(arr, 99)) };
  }
  report.apiLatencyMs = lat;

  // 2) 项目导入耗时（fixture 混合项目，幂等导入跳过 vs 首次）
  const t0 = performance.now();
  const imp = await fetch(`${API}/projects/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'folder', rootPath: 'C:/Users/administer/WorkBuddy/DevPilot/tests/fixtures/demo-project' }) }).then((r) => r.json());
  report.importProjectMs = { elapsed: Math.round(performance.now() - t0), services: imp.analysis?.services?.length ?? 0 };

  // 3) 环境检测（15 探针全跑）
  const t1 = performance.now();
  const env = await fetch(`${API}/environments`).then((r) => r.json());
  report.envDetectMs = { elapsed: Math.round(performance.now() - t1), tools: env.length };

  // 4.5) WS 推送延迟（测试方案 ≤1s）：POST /notifications 触发 notification.new，测 POST 发出到 WS 收到
  const wsSamples = [];
  {
    const wsUrl = 'ws://127.0.0.1:37100/ws';
    const ws = new WebSocket(wsUrl);
    /** 按通知 id 缓存到达时间——服务端 broadcast 先于 HTTP 响应，帧可能比 pendingId 赋值更早 */
    const arrivedAt = new Map();
    ws.on('message', (raw) => {
      try {
        const ev = JSON.parse(String(raw));
        if (ev.event_type === 'notification.new' && ev.payload?.notificationId) {
          arrivedAt.set(ev.payload.notificationId, performance.now());
        }
      } catch { /* 非 JSON 帧忽略 */ }
    });
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); setTimeout(() => reject(new Error('ws connect timeout')), 5000); });
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const r = await fetch(`${API}/notifications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'perf.probe', title: `ws-latency-${i}`, priority: 5 }) }).then((x) => x.json());
      // WS 帧可能先于 POST 响应到达：帧已入 arrivedAt，直接查表
      const deadline = t0 + 3000;
      let arrived = arrivedAt.get(r.id);
      while (arrived === undefined && performance.now() < deadline) {
        await new Promise((r2) => setTimeout(r2, 2));
        arrived = arrivedAt.get(r.id);
      }
      if (arrived !== undefined) wsSamples.push(Math.max(0, arrived - t0));
      await new Promise((r2) => setTimeout(r2, 150));
    }
    ws.close();
  }
  report.wsPushLatencyMs = wsSamples.length
    ? { samples: wsSamples.length, avg: Math.round(wsSamples.reduce((a, b) => a + b) / wsSamples.length), p95: Math.round(pct(wsSamples, 95)), target: '≤1000', note: 'POST 响应返回 → 客户端 WS 收到 notification.new' }
    : { error: '未收到任何推送（检查规则过滤/网关）' };

  // 5) 脚本内派生的进程都会被会话回收——冷启动已放最后，后端由外部（下一次工具调用）恢复：
  //    Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd /c C:////Users////administer////WorkBuddy////DevPilot////scripts////backend-daemon.cmd' }
  report.daemonRestored = 'external-recovery-required';

  // 4) 冷启动（放最后）：杀当前后端 → WMI 派生 → 计时到 health 200；脚本退出后后端由外部恢复
  //    （不 spawn 子进程：脚本内前台子进程会在被回收时连带 SIGTERM 整个任务，P8 坑）
  const killPs = spawn('powershell.exe', ['-NoProfile', '-Command', "try { Stop-Process -Id (Get-NetTCPConnection -LocalPort 37100 -State Listen)[0].OwningProcess -Force -Confirm:$false } catch {}"], { windowsHide: true });
  await new Promise((r) => killPs.on('close', r));
  await new Promise((r) => setTimeout(r, 1500));
  const coldChild = spawn('node', ['dist/main.js'], { cwd: 'C:/Users/administer/WorkBuddy/DevPilot/apps/backend', stdio: 'ignore', windowsHide: true });
  const bootStart = performance.now();
  let bootMs = null;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(500) });
      if (r.ok) { bootMs = Math.round(performance.now() - bootStart); break; }
    } catch { /* 未就绪 */ }
  }
  report.coldStartMs = { elapsed: bootMs, target: '≤5000（测试方案建议值）', note: '从 spawn node 到首个 health 200，含 Nest 路由映射与 V5 迁移检查' };

  // 清理：杀掉脚本自起的子进程
  try { backend.kill(); coldChild.kill(); } catch { /* 已退出 */ }
  report.daemonRestored = 'external-recovery-required：请运行 scripts/start-backend.cmd 或 WMI 派生 backend-daemon.cmd 恢复常驻';

  // 4.6) 清理 perf 探针通知
  try {
    const list = await fetch(`${API}/notifications?limit=200`).then((r) => r.json());
    for (const n of list.filter((n) => n.type === 'perf.probe')) await fetch(`${API}/notifications/${n.id}`, { method: 'DELETE' });
  } catch { /* 清理失败不影响报告 */ }

  fs.writeFileSync('C:/Users/administer/WorkBuddy/DevPilot/docs/性能基线报告.json', JSON.stringify(report, null, 2), 'utf-8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
