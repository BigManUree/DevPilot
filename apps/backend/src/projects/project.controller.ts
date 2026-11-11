import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ProjectService } from './project.service';

/**
 * 项目 REST API（API 设计第 2 节项目域）。
 */
@Controller('api/v1/projects')
export class ProjectController {
  constructor(private readonly svc: ProjectService) {}

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
