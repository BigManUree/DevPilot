import { Module } from '@nestjs/common';
import { PluginController } from './plugin.controller';
import { PluginService } from './plugin.service';
import { PermissionsModule } from '../permissions/permissions.module';
import { LogsModule } from '../logs/logs.module';
import { EventsModule } from '../events.module';

@Module({
  imports: [PermissionsModule, LogsModule, EventsModule],
  controllers: [PluginController],
  providers: [PluginService],
  exports: [PluginService],
})
export class PluginsModule {}
