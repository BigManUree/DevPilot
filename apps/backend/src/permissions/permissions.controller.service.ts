import { Injectable } from '@nestjs/common';
import { PermissionService } from './permission.service';
import { AuditService } from './audit.service';
import { ToolGatewayService, type ToolCallRequest } from './tool-gateway.service';
import { parseBoundedInt } from '../http-params';

@Injectable()
export class PermissionsControllerService {
  constructor(
    private readonly perms: PermissionService,
    private readonly audit: AuditService,
    private readonly gateway: ToolGatewayService,
  ) {}

  listApprovals() {
    return this.perms.listApprovals();
  }

  approve(id: string) {
    return this.perms.approve(id);
  }

  reject(id: string) {
    this.perms.reject(id);
  }

  listPermissions() {
    return this.perms.listPermissions();
  }

  /** 审批模式（含审计：模式切换是高危配置动作，必须留痕） */
  getMode() {
    return { mode: this.perms.getApprovalMode() };
  }

  setMode(mode: 'manual' | 'auto') {
    const r = this.perms.setApprovalMode(mode);
    this.audit.record({
      subject: 'user:local-user',
      action: 'approval.mode.set',
      target: mode,
      result: 'ok',
      detail: { mode, note: mode === 'auto' ? '完全访问：全部工具操作自动批准' : '恢复逐条审批' },
    });
    return r;
  }

  listAudit(limit?: string) {
    return this.audit.list(parseBoundedInt(limit, { fallback: 100, min: 1, max: 1000, name: 'limit' }));
  }

  callTool(req: ToolCallRequest) {
    return this.gateway.call(req);
  }
}
