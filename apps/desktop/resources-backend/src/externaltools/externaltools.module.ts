import { Module } from '@nestjs/common';
import { ExternalToolsService } from './externaltools.service';
import { ExternalToolsController } from './externaltools.controller';
import { PermissionsModule } from '../permissions/permissions.module';
import { LogsModule } from '../logs/logs.module';

@Module({
  imports: [PermissionsModule, LogsModule],
  providers: [ExternalToolsService],
  controllers: [ExternalToolsController],
  exports: [ExternalToolsService],
})
export class ExternalToolsModule {}
