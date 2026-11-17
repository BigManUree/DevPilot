/**
 * DevPilot 灰盒 / 破坏性测试（隔离实例 37150 + 隔离数据目录）
 * 覆盖：导入 → 启动 → 并发 → 停止 → 删除；CSRF；主体伪造；符号链接逃逸；ZIP Slip；
 *       备份创建/恢复；本地服务；终端；MCP 外部调用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const BASE = process.argv[2] || 'http://127.0.0.1:37150/api/v1';
const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures');
const out = [];
const rec = (o) => { out.push(o); console.log(JSON.stringify(o)); };

async function call(method, url, body, opts = {}) {
  const t0 = performance.now();
  const res = await fetch(BASE + url, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    signal: AbortSignal.timeout(opts.timeout ?? 60_000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, ms: Math.round(performance.now() - t0) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. 导入夹具项目 ----------
async function importAndWait(source, ref, label) {
  const r = await call('POST', '/projects/import/unified', { source, ref });
  if (!r.json?.jobId) { rec({ case: `导入-${label}`, status: r.status, body: r.text.slice(0, 200), ok: false }); return null; }
  const jobId = r.json.jobId;
  const t0 = Date.now();
  let job = null;
  while (Date.now() - t0 < 60_000) {
    const g = await call('GET', `/projects/import/unified/${jobId}`);
    job = g.json;
    if (job && ['Success', 'Failed', 'Cancelled'].includes(job.status)) break;
    await sleep(300);
  }
  rec({ case: `导入-${label}`, jobId, status: job?.status, elapsedMs: Date.now() - t0, error: job?.error ?? null, projectId: job?.projectId ?? null });
  return job;
}

const jobA = await importAndWait('folder', path.join(FIX, 'vite-app').replace(/\\/g, '/'), '文件夹/Vite 类');
const jobB = await importAndWait('folder', path.join(FIX, 'plain-node').replace(/\\/g, '/'), '文件夹/纯 Node');

const list = await call('GET', '/projects');
const projects = list.json || [];
const PA = projects.find((p) => (p.name || '').includes('vite-app')) ?? projects[0];
const PB = projects.find((p) => (p.name || '').includes('plain-node'));
rec({ case: '项目列表', count: projects.length, pa: PA?.id, pb: PB?.id, paName: PA?.name, pbName: PB?.name });

if (PA) {
  const det = await call('GET', `/projects/${PA.id}`);
  rec({ case: '项目详情/服务识别', services: (det.json?.services ?? []).map((s) => ({ name: s.name, port: s.port, cmd: s.start_command, status: s.status })) });
  // 补端口：识别出来的服务若没有端口，设置 4211 便于探活
  for (const s of det.json?.services ?? []) {
    if (!s.port) {
      const u = await call('POST', `/services/${s.id}/policy`, { port: 4211 });
      rec({ case: '服务端口设置', service: s.name, status: u.status, body: u.text.slice(0, 120) });
    }
  }
}

// ---------- 2. 启动 / 并发 / 停止 计时 ----------
async function autostartTimed(pid, label) {
  const t0 = performance.now();
  const r = await call('POST', `/projects/${pid}/autostart`);
  const jobId = r.json?.jobId;
  let job = null;
  while (performance.now() - t0 < 120_000) {
    const g = await call('GET', `/autostart/${jobId}`);
    job = g.json;
    if (job && ['Success', 'Failed', 'Cancelled'].includes(job.status)) break;
    await sleep(150);
  }
  rec({ case: `启动-${label}`, status: job?.status, elapsedMs: Math.round(performance.now() - t0), port: job?.port ?? null, report: (job?.report ?? '').slice(0, 160) });
  return { jobId, job };
}

let A = null, B = null;
if (PA && PB) {
  // 并发：同时发起两个项目的启动
  const [ra, rb] = await Promise.all([autostartTimed(PA.id, 'A/并发'), autostartTimed(PB.id, 'B/并发')]);
  A = ra; B = rb;
  const tracked = await call('GET', '/runtime/tracked');
  rec({ case: '并发后受管进程', count: Array.isArray(tracked.json) ? tracked.json.length : null, ports: (tracked.json ?? []).map((t) => t.port ?? t.pid) });
} else if (PA) {
  A = await autostartTimed(PA.id, 'A/单项目');
}

// 停止计时
if (PA) {
  const t0 = performance.now();
  const s = await call('POST', `/projects/${PA.id}/stop`);
  rec({ case: '停止-项目A', status: s.status, elapsedMs: Math.round(performance.now() - t0), body: s.text.slice(0, 160) });
}

// ---------- 3. CSRF：表单型跨站请求（无预检） ----------
if (PA) {
  // 先重新启动，确认 CSRF 能产生真实副作用
  const pre = await autostartTimed(PA.id, 'CSRF 前置启动');
  const csrf = await fetch(`${BASE}/projects/${PA.id}/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example.com' },
    body: 'x=1',
  });
  const csrfText = await csrf.text();
  await sleep(1500);
  const after = await call('GET', `/projects/${PA.id}`);
  const stillRunning = (after.json?.services ?? []).filter((s) => s.status === 'Running').length;
  rec({
    case: 'CSRF-表单型跨站 POST /stop',
    httpStatus: csrf.status,
    body: csrfText.slice(0, 120),
    runningServicesAfter: stillRunning,
    csrfEffective: stillRunning === 0 && csrf.status < 400,
    note: '无 Origin 校验 + 无自定义头要求 → 任意网页可用简单请求触发',
  });
}

// ---------- 4. 主体伪造：agent 身份 vs user 身份 ----------
const cmdProbe = 'echo DEV_PILOT_QA_PROBE';
const asUser = await call('POST', '/tools/call', { subjectType: 'user', subjectId: 'x', tool: 'command.exec', params: { command: cmdProbe } });
rec({ case: '工具调用-user 主体命令执行', status: asUser.status, ok: asUser.json?.ok, permission: asUser.json?.permission, stdout: String(asUser.json?.data?.stdout ?? '').trim().slice(0, 60) });
const asAgent = await call('POST', '/tools/call', { subjectType: 'agent', subjectId: 'qa-agent', tool: 'command.exec', params: { command: cmdProbe }, projectId: PA?.id });
rec({ case: '工具调用-agent 主体命令执行', status: asAgent.status, ok: asAgent.json?.ok, permission: asAgent.json?.permission, approvalId: asAgent.json?.approvalId ?? null, error: String(asAgent.json?.error ?? '').slice(0, 80) });
const asAgentUserSpoof = await call('POST', '/tools/call', { subjectType: 'agent', subjectId: 'qa-agent', tool: 'fs.write', params: { path: 'C:/Windows/Temp/qa-escape.txt', content: 'x' }, projectId: PA?.id });
rec({ case: '工具调用-agent 越界写', status: asAgentUserSpoof.status, ok: asAgentUserSpoof.json?.ok, error: String(asAgentUserSpoof.json?.error ?? '').slice(0, 120) });
const userEscapeWrite = await call('POST', '/tools/call', { subjectType: 'user', subjectId: 'x', tool: 'fs.write', params: { path: 'C:/Windows/Temp/qa-user-escape.txt', content: 'probe' } });
rec({ case: '工具调用-user 主体写系统目录', status: userEscapeWrite.status, ok: userEscapeWrite.json?.ok, error: String(userEscapeWrite.json?.error ?? '').slice(0, 120) });

// ---------- 5. 符号链接逃逸（工作区） ----------
if (PA) {
  const linkPath = path.join(FIX, 'vite-app', 'escape-link');
  try {
    if (!fs.existsSync(linkPath)) execSync(`cmd /c mklink /D "${linkPath}" "C:\\Windows"`, { windowsHide: true });
    rec({ case: '符号链接创建', ok: fs.existsSync(linkPath) });
  } catch (e) { rec({ case: '符号链接创建', ok: false, error: String(e).slice(0, 120) }); }
  const r = await call('GET', `/workspace/dir?dirPath=${encodeURIComponent(linkPath)}`);
  rec({ case: '工作区-符号链接指向 C:\\Windows', status: r.status, body: r.text.slice(0, 160), blocked: r.status === 400 });
  // 项目根内的普通读取作为对照
  const ok = await call('GET', `/workspace/dir?dirPath=${encodeURIComponent(path.join(FIX, 'vite-app'))}`);
  rec({ case: '工作区-项目根对照', status: ok.status, entries: (ok.json?.entries ?? []).length });
  try { execSync(`cmd /c rmdir "${linkPath}"`, { windowsHide: true }); } catch {}
}

// ---------- 6. ZIP Slip / 压缩炸弹 ----------
const zipDir = path.join(here, 'fixtures');
const slipZip = path.join(zipDir, 'slip.zip');
try {
  // 手工构造含 ../ 条目与绝对路径条目的 zip
  const { execSync: ex } = await import('node:child_process');
  const stage = path.join(zipDir, 'slip-stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'ok.txt'), 'ok');
  const py = `
import zipfile, os, shutil
p = r"${slipZip}"
if os.path.exists(p): os.remove(p)
z = zipfile.ZipFile(p, 'w')
z.writestr('../devpilot-slip-escape.txt', 'ESCAPED')
z.writestr('../../devpilot-slip-escape2.txt', 'ESCAPED2')
z.writestr('C:/Windows/Temp/devpilot-slip-abs.txt', 'ABS')
z.writestr('ok.txt', 'ok')
z.close()
print('zip built')
`;
  fs.writeFileSync(path.join(zipDir, 'mkzip.py'), py);
  try { console.log(ex('python ' + JSON.stringify(path.join(zipDir, 'mkzip.py'))).toString().trim()); }
  catch { try { console.log(ex('py ' + JSON.stringify(path.join(zipDir, 'mkzip.py'))).toString().trim()); } catch (e2) { console.log('python unavailable: ' + String(e2).slice(0, 80)); } }
} catch (e) { rec({ case: 'ZIP 构造', error: String(e).slice(0, 120) }); }

if (fs.existsSync(slipZip)) {
  const job = await importAndWait('archive', slipZip.replace(/\\/g, '/'), 'ZIP Slip 载荷');
  rec({
    case: 'ZIP Slip 结果',
    jobStatus: job?.status,
    escaped1: fs.existsSync(path.join(here, 'devpilot-slip-escape.txt')) || fs.existsSync(path.join(FIX, '..', 'devpilot-slip-escape.txt')),
    escaped2: fs.existsSync(path.join(here, '..', 'devpilot-slip-escape2.txt')),
    escapedAbs: fs.existsSync('C:/Windows/Temp/devpilot-slip-abs.txt'),
  });
}

// ---------- 7. 备份 / 恢复 ----------
const bk = await call('POST', '/backups', { backupType: 'manual' });
rec({ case: '备份创建', status: bk.status, body: bk.text.slice(0, 160) });
const bkList = await call('GET', '/backups');
const bkRow = Array.isArray(bkList.json) ? bkList.json[0] : null;
if (bkRow) {
  const v = await call('POST', `/backups/${bkRow.id}/verify`);
  rec({ case: '备份校验', status: v.status, body: v.text.slice(0, 160) });
  const exp = await call('POST', '/backups/export-project', { projectId: PA?.id });
  rec({ case: '项目导出', status: exp.status, body: exp.text.slice(0, 200) });
}

// ---------- 8. 本地服务（任意 exe 托管） ----------
const ls = await call('POST', '/local-services', { name: 'qa-echo', serviceKind: 'node', exePath: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'], port: null });
rec({ case: '本地服务-创建', status: ls.status, body: ls.text.slice(0, 160) });
const lsList = await call('GET', '/local-services');
const qaRow = (lsList.json ?? []).find((r) => r.name === 'qa-echo');
if (qaRow) {
  const st = await call('POST', `/local-services/${qaRow.id}/start`);
  rec({ case: '本地服务-启动任意可执行', status: st.status, body: st.text.slice(0, 160) });
  const sp = await call('POST', `/local-services/${qaRow.id}/stop`);
  rec({ case: '本地服务-停止', status: sp.status, body: sp.text.slice(0, 160) });
  await call('DELETE', `/local-services/${qaRow.id}`);
}

// ---------- 9. 终端 ----------
const term = await call('POST', '/terminal/sessions', { cwd: 'C:/Windows' });
rec({ case: '终端-创建(任意 cwd)', status: term.status, body: term.text.slice(0, 160) });
if (term.json?.id) {
  await sleep(500);
  const buf = await call('GET', `/terminal/sessions/${term.json.id}/buffer`);
  rec({ case: '终端-读取输出', status: buf.status, hasBuffer: (buf.json?.buffer ?? '').length > 0, len: (buf.json?.buffer ?? '').length });
  const kill = await call('DELETE', `/terminal/sessions/${term.json.id}`);
  rec({ case: '终端-关闭', status: kill.status, body: kill.text.slice(0, 120) });
}

// ---------- 10. 任务生命周期 ----------
const task = await call('POST', '/tasks', { projectId: PA?.id, title: 'QA 生命周期任务', description: '验证创建→暂停→恢复→取消' });
rec({ case: '任务创建', status: task.status, body: task.text.slice(0, 200) });
const tid = task.json?.id ?? task.json?.taskId;
if (tid) {
  for (const act of ['pause', 'resume', 'cancel']) {
    const r = await call('POST', `/tasks/${tid}/${act}`);
    rec({ case: `任务-${act}`, status: r.status, body: r.text.slice(0, 140) });
  }
  await call('DELETE', `/tasks/${tid}`);
}

// ---------- 11. MCP 外部调用（走审批双门？） ----------
const mcpInit = await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'qa' } } });
rec({ case: 'MCP initialize', status: mcpInit.status, body: mcpInit.text.slice(0, 200) });
const mcpTools = await call('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
rec({ case: 'MCP tools/list', status: mcpTools.status, tools: (mcpTools.json?.result?.tools ?? []).map?.((t) => t.name)?.slice(0, 12) ?? mcpTools.text.slice(0, 160) });
const mcpCall = await call('POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'project.list', arguments: {} } });
rec({ case: 'MCP tools/call', status: mcpCall.status, body: mcpCall.text.slice(0, 220) });

// ---------- 12. 删除项目（含 deleteFiles） ----------
if (PA) {
  const before = fs.existsSync(path.join(FIX, 'vite-app', 'package.json'));
  const del = await call('DELETE', `/projects/${PA.id}?deleteFiles=true`);
  await sleep(500);
  const after = fs.existsSync(path.join(FIX, 'vite-app', 'package.json'));
  rec({ case: '删除项目-deleteFiles=true', status: del.status, body: del.text.slice(0, 140), fileExistedBefore: before, fileExistsAfter: after, filesDeleted: before && !after });
}
if (PB) {
  const del = await call('DELETE', `/projects/${PB.id}`);
  rec({ case: '删除项目-保留文件', status: del.status, fileExists: fs.existsSync(path.join(FIX, 'plain-node', 'package.json')) });
}

fs.writeFileSync(path.join(here, 'graybox-result.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), out }, null, 2));
console.log('\n=== 写入 graybox-result.json，用例数 ' + out.length + ' ===');
