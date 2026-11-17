import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { ToolGatewayService } from '../permissions/tool-gateway.service';
import { DatabaseService } from '../database/database.module';
import { EnvironmentService } from '../environments/environment.service';
import { RuntimeService } from '../runtime/runtime.service';
import { AutoFixerService } from '../runtime/auto-fixer.service';
import type { ToolDescriptor } from '@devpilot/shared-types';

/**
 * Agent 工具注册中心（升级任务书 §6.2）：
 * - Schema 化描述（输入/输出/权限/风险/超时/副作用）
 * - 全部真实执行：读 EnvironmentService/RuntimeService/ToolGateway，不返回预设 JSON
 * - 副作用工具一律经 ToolGateway（权限+审计）；只读工具直连后端服务
 */

export interface ToolCallCtx {
  projectId?: string;
  taskId?: string;
  executionId?: string;
  /** 执行主体（用于权限网关） */
  agentId?: string;
}

export interface ToolExecResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** 命令类工具的真实退出码 */
  exitCode?: number | null;
  /** true = 因权限不足挂起等审批（区别于普通失败） */
  pendingApproval?: boolean;
}

const TOOL_LIST: ToolDescriptor[] = [
  // 项目工具
  { name: 'project.inspect', title: '查看项目基本信息（路径/语言/框架/服务/组件树摘要）', inputSchema: { type: 'object', properties: {} }, outputHint: '项目元数据 JSON', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 10_000 },
  { name: 'project.get_profile', title: '读取项目组件树档案（技术栈/版本约束/环境变量/外部服务）', inputSchema: { type: 'object', properties: {} }, outputHint: 'ProjectProfile JSON', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 10_000 },
  { name: 'project.tree', title: '列出项目目录树（最多 2 层，自动忽略 node_modules/.git 等）', inputSchema: { type: 'object', properties: {} }, outputHint: '目录条目数组', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 10_000 },
  // 环境工具
  { name: 'env.scan_versions', title: '扫描本机全部已安装工具版本（真实执行 --version 验证）', inputSchema: { type: 'object', properties: {} }, outputHint: '各工具的版本列表', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 60_000 },
  { name: 'env.match', title: '项目要求版本 vs 本机多版本 匹配（含证据与建议）', inputSchema: { type: 'object', properties: {} }, outputHint: '逐组件匹配结果', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 120_000 },
  { name: 'env.check_vars', title: '检查项目缺失的环境变量（.env.example vs .env）', inputSchema: { type: 'object', properties: {} }, outputHint: '变量清单与缺失项', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 10_000 },
  { name: 'env.check_services', title: '外部服务探活（MySQL/Redis 等端口连通与进程识别）', inputSchema: { type: 'object', properties: {} }, outputHint: '服务状态数组', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 30_000 },
  // 文件工具
  { name: 'fs.read', title: '读文件（经权限网关）', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } }, outputHint: '文件内容（>1MB 截断）', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 10_000 },
  { name: 'fs.write', title: '写文件（原子写 + 自动备份，经权限网关，可能需要审批）', inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } }, outputHint: '写入结果', category: 'modify_project_config', risk: 'L2', sideEffects: true, timeoutMs: 10_000 },
  { name: 'fs.list', title: '列目录', inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } }, outputHint: '条目数组', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 10_000 },
  { name: 'fs.search', title: '在项目内按文件名或内容关键字搜索（最多 200 命中）', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, glob: { type: 'string' } } }, outputHint: '命中文件与行', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 30_000 },
  // 终端工具
  { name: 'terminal.exec', title: '在指定目录执行命令（真实 spawn，返回退出码/stdout/stderr；可能需要审批）', inputSchema: { type: 'object', required: ['command'], properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeoutMs: { type: 'number' } } }, outputHint: 'exitCode/stdout/stderr', category: 'command_execution', risk: 'L2', sideEffects: true, timeoutMs: 300_000 },
  // 运行工具
  { name: 'runtime.status', title: '查询项目各服务运行状态（真实 PID/端口）', inputSchema: { type: 'object', properties: {} }, outputHint: '服务状态数组', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 10_000 },
  { name: 'runtime.start', title: '启动指定服务（真实进程，可能需要审批）', inputSchema: { type: 'object', required: ['serviceId'], properties: { serviceId: { type: 'string' } } }, outputHint: 'status/pid/port', category: 'command_execution', risk: 'L2', sideEffects: true, timeoutMs: 120_000 },
  { name: 'runtime.stop', title: '停止指定服务', inputSchema: { type: 'object', required: ['serviceId'], properties: { serviceId: { type: 'string' } } }, outputHint: 'stopped', category: 'command_execution', risk: 'L2', sideEffects: true, timeoutMs: 30_000 },
  { name: 'runtime.logs', title: '读取服务最近运行日志（真实日志，非模拟）', inputSchema: { type: 'object', properties: { serviceId: { type: 'string' }, lines: { type: 'number' } } }, outputHint: '日志文本', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 15_000 },
  { name: 'runtime.health_check', title: '对服务端口做 TCP/HTTP 健康检查', inputSchema: { type: 'object', required: ['port'], properties: { port: { type: 'number' }, path: { type: 'string' } } }, outputHint: '健康检查结果', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 30_000 },
  // Docker 工具
  { name: 'docker.check', title: '检查 Docker Engine 可用性与版本', inputSchema: { type: 'object', properties: {} }, outputHint: 'docker version 输出', category: 'command_execution', risk: 'L0', sideEffects: false, timeoutMs: 15_000 },
  { name: 'docker.compose', title: '在项目目录执行 docker compose 子命令（up/down/ps/logs，up 需审批）', inputSchema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['up', 'down', 'ps', 'logs'] } } }, outputHint: '命令输出', category: 'command_execution', risk: 'L2', sideEffects: true, timeoutMs: 600_000 },
  // 诊断工具
  { name: 'diagnostics.classify', title: '对错误日志做规则分类（确定性，返回类别与证据）', inputSchema: { type: 'object', required: ['logText'], properties: { logText: { type: 'string' } } }, outputHint: '类别/置信度/证据', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 10_000 },
  { name: 'diagnostics.repair', title: '调用自动修复引擎（确定性预检 + 修复计划 + 白名单命令执行；修改类动作需审批）', inputSchema: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['analyze-start', 'repair'] }, logText: { type: 'string' } } }, outputHint: '修复动作与结果', category: 'auto_retry', risk: 'L2', sideEffects: true, timeoutMs: 600_000 },
  // 进程工具（用户口头任务如「杀掉 PID 20928」的受控通道）
  { name: 'process.list', title: '列出本机运行中的进程（name/pid/内存，可按关键字过滤，最多 200 条）', inputSchema: { type: 'object', properties: { filter: { type: 'string' } } }, outputHint: '进程数组', category: 'project_analysis', risk: 'L0', sideEffects: false, timeoutMs: 15_000 },
  { name: 'process.kill', title: '终止指定 PID 的进程（L3 高危：强制当次审批；先 process.list 确认目标，杀后返回验证证据）', inputSchema: { type: 'object', required: ['pid'], properties: { pid: { type: 'number' } } }, outputHint: '终止结果与验证', category: 'command_execution', risk: 'L3', sideEffects: true, timeoutMs: 30_000 },
];

export const TOOLS = TOOL_LIST;

@Injectable()
export class ToolRegistryService {
  constructor(
    private readonly ds: DatabaseService,
    private readonly gateway: ToolGatewayService,
    private readonly env: EnvironmentService,
    private readonly runtime: RuntimeService,
    private readonly fixer: AutoFixerService,
  ) {}

  descriptors(): ToolDescriptor[] {
    return TOOL_LIST;
  }

  /** 供 LLM 的紧凑工具说明 */
  describeForPrompt(): string {
    return TOOL_LIST.map((t) => `- ${t.name}: ${t.title}；入参 ${JSON.stringify(t.inputSchema.properties)}；输出 ${t.outputHint}；风险 ${t.risk}`).join('\n');
  }

  async execute(tool: string, params: Record<string, unknown>, ctx: ToolCallCtx): Promise<ToolExecResult> {
    const desc = TOOL_LIST.find((t) => t.name === tool);
    if (!desc) return { ok: false, error: `未知工具：${tool}` };

    try {
      switch (tool) {
        case 'project.inspect': {
          if (!ctx.projectId) return { ok: false, error: '需要项目上下文（projectId）' };
          const row = this.ds.db.prepare('SELECT id,name,root_path,language,framework,project_type,profile_hash,source_json FROM projects WHERE id=?').get(ctx.projectId);
          const services = this.gateway['ds'].db.prepare('SELECT id,name,service_type,port,status,start_command FROM project_services WHERE project_id=?').all(ctx.projectId);
          return { ok: !!row, data: { project: row, services } };
        }
        case 'project.get_profile': {
          const row = this.gateway['ds'].db.prepare('SELECT components_json FROM projects WHERE id=?').get(ctx.projectId) as { components_json: string | null } | undefined;
          if (!row?.components_json) return { ok: false, error: '项目无组件树档案，先调用 project.inspect 或让用户重新分析' };
          return { ok: true, data: JSON.parse(row.components_json) };
        }
        case 'project.tree': {
          const root = this.projectRoot(ctx.projectId);
          if (!root) return { ok: false, error: '需要项目上下文' };
          return { ok: true, data: this.tree(root, 2) };
        }
        case 'env.scan_versions': {
          const { scanAllVersions } = await import('../environments/version-scan');
          return { ok: true, data: await scanAllVersions() };
        }
        case 'env.match': {
          if (!ctx.projectId) return { ok: false, error: '需要项目上下文' };
          return { ok: true, data: await this.env.matchProject(ctx.projectId) };
        }
        case 'env.check_vars': {
          if (!ctx.projectId) return { ok: false, error: '需要项目上下文' };
          return { ok: true, data: await this.env.checkEnvVars(ctx.projectId) };
        }
        case 'env.check_services': {
          if (!ctx.projectId) return { ok: false, error: '需要项目上下文' };
          return { ok: true, data: await this.env.checkExternalServices(ctx.projectId) };
        }
        case 'fs.read':
        case 'fs.write': {
          const r = await this.gateway.call({ subjectType: 'agent', subjectId: ctx.agentId ?? 'supervisor', tool, params: params as Record<string, unknown>, projectId: ctx.projectId, taskId: ctx.taskId, executionId: ctx.executionId }, tool === 'fs.write' ? 'modify_project_config' : undefined);
          return { ok: r.ok, data: r.data, error: r.error, pendingApproval: r.permission === 'pending_approval' };
        }
        case 'fs.list': {
          const root = this.projectRoot(ctx.projectId);
          if (!root) return { ok: false, error: 'fs.list 需要项目上下文（不允许列出任意目录）' };
          const p = String(params.path ?? root);
          const safe = this.containToProject(p, root);
          if (!safe) return { ok: false, error: `路径不在项目内，拒绝访问：${p}` };
          const entries = fs.readdirSync(safe, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
          return { ok: true, data: entries.slice(0, 500) };
        }
        case 'fs.search': {
          const root = this.projectRoot(ctx.projectId);
          if (!root) return { ok: false, error: 'fs.search 需要项目上下文（不允许搜索任意目录）' };
          const requested = String(params.path ?? root);
          const safe = this.containToProject(requested, root);
          if (!safe) return { ok: false, error: `路径不在项目内，拒绝搜索：${requested}` };
          return { ok: true, data: this.searchFiles(safe, String(params.query), String(params.glob ?? '')) };
        }
        case 'terminal.exec': {
          const command = String(params.command);
          const cwd = String(params.cwd ?? this.projectRoot(ctx.projectId) ?? process.cwd());
          const timeoutMs = Number(params.timeoutMs ?? 120_000);
          const r = await this.gateway.call({ subjectType: 'agent', subjectId: ctx.agentId ?? 'supervisor', tool: 'command.exec', params: { command, cwd, timeoutMs }, projectId: ctx.projectId, taskId: ctx.taskId, executionId: ctx.executionId });
          const data = r.data as { exitCode?: number | null; stdout?: string; stderr?: string; timedOut?: boolean } | undefined;
          return { ok: r.ok, error: r.error, pendingApproval: r.permission === 'pending_approval', exitCode: data?.exitCode ?? null, data: { exitCode: data?.exitCode, timedOut: data?.timedOut, stdout: data?.stdout?.slice(-8000), stderr: data?.stderr?.slice(-8000) } };
        }
        case 'runtime.status': {
          if (!ctx.projectId) return { ok: false, error: '需要项目上下文' };
          const services = this.gateway['ds'].db.prepare('SELECT id,name,service_type,port,status,access_path FROM project_services WHERE project_id=?').all(ctx.projectId) as Array<{ id: string; name: string; port: number | null; status: string; access_path: string | null }>;
          return { ok: true, data: services };
        }
        case 'runtime.start': {
          const r = await this.gateway.call({ subjectType: 'agent', subjectId: ctx.agentId ?? 'supervisor', tool: 'command.exec', params: { command: `devpilot-internal:start-service:${String(params.serviceId)}`, cwd: this.projectRoot(ctx.projectId) ?? process.cwd() }, projectId: ctx.projectId, taskId: ctx.taskId, executionId: ctx.executionId }, 'command_execution');
          if (!r.ok) return { ok: false, error: r.error ?? '启动服务需要审批', pendingApproval: r.permission === 'pending_approval' };
          // 真实启动（通过 RuntimeService）
          const started = await this.runtime.startService(String(params.serviceId));
          return { ok: started.status === 'Running' || started.status === 'Stopped', data: started };
        }
        case 'runtime.stop': {
          // 停止服务也是副作用操作：与 start 一致走权限网关（修复审计发现的审批绕过）
          const r = await this.gateway.call({ subjectType: 'agent', subjectId: ctx.agentId ?? 'supervisor', tool: 'command.exec', params: { command: `devpilot-internal:stop-service:${String(params.serviceId)}`, cwd: this.projectRoot(ctx.projectId) ?? process.cwd() }, projectId: ctx.projectId, taskId: ctx.taskId, executionId: ctx.executionId }, 'command_execution');
          if (!r.ok) return { ok: false, error: r.error ?? '停止服务需要审批', pendingApproval: r.permission === 'pending_approval' };
          const stopped = await this.runtime.stopService(String(params.serviceId));
          return { ok: stopped.stopped, data: stopped };
        }
        case 'runtime.logs': {
          const serviceId = params.serviceId ? String(params.serviceId) : null;
          const lines = Math.min(Number(params.lines ?? 120), 400);
          const svc = serviceId
            ? this.gateway['ds'].db.prepare('SELECT name,project_id FROM project_services WHERE id=?').get(serviceId) as { name: string; project_id: string } | undefined
            : undefined;
          const rows = this.gateway['ds'].db
            .prepare(`SELECT level, source_module, message, created_at FROM logs ${svc ? 'WHERE source_module = ?' : 'WHERE project_id = ?'} ORDER BY created_at DESC LIMIT ?`)
            .all(svc ? `service.${svc.name}` : ctx.projectId ?? '', lines) as Array<{ level: string; source_module: string; message: string; created_at: string }>;
          return { ok: true, data: rows.reverse().map((r) => `[${r.created_at}] ${r.level.toUpperCase()} ${r.message}`.slice(0, 2000)) };
        }
        case 'runtime.health_check': {
          const port = Number(params.port);
          if (!port) return { ok: false, error: '需要 port 参数' };
          const open = await new Promise<boolean>((resolve) => {
            const sock = net.connect({ host: '127.0.0.1', port, timeout: 5000 });
            sock.once('connect', () => { sock.destroy(); resolve(true); });
            sock.once('timeout', () => { sock.destroy(); resolve(false); });
            sock.once('error', () => resolve(false));
          });
          let httpStatus: number | null = null;
          if (open && params.path) {
            try {
              const res = await fetch(`http://127.0.0.1:${port}${String(params.path)}`, { signal: AbortSignal.timeout(8000) });
              httpStatus = res.status;
            } catch { httpStatus = null; }
          }
          return { ok: true, data: { port, tcpListening: open, httpStatus, healthy: open && (httpStatus === null || httpStatus < 400) } };
        }
        case 'docker.check': {
          const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
            execFile('docker', ['version', '--format', 'Client {{.Client.Version}} / Server {{.Server.Version}}'], { timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
              resolve(err ? { code: 1, text: `Docker 不可用：${String(stderr || err.message).slice(0, 200)}` } : { code: 0, text: stdout.trim() });
            });
          });
          return { ok: out.code === 0, data: out.text, exitCode: out.code };
        }
        case 'docker.compose': {
          const action = String(params.action);
          if (!['up', 'down', 'ps', 'logs'].includes(action)) return { ok: false, error: `不支持的 compose 动作：${action}` };
          const cwd = this.projectRoot(ctx.projectId);
          if (!cwd) return { ok: false, error: '需要项目上下文' };
          const command = `docker compose ${action}${action === 'up' ? ' -d' : ''}`;
          const r = await this.gateway.call({ subjectType: 'agent', subjectId: ctx.agentId ?? 'supervisor', tool: 'command.exec', params: { command, cwd, timeoutMs: 600_000 }, projectId: ctx.projectId, taskId: ctx.taskId, executionId: ctx.executionId });
          const data = r.data as { exitCode?: number | null; stdout?: string; stderr?: string } | undefined;
          return { ok: r.ok, error: r.error, pendingApproval: r.permission === 'pending_approval', exitCode: data?.exitCode ?? null, data: { stdout: data?.stdout?.slice(-8000), stderr: data?.stderr?.slice(-8000) } };
        }
        case 'diagnostics.classify': {
          const { classifyError } = await import('../diagnostics/classifier');
          return { ok: true, data: classifyError(String(params.logText ?? '')) };
        }
        case 'process.list': {
          const rows = await this.listProcesses(String(params.filter ?? ''));
          return { ok: true, data: rows };
        }
        case 'process.kill': {
          const pid = Number(params.pid);
          if (!Number.isInteger(pid) || pid <= 0) return { ok: false, error: `非法 PID：${params.pid}` };
          if (pid === process.pid) return { ok: false, error: '拒绝终止 DevPilot 自身进程' };
          // 权限门：L3 高危，经网关走参数级审批（command=`devpilot-internal:kill-pid:<pid>`，
          // 网关 classifyCommandRisk 对该形态强制 L3 → 即使已授权也当次审批）
          const before = await this.processAlive(pid);
          if (!before) return { ok: true, data: { pid, killed: true, alreadyDead: true, verify: '进程在终止前已不存在' } };
          const r = await this.gateway.call({ subjectType: 'agent', subjectId: ctx.agentId ?? 'supervisor', tool: 'command.exec', params: { command: `devpilot-internal:kill-pid:${pid}`, cwd: this.projectRoot(ctx.projectId) ?? process.cwd() }, projectId: ctx.projectId, taskId: ctx.taskId, executionId: ctx.executionId }, 'command_execution');
          if (!r.ok) return { ok: false, error: r.error ?? '终止进程需要审批', pendingApproval: r.permission === 'pending_approval' };
          // 真实终止 + 验证证据
          const { platform } = await import('@devpilot/platform-adapters');
          await platform.killTreeWait(pid);
          const alive = await this.processAlive(pid);
          const meta = await this.processInfo(pid);
          return {
            ok: !alive,
            data: { pid, killed: !alive, verify: alive ? '终止后进程仍存活（可能有守护重启）' : `进程 ${pid}${meta ? `（${meta}）` : ''} 已终止`, processName: meta },
            error: alive ? `PID ${pid} 终止后仍存活` : undefined,
          };
        }
        case 'diagnostics.repair': {
          if (!ctx.projectId) return { ok: false, error: '需要项目上下文' };
          const project = this.gateway['ds'].db.prepare('SELECT id,name,root_path,language,project_type FROM projects WHERE id=?').get(ctx.projectId) as { id: string; name: string; root_path: string; language: string | null; project_type: string } | undefined;
          if (!project) return { ok: false, error: '项目不存在' };
          const services = this.gateway['ds'].db.prepare('SELECT id,name,port,start_command FROM project_services WHERE project_id=? ORDER BY rowid LIMIT 1').get(ctx.projectId) as { id: string; port: number | null; start_command: string | null } | undefined;
          const outcome = await this.fixer.fix({
            projectId: project.id,
            rootPath: project.root_path,
            projectName: project.name,
            language: project.language ?? 'unknown',
            isBinary: project.project_type === 'binary',
            startCommand: services?.start_command ?? null,
            port: services?.port ?? null,
            logText: String(params.logText ?? ''),
            attempt: 1,
            mode: params.mode === 'repair' ? 'repair' : 'analyze-start',
          });
          return { ok: outcome.changed || outcome.ranCommands.length > 0 || !!outcome.startCommand, data: outcome };
        }
        default:
          return { ok: false, error: `工具未实现：${tool}` };
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private projectRoot(projectId?: string): string | null {
    if (!projectId) return null;
    const row = this.gateway['ds'].db.prepare('SELECT root_path FROM projects WHERE id=?').get(projectId) as { root_path: string } | undefined;
    return row?.root_path ?? null;
  }

  /** 路径包含校验：目标必须位于项目根内（realpath，防 ../ 与符号链接逃逸）；返回安全后的真实路径 */
  private containToProject(p: string, projectRoot: string): string | null {
    try {
      const rootReal = fs.realpathSync(path.resolve(projectRoot));
      const abs = path.resolve(p);
      let targetReal: string;
      try {
        targetReal = fs.realpathSync(abs);
      } catch {
        const parentReal = fs.realpathSync(path.dirname(abs));
        targetReal = path.join(parentReal, path.basename(abs));
      }
      const rel = path.relative(rootReal, targetReal);
      if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) return null;
      return targetReal;
    } catch {
      return null;
    }
  }

  private tree(root: string, depth: number, prefix = ''): Array<{ name: string; isDir: boolean; path: string }> {
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.idea', '.next']);
    const out: Array<{ name: string; isDir: boolean; path: string }> = [];
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (IGNORE.has(e.name)) continue;
        out.push({ name: e.name, isDir: e.isDirectory(), path: `${prefix}${e.name}` });
        if (e.isDirectory() && depth > 1) {
          out.push(...this.tree(path.join(root, e.name), depth - 1, `${prefix}${e.name}/`));
        }
      }
    } catch { /* ignore */ }
    return out.slice(0, 300);
  }

  private searchFiles(root: string, query: string, glob: string): Array<{ file: string; line: number; text: string }> {
    const hits: Array<{ file: string; line: number; text: string }> = [];
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__']);
    const walk = (dir: string, depth: number) => {
      if (depth > 6 || hits.length >= 200) return;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (hits.length >= 200) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!IGNORE.has(e.name)) walk(full, depth + 1); continue; }
        if (glob && !e.name.includes(glob.replace('*', ''))) continue;
        if (/\.(exe|dll|bin|png|jpg|zip|7z|rar|jar|class|woff2?|ttf|pdf|node|pdb|so|dylib)$/i.test(e.name)) continue;
        try {
          const st = fs.statSync(full);
          if (st.size > 512 * 1024) continue;
          const content = fs.readFileSync(full, 'utf-8');
          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(query)) {
              hits.push({ file: path.relative(root, full), line: i + 1, text: lines[i].trim().slice(0, 200) });
              if (hits.length >= 200) return;
            }
          }
        } catch { /* 非文本/权限 */ }
      }
    };
    walk(root, 0);
    return hits;
  }

  /** 本机进程清单（Windows tasklist / POSIX ps），支持关键字过滤，最多 200 条 */
  private listProcesses(filter: string): Promise<Array<{ pid: number; name: string; memMB: string | null }>> {
    const { execFile } = require('node:child_process') as typeof import('node:child_process');
    const isWin = process.platform === 'win32';
    return new Promise((resolve) => {
      const done = (rows: Array<{ pid: number; name: string; memMB: string | null }>) => {
        const kw = filter.trim().toLowerCase();
        const hit = kw ? rows.filter((r) => r.name.toLowerCase().includes(kw) || String(r.pid).includes(kw)) : rows;
        resolve(hit.slice(0, 200));
      };
      if (isWin) {
        execFile('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 12_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
          if (err) return resolve([]);
          const rows = String(stdout).split(/\r?\n/).map((line) => {
            // tasklist /FO CSV /NH 实际 5 列："镜像名","PID","会话名","会话号","内存"
            const m = line.match(/^"([^"]+)","(\d+)","[^"]*","[^"]*","([^"]*)"/);
            return m ? { name: m[1], pid: Number(m[2]), memMB: m[3] ? m[3].replace(/[^\d.,]/g, '') : null } : null;
          }).filter(Boolean) as Array<{ pid: number; name: string; memMB: string | null }>;
          done(rows);
        });
      } else {
        execFile('ps', ['axo', 'pid=,comm=,rss='], { timeout: 12_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
          if (err) return resolve([]);
          const rows = String(stdout).split(/\r?\n/).map((line) => {
            const m = line.trim().match(/^(\d+)\s+(.+?)\s+(\d+)$/);
            return m ? { pid: Number(m[1]), name: path.basename(m[2]), memMB: m[3] ? String(Math.round(Number(m[3]) / 1024)) : null } : null;
          }).filter(Boolean) as Array<{ pid: number; name: string; memMB: string | null }>;
          done(rows);
        });
      }
    });
  }

  /** PID 是否存活 */
  private async processAlive(pid: number): Promise<boolean> {
    const rows = await this.listProcesses(String(pid));
    return rows.some((r) => r.pid === pid);
  }

  /** 进程名（终止验证证据用） */
  private async processInfo(pid: number): Promise<string | null> {
    const rows = await this.listProcesses(String(pid));
    return rows.find((r) => r.pid === pid)?.name ?? null;
  }
}
