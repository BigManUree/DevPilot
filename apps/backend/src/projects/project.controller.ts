import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ProjectService } from './project.service';
import { GitImportService } from './git-import.service';

/**
 * 项目 REST API（API 设计第 2 节项目域）。
 */
@Controller('api/v1/projects')
export class ProjectController {
  constructor(
    private readonly svc: ProjectService,
    private readonly git: GitImportService,
  ) {}

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

  @Post(':projectId/services')
  createService(
    @Param('projectId') projectId: string,
    @Body() body: Parameters<ProjectService['createService']>[1],
  ) {
    return this.svc.createService(projectId, body);
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

  @Post(':projectId/confirm')
  confirm(@Param('projectId') projectId: string) {
    return this.svc.confirm(projectId);
  }

  @Delete(':projectId')
  remove(@Param('projectId') projectId: string, @Query('deleteFiles') deleteFiles?: string) {
    return this.svc.remove(projectId, deleteFiles === 'true');
  }
}
