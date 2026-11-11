import { Module } from '@nestjs/common';
import { RuntimeService } from './runtime.service';
import { RuntimeController } from './runtime.controller';
import { PermissionsModule } from '../permissions/permissions.module';
import { EventsModule } from '../events.module';
import { LogsModule } from '../logs/logs.module';

@Module({
  imports: [PermissionsModule, EventsModule, LogsModule],
  providers: [RuntimeService],
  controllers: [RuntimeController],
  exports: [RuntimeService],
})
export class RuntimeModule {}
