import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ProjectService } from './project.service';
import { GitImportService } from './git-import.service';
import { UnifiedImportService } from './import/import.service';
import { ConfigCheckService } from './config-check.service';

/**
 * 项目 REST API（API 设计第 2 节项目域）。
 */
@Controller('api/v1/projects')
export class ProjectController {
  constructor(
    private readonly svc: ProjectService,
    private readonly git: GitImportService,
    private readonly unified: UnifiedImportService,
    private readonly configCheck: ConfigCheckService,
  ) {}

  /** 统一导入入口：folder/git/archive/http/docker/scan 全来源同一流程（异步 job + 真实进度 + 取消） */
  @Post('import/unified')
  importUnified(
    @Body()
    body: { source: 'folder' | 'git' | 'archive' | 'http' | 'docker' | 'scan'; ref: string; name?: string; branch?: string; composeFile?: string },
  ) {
    return this.unified.start(body);
  }

  @Get('import/unified/:jobId')
  importUnifiedJob(@Param('jobId') jobId: string) {
    return this.unified.get(jobId) ?? { error: 'not found' };
  }

  @Post('import/unified/:jobId/cancel')
  importUnifiedCancel(@Param('jobId') jobId: string) {
    return this.unified.cancel(jobId);
  }

  /** 从 GitHub / 任意 git 远端导入：异步 job，前端轮询看克隆与识别进度 */
  @Post('import-git')
  importGit(@Body() body: { repoUrl: string; branch?: string; targetDir?: string; name?: string }) {
    return this.git.start(body);
  }

  @Get('import-git/:jobId')
  importGitJob(@Param('jobId') jobId: string) {
    return this.git.get(jobId) ?? { error: 'not found' };
  }

  @Post('import')
  import(
    @Body()
    body: {
      source: 'folder' | 'drag' | 'script' | 'git' | 'archive' | 'scan';
      rootPath?: string;
      gitUrl?: string;
      archivePath?: string;
      scanDir?: string;
      name?: string;
    },
  ) {
    return this.svc.import(body);
  }

  @Get('scan-candidates')
  scanCandidates(@Query('dir') dir: string) {
    return { candidates: this.svc.scanDirectories(dir) };
  }

  /**
   * 配置体检：.env 完整性 / 占位符 / API Key 真实可用性 / 数据库连通 / 端口占用 / 启动命令可疑性。
   * probe=0 只做静态检查；默认 probe=1 会真实调用一次提供商接口（约 1-8s）。
   */
  @Get(':projectId/config-check')
  checkConfig(@Param('projectId') projectId: string, @Query('probe') probe?: string) {
    return this.configCheck.check(projectId, { probe: probe !== '0' });
  }

  /** 项目组件树档案（技术栈/版本约束/环境变量/外部服务 + 证据） */
  @Get(':projectId/profile')
  getProfile(@Param('projectId') projectId: string) {
    return this.svc.getProfile(projectId);
  }

  /** 运行档案（run_archives）+ 修复记录（repair_records_v2） */
  @Get(':projectId/archives')
  getArchives(@Param('projectId') projectId: string) {
    return this.svc.getArchives(projectId);
  }

  /** 项目图标：本地图片上传（base64，≤2MB）；无图标时 dataUrl=null（前端回退字母头像） */
  @Get(':projectId/icon')
  getIcon(@Param('projectId') projectId: string) {
    return this.svc.iconDataUrl(projectId);
  }

  @Post(':projectId/icon')
  setIcon(
    @Param('projectId') projectId: string,
    @Body() body: { dataBase64?: string; fileName?: string },
  ) {
    return this.svc.setIcon(projectId, String(body?.dataBase64 ?? ''), String(body?.fileName ?? ''));
  }

  @Delete(':projectId/icon')
  clearIcon(@Param('projectId') projectId: string) {
    return this.svc.clearIcon(projectId);
  }

  @Post(':projectId/services')
  createService(
    @Param('projectId') projectId: string,
    @Body() body: Parameters<ProjectService['createService']>[1],
  ) {
    return this.svc.createService(projectId, body);
  }

  @Delete(':projectId/services/:serviceId')
  deleteService(@Param('projectId') projectId: string, @Param('serviceId') serviceId: string) {
    return this.svc.deleteService(projectId, serviceId);
  }

  @Get()
  list() {
    return this.svc.list();
  }

  @Get(':projectId')
  get(@Param('projectId') projectId: string) {
    return this.svc.get(projectId);
  }

  @Post(':projectId/analyze')
  reanalyze(@Param('projectId') projectId: string) {
    return this.svc.reanalyze(projectId);
  }

  /** 重新生成项目简介（Agent 扫描项目） */
  @Post(':projectId/description')
  async regenerateDescription(@Param('projectId') projectId: string) {
    return this.svc.regenerateDescription(projectId);
  }

  @Post(':projectId/confirm')
  confirm(@Param('projectId') projectId: string) {
    return this.svc.confirm(projectId);
  }

  @Delete(':projectId')
  remove(
    @Param('projectId') projectId: string,
    @Query('deleteFiles') deleteFiles?: string,
    @Query('confirm') confirm?: string,
  ) {
    return this.svc.remove(projectId, deleteFiles === 'true', confirm);
  }
}
