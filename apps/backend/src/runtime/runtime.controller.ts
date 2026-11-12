import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { RuntimeService } from './runtime.service';
import { AutoStartService } from './autostart.service';

@Controller('api/v1')
export class RuntimeController {
  constructor(
    private readonly svc: RuntimeService,
    private readonly autostart: AutoStartService,
  ) {}

  /** 一键自动启动：识别自带启动脚本 → 启动 → 失败自动修复 → 重试，直到成功 */
  @Post('projects/:projectId/autostart')
  startAuto(@Param('projectId') projectId: string) {
    return this.autostart.start(projectId);
  }

  @Get('autostart/:jobId')
  autoJob(@Param('jobId') jobId: string) {
    return this.autostart.get(jobId) ?? { error: 'not found' };
  }

  @Get('projects/:projectId/autostart')
  autoLatest(@Param('projectId') projectId: string) {
    return this.autostart.latest(projectId) ?? null;
  }

  /** 只识别不执行：项目根目录里有哪些可用的一键启动脚本 */
  @Get('projects/:projectId/launcher')
  launcher(@Param('projectId') projectId: string) {
    return this.autostart.detect(projectId);
  }

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
