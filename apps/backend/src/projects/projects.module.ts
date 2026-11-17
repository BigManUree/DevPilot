import { Module } from '@nestjs/common';
import { ProjectService } from './project.service';
import { ProjectController } from './project.controller';
import { GitImportService } from './git-import.service';
import { UnifiedImportService } from './import/import.service';
import { ConfigCheckService } from './config-check.service';
import { PermissionsModule } from '../permissions/permissions.module';
import { LogsModule } from '../logs/logs.module';
import { AgentsModule } from '../agents/agents.module';
import { EventsModule } from '../events.module';

@Module({
  imports: [PermissionsModule, LogsModule, AgentsModule, EventsModule],
  providers: [ProjectService, GitImportService, UnifiedImportService, ConfigCheckService],
  controllers: [ProjectController],
  exports: [ProjectService, GitImportService, UnifiedImportService, ConfigCheckService],
})
export class ProjectsModule {}
