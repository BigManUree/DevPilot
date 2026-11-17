import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
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

  /** 审批模式查询：manual（默认逐条审批）| auto（完全访问） */
  @Get('permissions/mode')
  getMode() {
    return this.svc.getMode();
  }

  /** 切换审批模式（开启完全访问 = 自动批准全部工具操作，含高危） */
  @Post('permissions/mode')
  setMode(@Body() body: { mode?: string }) {
    return this.svc.setMode(body?.mode === 'auto' ? 'auto' : 'manual');
  }

  @Get('audit')
  listAudit(@Query('limit') limit?: string) {
    return this.svc.listAudit(limit);
  }

  @Post('tools/call')
  callTool(@Body() req: ToolCallRequest) {
    // 审计 F-04/F-05：缺字段/未知工具必须在入口 400，不能落到 service 里抛 TypeError（Nest 兜底 500）
    const body = (req ?? {}) as Partial<ToolCallRequest>;
    const subjects = ['user', 'supervisor', 'agent', 'plugin', 'external', 'workflow'];
    const tools = ['fs.read', 'fs.write', 'command.exec'];
    if (!body.subjectType || !subjects.includes(body.subjectType)) {
      throw new BadRequestException(`subjectType 必须是 ${subjects.join('/')} 之一`);
    }
    if (!body.subjectId || typeof body.subjectId !== 'string') {
      throw new BadRequestException('缺少 subjectId');
    }
    if (!body.tool || !tools.includes(body.tool)) {
      throw new BadRequestException(`tool 必须是 ${tools.join('/')} 之一`);
    }
    if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
      throw new BadRequestException('params 必须是对象');
    }
    return this.svc.callTool(body as ToolCallRequest);
  }
}
