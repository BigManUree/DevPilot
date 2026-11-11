import { Module } from '@nestjs/common';
import { DatabasesService } from './databases.service';
import { DatabasesController, LocalServicesController } from './databases.controller';
import { PermissionsModule } from '../permissions/permissions.module';
import { LogsModule } from '../logs/logs.module';

@Module({
  imports: [PermissionsModule, LogsModule],
  providers: [DatabasesService],
  controllers: [DatabasesController, LocalServicesController],
  exports: [DatabasesService],
})
export class DatabasesModule {}
