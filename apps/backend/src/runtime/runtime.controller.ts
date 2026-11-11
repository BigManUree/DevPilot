import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { RuntimeService } from './runtime.service';

@Controller('api/v1')
export class RuntimeController {
  constructor(private readonly svc: RuntimeService) {}

  @Post('services/:serviceId/start')
  startService(@Param('serviceId') serviceId: string) {
    return this.svc.startService(serviceId);
  }

  @Post('services/:serviceId/stop')
  stopService(@Param('serviceId') serviceId: string) {
    return this.svc.stopService(serviceId);
  }

  @Post('projects/:projectId/start')
  startProject(@Param('projectId') projectId: string) {
    return this.svc.startProject(projectId);
  }

  @Post('projects/:projectId/stop')
  stopProject(@Param('projectId') projectId: string) {
    return this.svc.stopProject(projectId);
  }

  @Get('runtime/sessions')
  sessions() {
    return this.svc.sessions();
  }
}
