import { Module } from '@nestjs/common';
import { GitService } from './git.service';
import { GitController } from './git.controller';
import { PermissionsModule } from '../permissions/permissions.module';
import { LogsModule } from '../logs/logs.module';

@Module({
  imports: [PermissionsModule, LogsModule],
  providers: [GitService],
  controllers: [GitController],
  exports: [GitService],
})
export class GitModule {}
