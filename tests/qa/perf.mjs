/**
 * DevPilot 性能 / 并发测试（隔离实例 37150）
 * 输出 perf-result.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const req = createRequire('C:/Users/administer/WorkBuddy/DevPilot/apps/backend/package.json');
const Database = req('better-sqlite3');

const BASE = process.argv[2] || 'http://127.0.0.1:37150/api/v1';
const DB = 'C:/Users/administer/WorkBuddy/DevPilot/.audit-qa/data/devpilot.db';
const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { api: {}, startup: {}, stop: {}, imports: {}, timeline: {} };

async function call(method, url, body, timeout = 120_000) {
  const t0 = performance.now();
  const res = await fetch(BASE + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, ms: performance.now() - t0 };
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return +(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0).toFixed(1); };
const stats = (arr) => ({ n: arr.length, min: +Math.min(...arr).toFixed(1), p50: pct(arr, 50), p95: pct(arr, 95), max: +Math.max(...arr).toFixed(1), avg: +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) });

// ---------- 导入并计时 ----------
async function importFolder(ref, label) {
  const t0 = performance.now();
  const r = await call('POST', '/projects/import/unified', { source: 'folder', ref: ref.replace(/\\/g, '/') });
  const jobId = r.json?.jobId;
  let job = null;
  while (performance.now() - t0 < 180_000) {
    const g = await call('GET', `/projects/import/unified/${jobId}`);
    job = g.json;
    if (job && ['Success', 'success', 'done', 'Failed', 'failed', 'error', 'Cancelled', 'cancelled'].includes(String(job.status))) break;
    await sleep(200);
  }
  const ms = Math.round(performance.now() - t0);
  out.imports[label] = { jobId, status: job?.status, ms, phases: (job?.phases ?? []).slice(-4), error: job?.error ?? null };
  console.log(`导入 ${label}: ${ms}ms status=${job?.status}`);
  const all = await call('GET', '/projects');
  return { jobId, list: all.json };
}

const impA = await importFolder(path.join(FIX, 'app-port'), 'folder/有端口');
const impB = await importFolder(path.join(FIX, 'app-noport'), 'folder/无端口');

const findP = (name) => (impB.list ?? []).find((p) => (p.name ?? '').includes(name));
const PA = findP('app-port');
const PB = findP('app-noport');
console.log('项目:', PA?.id, PA?.name, '|', PB?.id, PB?.name);

// 给 A 的自动识别服务写入端口（灰盒：直接改库，等价于 UI 里填端口）
if (PA) {
  const db = new Database(DB);
  const svc = db.prepare('SELECT id, name, start_command, port FROM project_services WHERE project_id = ?').all(PA.id);
  console.log('A 服务:', JSON.stringify(svc));
  const target = svc.find((s) => s.start_command);
  if (target) db.prepare('UPDATE project_services SET port = 4211 WHERE id = ?').run(target.id);
  db.close();
}

async function startTimed(pid, label) {
  const t0 = performance.now();
  const r = await call('POST', `/projects/${pid}/autostart`);
  const jobId = r.json?.jobId;
  let job = null;
  while (performance.now() - t0 < 180_000) {
    const g = await call('GET', `/autostart/${jobId}`);
    job = g.json;
    if (job && ['Success', 'Failed', 'Cancelled'].includes(job.status)) break;
    await sleep(80);
  }
  const ms = Math.round(performance.now() - t0);
  return { ms, status: job?.status, jobId, job };
}

async function stopTimed(pid) {
  const t0 = performance.now();
  const r = await call('POST', `/projects/${pid}/stop`);
  return { ms: Math.round(performance.now() - t0), status: r.status, body: r.text.slice(0, 120) };
}

if (PA) {
  const seq = [];
  for (let i = 0; i < 3; i++) {
    const s = await startTimed(PA.id, `有端口#${i + 1}`);
    seq.push(s.ms);
    if (i === 0) out.timeline['A-有端口-首次'] = (s.job?.steps ?? []).map((x) => ({ at: x.at?.slice(11, 23), phase: x.phase, msg: String(x.message).slice(0, 70) }));
    const st = await stopTimed(PA.id);
    seq.push(-st.ms);
    out.stop[`A#${i + 1}`] = st.ms;
    if (i === 0) out.timeline['A-停止'] = st;
    await sleep(800);
  }
  out.startup['A 有端口(4211) 3 轮'] = { starts: seq.filter((x) => x > 0), stops: seq.filter((x) => x < 0).map((x) => -x) };
  console.log('A 启动/停止序列:', JSON.stringify(out.startup['A 有端口(4211) 3 轮']));
}
if (PB) {
  const seq = [];
  for (let i = 0; i < 2; i++) {
    const s = await startTimed(PB.id, `无端口#${i + 1}`);
    seq.push(s.ms);
    if (i === 0) out.timeline['B-无端口-首次'] = (s.job?.steps ?? []).map((x) => ({ at: x.at?.slice(11, 23), phase: x.phase, msg: String(x.message).slice(0, 70) }));
    const st = await stopTimed(PB.id);
    seq.push(-st.ms);
    out.stop[`B#${i + 1}`] = st.ms;
    await sleep(800);
  }
  out.startup['B 无端口 2 轮'] = { starts: seq.filter((x) => x > 0), stops: seq.filter((x) => x < 0).map((x) => -x) };
  console.log('B 启动/停止序列:', JSON.stringify(out.startup['B 无端口 2 轮']));
}

// ---------- API 时延 ----------
async function latency(name, method, url, body, n = 50) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const r = await call(method, url, body);
    arr.push(r.ms);
  }
  out.api[name] = stats(arr);
  console.log(`${name}: ${JSON.stringify(out.api[name])}`);
}
await latency('GET /projects ×100', 'GET', '/projects', undefined, 100);
await latency('GET /logs?limit=50 ×50', 'GET', '/logs?limit=50', undefined, 50);
await latency('GET /runtime/tracked ×50', 'GET', '/runtime/tracked', undefined, 50);
await latency('GET /environments ×30', 'GET', '/environments', undefined, 30);
await latency('POST /tools/call(echo) ×30', 'POST', '/tools/call', { subjectType: 'user', subjectId: 'qa', tool: 'command.exec', params: { command: 'echo perf' } }, 30);

// ---------- 并发 ----------
async function concurrent(name, n, method, url, body) {
  const t0 = performance.now();
  const rs = await Promise.all(Array.from({ length: n }, () => call(method, url, body).catch((e) => ({ status: 0, ms: 0, text: String(e) }))));
  const total = performance.now() - t0;
  const arr = rs.map((r) => r.ms);
  out.api[name] = { ...stats(arr), wallMs: Math.round(total), statuses: rs.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {}) };
  console.log(`${name}: ${JSON.stringify(out.api[name])}`);
}
await concurrent('并发 30× GET /projects', 30, 'GET', '/projects');
await concurrent('并发 10× GET /environments/scan-versions', 10, 'GET', '/environments/scan-versions');
await concurrent('并发 5× GET /logs?limit=500', 5, 'GET', '/logs?limit=500');

// ---------- 大目录列举（同步 IO 阻塞探针） ----------
const t0 = performance.now();
const hv = await Promise.all([
  call('GET', '/system/fs/dirs?path=C%3A%5CWindows%5CSystem32', undefined, 120_000),
  (async () => { await sleep(30); return call('GET', '/health'); })(),
]);
out.api['大目录列举(C:\\Windows\\System32)+健康探针'] = {
  dirMs: Math.round(hv[0].ms), dirStatus: hv[0].status, dirCount: (hv[0].json?.dirs ?? []).length,
  healthDuringMs: Math.round(hv[1].ms), healthStatus: hv[1].status, wallMs: Math.round(performance.now() - t0),
};
console.log('大目录探针:', JSON.stringify(out.api['大目录列举(C:\\Windows\\System32)+健康探针']));

fs.writeFileSync(path.join(here, 'perf-result.json'), JSON.stringify(out, null, 2));
console.log('\n=== perf-result.json 已写入 ===');
