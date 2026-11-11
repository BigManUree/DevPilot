import { Module } from '@nestjs/common';
import { RepairLoopService } from './repair-loop.service';
import { DiagnosticsController } from './diagnostics.controller';
import { PermissionsModule } from '../permissions/permissions.module';
import { EventsModule } from '../events.module';
import { LogsModule } from '../logs/logs.module';
import { AgentsModule } from '../agents/agents.module';

@Module({
  imports: [PermissionsModule, EventsModule, LogsModule, AgentsModule],
  providers: [RepairLoopService],
  controllers: [DiagnosticsController],
  exports: [RepairLoopService],
})
export class DiagnosticsModule {}
