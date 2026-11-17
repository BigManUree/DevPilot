import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { EnvironmentService } from './environment.service';

@Controller('api/v1/environments')
export class EnvironmentController {
  constructor(private readonly svc: EnvironmentService) {}

  @Get()
  detectAll(@Query('refresh') refresh?: string) {
    return this.svc.detectAll(refresh === '1');
  }

  @Get('check/:projectId')
  checkProject(@Param('projectId') projectId: string) {
    return this.svc.checkProject(projectId);
  }

  /** 多版本扫描（真实执行版本命令验证每个候选） */
  @Get('scan-versions')
  scanVersions() {
    return this.svc.scanAllVersions();
  }

  /** 项目要求 vs 本机多版本 匹配（基于项目组件树档案中的版本约束） */
  @Get('match/:projectId')
  matchProject(@Param('projectId') projectId: string) {
    return this.svc.matchProject(projectId);
  }

  /** 外部服务探活（MySQL/Redis/... 端口连通 + 进程名识别） */
  @Get('services/:projectId')
  checkServices(@Param('projectId') projectId: string) {
    return this.svc.checkExternalServices(projectId);
  }

  /** 环境变量缺失检查（.env.example / application.yml vs 项目 .env 与 env_json） */
  @Get('env-vars/:projectId')
  checkEnvVars(@Param('projectId') projectId: string) {
    return this.svc.checkEnvVars(projectId);
  }

  /** 配置向导保存：验证用户输入 → 写回项目根 .env → 返回仍未通过项（循环直到全部可用） */
  @Post('env-config/:projectId')
  saveEnvConfig(@Param('projectId') projectId: string, @Body() body: { values?: Record<string, string> }) {
    return this.svc.saveEnvConfig(projectId, body?.values ?? {});
  }
}
