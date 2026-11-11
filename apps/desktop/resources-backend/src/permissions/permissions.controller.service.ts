import { Injectable } from '@nestjs/common';
import { PermissionService } from './permission.service';
import { AuditService } from './audit.service';
import { ToolGatewayService, type ToolCallRequest } from './tool-gateway.service';

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

  listAudit(limit?: number) {
    return this.audit.list(limit ?? 100);
  }

  callTool(req: ToolCallRequest) {
    return this.gateway.call(req);
  }
}
