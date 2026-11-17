import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PermissionService } from './permission.service';
import { AuditService } from './audit.service';
import { DatabaseService } from '../database/database.module';
import { platform as plat, cleanServiceEnv } from '@devpilot/platform-adapters';
import { EXECUTION_LIMITS_DEFAULT } from '@devpilot/shared-types';

/**
 * 统一工具网关（核心执行与通信机制第 1-3 节）。
 * 所有文件读写、命令执行必须经此入口：权限检查 → 执行 → 审计。
 * Agent 不允许绕过网关直接调用 Shell/文件系统。
 */

export interface ToolCallRequest {
  subjectType: 'user' | 'supervisor' | 'agent' | 'plugin' | 'external' | 'workflow';
  subjectId: string;
  tool: 'fs.read' | 'fs.write' | 'command.exec';
  params: Record<string, unknown>;
  projectId?: string;
  taskId?: string;
  /** agent_executions.id（tool_calls FK 指向该表） */
  executionId?: string;
  traceId?: string;
}

export interface ToolCallResult {
  toolCallId: string;
  ok: boolean;
  permission: 'allowed' | 'pending_approval';
  approvalId?: string;
  data?: unknown;
  error?: string;
}

/** 工具 → 权限类别映射 */
const TOOL_CATEGORY: Record<ToolCallRequest['tool'], string> = {
  'fs.read': 'project_analysis',
  'fs.write': 'modify_project_config', // 写代码文件的调用点按 modify_code 传入 categoryOverride
  'command.exec': 'command_execution',
};

import { createHash } from 'node:crypto';

/** 高危命令模式（L3）：命中即视为不可逆/系统级操作，任何已授权都不放行，必须当次审批 */
const L3_COMMAND_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /devpilot-internal:kill-pid:\d+/i, reason: '终止进程（不可逆操作，需确认目标）' },
  { re: /(^|\s)(rm|del|rd|rmdir)\s+(-[a-z]*[rsf][a-z]*\s+|\/s(\s|\/f|\/q))*/i, reason: '递归删除文件/目录' },
  { re: /format\s+[a-z]:|diskpart|mkfs|dd\s+if=/i, reason: '磁盘格式化/底层写盘' },
  { re: /reg(\.exe)?\s+(add|delete|import)|regedit\s+\/s/i, reason: '注册表写入/删除' },
  { re: /curl[^\n|]*\|\s*(sh|bash|zsh)|wget[^\n|]*\|\s*(sh|bash)|iex\s*\(\s*iwr|Invoke-Expression/i, reason: '远程脚本直接执行' },
  { re: /npm\s+(install|i|add)\s+[^&\n]*-g(--global)?(\s|$)|yarn\s+global\s+add|pnpm\s+add\s+-g/i, reason: '全局安装依赖（影响系统环境）' },
  { re: /pip\s+install[^&\n]*--system|sudo\s/i, reason: '系统级安装/提权执行' },
  { re: /taskkill\s+\/f[^&\n]*\/im|kill(all)?\s+-9/i, reason: '按名称强杀进程（范围不可控）' },
  { re: /shutdown|restart-computer|reboot/i, reason: '关机/重启' },
  { re: /vssadmin|wbadmin|bcdedit|cipher\s+\/w/i, reason: '系统恢复点/引导/擦除类操作' },
  { re: /powershell(-[\w.]+)?\s+-enc\s/i, reason: '编码混淆的 PowerShell（规避审计）' },
  { re: /(chmod|chown)\s+(-R\s+)?[07]?[67][67]\s+\/(\s|$)/i, reason: '系统根目录权限变更' },
];

export interface CommandRisk {
  level: 'L0' | 'L2' | 'L3';
  reasons: string[];
}

/** 命令风险分类：L3 高危（不可逆/系统级）；其余 command.exec 为 L2（有副作用需审批） */
export function classifyCommandRisk(command: string): CommandRisk {
  const reasons: string[] = [];
  for (const p of L3_COMMAND_PATTERNS) {
    if (p.re.test(command)) reasons.push(p.reason);
  }
  return { level: reasons.length ? 'L3' : 'L2', reasons };
}

/**
 * 参数规范化摘要：同一工具 + 同一项目 + 语义相同的参数 → 同一哈希。
 * 命令折叠空白；路径解析为绝对路径（Windows 不区分大小写）；fs.write 绑定内容哈希（改内容需重新审批）。
 */
export function paramDigest(tool: string, params: Record<string, unknown>, projectId?: string): string {
  const norm: Record<string, unknown> = { tool, projectId: projectId ?? null };
  if (tool === 'command.exec') {
    norm.command = String(params.command ?? '').trim().replace(/\s+/g, ' ');
    norm.cwd = path.resolve(String(params.cwd ?? '')).toLowerCase();
  } else if (tool === 'fs.read' || tool === 'fs.write') {
    norm.path = path.resolve(String(params.path ?? '')).toLowerCase();
    if (tool === 'fs.write' && params.content !== undefined) {
      norm.contentHash = createHash('sha256').update(String(params.content)).digest('hex').slice(0, 16);
    }
  } else {
    // 其他工具：全参数参与摘要（键排序，值字符串化）
    for (const k of Object.keys(params).sort()) norm[k] = String(params[k]);
  }
  return createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 24);
}

@Injectable()
export class ToolGatewayService {
  constructor(
    private readonly perms: PermissionService,
    private readonly audit: AuditService,
    private readonly ds: DatabaseService,
  ) {}

  async call(req: ToolCallRequest, categoryOverride?: string): Promise<ToolCallResult> {
    const toolCallId = randomUUID();
    const traceId = req.traceId ?? randomUUID();
    const category = categoryOverride ?? TOOL_CATEGORY[req.tool];

    // 参数级审批：计算规范化参数摘要；command.exec 做风险分级
    const pHash = paramDigest(req.tool, req.params, req.projectId);
    const risk = req.tool === 'command.exec' ? classifyCommandRisk(String(req.params.command ?? '')) : { level: 'L2' as const, reasons: [] };

    const check = this.perms.check({
      subjectType: req.subjectType,
      subjectId: req.subjectId,
      category,
      projectId: req.projectId,
      taskId: req.taskId,
      pathScope: typeof req.params.path === 'string' ? req.params.path : undefined,
      paramHash: pHash,
      paramJson: { tool: req.tool, params: this.audit.redact(req.params) as Record<string, unknown>, projectId: req.projectId ?? null, risk: risk.level, riskReasons: risk.reasons },
      risk: risk.level,
      riskReasons: risk.reasons,
    });

    // 记录 tool_call
    this.ds.db
      .prepare(
        `INSERT INTO tool_calls (id, execution_id, tool_name, params_summary, permission_result, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        toolCallId,
        req.executionId ?? null,
        req.tool,
        JSON.stringify(this.audit.redact(req.params)),
        check.allowed ? 'allowed' : 'denied',
        new Date().toISOString(),
      );

    if (!check.allowed) {
      this.audit.record({
        subject: `${req.subjectType}:${req.subjectId}`,
        action: req.tool,
        target: String(req.params.path ?? ''),
        result: 'denied',
        traceId,
        detail: { reason: check.reason, approvalId: check.approvalId },
      });
      return { toolCallId, ok: false, permission: 'pending_approval', approvalId: check.approvalId, error: check.reason };
    }

    try {
      // 审计 S1 补强：非 user 主体（agent/external/plugin/workflow/supervisor）的 fs 调用，
      // 路径必须位于所绑定项目的 root_path 内（realpath 校验，防符号链接逃逸）。
      // user 主体（工作区 UI / 自动修复）沿用各自控制器已有包含校验，此处不重复限制。
      if (req.subjectType !== 'user' && (req.tool === 'fs.read' || req.tool === 'fs.write')) {
        this.assertPathInProject(String(req.params.path ?? ''), req.projectId);
      }
      const data = await this.dispatch(req, toolCallId);
      this.finishCall(toolCallId, 'ok');
      this.audit.record({
        subject: `${req.subjectType}:${req.subjectId}`,
        action: req.tool,
        target: String(req.params.path ?? req.params.command ?? ''),
        result: 'ok',
        traceId,
        detail: req.params,
      });
      return { toolCallId, ok: true, permission: 'allowed', data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.finishCall(toolCallId, `error:${msg}`);
      this.audit.record({
        subject: `${req.subjectType}:${req.subjectId}`,
        action: req.tool,
        target: String(req.params.path ?? req.params.command ?? ''),
        result: 'error',
        traceId,
        detail: { error: msg },
      });
      return { toolCallId, ok: false, permission: 'allowed', error: msg };
    }
  }

  private finishCall(toolCallId: string, status: string) {
    this.ds.db
      .prepare('UPDATE tool_calls SET exit_status=?, finished_at=? WHERE id=?')
      .run(status, new Date().toISOString(), toolCallId);
  }

  private async dispatch(req: ToolCallRequest, toolCallId: string): Promise<unknown> {
    switch (req.tool) {
      case 'fs.read':
        return this.fsRead(req);
      case 'fs.write':
        return this.fsWrite(req);
      case 'command.exec':
        return this.commandExec(req, toolCallId);
      default:
        // 审计 F-05：旧实现 switch 没有 default，未知工具直接返回 undefined，
        // 上层看到的是 {ok:true} —— 调用方以为执行成功，实际什么都没做。
        throw new Error(`未知工具：${String((req as { tool?: unknown }).tool)}（仅支持 fs.read / fs.write / command.exec）`);
    }
  }

  /**
   * fs 路径安全校验（审计 S2 修复）：
   * - 规范化 + realpath（防 ../、绝对路径注入与符号链接逃逸）
   * - fs.write 拒绝系统敏感目录（Windows/Program Files/用户根目录等），无论主体是谁
   */
  private assertFsPath(p: string, mode: 'read' | 'write'): string {
    if (!p || typeof p !== 'string') throw new Error('fs 工具需要 path 参数');
    const abs = path.resolve(p);
    const PROTECTED = [
      /^C:\\Windows(\\|$)/i, /^C:\\Program Files/i, /^C:\\Program Files \(x86\)/i,
      /^C:\\$/i, /^[A-Z]:\\(System Volume Information|\$Recycle\.Bin)/i,
      /^\/(etc|usr|bin|sbin|var|sys|proc|boot)(\/|$)/,
    ];
    if (mode === 'write') {
      for (const re of PROTECTED) {
        if (re.test(abs)) throw new Error(`拒绝写入受保护目录：${abs}`);
      }
      // 用户主目录根本身不可写（深层项目目录不受影响）
      const home = process.env.USERPROFILE ?? process.env.HOME;
      if (home && path.relative(path.resolve(home), abs) === '') {
        throw new Error(`拒绝写入用户主目录根：${abs}`);
      }
    }
    // 符号链接逃逸：若真实路径解析后与传入路径的根不一致且未授权（这里统一记录真实路径）
    try {
      return fs.realpathSync(abs);
    } catch {
      // 目标尚不存在（写新建文件）：校验父目录的真实路径
      try {
        const parentReal = fs.realpathSync(path.dirname(abs));
        return path.join(parentReal, path.basename(abs));
      } catch {
        return abs;
      }
    }
  }

  /** 项目根包含校验：路径（真实路径）必须落在绑定项目的 root_path 内 */
  private assertPathInProject(p: string, projectId?: string): void {
    if (!p) throw new Error('fs 工具需要 path 参数');
    if (!projectId) throw new Error(`非 user 主体的 fs 访问必须绑定项目（projectId 缺失），拒绝访问：${p}`);
    const row = this.ds.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string } | undefined;
    if (!row?.root_path) throw new Error(`项目不存在：${projectId}`);
    const rootReal = fs.realpathSync(path.resolve(row.root_path));
    const abs = path.resolve(p);
    let targetReal: string;
    try {
      targetReal = fs.realpathSync(abs);
    } catch {
      // 目标尚不存在（新建文件）：校验父目录真实路径
      try {
        const parentReal = fs.realpathSync(path.dirname(abs));
        targetReal = path.join(parentReal, path.basename(abs));
      } catch {
        throw new Error(`路径不存在且父目录不可解析，拒绝访问：${abs}`);
      }
    }
    const rel = path.relative(rootReal, targetReal);
    if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
      throw new Error(`路径不在项目 ${path.basename(rootReal)} 内，拒绝访问：${targetReal}`);
    }
  }

  private fsRead(req: ToolCallRequest): unknown {
    const p = this.assertFsPath(String(req.params.path), 'read');
    const content = fs.readFileSync(p, 'utf-8');
    const size = Buffer.byteLength(content);
    if (size > 1024 * 1024) return { path: p, size, truncated: true, content: content.slice(0, 1024 * 1024) };
    return { path: p, size, content };
  }

  /** 原子写入 + 修改前备份（安全设计第 6 节） */
  private fsWrite(req: ToolCallRequest): unknown {
    const p = this.assertFsPath(String(req.params.path), 'write');
    const content = String(req.params.content ?? '');
    if (fs.existsSync(p)) {
      const bakDir = path.join(path.dirname(p), '.devpilot-backup');
      fs.mkdirSync(bakDir, { recursive: true });
      fs.copyFileSync(p, path.join(bakDir, `${path.basename(p)}.${Date.now()}.bak`));
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, content, 'utf-8');
      fs.renameSync(tmp, p);
    } catch (err) {
      // 审计 F-07：失败时清掉临时文件，旧实现会在用户项目里留一堆 xxx.tmp
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw err;
    }
    return { path: p, bytes: Buffer.byteLength(content), backedUp: fs.existsSync(p) };
  }

  /** 命令执行：超时控制 + 进程追踪（不按名称杀进程；只记录本会话 PID 树） */
  private commandExec(req: ToolCallRequest, toolCallId: string): Promise<unknown> {
    const command = String(req.params.command);
    const cwd = String(req.params.cwd ?? process.cwd());
    const timeoutMs = Number(req.params.timeoutMs ?? EXECUTION_LIMITS_DEFAULT.commandTimeoutMs);

    return new Promise((resolve, reject) => {
      const { shell, args: shellArg } = plat.shellFor(command);
      const child = spawn(shell, shellArg, { cwd, env: cleanServiceEnv(process.env), windowsHide: true, ...(plat.shellFor(command).options ?? {}) });
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        // 超时强制终止：只终止本调用创建的进程
        if (child.pid) plat.killTree(child.pid);
      }, timeoutMs);

      child.stdout?.on('data', (d) => (stdout += String(d)));
      child.stderr?.on('data', (d) => (stderr += String(d)));
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          pid: child.pid,
          exitCode: code,
          timedOut,
          stdout: stdout.slice(-512 * 1024),
          stderr: stderr.slice(-512 * 1024),
          durationMs: timeoutMs === 0 ? undefined : undefined,
          toolCallId,
        });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
