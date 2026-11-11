import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { PermissionsModule } from '../permissions/permissions.module';

@Module({
  imports: [PermissionsModule],
  controllers: [WorkspaceController],
})
export class WorkspaceModule {}
