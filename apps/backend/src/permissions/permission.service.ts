import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';

export interface PermissionCheckRequest {
  subjectType: 'user' | 'supervisor' | 'agent' | 'plugin' | 'external' | 'workflow';
  subjectId: string;
  category: string; // PermissionCategory
  projectId?: string;
  /** 发起调用的任务 ID（审批与任务绑定，批准后可恢复等待中的任务） */
  taskId?: string;
  /** 参数规范化摘要（参数级审批匹配键） */
  paramHash?: string;
  /** 参数明细（落审批记录，供审批 UI 展示与追溯） */
  paramJson?: Record<string, unknown>;
  /** 风险等级（L3 高危永不自动放行） */
  risk?: 'L0' | 'L2' | 'L3';
  riskReasons?: string[];
  /** 请求的目录范围（用于校验路径越界） */
  pathScope?: string;
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason: string;
  permissionId?: string;
  /** 不在授权范围时，生成待审批授权请求 */
  approvalId?: string;
}

/**
 * 权限管理器（核心执行与通信机制第 2 节）：
 * - 已授权范围内自主执行
 * - 越权 → 生成审批记录（approvals），等待用户批准
 * - 主体：user 默认全授权；agent/受控身份按 permissions 表
 */
@Injectable()
export class PermissionService {
  constructor(private readonly ds: DatabaseService) {}

  /** 审批模式：'manual'（默认，逐条审批）| 'auto'（完全访问，自动批准全部工具操作）。
   *  持久化在 settings 表（key=approval.mode, scope=global），重启保留。 */
  getApprovalMode(): 'manual' | 'auto' {
    const row = this.ds.db
      .prepare(`SELECT value_json FROM settings WHERE key = 'approval.mode' AND scope = 'global'`)
      .get() as { value_json: string } | undefined;
    try {
      const parsed = row ? JSON.parse(row.value_json) as { mode?: string } : null;
      return parsed?.mode === 'auto' ? 'auto' : 'manual';
    } catch {
      return 'manual';
    }
  }

  setApprovalMode(mode: 'manual' | 'auto'): { mode: 'manual' | 'auto' } {
    if (mode !== 'manual' && mode !== 'auto') throw new Error(`非法审批模式：${mode}`);
    const now = new Date().toISOString();
    this.ds.db
      .prepare(
        `INSERT INTO settings (key, scope, value_json, version, updated_at)
         VALUES ('approval.mode', 'global', ?, 1, ?)
         ON CONFLICT(key, scope) DO UPDATE SET value_json = excluded.value_json, version = version + 1, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify({ mode }), now);
    return { mode };
  }

  check(req: PermissionCheckRequest): PermissionCheckResult {
    const db = this.ds.db;

    // 主体为 user：本地单用户，默认授权（审批仍由 UI 高风险确认流承担）
    if (req.subjectType === 'user') {
      return { allowed: true, reason: 'user-implicit-grant' };
    }

    // 完全访问模式（用户显式开启）：自动批准全部工具操作（含 L3）。
    // 结构性安全不放松：fs 写入系统保护目录仍在网关 dispatch 层拦截。
    if (this.getApprovalMode() === 'auto') {
      return { allowed: true, reason: 'auto-approve-full-access' };
    }

    const now = new Date().toISOString();
    const rows = db
      .prepare(
        `SELECT * FROM permissions
         WHERE subject_type = ? AND subject_id = ? AND category = ? AND status = 'active'
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .all(req.subjectType, req.subjectId, req.category, now) as Array<{
      id: string;
      resource_scope: string | null;
      scope_kind: string;
      param_hash: string | null;
      one_shot: number;
      used_at: string | null;
    }>;

    // 参数级授权优先匹配（scope_kind='param'：绑定 param_hash + 项目 + 未消费 + 未过期）。
    // 注意顺序：L3 高危绕过的是"类别级授权"，但用户对具体某次操作显式批准的 one-shot 必须生效，
    // 否则批准后任务永远无法恢复（审批死锁）。
    const paramHit = req.paramHash
      ? rows.find((r) =>
          r.scope_kind === 'param'
          && r.param_hash === req.paramHash
          && r.used_at === null
          && (!r.resource_scope || (req.projectId ? (JSON.parse(r.resource_scope) as string[]).includes(req.projectId) : false)),
        )
      : undefined;
    if (paramHit) {
      if (paramHit.one_shot) {
        // one_shot 消费型授权：用一次即失效（并发安全：仅当 used_at 仍为空时置位）
        const upd = db
          .prepare(`UPDATE permissions SET used_at = ? WHERE id = ? AND used_at IS NULL`)
          .run(now, paramHit.id);
        if (upd.changes === 0) {
          // 并发下已被消费 → 转审批
          return this.createApproval(req, req.risk === 'L3' ? 'high' : 'medium');
        }
      }
      return { allowed: true, reason: 'param-grant', permissionId: paramHit.id };
    }

    // L3 高危（不可逆/系统级）：类别级授权不放行，必须当次审批（任务书 §5.1 第 8 条）
    if (req.risk === 'L3') {
      return this.createApproval(req, 'high');
    }

    // 类别级授权兜底（旧行为/内置默认）：scope 为空 = 全局；否则需包含 projectId
    const hit = rows.find((r) => {
      if (r.scope_kind !== 'category') return false;
      if (!r.resource_scope) return true;
      if (!req.projectId) return false;
      const scopes = JSON.parse(r.resource_scope) as string[];
      return scopes.includes(req.projectId);
    });

    if (hit) {
      return { allowed: true, reason: 'permission-granted', permissionId: hit.id };
    }

    // 越权：创建参数绑定的待审批记录
    return this.createApproval(req, 'medium');
  }

  private createApproval(req: PermissionCheckRequest, risk: 'medium' | 'high'): PermissionCheckResult {
    const db = this.ds.db;
    const approvalId = randomUUID();
    const paramJson = req.paramJson ?? { category: req.category, projectId: req.projectId ?? null, pathScope: req.pathScope };
    const hash = req.paramHash ?? null;
    db.prepare(
      `INSERT INTO approvals (id, target_ref, requester, action_summary, risk_level, approval_status, created_at, param_json, param_hash, risk_reasons)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    ).run(
      approvalId,
      JSON.stringify({ category: req.category, projectId: req.projectId, taskId: req.taskId ?? null, pathScope: req.pathScope }),
      `${req.subjectType}:${req.subjectId}`,
      this.summarizeApproval(req, risk),
      risk,
      new Date().toISOString(),
      JSON.stringify(paramJson),
      hash,
      req.riskReasons?.length ? JSON.stringify(req.riskReasons) : null,
    );
    return {
      allowed: false,
      reason: 'PERMISSION_DENIED_PENDING_APPROVAL',
      approvalId,
    };
  }

  /** 审批摘要：一句话说清要执行什么（命令/写文件路径）、在哪执行、风险等级与原因 */
  private summarizeApproval(req: PermissionCheckRequest, risk: 'medium' | 'high'): string {
    const p = (req.paramJson ?? {}) as { tool?: string; params?: Record<string, unknown> };
    const tool = p.tool ?? req.category;
    const params = p.params ?? {};
    let detail = '';
    if (typeof params.command === 'string') {
      const cwd = typeof params.cwd === 'string' ? params.cwd : '';
      detail = `命令「${params.command.slice(0, 160)}」${cwd ? ` @ ${cwd}` : ''}`;
    } else if (typeof params.path === 'string') {
      detail = `${tool === 'fs.write' ? '写入文件' : '读取文件'}「${params.path}」`;
      if (params.content !== undefined) detail += `（内容 ${Buffer.byteLength(String(params.content))}B，将自动备份）`;
    } else {
      detail = `${tool}（${req.category}）${req.projectId ? ` @ 项目 ${req.projectId.slice(0, 8)}` : ''}`;
    }
    const riskTag = risk === 'high' ? '【L3 高危】' : '【L2 需审批】';
    const reasons = req.riskReasons?.length ? `，原因：${req.riskReasons.join('；')}` : '';
    return `${riskTag}请求${detail}${reasons}。批准后仅授权本次完全相同的操作（参数改动需重新审批）。`;
  }

  /** 审批决定回调（AgentService 注册：批准后自动恢复 WaitingApproval 任务；避免模块循环依赖） */
  private approvalDecidedHooks: Array<(info: { approvalId: string; approved: boolean; taskId?: string; category?: string; requester?: string }) => void> = [];
  onApprovalDecided(cb: (info: { approvalId: string; approved: boolean; taskId?: string; category?: string; requester?: string }) => void): void {
    this.approvalDecidedHooks.push(cb);
  }

  private emitApprovalDecided(info: { approvalId: string; approved: boolean; taskId?: string; category?: string; requester?: string }): void {
    for (const cb of this.approvalDecidedHooks) {
      try { cb(info); } catch { /* 回调异常不影响审批主流程 */ }
    }
  }

  /** 审批通过 → 落参数级 one-shot 授权（24h 有效期，用一次即失效）；
   *  旧审批（V18 前，无 param_hash）兼容回退为类别级授权，不放宽到参数级之外的任何行为 */
  approve(approvalId: string): { permissionId: string; taskId?: string; scope: 'param' | 'category' } {
    const db = this.ds.db;
    const appr = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as
      | { id: string; target_ref: string; requester: string; approval_status: string; param_hash: string | null; risk_level: string }
      | undefined;
    if (!appr) throw new NotFoundException(`审批不存在：${approvalId}`);
    if (appr.approval_status !== 'pending') throw new ConflictException(`审批已处理（${appr.approval_status}），不能重复批准`);
    const target = JSON.parse(appr.target_ref) as { category: string; projectId?: string; taskId?: string | null };

    const permId = randomUUID();
    const expires = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const isParam = !!appr.param_hash;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO permissions (id, subject_type, subject_id, category, resource_scope, grant_source, expires_at, status, created_at, scope_kind, param_hash, one_shot)
         VALUES (?, ?, ?, ?, ?, 'approval', ?, 'active', ?, ?, ?, ?)`,
      ).run(
        permId,
        appr.requester.split(':')[0],
        appr.requester.split(':')[1] ?? appr.requester,
        target.category,
        target.projectId ? JSON.stringify([target.projectId]) : null,
        expires,
        new Date().toISOString(),
        isParam ? 'param' : 'category',
        appr.param_hash,
        isParam ? 1 : 0,
      );
      db.prepare(`UPDATE approvals SET approval_status='approved', decided_at=? WHERE id=?`)
        .run(new Date().toISOString(), approvalId);
    })();
    this.emitApprovalDecided({ approvalId, approved: true, taskId: target.taskId ?? undefined, category: target.category, requester: appr.requester });
    return { permissionId: permId, taskId: target.taskId ?? undefined, scope: isParam ? 'param' : 'category' };
  }

  reject(approvalId: string) {
    const appr = this.ds.db.prepare('SELECT target_ref, approval_status FROM approvals WHERE id = ?').get(approvalId) as
      | { target_ref: string; approval_status: string }
      | undefined;
    if (!appr) throw new NotFoundException(`审批不存在：${approvalId}`);
    if (appr.approval_status !== 'pending') throw new ConflictException(`审批已处理（${appr.approval_status}），不能重复拒绝`);
    this.ds.db
      .prepare(`UPDATE approvals SET approval_status='rejected', decided_at=? WHERE id=?`)
      .run(new Date().toISOString(), approvalId);
    try {
      const target = JSON.parse(appr.target_ref) as { category?: string; taskId?: string | null };
      this.emitApprovalDecided({ approvalId, approved: false, taskId: target.taskId ?? undefined, category: target.category });
    } catch { /* target_ref 损坏时跳过回调 */ }
  }

  listApprovals() {
    return this.ds.db
      .prepare(`SELECT * FROM approvals WHERE approval_status='pending' ORDER BY created_at DESC`)
      .all();
  }

  listPermissions() {
    return this.ds.db.prepare('SELECT * FROM permissions').all();
  }
}
