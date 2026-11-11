import { Module } from '@nestjs/common';
import { PermissionService } from './permission.service';
import { AuditService } from './audit.service';
import { ToolGatewayService } from './tool-gateway.service';
import { PermissionsControllerService } from './permissions.controller.service';
import { PermissionController } from './permission.controller';

@Module({
  providers: [PermissionService, AuditService, ToolGatewayService, PermissionsControllerService],
  controllers: [PermissionController],
  exports: [PermissionService, AuditService, ToolGatewayService],
})
export class PermissionsModule {}
