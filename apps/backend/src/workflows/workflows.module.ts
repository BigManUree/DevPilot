import { Module } from '@nestjs/common';
import { WorkflowController } from './workflow.controller';
import { WorkflowService } from './workflow.service';
import { PermissionsModule } from '../permissions/permissions.module';
import { AgentsModule } from '../agents/agents.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EventsModule } from '../events.module';
import { LogsModule } from '../logs/logs.module';

@Module({
  imports: [PermissionsModule, AgentsModule, NotificationsModule, EventsModule, LogsModule],
  controllers: [WorkflowController],
  providers: [WorkflowService],
  exports: [WorkflowService],
})
export class WorkflowsModule {}
