import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';

export interface PermissionCheckRequest {
  subjectType: 'user' | 'supervisor' | 'agent' | 'plugin' | 'external' | 'workflow';
  subjectId: string;
  category: string; // PermissionCategory
  projectId?: string;
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

  check(req: PermissionCheckRequest): PermissionCheckResult {
    const db = this.ds.db;

    // 主体为 user：本地单用户，默认授权（审批仍由 UI 高风险确认流承担）
    if (req.subjectType === 'user') {
      return { allowed: true, reason: 'user-implicit-grant' };
    }

    const rows = db
      .prepare(
        `SELECT * FROM permissions
         WHERE subject_type = ? AND subject_id = ? AND category = ? AND status = 'active'
           AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .all(req.subjectType, req.subjectId, req.category, new Date().toISOString()) as Array<{
      id: string;
      resource_scope: string | null;
    }>;

    // 项目范围匹配：scope 为空 = 全局；否则需包含 projectId
    const hit = rows.find((r) => {
      if (!r.resource_scope) return true;
      if (!req.projectId) return false;
      const scopes = JSON.parse(r.resource_scope) as string[];
      return scopes.includes(req.projectId);
    });

    if (hit) {
      return { allowed: true, reason: 'permission-granted', permissionId: hit.id };
    }

    // 越权：创建待审批记录
    const approvalId = randomUUID();
    db.prepare(
      `INSERT INTO approvals (id, target_ref, requester, action_summary, risk_level, approval_status, created_at)
       VALUES (?, ?, ?, ?, 'medium', 'pending', ?)`,
    ).run(
      approvalId,
      JSON.stringify({ category: req.category, projectId: req.projectId, pathScope: req.pathScope }),
      `${req.subjectType}:${req.subjectId}`,
      `请求权限 ${req.category}${req.projectId ? `（项目 ${req.projectId}）` : ''}`,
      new Date().toISOString(),
    );
    return {
      allowed: false,
      reason: 'PERMISSION_DENIED_PENDING_APPROVAL',
      approvalId,
    };
  }

  /** 审批通过 → 落权限（默认 30 天有效期） */
  approve(approvalId: string): { permissionId: string } {
    const db = this.ds.db;
    const appr = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as
      | { id: string; target_ref: string; requester: string }
      | undefined;
    if (!appr) throw new Error('approval not found');
    const target = JSON.parse(appr.target_ref) as { category: string; projectId?: string };

    const permId = randomUUID();
    const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO permissions (id, subject_type, subject_id, category, resource_scope, grant_source, expires_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'approval', ?, 'active', ?)`,
      ).run(
        permId,
        appr.requester.split(':')[0],
        appr.requester.split(':')[1] ?? appr.requester,
        target.category,
        target.projectId ? JSON.stringify([target.projectId]) : null,
        expires,
        new Date().toISOString(),
      );
      db.prepare(`UPDATE approvals SET approval_status='approved', decided_at=? WHERE id=?`)
        .run(new Date().toISOString(), approvalId);
    })();
    return { permissionId: permId };
  }

  reject(approvalId: string) {
    this.ds.db
      .prepare(`UPDATE approvals SET approval_status='rejected', decided_at=? WHERE id=?`)
      .run(new Date().toISOString(), approvalId);
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
