import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { RuntimeService } from './runtime.service';

@Controller('api/v1')
export class RuntimeController {
  constructor(private readonly svc: RuntimeService) {}

  @Post('services/:serviceId/start')
  startService(@Param('serviceId') serviceId: string) {
    return this.svc.startService(serviceId);
  }

  /** 设置服务自动重启策略：off | on-failure（有限 3 次） */
  @Post('services/:serviceId/policy')
  setPolicy(@Param('serviceId') serviceId: string, @Body() body: { policy: 'off' | 'on-failure' }) {
    return this.svc.setRestartPolicy(serviceId, body?.policy === 'on-failure' ? 'on-failure' : 'off');
  }

  @Post('services/:serviceId/stop')
  stopService(@Param('serviceId') serviceId: string, @Body() body: { force?: boolean }) {
    return this.svc.stopService(serviceId, body?.force === true);
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

  /** 当前跟踪的进程（含被接管的"外部实例"标记），运行中心用它区分启动来源 */
  @Get('runtime/tracked')
  tracked() {
    return this.svc.trackedServices();
  }
}
