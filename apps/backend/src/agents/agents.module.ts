import { Module, forwardRef } from '@nestjs/common';
import { ModelService } from './model.service';
import { AgentService } from './agent.service';
import { AgentController } from './agent.controller';
import { ToolRegistryService } from './tool-registry';
import { PermissionsModule } from '../permissions/permissions.module';
import { EventsModule } from '../events.module';
import { LogsModule } from '../logs/logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EnvironmentsModule } from '../environments/environments.module';
import { RuntimeModule } from '../runtime/runtime.module';

@Module({
  imports: [
    PermissionsModule,
    EventsModule,
    LogsModule,
    NotificationsModule,
    EnvironmentsModule,
    forwardRef(() => RuntimeModule),
  ],
  providers: [ModelService, AgentService, ToolRegistryService],
  controllers: [AgentController],
  exports: [ModelService, AgentService, ToolRegistryService],
})
export class AgentsModule {}
