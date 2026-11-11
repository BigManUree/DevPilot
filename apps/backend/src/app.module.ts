import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DatabaseModule } from './database/database.module';
import { SystemController } from './system.controller';
import { PermissionsModule } from './permissions/permissions.module';
import { ProjectsModule } from './projects/projects.module';
import { RuntimeModule } from './runtime/runtime.module';
import { EventsModule } from './events.module';
import { TerminalModule } from './terminal/terminal.module';
import { LogsModule } from './logs/logs.module';
import { EnvironmentsModule } from './environments/environments.module';
import { AgentsModule } from './agents/agents.module';
import { DiagnosticsModule } from './diagnostics/diagnostics.module';
import { GitModule } from './git/git.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { MemoryModule } from './memory/memory.module';
import { DatabasesModule } from './databases/databases.module';
import { ExternalToolsModule } from './externaltools/externaltools.module';
import { ConfigCenterModule } from './configcenter/configcenter.module';
import { BackupModule } from './backup/backup.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PluginsModule } from './plugins/plugins.module';
import { WorkflowsModule } from './workflows/workflows.module';

@Module({
  imports: [DatabaseModule, EventsModule, LogsModule, PermissionsModule, ProjectsModule, RuntimeModule, TerminalModule, EnvironmentsModule, AgentsModule, DiagnosticsModule, GitModule, WorkspaceModule, MemoryModule, DatabasesModule, ExternalToolsModule, ConfigCenterModule, BackupModule, NotificationsModule, PluginsModule, WorkflowsModule],
  controllers: [HealthController, SystemController],
})
export class AppModule {}
