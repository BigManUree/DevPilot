import { Module } from '@nestjs/common';
import { ProjectService } from './project.service';
import { ProjectController } from './project.controller';
import { GitImportService } from './git-import.service';
import { PermissionsModule } from '../permissions/permissions.module';

@Module({
  imports: [PermissionsModule],
  providers: [ProjectService, GitImportService],
  controllers: [ProjectController],
  exports: [ProjectService, GitImportService],
})
export class ProjectsModule {}
