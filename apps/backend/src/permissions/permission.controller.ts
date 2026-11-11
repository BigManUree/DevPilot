import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { PermissionsControllerService } from './permissions.controller.service';
import type { ToolCallRequest } from './tool-gateway.service';

/**
 * 权限与工具网关 REST API（API 设计第 2 节：审批与权限域）。
 * POST /api/v1/tools/call 为唯一受控执行入口。
 */
@Controller('api/v1')
export class PermissionController {
  constructor(private readonly svc: PermissionsControllerService) {}

  @Get('approvals')
  listApprovals() {
    return this.svc.listApprovals();
  }

  @Post('approvals/:id/approve')
  approve(@Param('id') id: string) {
    return this.svc.approve(id);
  }

  @Post('approvals/:id/reject')
  reject(@Param('id') id: string) {
    return this.svc.reject(id);
  }

  @Get('permissions')
  listPermissions() {
    return this.svc.listPermissions();
  }

  @Get('audit')
  listAudit(@Query('limit') limit?: string) {
    return this.svc.listAudit(limit ? Number(limit) : undefined);
  }

  @Post('tools/call')
  callTool(@Body() req: ToolCallRequest) {
    return this.svc.callTool(req);
  }
}
