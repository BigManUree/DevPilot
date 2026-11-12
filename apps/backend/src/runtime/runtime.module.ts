import { Module } from '@nestjs/common';
import { RuntimeService } from './runtime.service';
import { RuntimeController } from './runtime.controller';
import { AutoStartService } from './autostart.service';
import { AutoFixerService } from './auto-fixer.service';
import { PermissionsModule } from '../permissions/permissions.module';
import { EventsModule } from '../events.module';
import { LogsModule } from '../logs/logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [PermissionsModule, EventsModule, LogsModule, NotificationsModule, AgentsModule],
  providers: [RuntimeService, AutoFixerService, AutoStartService],
  controllers: [RuntimeController],
  exports: [RuntimeService, AutoStartService],
})
export class RuntimeModule {}
