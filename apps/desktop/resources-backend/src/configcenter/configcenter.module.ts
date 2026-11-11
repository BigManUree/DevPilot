import { Module } from '@nestjs/common';
import { ConfigCenterService } from './configcenter.service';
import { ConfigCenterController } from './configcenter.controller';
import { PermissionsModule } from '../permissions/permissions.module';

@Module({
  imports: [PermissionsModule],
  providers: [ConfigCenterService],
  controllers: [ConfigCenterController],
  exports: [ConfigCenterService],
})
export class ConfigCenterModule {}
