import { Module } from '@nestjs/common';
import { ModelService } from './model.service';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { PermissionsModule } from '../permissions/permissions.module';
import { EventsModule } from '../events.module';
import { LogsModule } from '../logs/logs.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PermissionsModule, EventsModule, LogsModule, NotificationsModule],
  providers: [ModelService, AgentService],
  controllers: [AgentController],
  exports: [ModelService, AgentService],
})
export class AgentsModule {}
