import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { DatabasesService } from './databases.service';

@Controller('api/v1/databases')
export class DatabasesController {
  constructor(private readonly svc: DatabasesService) {}

  @Get('connections')
  list() { return this.svc.listConnections(); }

  @Post('connections')
  upsert(@Body() body: Parameters<DatabasesService['upsertConnection']>[0]) { return this.svc.upsertConnection(body); }

  @Post('connections/:id/test')
  test(@Param('id') id: string) { return this.svc.testConnection(id); }

  @Delete('connections/:id')
  remove(@Param('id') id: string) { return this.svc.deleteConnection(id); }

  @Get('detect')
  detect() { return this.svc.detectLocalServices(); }
}

@Controller('api/v1/local-services')
export class LocalServicesController {
  constructor(private readonly svc: DatabasesService) {}

  @Get()
  list() { return this.svc.listLocalServices(); }

  @Post()
  upsert(@Body() body: Parameters<DatabasesService['upsertLocalService']>[0]) { return this.svc.upsertLocalService(body); }

  @Post(':id/start')
  start(@Param('id') id: string) { return this.svc.startLocalService(id); }

  @Post(':id/stop')
  stop(@Param('id') id: string) { return this.svc.stopLocalService(id); }

  @Post(':id/check')
  check(@Param('id') id: string) { return this.svc.checkLocalService(id); }

  @Delete(':id')
  remove(@Param('id') id: string) { return this.svc.deleteLocalService(id); }
}
