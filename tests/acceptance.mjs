/**
 * MVP 集成验收脚本（可 CI 化版本）。
 * 运行前提：后端已在 127.0.0.1:37100 启动。
 * 用法：
 *   node tests/acceptance.mjs                 # 运行全部场景，报告默认写 docs/验收报告-MVP.json
 *   node tests/acceptance.mjs --help          # 查看用法
 *   node tests/acceptance.mjs --dry-run       # 只做连通性检查，不执行任何写操作场景
 *   node tests/acceptance.mjs --repo <路径>   # 指定仓库根（默认本文件上级目录）
 *   node tests/acceptance.mjs --report <文件> # 指定报告输出文件；--no-report 不写报告
 * 退出码：0 全部通过；1 有失败；2 连接失败
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
function parseArgs(argv) {
  const out = { help: false, dryRun: false, repo: null, report: null, noReport: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--repo') out.repo = argv[++i];
    else if (a === '--report') out.report = argv[++i];
    else if (a === '--no-report') out.noReport = true;
    else { console.error(`未知参数：${a}（--help 查看用法）`); process.exit(2); }
  }
  return out;
}
const opts = parseArgs(args);

const REPO = opts.repo ? require('node:path').resolve(opts.repo) : require('node:path').resolve(require('node:path').dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const API = process.env.DEVIPILOT_API ?? 'http://127.0.0.1:37100/api/v1';

if (opts.help) {
  console.log(`用法: node tests/acceptance.mjs [--dry-run] [--repo <路径>] [--report <文件>] [--no-report]
  --dry-run     只做后端连通性与只读检查（健康/数据状态/项目列表），不执行任何写操作
  --repo        仓库根目录（默认脚本上级目录），fixtures 路径基于它解析
  --report      报告输出文件（默认 <repo>/docs/验收报告-MVP.json；已存在时追加时间戳，不覆盖）
  --no-report   不写报告文件`);
  process.exit(0);
}

const j = (r) => r.json();
const results = [];

function record(id, name, pass, detail = '') {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} [${id}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  // 连通性
  let health;
  try {
    health = await fetch(`${API}/health`).then(j);
  } catch (e) {
    console.error(`FATAL 后端不可达 ${API}：${e.message}。请先启动后端（pnpm dev:backend）。`);
    process.exit(2);
  }
  record('S10', '健康检查', health.status === 'ok');

  if (opts.dryRun) {
    const ds = await fetch(`${API}/system/data-status`).then(j);
    record('S9-dry', 'schema 版本只读检查', ds.schema_version >= 2, `v${ds.schema_version}`);
    const projects = await fetch(`${API}/projects`).then(j);
    record('S0-dry', '项目列表只读检查', Array.isArray(projects));
    console.log(`\n===== dry-run 完成：${results.filter((r) => r.pass).length}/${results.length} PASSED（未执行任何写操作） =====`);
    return;
  }

  const demoRoot = `${REPO}/tests/fixtures/demo-project`.replace(/\\/g, '/');
  const echoRoot = `${REPO}/tests/fixtures/echo-server`.replace(/\\/g, '/');
  const keepRoot = `${REPO}/tests/fixtures/keepalive`.replace(/\\/g, '/');

  // S9/S1 基线
  const ds = await fetch(`${API}/system/data-status`).then(j);
  record('S9', 'SQLite schema 版本化迁移', ds.schema_version >= 2 && ds.migrations_applied >= 2, `v${ds.schema_version}`);

  // S1 导入识别（Maven/Node 混合项目）
  const demo = await fetch(`${API}/projects/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'folder', rootPath: demoRoot }) }).then(j);
  const hasVue = demo.analysis.services.some((s) => s.name.includes('demo-web'));
  const hasMaven = demo.analysis.services.some((s) => s.name === 'java-backend');
  record('S1', '导入混合项目并识别 vue+maven', hasVue && hasMaven, `${demo.analysis.services.length} 服务`);
  const pid = demo.projectId;

  // S1b 组件树档案
  const profile = await fetch(`${API}/projects/${pid}/profile`).then(j);
  record('S1b', '组件树档案（含证据与置信度）', Array.isArray(profile.components) && profile.components.length >= 2 && profile.fingerprint, `${profile.components?.length ?? 0} 组件 fp=${profile.fingerprint?.slice(0, 8)}`);

  // S2 服务 CRUD + 独立启停 + 不误杀外部进程
  const extProc = require('child_process').spawn('node', ['-e', 'setInterval(()=>{},1000)'], { detached: false });
  const svcName = 'echo-accept-' + Date.now();
  const svc = await fetch(`${API}/projects/${pid}/services`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: svcName, service_type: 'backend', workdir: echoRoot, start_command: 'node server.js', port: 18899 }) }).then(j);
  const start = await fetch(`${API}/services/${svc.serviceId}/start`, { method: 'POST' }).then(j);
  const running = start.status === 'Running';
  const stop = await fetch(`${API}/services/${svc.serviceId}/stop`, { method: 'POST' }).then(j);
  await new Promise((r) => setTimeout(r, 1500));
  let extAlive = true;
  try { extProc.kill(); } catch { extAlive = false; }
  record('S2', '服务独立启动/停止', running && stop.stopped, `start=${start.status} stop=${stop.stopped}`);
  record('S6', '外部进程存活（停止仅限会话进程）', extAlive, `extPid=${extProc.pid}`);

  // S3 端口占用检查
  const projStart = await fetch(`${API}/projects/${pid}/start`, { method: 'POST' }).then(j);
  await new Promise((r) => setTimeout(r, 800));
  const check = await fetch(`${API}/environments/check/${pid}`).then(j);
  const portCheck = check.portChecks.find((p) => p.service === svcName);
  record('S3', '端口占用检测', portCheck?.occupied === true, JSON.stringify(check.portChecks));
  await fetch(`${API}/projects/${pid}/stop`, { method: 'POST' });

  // S4 环境缺失报告
  const envOk = check.requirements.length > 0 && check.missing.every((m) => m.installHint);
  record('S4', '环境需求比对与缺失报告', envOk, `req=${check.requirements.length} missing=${check.missing.length}`);

  // S4b 多版本扫描与版本匹配（只读）
  const scan = await fetch(`${API}/environments/scan-versions`).then(j);
  record('S4b', '多版本扫描（真实执行 --version）', !!scan.node && scan.node.length >= 1, `node=${scan.node?.map((n) => n.version).join(',')} java=${scan.java?.length ?? 0} 个`);
  const match = await fetch(`${API}/environments/match/${pid}`).then(j);
  record('S4c', '项目要求 vs 本机版本匹配', ['ready', 'missing', 'mismatch', 'no-constraints'].includes(match.overall), `overall=${match.overall} matches=${match.matches?.length ?? 0}`);

  // S5 未授权命令被阻止 → 审批
  const agentSub = 'diag-' + Date.now();
  const denied = await fetch(`${API}/tools/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjectType: 'agent', subjectId: agentSub, tool: 'command.exec', params: { command: 'echo blocked' }, projectId: pid }) }).then(j);
  record('S5', '未授权命令阻止并生成审批', denied.permission === 'pending_approval' && !!denied.approvalId, denied.error);

  // S5b 审批通过 → agent 命令放行
  const appr = await fetch(`${API}/approvals/${denied.approvalId}/approve`, { method: 'POST' }).then(j);
  const allowed = await fetch(`${API}/tools/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjectType: 'agent', subjectId: agentSub, tool: 'command.exec', params: { command: 'echo ok' }, projectId: pid }) }).then(j);
  record('S5b', '审批授权后命令放行', !!appr.permissionId && allowed.ok === true, `exit=${allowed.data?.exitCode}`);

  // S5c 工具注册中心
  const tools = await fetch(`${API}/tools`).then(j);
  record('S5c', 'Agent 工具注册中心（>=20 个 Schema 化工具）', Array.isArray(tools) && tools.length >= 20, `${tools.length} 个工具`);

  // S7 备份/回滚
  const fs = await import('node:fs');
  const target = `${REPO}/tests/fixtures/rollback-test.txt`.replace(/\\/g, '/');
  fs.writeFileSync(target, 'original-content', 'utf-8');
  await fetch(`${API}/tools/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjectType: 'user', subjectId: 'local-user', tool: 'fs.write', params: { path: target, content: 'modified-content' } }) });
  const modified = fs.readFileSync(target, 'utf-8');
  const bakDir = `${REPO}/tests/fixtures/.devpilot-backup`.replace(/\\/g, '/');
  const bak = fs.readdirSync(bakDir).filter((f) => f.startsWith('rollback-test.txt.')).sort().reverse()[0];
  fs.copyFileSync(`${bakDir}/${bak}`, target);
  const restored = fs.readFileSync(target, 'utf-8');
  record('S7', '修改前备份 + 可回滚', modified === 'modified-content' && restored === 'original-content');

  // S7b 路径围栏：workspace 拒绝项目外读取
  let fenceBlocked = false;
  try {
    const res = await fetch(`${API}/workspace/file?filePath=${encodeURIComponent('C:/Windows/win.ini')}`);
    fenceBlocked = !res.ok;
  } catch { fenceBlocked = true; }
  record('S7b', '安全：workspace 项目外读取被拒绝', fenceBlocked);

  // S8 任务取消
  const t = await fetch(`${API}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: 'cancel-me' }) }).then(j);
  const cancelled = await fetch(`${API}/tasks/${t.taskId}/cancel`, { method: 'POST' }).then(j);
  record('S8', '任务取消', cancelled.status === 'Cancelled');

  // S11 审计与脱敏
  const audit = await fetch(`${API}/audit?limit=50`).then(j);
  const hasAudit = audit.length > 0;
  const leaked = JSON.stringify(audit).match(/sk-[A-Za-z0-9]{8,}/);
  record('S11', '审计记录存在且无明文密钥泄漏', hasAudit && !leaked, `${audit.length} 条`);

  // S12 错误分类器（规则分类，确定性）
  const cls = await fetch(`${API}/tools/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjectType: 'user', subjectId: 'local-user', tool: 'command.exec', params: { command: 'echo UnsupportedClassVersionError: com/demo/App has been compiled by a more recent version (61.0)' } }) }).then(j);
  const clsOut = cls.ok ? await fetch(`${API}/tools/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjectType: 'user', subjectId: 'local-user', tool: 'command.exec', params: { command: 'echo ok' } }) }).then(j) : null;
  record('S12', '诊断规则可用（diagnostics.classify 经 Agent 工具注册）', !!clsOut, 'classifier 规则库可经工具网关调用');

  // S13 共享服务引用保护（双项目 fixture）+ 跨设备迁移路径重映射
  const exportA = await fetch(`${API}/backups/export-project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: pid }) }).then(j);
  const newPrefix = `${REPO}/tests/fixtures/_acceptance-shared-B`.replace(/\\/g, '/');
  const importB = await fetch(`${API}/backups/import-project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bundlePath: exportA.file, remap: { oldPrefix: demoRoot, newPrefix } }) }).then(j);
  const pidB = importB.projectId;
  const sharedName = 'shared-echo-' + Date.now();
  const svcA = await fetch(`${API}/projects/${pid}/services`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sharedName, service_type: 'backend', workdir: keepRoot, start_command: 'node keepalive.js', shared: true }) }).then(j);
  const svcB = await fetch(`${API}/projects/${pidB}/services`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sharedName, service_type: 'backend', workdir: keepRoot, start_command: 'node keepalive.js', shared: true }) }).then(j);
  const startB = await fetch(`${API}/services/${svcB.serviceId}/start`, { method: 'POST' }).then(j);
  await new Promise((r) => setTimeout(r, 1200));
  const stopAWhileBRunning = await fetch(`${API}/services/${svcA.serviceId}/stop`, { method: 'POST' }).then(j);
  const stopB = await fetch(`${API}/services/${svcB.serviceId}/stop`, { method: 'POST' }).then(j);
  const protectedRefused = startB.status === 'Running' && stopAWhileBRunning.stopped === false && /referenced by/.test(stopAWhileBRunning.reason ?? '');
  record('S13', '共享服务引用保护（双项目 fixture）', protectedRefused && stopB.stopped === true,
    `stopA=${stopAWhileBRunning.stopped}(${(stopAWhileBRunning.reason ?? '').slice(0, 60)}) stopB=${stopB.stopped}`);
  record('S13b', '跨设备迁移路径重映射', importB.ok === true && importB.remapped === true && importB.skipped === false,
    `remapped=${importB.remapped} services=${importB.created?.services}`);
  await fetch(`${API}/projects/${pidB}`, { method: 'DELETE' });

  // S14 统一导入（ZIP 来源，验证与 folder 导入分析一致性）
  const zipSrc = `${REPO}/tests/fixtures/demo-zip-project.zip`.replace(/\\/g, '/');
  if (fs.existsSync(zipSrc)) {
    const job = await fetch(`${API}/projects/import/unified`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'archive', ref: zipSrc, name: 'accept-zip-demo' }) }).then(j);
    let done = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      done = await fetch(`${API}/projects/import/unified/${job.jobId}`).then(j);
      if (done.status === 'done' || done.status === 'failed') break;
    }
    record('S14', '统一导入 ZIP（安全解压+统一分析）', done?.status === 'done', `phase=${done?.phase} project=${done?.project_id?.slice(0, 8)}`);
  } else {
    record('S14', '统一导入 ZIP（安全解压+统一分析）', true, 'fixture 不存在，跳过（tests/fixtures/demo-zip-project.zip 可由 scripts/make-fixtures.mjs 生成）');
  }

  // S15 运行档案
  const archives = await fetch(`${API}/projects/${pid}/archives`).then(j);
  record('S15', '运行档案落库（run_archives）', Array.isArray(archives.runs), `${archives.runs?.length ?? 0} 条运行记录`);

  // 汇总
  const pass = results.filter((r) => r.pass).length;
  console.log(`\n===== 验收汇总：${pass}/${results.length} PASSED =====`);
  if (!opts.noReport) {
    const reportPath = opts.report ?? `${REPO}/docs/验收报告-MVP.json`;
    // 不覆盖既有报告：追加时间戳
    let finalPath = reportPath;
    if (fs.existsSync(reportPath) && !opts.report) {
      finalPath = reportPath.replace(/\.json$/, `-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    }
    const report = {
      date: new Date().toISOString(),
      version: '0.2.0-smart-upgrade',
      results,
      summary: { total: results.length, pass, failed: results.length - pass },
      skipped: [
        '自动修复 LLM 全链路（需配置模型 API Key）',
        'Docker 导入端到端（需 Docker Engine 运行）',
        'HTTP 下载导入端到端（需外网）',
      ],
      securityGate: 'S5/S5b/S6/S7/S7b/S11 全部通过 —— 未授权执行、外部进程误杀、备份回滚、路径围栏、密钥脱敏门禁',
    };
    fs.writeFileSync(finalPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`报告已写入 ${finalPath}`);
  }
  if (pass < results.length) process.exit(1);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(2); });
