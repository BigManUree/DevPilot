import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ModelService } from '../agents/model.service';
import { ToolGatewayService } from '../permissions/tool-gateway.service';
import { LogService } from '../logs/log.service';
import { AuditService } from '../permissions/audit.service';
import { EventsGateway } from '../events.gateway';
import { diffLines, renderDiff } from './diff';
import { EXECUTION_LIMITS_DEFAULT } from '@devpilot/shared-types';

/**
 * AI 诊断修复闭环（WF-08 + 需求 8.3/8.4）：
 * 日志采集 → LLM 根因分析 → 修复计划（文件级 newContent）→ 权限校验（agent 身份走网关，越权转审批）
 * → 备份 → 修改 → Diff → 验证命令（重试 ≤3 / 命令超时 120s / 总时长 10min）
 * → 失败回滚（从备份还原）→ 报告。
 */

export interface RepairRecord {
  diagnosisId: string;
  projectId?: string;
  status: 'Diagnosing' | 'Applying' | 'Verifying' | 'Completed' | 'Failed' | 'WaitingApproval' | 'RolledBack';
  analysis?: string;
  diffs: Array<{ path: string; diff: string; applied: boolean; rolledBack?: boolean }>;
  verifyAttempts: Array<{ command: string; exitCode: number | null; timedOut: boolean }>;
  report?: string;
}

@Injectable()
export class RepairLoopService {
  private records = new Map<string, RepairRecord>();

  constructor(
    private readonly model: ModelService,
    private readonly gateway: ToolGatewayService,
    private readonly logs: LogService,
    private readonly audit: AuditService,
    private readonly events: EventsGateway,
  ) {}

  private recordPath(id: string): string {
    const dir = path.join(
      process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data'),
      'repairs',
    );
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${id}.json`);
  }

  get(id: string): RepairRecord | undefined {
    return this.records.get(id) ?? (fs.existsSync(this.recordPath(id)) ? JSON.parse(fs.readFileSync(this.recordPath(id), 'utf-8')) : undefined);
  }

  /** 主流程 */
  async diagnose(input: { projectId?: string; logExcerpt: string; verifyCommand: string; cwd?: string }): Promise<RepairRecord> {
    const id = randomUUID();
    const rec: RepairRecord = { diagnosisId: id, projectId: input.projectId, status: 'Diagnosing', diffs: [], verifyAttempts: [] };
    this.records.set(id, rec);
    const startedAt = Date.now();

    try {
      // 1) LLM 分析 + 修复计划
      const raw = await this.model.chat([
        { role: 'system', content: '你是 DevPilot 诊断修复 Agent。只输出 JSON：{"analysis":string,"files":[{"path":string,"content":string}],"explanation":string}。files 每项是修复后的完整文件内容。只修改必要的文件，不得删除既有功能。' },
        { role: 'user', content: `错误日志：\n${input.logExcerpt.slice(0, 8000)}\n\n请分析根因并给出修复后的完整文件内容。` },
      ], { json: true });
      const plan = JSON.parse(raw) as { analysis: string; files: Array<{ path: string; content: string }>; explanation?: string };
      rec.analysis = plan.analysis;
      rec.status = 'Applying';
      // 相对路径归一化：以 cwd（或项目根）为基准
      for (const f of plan.files) {
        if (!path.isAbsolute(f.path)) {
          f.path = path.resolve(input.cwd ?? process.cwd(), f.path);
        }
      }

      for (const f of plan.files) {
        // 2) 权限校验（repair Agent 身份 → modify_code，越权自动生成审批）
        const r = await this.gateway.call(
          { subjectType: 'agent', subjectId: 'repair', tool: 'fs.write', params: { path: f.path, content: f.content }, projectId: input.projectId },
          'modify_code',
        );
        if (!r.ok && r.permission === 'pending_approval') {
          rec.status = 'WaitingApproval';
          rec.report = `需要审批：${r.error} approvalId=${r.approvalId}`;
          this.persist(rec);
          return rec;
        }
        if (!r.ok) throw new Error(`write failed: ${r.error}`);

        // 3) Diff（对比备份内容：gateway fs.write 已做 .devpilot-backup，此处取原文件内容生成 diff）
        const before = await this.readOriginal(f.path);
        rec.diffs.push({ path: f.path, diff: renderDiff(f.path, before.content ?? '', f.content), applied: true });
        this.logs.log({ level: 'info', sourceModule: 'repair', projectId: input.projectId, message: `applied fix to ${f.path}` });
      }

      // 4) 验证：重试上限 3 / 单命令 120s / 总时长 10min
      rec.status = 'Verifying';
      for (let attempt = 1; attempt <= EXECUTION_LIMITS_DEFAULT.maxAutoRepairAttempts; attempt++) {
        if (Date.now() - startedAt > EXECUTION_LIMITS_DEFAULT.repairTaskTotalMs) {
          rec.status = 'Failed';
          rec.report = '总时长超过 10 分钟上限，停止并报告';
          break;
        }
        const v = await this.gateway.call({
          subjectType: 'user', subjectId: 'local-user', tool: 'command.exec',
          params: { command: input.verifyCommand, cwd: input.cwd, timeoutMs: EXECUTION_LIMITS_DEFAULT.commandTimeoutMs },
          projectId: input.projectId,
        });
        const data = v.data as { exitCode: number; timedOut: boolean } | undefined;
        rec.verifyAttempts.push({ command: input.verifyCommand, exitCode: data?.exitCode ?? null, timedOut: data?.timedOut ?? false });

        if (v.ok && data?.exitCode === 0) {
          rec.status = 'Completed';
          rec.report = `修复成功：第 ${attempt} 次验证通过。${plan.explanation ?? ''}`;
          this.persist(rec);
          return rec;
        }
        this.logs.log({ level: 'warn', sourceModule: 'repair', projectId: input.projectId, message: `verify attempt ${attempt} failed exit=${data?.exitCode}` });
      }

      // 5) 超限 → 回滚
      if ((rec.status as string) !== 'Completed') {
        await this.rollback(rec);
        rec.status = 'RolledBack';
        rec.report = `验证 ${rec.verifyAttempts.length} 次未通过，已回滚全部修改。已尝试方案：${rec.diffs.map(d => d.path).join(', ')}。建议人工检查。`;
      }
    } catch (err) {
      rec.status = 'Failed';
      rec.report = `流程异常：${String(err).slice(0, 300)}`;
      await this.rollback(rec).catch(() => {});
    }
    this.persist(rec);
    return rec;
  }

  private async readOriginal(p: string): Promise<{ content?: string }> {
    const r = await this.gateway.call({ subjectType: 'user', subjectId: 'local-user', tool: 'fs.read', params: { path: p } });
    return (r.data as { content?: string }) ?? {};
  }

  /** 回滚：从 .devpilot-backup 找最近备份还原 */
  private async rollback(rec: RepairRecord): Promise<void> {
    for (const d of rec.diffs) {
      if (!d.applied) continue;
      const bakDir = path.join(path.dirname(d.path), '.devpilot-backup');
      if (!fs.existsSync(bakDir)) continue;
      const base = path.basename(d.path);
      const backups = fs.readdirSync(bakDir).filter((f) => f.startsWith(base + '.')).sort().reverse();
      if (backups[0]) {
        fs.copyFileSync(path.join(bakDir, backups[0]), d.path);
        d.rolledBack = true;
        this.audit.record({ subject: 'agent:repair', action: 'repair.rollback', target: d.path, result: 'ok' });
        this.logs.log({ level: 'info', sourceModule: 'repair', message: `rolled back ${d.path} from ${backups[0]}` });
      }
    }
  }

  private persist(rec: RepairRecord) {
    fs.writeFileSync(this.recordPath(rec.diagnosisId), JSON.stringify(rec, null, 2), 'utf-8');
    this.events.broadcast({
      event_id: randomUUID(),
      event_type: 'notification.created',
      timestamp: new Date().toISOString(),
      source_module: 'repair-loop',
      project_id: rec.projectId,
      trace_id: rec.diagnosisId,
      severity: rec.status === 'Completed' ? 'info' : 'warn',
      payload: { status: rec.status, summary: rec.report ?? rec.analysis ?? '' },
    });
  }
}
