/**
 * DevPilot 兼容性测试（隔离实例 37150）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const req = createRequire('C:/Users/administer/WorkBuddy/DevPilot/apps/backend/package.json');
const Database = req('better-sqlite3');
const BASE = 'http://127.0.0.1:37150/api/v1';
const DB = 'C:/Users/administer/WorkBuddy/DevPilot/.audit-qa/data/devpilot.db';
const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];

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
  return { status: res.status, json, text, ms: Math.round(performance.now() - t0) };
}
const rec = (o) => { out.push(o); console.log(JSON.stringify(o)); };

async function importFolder(ref) {
  const r = await call('POST', '/projects/import/unified', { source: 'folder', ref: ref.replace(/\\/g, '/') });
  const jobId = r.json?.jobId;
  const t0 = Date.now();
  let job = null;
  while (Date.now() - t0 < 60_000) {
    const g = await call('GET', `/projects/import/unified/${jobId}`);
    job = g.json;
    if (job && ['done', 'failed', 'error', 'Success', 'Failed', 'Cancelled'].includes(String(job.status))) break;
    await sleep(150);
  }
  const list = await call('GET', '/projects');
  return { job, project: (list.json ?? []).find((p) => p.root_path === path.resolve(ref).replace(/\\/g, '\\')) ?? (list.json ?? []).find((p) => (p.name ?? '').includes(path.basename(ref))) };
}

// ---------- 环境矩阵 ----------
const ver = {
  os: process.platform + ' ' + (process.getSystemVersion?.() ?? ''),
  node: process.version,
  npm: (() => { try { return execSync('npm -v', { windowsHide: true }).toString().trim(); } catch { return null; } })(),
  pnpm: (() => { try { return execSync('pnpm -v', { windowsHide: true }).toString().trim(); } catch { return null; } })(),
};
try { ver.electron = req('electron/package.json').version; } catch { ver.electron = null; }
rec({ case: '环境矩阵', ...ver });

// ---------- C1 中文 + 空格路径 ----------
const cnDir = path.join(FIX, '中文 项目 测试');
fs.mkdirSync(cnDir, { recursive: true });
fs.writeFileSync(path.join(cnDir, 'package.json'), JSON.stringify({ name: 'cn-app', version: '1.0.0', scripts: { dev: 'node server.cjs' } }, null, 2));
fs.writeFileSync(path.join(cnDir, 'server.cjs'), "const http=require('node:http');http.createServer((q,s)=>s.end('cn ok')).listen(4214,'127.0.0.1',()=>console.log('cn app up'));\n");
fs.mkdirSync(path.join(cnDir, 'node_modules'), { recursive: true });
const cn = await importFolder(cnDir);
rec({ case: 'C1 中文+空格路径导入', jobStatus: cn.job?.status, projectId: cn.project?.id, name: cn.project?.name, rootPath: cn.project?.root_path });

if (cn.project) {
  const db = new Database(DB);
  db.prepare('UPDATE project_services SET port = 4214 WHERE project_id = ?').run(cn.project.id);
  db.close();
  const t0 = performance.now();
  const s = await call('POST', `/projects/${cn.project.id}/autostart`);
  const jobId = s.json?.jobId;
  let job = null;
  while (performance.now() - t0 < 60_000) {
    job = (await call('GET', `/autostart/${jobId}`)).json;
    if (job && ['Success', 'Failed', 'Cancelled'].includes(job.status)) break;
    await sleep(100);
  }
  rec({ case: 'C1 中文路径启动', status: job?.status, ms: Math.round(performance.now() - t0), report: String(job?.report ?? '').slice(0, 120) });
  const probe = await fetch('http://127.0.0.1:4214/').then((r) => r.text()).catch((e) => 'ERR ' + e.message);
  rec({ case: 'C1 端口探活', response: probe.slice(0, 40) });
  // 工作区读中文路径
  const wd = await call('GET', `/workspace/dir?dirPath=${encodeURIComponent(cnDir)}`);
  rec({ case: 'C1 工作区列中文路径', status: wd.status, entries: (wd.json?.entries ?? []).length });
  await call('POST', `/projects/${cn.project.id}/stop`);
}

// ---------- C2 端口冲突 ----------
const conflictDir = path.join(FIX, 'app-conflict');
fs.mkdirSync(path.join(conflictDir, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(conflictDir, 'package.json'), JSON.stringify({ name: 'conflict-app', version: '1.0.0', scripts: { dev: 'node server.cjs' } }, null, 2));
fs.writeFileSync(path.join(conflictDir, 'server.cjs'), "const http=require('node:http');http.createServer((q,s)=>s.end('conflict ok')).listen(4215,'127.0.0.1');\n");
const cf = await importFolder(conflictDir);
const occupier = spawn(process.execPath, ['-e', "require('node:http').createServer((q,s)=>s.end('squatter')).listen(4215,'127.0.0.1',()=>console.log('squatter up'))"], { windowsHide: true, stdio: 'ignore' });
await sleep(1200);
if (cf.project) {
  const db = new Database(DB);
  db.prepare('UPDATE project_services SET port = 4215 WHERE project_id = ?').run(cf.project.id);
  db.close();
  const t0 = performance.now();
  const s = await call('POST', `/projects/${cf.project.id}/autostart`);
  const jobId = s.json?.jobId;
  let job = null;
  while (performance.now() - t0 < 90_000) {
    job = (await call('GET', `/autostart/${jobId}`)).json;
    if (job && ['Success', 'Failed', 'Cancelled'].includes(job.status)) break;
    await sleep(120);
  }
  rec({
    case: 'C2 端口被占用时启动',
    status: job?.status,
    ms: Math.round(performance.now() - t0),
    occupierAlive: occupier.exitCode === null,
    report: String(job?.report ?? '').slice(0, 200),
    steps: (job?.steps ?? []).map((x) => x.message.slice(0, 80)),
  });
  await call('POST', `/projects/${cf.project.id}/stop`);
}
try { occupier.kill(); } catch {}

// ---------- C3 同项目并发重复启动 ----------
const list = await call('GET', '/projects');
const target = (list.json ?? []).find((p) => (p.name ?? '').includes('app-port'));
if (target) {
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => call('POST', `/projects/${target.id}/autostart`)));
  const jobIds = rs.map((r) => r.json?.jobId);
  rec({ case: 'C3 同项目 5 次并发启动', uniqueJobIds: new Set(jobIds).size, jobIds, statuses: rs.map((r) => r.status) });
  await sleep(3000);
  for (const id of new Set(jobIds)) {
    const j = (await call('GET', `/autostart/${id}`)).json;
    rec({ case: 'C3 任务状态', jobId: id, status: j?.status, attempt: j?.attempt });
  }
  await call('POST', `/projects/${target.id}/stop`);
}

// ---------- C4 启动命令不存在 ----------
const badDir = path.join(FIX, 'app-badcmd');
fs.mkdirSync(badDir, { recursive: true });
fs.writeFileSync(path.join(badDir, 'package.json'), JSON.stringify({ name: 'bad-cmd-app', version: '1.0.0' }, null, 2));
const bad = await importFolder(badDir);
const bp = (await call('GET', '/projects')).json?.find((p) => p.root_path === path.resolve(badDir));
if (bp) {
  await call('POST', `/projects/${bp.id}/services`, { name: 'bad', start_command: 'devpilot-no-such-command --version', port: null });
  const t0 = performance.now();
  const s = await call('POST', `/projects/${bp.id}/autostart`);
  const jobId = s.json?.jobId;
  let job = null;
  while (performance.now() - t0 < 120_000) {
    job = (await call('GET', `/autostart/${jobId}`)).json;
    if (job && ['Success', 'Failed', 'Cancelled'].includes(job.status)) break;
    await sleep(200);
  }
  rec({
    case: 'C4 启动命令不存在',
    status: job?.status,
    ms: Math.round(performance.now() - t0),
    report: String(job?.report ?? '').slice(0, 220),
    steps: (job?.steps ?? []).slice(-3).map((x) => ({ phase: x.phase, msg: x.message.slice(0, 90) })),
  });
}

// ---------- C5 超长路径（>260） ----------
let deep = FIX;
for (let i = 0; i < 10; i++) deep = path.join(deep, 'deepsegment_' + 'x'.repeat(18) + i);
try {
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'package.json'), JSON.stringify({ name: 'deep-app', version: '1.0.0' }, null, 2));
  rec({ case: 'C5 超长路径创建', ok: true, len: deep.length });
  const d = await importFolder(deep);
  rec({ case: 'C5 超长路径导入', ok: d.job?.status === 'done', jobStatus: d.job?.status, error: String(d.job?.error ?? '').slice(0, 160), projectId: d.project?.id });
} catch (e) {
  rec({ case: 'C5 超长路径创建', ok: false, error: String(e).slice(0, 160), len: deep.length });
}

// ---------- C6 二进制 / GBK 文件读取 ----------
const binSrc = process.execPath;
const gbkFile = path.join(FIX, 'app-port', 'gbk.txt');
try { fs.writeFileSync(gbkFile, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a])); } catch {}
const readBin = await call('GET', `/workspace/file?filePath=${encodeURIComponent(binSrc)}`);
rec({ case: 'C6 读二进制文件(系统 node.exe)', status: readBin.status, note: '预期 400（超出项目/大小限制）', snippet: readBin.text.slice(0, 100) });
const readGbk = await call('GET', `/workspace/file?filePath=${encodeURIComponent(gbkFile)}`);
rec({ case: 'C6 读 GBK 文件', status: readGbk.status, content: JSON.stringify((readGbk.json?.content ?? '').slice(0, 12)), note: 'UTF-8 解码 GBK 会乱码' });

// ---------- C7 只读文件写入 ----------
const roFile = path.join(FIX, 'app-port', 'readonly.txt');
fs.writeFileSync(roFile, 'origin');
try { execSync(`attrib +R "${roFile}"`, { windowsHide: true }); } catch {}
const wr = await call('POST', '/workspace/file', { filePath: roFile, content: 'changed' });
rec({ case: 'C7 写只读文件', status: wr.status, body: wr.text.slice(0, 160), fileNow: fs.readFileSync(roFile, 'utf-8') });
try { execSync(`attrib -R "${roFile}"`, { windowsHide: true }); } catch {}

// ---------- C8 超大文件写入（>2MB 读取限制；写入无限制） ----------
const bigContent = 'x'.repeat(3 * 1024 * 1024);
const bigWrite = await call('POST', '/workspace/file', { filePath: path.join(FIX, 'app-port', 'big.txt'), content: bigContent }, 60_000);
const bigRead = await call('GET', `/workspace/file?filePath=${encodeURIComponent(path.join(FIX, 'app-port', 'big.txt'))}`);
rec({ case: 'C8 写入 3MB 文件', writeStatus: bigWrite.status, writeOk: bigWrite.json?.ok, readStatus: bigRead.status, readSnippet: bigRead.text.slice(0, 100) });

// ---------- C9 CRLF / BOM ----------
const crlf = path.join(FIX, 'app-port', 'crlf.txt');
fs.writeFileSync(crlf, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('line1\r\nline2\r\n')]));
const readCrlf = await call('GET', `/workspace/file?filePath=${encodeURIComponent(crlf)}`);
rec({ case: 'C9 BOM+CRLF 读取', status: readCrlf.status, content: JSON.stringify((readCrlf.json?.content ?? '').slice(0, 20)) });

fs.writeFileSync(path.join(here, 'compat-result.json'), JSON.stringify({ env: ver, out }, null, 2));
console.log('\n=== compat-result.json 已写入，用例 ' + out.length + ' ===');
