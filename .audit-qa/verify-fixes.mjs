/**
 * 修复验证脚本：逐条断言报告中的缺陷已被修复
 * 用法：node .audit-qa/verify-fixes.mjs http://127.0.0.1:37150/api/v1
 */
const BASE = process.argv[2] || 'http://127.0.0.1:37150/api/v1';
const TOKEN = (await import('node:fs')).readFileSync(`${process.env.APPDATA}/devpilot/data/.auth-token`, 'utf-8').trim();
const isoToken = (await import('node:fs')).existsSync('C:/Users/administer/WorkBuddy/DevPilot/.audit-qa/data/.auth-token')
  ? (await import('node:fs')).readFileSync('C:/Users/administer/WorkBuddy/DevPilot/.audit-qa/data/.auth-token', 'utf-8').trim()
  : TOKEN;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(id, name, pass, detail) {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}  ${detail ? '| ' + detail : ''}`);
}

async function req(method, path, { body, headers, raw } = {}) {
  const t0 = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers || {}) },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, ms: performance.now() - t0, headers: res.headers };
}

// ---- S-01 CSRF ----
const evil = await req('POST', '/tools/call', {
  raw: 'subjectType=user&subjectId=x&tool=command.exec&params%5Bcommand%5D=echo HACKED',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example.com' },
});
check('S-01a', '恶意来源表单 POST 被拒', evil.status === 403, `status=${evil.status}`);

const nullNoToken = await req('GET', '/projects', { headers: { origin: 'null' } });
check('S-01b', 'Origin:null 无 token 被拒', nullNoToken.status === 403, `status=${nullNoToken.status}`);

const devOrigin = await req('GET', '/projects', { headers: { origin: 'http://localhost:5173' } });
check('S-01c', '开发前端来源放行', devOrigin.status === 200, `status=${devOrigin.status}`);

const noOrigin = await req('GET', '/projects');
check('S-01d', '本机脚本（无 Origin）放行', noOrigin.status === 200, `status=${noOrigin.status}`);

const withToken = await req('GET', '/projects', { headers: { origin: 'null', 'x-devpilot-token': isoToken } });
check('S-01e', 'Origin:null + 正确 token 放行', withToken.status === 200, `status=${withToken.status}`);

const preflight = await fetch(BASE + '/projects', {
  method: 'OPTIONS',
  headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-devpilot-token' },
});
check(
  'S-01f',
  'CORS 预检允许自定义头',
  preflight.status < 400 && (preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase().includes('x-devpilot-token'),
  `status=${preflight.status} acah=${preflight.headers.get('access-control-allow-headers')}`,
);

// ---- 选中一个项目 ----
const list = await req('GET', '/projects');
const projects = Array.isArray(list.json) ? list.json : [];
const appPort = projects.find((p) => (p.name ?? '').includes('app-port')) ?? projects[0];
const daemon = projects.find((p) => (p.name ?? '').includes('daemon'));

// ---- F-01 工作区新建文件 ----
if (appPort) {
  const target = `${appPort.root_path.replace(/\\/g, '/')}/.qa-verify-new.txt`;
  const w = await req('POST', '/workspace/file', { body: { filePath: target, content: 'verify' } });
  const r = await req('GET', `/workspace/file?filePath=${encodeURIComponent(target)}`);
  check('F-01', '工作区新建文件', w.status < 300 && r.json?.content === 'verify', `write=${w.status} read=${r.json?.content}`);
  const { execSync } = await import('node:child_process');
  try { execSync(`cmd /c del "${target.replace(/\//g, '\\\\')}"`, { windowsHide: true }); } catch { /* ignore */ }
}

// ---- F-04 语义 ----
const cases = [
  ['F-04a', 'GET 不存在项目 → 404', 'GET', '/projects/00000000-0000-0000-0000-000000000000', undefined, 404],
  ['F-04b', 'logs limit=abc → 400', 'GET', '/logs?limit=abc', undefined, 400],
  ['F-04c', 'logs offset 溢出 → 400', 'GET', '/logs?offset=99999999999999999999', undefined, 400],
  ['F-04d', '空任务体 → 400', 'POST', '/tasks', {}, 400],
  ['F-04e', 'tools/call 空体 → 400', 'POST', '/tools/call', {}, 400],
  ['F-05', '未知工具 → 400', 'POST', '/tools/call', { subjectType: 'user', subjectId: 'x', tool: 'no.such', params: {} }, 400],
  ['F-04f', 'memory scope 非法 → 400', 'POST', '/memories', { scope: 'bogus', content: 'x' }, 400],
  ['F-04g', '审批不存在 → 404', 'POST', '/approvals/nope/approve', undefined, 404],
  ['S-04', '删文件无 confirm → 409', 'DELETE', `/projects/${appPort?.id ?? 'x'}?deleteFiles=true`, undefined, 409],
];
for (const [id, name, method, path, body, expect] of cases) {
  const r = await req(method, path, { body });
  check(id, name, r.status === expect, `status=${r.status}`);
}

// ---- 413 ----
const big = 'x'.repeat(11 * 1024 * 1024);
const bigRes = await req('POST', '/tools/call', {
  raw: JSON.stringify({ subjectType: 'user', subjectId: 'x', tool: 'fs.read', params: { path: big } }),
  headers: { 'content-type': 'application/json' },
}).catch((e) => ({ status: 0, text: String(e) }));
check('P-413', '11MB 请求体 → 413', bigRes.status === 413, `status=${bigRes.status}`);

// ---- P-02 环境缓存 ----
const e1 = await req('GET', '/environments?refresh=1');
const e2 = await req('GET', '/environments');
check('P-02', '环境探针命中缓存', e2.ms < 100, `first=${Math.round(e1.ms)}ms second=${Math.round(e2.ms)}ms`);

// ---- C-08 MCP GET ----
const mcpGet = await req('GET', '/mcp');
check('C-08', 'GET /mcp 无 SSE Accept → 405', mcpGet.status === 405, `status=${mcpGet.status}`);

// ---- C-03 GBK ----
if (appPort) {
  const gbk = `${appPort.root_path.replace(/\\/g, '/')}/gbk-verify.txt`;
  const fs = await import('node:fs');
  fs.writeFileSync(gbk, Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  const r = await req('GET', `/workspace/file?filePath=${encodeURIComponent(gbk)}`);
  check('C-03', 'GBK 文件按 GBK 解码', r.json?.encoding === 'gbk' && r.json?.content === '中文', `encoding=${r.json?.encoding} content=${r.json?.content}`);
  fs.rmSync(gbk, { force: true });
}

// ---- P-03 无端口服务启动耗时 ----
async function startTimed(pid) {
  const t0 = performance.now();
  const r = await req('POST', `/projects/${pid}/autostart`);
  let j = null;
  while (performance.now() - t0 < 60_000) {
    const g = await req('GET', `/autostart/${r.json?.jobId}`);
    j = g.json;
    if (j && ['Success', 'Failed', 'Cancelled'].includes(j.status)) break;
    await sleep(80);
  }
  return { ms: Math.round(performance.now() - t0), status: j?.status, steps: (j?.steps ?? []).map((s) => s.message) };
}
if (daemon) {
  const s = await startTimed(daemon.id);
  check('P-03', '无端口常驻服务启动 < 2500ms', s.status === 'Success' && s.ms < 2500, `${s.ms}ms status=${s.status}`);
  await req('POST', `/projects/${daemon.id}/stop`);
}

// ---- 汇总 ----
const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} PASSED ===`);
if (failed.length) {
  for (const f of failed) console.log('  ✗', f.id, f.name, f.detail);
  process.exitCode = 1;
}
