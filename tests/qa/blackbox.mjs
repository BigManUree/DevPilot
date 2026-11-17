/**
 * DevPilot 黑盒 / 接口测试（只读 + 非破坏性）
 * 用法: node .audit-qa/blackbox.mjs [baseUrl]
 * 输出: .audit-qa/blackbox-result.json + 控制台表格
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:37100/api/v1';
const outDir = path.dirname(fileURLToPath(import.meta.url));
const results = [];

async function req(name, method, url, { body, headers, expect, note, raw } = {}) {
  const t0 = performance.now();
  let status = 0, text = '', err = null, json = null;
  try {
    const res = await fetch(url.startsWith('http') ? url : BASE + url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers || {}) },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    status = res.status;
    text = await res.text();
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  } catch (e) {
    err = String(e?.cause?.code || e?.message || e);
  }
  const ms = Math.round(performance.now() - t0);
  const snippet = (text || '').replace(/\s+/g, ' ').slice(0, 160);
  const r = { name, method, url, status, ms, expect, note: note ?? null, error: err, snippet };
  results.push(r);
  const flag = expect === undefined ? '' : checkExpect(status, expect) ? 'OK  ' : 'FAIL';
  console.log(`${flag} ${String(status).padEnd(4)} ${String(ms).padStart(5)}ms ${method.padEnd(6)} ${url}${note ? '  // ' + note : ''}${err ? '  ERR=' + err : ''}`);
  return { status, json, text, ms };
}

function checkExpect(status, expect) {
  if (Array.isArray(expect)) return expect.includes(status);
  if (typeof expect === 'string' && expect.startsWith('>=')) return status >= Number(expect.slice(1));
  return status === expect;
}

const j = (o) => JSON.stringify(o);

// ---------- 0. 健康 ----------
await req('健康检查', 'GET', '/health', { expect: 200 });
await req('系统数据状态', 'GET', '/system/data-status', { expect: 200 });
await req('更新检查', 'GET', '/system/update-check', { expect: 200 });
await req('盘符/目录列举', 'GET', '/system/fs/dirs', { expect: 200 });
await req('目录列举-不存在', 'GET', '/system/fs/dirs?path=Z%3A%5Cno-such-dir', { expect: 200, note: '返回 error 字段而非 4xx' });

// ---------- 1. 项目域 ----------
const projList = await req('项目列表', 'GET', '/projects', { expect: 200 });
const projects = Array.isArray(projList.json) ? projList.json : [];
const P0 = projects[0];
console.log(`     └ 项目数=${projects.length}${P0 ? ' 样本=' + P0.id + ' (' + P0.name + ')' : ''}`);
if (P0) {
  await req('项目详情', 'GET', `/projects/${P0.id}`, { expect: 200 });
  await req('项目组件档案', 'GET', `/projects/${P0.id}/profile`, { expect: 200 });
  await req('项目运行档案', 'GET', `/projects/${P0.id}/archives`, { expect: 200 });
  await req('项目图标', 'GET', `/projects/${P0.id}/icon`, { expect: 200 });
  await req('项目启动脚本探测', 'GET', `/projects/${P0.id}/launcher`, { expect: 200 });
  await req('项目 autostart 状态', 'GET', `/projects/${P0.id}/autostart`, { expect: [200, 404] });
}
await req('项目详情-不存在ID', 'GET', '/projects/00000000-0000-0000-0000-000000000000', { expect: [404, 400, 500], note: '期望 404' });
await req('项目详情-非法ID串', 'GET', '/projects/not-a-uuid', { expect: [404, 400, 500] });
await req('扫描候选目录-缺参', 'GET', '/projects/scan-candidates', { expect: [200, 400] });
await req('扫描候选目录-不存在路径', 'GET', '/projects/scan-candidates?dir=Z%3A%5Cno-such', { expect: [200, 400, 500] });

// ---------- 2. 运行域 ----------
await req('运行会话列表', 'GET', '/runtime/sessions', { expect: 200 });
await req('受管进程列表', 'GET', '/runtime/tracked', { expect: 200 });
await req('autostart 任务-不存在', 'GET', '/autostart/00000000-0000-0000-0000-000000000000', { expect: [404, 200], note: '期望 404' });
await req('停止项目-不存在ID', 'POST', '/projects/00000000-0000-0000-0000-000000000000/stop', { expect: [404, 400, 200] });
await req('启动服务-不存在ID', 'POST', '/services/00000000-0000-0000-0000-000000000000/start', { expect: [404, 400, 500] });
await req('服务终端-不存在ID', 'POST', '/services/00000000-0000-0000-0000-000000000000/terminal', { expect: [404, 400, 500] });

// ---------- 3. Agent / 模型 / 任务 ----------
await req('Agent 列表', 'GET', '/agents', { expect: 200 });
await req('工具列表', 'GET', '/tools', { expect: 200 });
await req('模型供应商', 'GET', '/models/providers', { expect: 200 });
await req('模型状态', 'GET', '/models/status', { expect: 200 });
await req('任务列表', 'GET', '/tasks', { expect: 200 });
await req('任务详情-不存在', 'GET', '/tasks/00000000-0000-0000-0000-000000000000', { expect: [404, 500] });
await req('任务取消-不存在', 'POST', '/tasks/00000000-0000-0000-0000-000000000000/cancel', { expect: [404, 500, 200] });
await req('创建任务-空体', 'POST', '/tasks', { body: {}, expect: [400, 422, 500], note: '期望 400 而非 500' });
await req('模型切换-非法供应商', 'POST', '/models/switch', { body: { provider: 'no-such-provider' }, expect: [400, 500, 200] });

// ---------- 4. 日志 / 通知 ----------
await req('日志查询', 'GET', '/logs?limit=5', { expect: 200 });
await req('日志查询-limit非数字', 'GET', '/logs?limit=abc', { expect: [400, 200], note: 'NaN 进 SQL 会 500' });
await req('日志查询-limit负数', 'GET', '/logs?limit=-1', { expect: [200, 400] });
await req('日志查询-limit超大', 'GET', '/logs?limit=999999999', { expect: [200, 400] });
await req('日志查询-注入串', 'GET', "/logs?level='%20OR%201%3D1--", { expect: 200, note: 'SQL 注入探针' });
await req('日志 tail', 'GET', '/logs/tail?sourceModule=runtime&lines=20', { expect: 200 });
await req('日志 tail-路径穿越', 'GET', '/logs/tail?sourceModule=..%2F..%2F..%2Fwindows%2Fwin.ini', { expect: [200, 400], note: '文件名清洗验证' });
await req('通知列表', 'GET', '/notifications?limit=5', { expect: 200 });
await req('未读数', 'GET', '/notifications/unread-count', { expect: 200 });
await req('通知规则', 'GET', '/notifications/rules', { expect: 200 });
await req('通知已读-不存在ID', 'POST', '/notifications/00000000-0000-0000-0000-000000000000/read', { expect: [404, 200, 500] });
await req('批量删除-空数组', 'POST', '/notifications/delete-batch', { body: { ids: [] }, expect: [200, 400, 500] });
await req('批量删除-非数组', 'POST', '/notifications/delete-batch', { body: { ids: 'abc' }, expect: [400, 500] });

// ---------- 5. 权限 / 审批 / 审计 ----------
await req('审批列表', 'GET', '/approvals', { expect: 200 });
await req('权限列表', 'GET', '/permissions', { expect: 200 });
await req('审批模式', 'GET', '/permissions/mode', { expect: 200 });
await req('审计列表', 'GET', '/audit?limit=5', { expect: 200 });
await req('审计-limit非数字', 'GET', '/audit?limit=abc', { expect: [200, 400] });
await req('审批-不存在ID', 'POST', '/approvals/00000000-0000-0000-0000-000000000000/approve', { expect: [404, 500] });
await req('工具调用-未知工具', 'POST', '/tools/call', { body: { subjectType: 'user', subjectId: 'qa', tool: 'no.such.tool', params: {} }, expect: [400, 500] });
await req('工具调用-缺参数', 'POST', '/tools/call', { body: {}, expect: [400, 500] });

// ---------- 6. 环境 / 配置中心 / 记忆 ----------
await req('环境探针', 'GET', '/environments', { expect: 200 });
await req('版本扫描', 'GET', '/environments/scan-versions', { expect: 200 });
if (P0) {
  await req('项目环境体检', 'GET', `/environments/check/${P0.id}`, { expect: 200 });
  await req('项目环境版本匹配', 'GET', `/environments/match/${P0.id}`, { expect: 200 });
  await req('项目服务清单', 'GET', `/environments/services/${P0.id}`, { expect: 200 });
  await req('项目环境变量', 'GET', `/environments/env-vars/${P0.id}`, { expect: 200 });
  await req('配置档案列表', 'GET', `/config-center/profiles?projectId=${P0.id}`, { expect: 200 });
}
await req('配置档案-不存在项目', 'GET', '/config-center/profiles?projectId=no-such', { expect: [200, 404] });
await req('记忆列表', 'GET', '/memories?limit=5', { expect: 200 });
await req('记忆检索', 'GET', '/memories/search?q=runtime', { expect: 200 });
await req('记忆检索-limit非数字', 'GET', '/memories/search?q=a&limit=abc', { expect: [200, 400] });
await req('记忆详情-不存在', 'GET', '/memories/00000000-0000-0000-0000-000000000000', { expect: [200, 404], note: '实现返回 null' });

// ---------- 7. 数据库 / 本地服务 / 外部工具 / 插件 / 工作流 ----------
await req('数据库连接列表', 'GET', '/databases/connections', { expect: 200 });
await req('数据库探测', 'GET', '/databases/detect', { expect: 200 });
await req('本地服务列表', 'GET', '/local-services', { expect: 200 });
await req('外部工具探测', 'GET', '/external-tools', { expect: 200 });
await req('AVD 列表', 'GET', '/external-tools/avds', { expect: 200 });
await req('插件列表', 'GET', '/plugins', { expect: 200 });
await req('工作流列表', 'GET', '/workflows', { expect: 200 });
await req('工作流详情-不存在', 'GET', '/workflows/no-such-id', { expect: [404, 500] });
await req('备份列表', 'GET', '/backups', { expect: 200 });

// ---------- 8. 工作区（路径包含校验） ----------
const rootPath = P0?.root_path;
console.log(`     └ 工作区根=${rootPath}`);
await req('目录浏览-项目根', 'GET', `/workspace/dir?dirPath=${encodeURIComponent(rootPath)}`, { expect: 200 });
await req('目录浏览-穿越到上级', 'GET', `/workspace/dir?dirPath=${encodeURIComponent(path.resolve(rootPath, '..'))}`, { expect: [400], note: '必须拒绝' });
await req('目录浏览-系统目录', 'GET', '/workspace/dir?dirPath=C%3A%5CWindows', { expect: [400], note: '必须拒绝' });
await req('目录浏览-空参数', 'GET', '/workspace/dir', { expect: [400] });
await req('读文件-不存在', 'GET', `/workspace/file?filePath=${encodeURIComponent(path.join(rootPath, 'no-such-file.txt'))}`, { expect: [400, 404] });
await req('读文件-系统 hosts', 'GET', '/workspace/file?filePath=C%3A%5CWindows%5CSystem32%5Cdrivers%5Cetc%5Chosts', { expect: [400], note: '必须拒绝' });
await req('写文件-项目外', 'POST', '/workspace/file', { body: { filePath: 'C:/qa-escape.txt', content: 'x' }, expect: [400], note: '必须拒绝' });

// ---------- 9. Git ----------
if (P0) {
  const rp = P0.root_path;
  await req('Git status', 'GET', `/git/status?repoPath=${encodeURIComponent(rp)}`, { expect: [200, 400, 500] });
  await req('Git 仓库列表', 'GET', '/git/repos', { expect: 200 });
  await req('Git status-不存在路径', 'GET', '/git/status?repoPath=Z%3A%5Cno-such', { expect: [200, 400, 500] });
}

// ---------- 10. MCP ----------
await req('MCP GET', 'GET', '/mcp', { expect: [200, 405] });
await req('MCP initialize', 'POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, expect: 200 });
await req('MCP tools/list', 'POST', '/mcp', { body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, expect: 200 });
await req('MCP 未知方法', 'POST', '/mcp', { body: { jsonrpc: '2.0', id: 3, method: 'no/such', params: {} }, expect: [200, 400] });
await req('MCP 非法 JSON', 'POST', '/mcp', { raw: '{not json', headers: { 'content-type': 'application/json' }, expect: [400, 500] });

// ---------- 11. 异常 / 边界 / 协议 ----------
await req('未知路由', 'GET', '/no-such-endpoint', { expect: 404 });
await req('方法不允许(PUT projects)', 'PUT', '/projects', { body: {}, expect: [404, 405] });
await req('非法 JSON 体', 'POST', '/projects/scan-candidates', { raw: '{"a":', headers: { 'content-type': 'application/json' }, expect: [400, 500] });
await req('Content-Type 错误', 'POST', '/tasks', { raw: 'a=1', headers: { 'content-type': 'text/plain' }, expect: [400, 415, 500] });
await req('超大 body(11MB)', 'POST', '/tools/call', { raw: j({ subjectType: 'user', subjectId: 'qa', tool: 'fs.read', params: { path: 'x'.repeat(11 * 1024 * 1024) } }), expect: [413, 400] });
await req('CORS 预检-允许源', 'OPTIONS', '/projects', { headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' }, expect: [204, 200] });
await req('CORS 预检-恶意源', 'OPTIONS', '/projects', { headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' }, expect: [204, 200], note: '应无 ACAO 头' });

// ---------- 12. 安全探针（非破坏） ----------
await req('SQL 注入-项目ID', 'GET', "/projects/1'%20OR%20'1'%3D'1", { expect: [404, 400, 500] });
await req('XSS 反射-项目名', 'POST', '/notifications', { body: { type: 'qa.xss', title: '<img src=x onerror=alert(1)>', content: '<script>alert(1)</script>' }, expect: [200, 201, 400] });
await req('原型污染体', 'POST', '/memories', { body: { scope: 'global', content: 'x', __proto__: { polluted: true } }, expect: [200, 400] });
await req('记忆 scope 非法', 'POST', '/memories', { body: { scope: 'bogus', content: 'x' }, expect: [400], note: '实现抛 Error→500' });
await req('SSRF-内网地址导入', 'POST', '/projects/import/unified', { body: { source: 'http', ref: 'http://127.0.0.1:37100/api/v1/health' }, expect: [200, 201, 400, 403] });
await req('SSRF-云元数据', 'POST', '/projects/import/unified', { body: { source: 'http', ref: 'http://169.254.169.254/latest/meta-data/' }, expect: [200, 201, 400, 403] });
await req('SSRF-非 http 协议', 'POST', '/projects/import/unified', { body: { source: 'http', ref: 'file:///C:/Windows/win.ini' }, expect: [400, 200] });
await req('导入-非法 source', 'POST', '/projects/import/unified', { body: { source: 'bogus', ref: 'x' }, expect: [400, 500] });
await req('导入-缺 ref', 'POST', '/projects/import/unified', { body: { source: 'folder' }, expect: [400, 500] });
await req('压缩包-ZIP Slip 探测(不存在)', 'POST', '/projects/import/unified', { body: { source: 'archive', ref: 'Z:/no-such.zip' }, expect: [200, 400, 500] });

const summary = {
  total: results.length,
  byStatus: results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {}),
  failedExpectation: results.filter((r) => r.expect !== undefined && !checkExpect(r.status, r.expect)).map((r) => ({
    name: r.name, method: r.method, url: r.url, status: r.status, expect: r.expect, snippet: r.snippet,
  })),
  serverErrors: results.filter((r) => r.status >= 500).map((r) => ({ name: r.name, url: r.url, snippet: r.snippet })),
};
fs.writeFileSync(path.join(outDir, 'blackbox-result.json'), JSON.stringify({ base: BASE, at: new Date().toISOString(), summary, results }, null, 2));
console.log('\n=== 汇总 ===');
console.log(JSON.stringify(summary.byStatus));
console.log(`5xx 用例: ${summary.serverErrors.length}`);
for (const s of summary.serverErrors) console.log('  500 →', s.name, s.url, '|', s.snippet.slice(0, 90));
console.log(`期望不符: ${summary.failedExpectation.length}`);
for (const f of summary.failedExpectation) console.log('  ✗', f.name, f.method, f.url, `status=${f.status} expect=${f.expect}`);
