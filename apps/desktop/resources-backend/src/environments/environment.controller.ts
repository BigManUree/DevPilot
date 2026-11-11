import { Controller, Get, Param } from '@nestjs/common';
import { EnvironmentService } from './environment.service';

@Controller('api/v1/environments')
export class EnvironmentController {
  constructor(private readonly svc: EnvironmentService) {}

  @Get()
  detectAll() {
    return this.svc.detectAll();
  }

  @Get('check/:projectId')
  checkProject(@Param('projectId') projectId: string) {
    return this.svc.checkProject(projectId);
  }
}
