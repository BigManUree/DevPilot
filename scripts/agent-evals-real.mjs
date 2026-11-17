/**
 * Agent 真实 LLM 评估脚本（任务书 §4.4「真实 LLM 测试」档，可选运行）。
 *
 * 前提：
 *   1. 后端已运行（DEVIPILOT_API，默认 http://127.0.0.1:37100/api/v1）
 *   2. 已在 DevPilot 设置中配置真实模型 Key（DeepSeek 等）
 *   3. 真实 LLM 调用会产生费用——本脚本不会在日常单元测试中运行，仅手工执行
 *
 * 用法：
 *   node scripts/agent-evals-real.mjs [--api http://...] [--scenario S01,S04] [--keep]
 *
 * 流程：为每个场景生成隔离故障项目 → 导入 → 创建 Agent 任务（真实 LLM）→ 轮询任务至终态
 *      → 验证修复结果（HTTP/文件检查）→ 输出 JSON 报告（docs/reports/agent-evals-real.json）
 * 不将本脚本结果混入单元测试统计；运行与否不影响任何测试通过标准。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
const API = opt('--api', process.env.DEVIPILOT_API ?? 'http://127.0.0.1:37100/api/v1');
const only = opt('--scenario', null);
const keep = args.includes('--keep');
const WORK = 'C:/Users/administer/WorkBuddy/DevPilot/.audit-e2e/agent-evals';
const j = async (url, opts) => (await fetch(`${API}${url}`, opts)).json();
const POST = (url, body) => j(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function httpGetText(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, timeout: 4000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** 场景定义：每个都是真实可运行的故障项目（真实 LLM 需要真实证据） */
function scenarioFixtures() {
  return [
    {
      id: 'S01', name: 'Node 模块缺失',
      files: {
        'package.json': JSON.stringify({ name: 'eval-s01', scripts: { start: 'node server.js' }, dependencies: { express: '^4.19.0' } }),
        // 代码正确但 node_modules 缺失 → 首次启动 require 失败
        'server.js': `const express=require('express');const app=express();app.get('/',(_q,r)=>r.send('eval-ok'));app.listen(19161,()=>console.log('up 19161'));`,
      },
      verify: async () => (await httpGetText('http://127.0.0.1:19161/'))?.includes('eval-ok'),
      goal: '帮我把这个项目运行起来并验证可用（HTTP 127.0.0.1:19161 返回 eval-ok 即成功）',
    },
    {
      id: 'S04', name: '端口被占用',
      files: {
        'package.json': JSON.stringify({ name: 'eval-s04', scripts: { start: 'node server.js' } }),
        // 启动时端口 19162 已被占（由 setup 起一个占用进程）→ Agent 需识别并改端口或提示
        'server.js': `const http=require('node:http');http.createServer((_q,r)=>r.end('eval-ok')).listen(Number(process.env.PORT||19162),()=>console.log('up',process.env.PORT||19162));`,
      },
      before: async () => {
        // 占用 19162
        fs.mkdirSync(WORK, { recursive: true });
        fs.writeFileSync(path.join(WORK, 'occupier-19162.js'), "require('node:http').createServer((_q,r)=>r.end('occupied')).listen(19162)");
        const { spawn } = await import('node:child_process');
        globalThis.__occ = spawn('node', [path.join(WORK, 'occupier-19162.js')], { stdio: 'ignore' });
        await sleep(800);
      },
      verify: async () => (await httpGetText('http://127.0.0.1:19163/'))?.includes('eval-ok'),
      goal: '端口 19162 被其它进程占用了，请诊断并让项目在其它可用端口上运行（PORT 环境变量可覆盖），验证可用。',
    },
    {
      id: 'S07', name: 'Python 模块缺失',
      files: {
        'requirements.txt': 'flask\n',
        'app.py': `from flask import Flask\napp=Flask(__name__)\n@app.route('/')\ndef index():\n    return 'eval-ok'\nif __name__=='__main__':\n    app.run(host='127.0.0.1', port=19164)\n`,
      },
      verify: async () => (await httpGetText('http://127.0.0.1:19164/'))?.includes('eval-ok'),
      goal: '帮我把这个 Python Flask 项目运行起来并验证 HTTP 127.0.0.1:19164 返回 eval-ok。',
    },
  ];
}

async function importFolder(dir, name) {
  const r = await POST('/projects/import/unified', { source: 'folder', ref: dir, name });
  for (let i = 0; i < 60; i++) {
    const job = await j(`/projects/import/unified/${r.jobId}`);
    if (job.status === 'done') return job.project_id;
    if (job.status === 'failed') throw new Error(`导入失败: ${job.error}`);
    await sleep(500);
  }
  throw new Error('导入超时');
}

async function runScenario(s) {
  const dir = path.join(WORK, s.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, content] of Object.entries(s.files)) fs.writeFileSync(path.join(dir, f), content);
  if (s.before) await s.before();
  const projectId = await importFolder(dir, `agent-eval-${s.id}`);
  const task = await POST('/tasks', { goal: s.goal, projectId });
  const t0 = Date.now();
  const run = await POST(`/tasks/${task.taskId}/run`);
  // 轮询至终态（WaitingApproval 会由用户在 UI 批准——脚本记录该状态后终止该场景）
  let status = run.status ?? 'Unknown';
  for (let i = 0; i < 120; i++) {
    const t = await j(`/tasks/${task.taskId}`);
    status = t.task.status;
    if (['Completed', 'Failed', 'Cancelled'].includes(status)) break;
    if (status === 'WaitingApproval') break; // 需人工批准，记录为「需人工干预」
    await sleep(2000);
  }
  const verified = status === 'Completed' ? !!(await s.verify()) : false;
  const detail = await j(`/tasks/${task.taskId}`);
  results.push({
    id: s.id,
    name: s.name,
    status,
    verified,
    durationSec: Math.round((Date.now() - t0) / 1000),
    toolCalls: (detail.checkpoints ?? []).length,
    needsHuman: status === 'WaitingApproval',
    summary: detail.task.result_summary ?? null,
  });
  console.log(`[${s.id}] ${s.name}: status=${status} verified=${verified}`);
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
}

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  const sts = await j('/models/status');
  if (!sts.configured) {
    console.error('未配置真实模型 Key。真实 LLM 评估需要先在设置页配置（本脚本不做 Mock 伪造）。');
    process.exit(2);
  }
  let scenarios = scenarioFixtures();
  if (only) scenarios = scenarios.filter((s) => only.split(',').includes(s.id));
  for (const s of scenarios) {
    try { await runScenario(s); } catch (e) { results.push({ id: s.id, name: s.name, status: 'Error', verified: false, error: String(e).slice(0, 200) }); }
    finally { if (globalThis.__occ) { try { globalThis.__occ.kill(); } catch { /* ignore */ } } }
  }
  fs.mkdirSync('C:/Users/administer/WorkBuddy/DevPilot/docs/reports', { recursive: true });
  fs.writeFileSync('C:/Users/administer/WorkBuddy/DevPilot/docs/reports/agent-evals-real.json', JSON.stringify({ ranAt: new Date().toISOString(), mode: 'real-llm', results }, null, 2));
  console.log(`完成：${results.filter((r) => r.verified).length}/${results.length} 场景真实修复并验证通过。报告：docs/reports/agent-evals-real.json`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
