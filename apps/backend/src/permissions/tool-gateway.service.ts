import { Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PermissionService } from './permission.service';
import { AuditService } from './audit.service';
import { DatabaseService } from '../database/database.module';
import { platform as plat } from '@devpilot/platform-adapters';
import { EXECUTION_LIMITS_DEFAULT } from '@devpilot/shared-types';

/**
 * 统一工具网关（核心执行与通信机制第 1-3 节）。
 * 所有文件读写、命令执行必须经此入口：权限检查 → 执行 → 审计。
 * Agent 不允许绕过网关直接调用 Shell/文件系统。
 */

export interface ToolCallRequest {
  subjectType: 'user' | 'supervisor' | 'agent' | 'plugin';
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

    const check = this.perms.check({
      subjectType: req.subjectType,
      subjectId: req.subjectId,
      category,
      projectId: req.projectId,
      pathScope: typeof req.params.path === 'string' ? req.params.path : undefined,
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
    }
  }

  private fsRead(req: ToolCallRequest): unknown {
    const p = String(req.params.path);
    const content = fs.readFileSync(p, 'utf-8');
    const size = Buffer.byteLength(content);
    if (size > 1024 * 1024) return { path: p, size, truncated: true, content: content.slice(0, 1024 * 1024) };
    return { path: p, size, content };
  }

  /** 原子写入 + 修改前备份（安全设计第 6 节） */
  private fsWrite(req: ToolCallRequest): unknown {
    const p = String(req.params.path);
    const content = String(req.params.content);
    if (fs.existsSync(p)) {
      const bakDir = path.join(path.dirname(p), '.devpilot-backup');
      fs.mkdirSync(bakDir, { recursive: true });
      fs.copyFileSync(p, path.join(bakDir, `${path.basename(p)}.${Date.now()}.bak`));
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, p);
    return { path: p, bytes: Buffer.byteLength(content), backedUp: fs.existsSync(p) };
  }

  /** 命令执行：超时控制 + 进程追踪（不按名称杀进程；只记录本会话 PID 树） */
  private commandExec(req: ToolCallRequest, toolCallId: string): Promise<unknown> {
    const command = String(req.params.command);
    const cwd = String(req.params.cwd ?? process.cwd());
    const timeoutMs = Number(req.params.timeoutMs ?? EXECUTION_LIMITS_DEFAULT.commandTimeoutMs);

    return new Promise((resolve, reject) => {
      const { shell, args: shellArg } = plat.shellFor(command);
      const child = spawn(shell, shellArg, { cwd, windowsHide: true });
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
