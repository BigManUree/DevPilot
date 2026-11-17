import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { GitService } from './git.service';
import { parseBoundedInt } from '../http-params';

@Controller('api/v1/git')
export class GitController {
  constructor(private readonly svc: GitService) {}

  @Post('register')
  register(@Body() body: { projectId: string; repoPath: string }) {
    return this.svc.register(body.projectId, body.repoPath);
  }

  @Get('repos')
  listRepos() {
    return this.svc.listRepos();
  }

  @Get('status')
  status(@Query('repoPath') repoPath: string) {
    return this.svc.status(repoPath);
  }

  @Get('branches')
  branches(@Query('repoPath') repoPath: string) {
    return this.svc.branches(repoPath);
  }

  @Get('log')
  log(@Query('repoPath') repoPath: string, @Query('limit') limit?: string) {
    return this.svc.log(repoPath, parseBoundedInt(limit, { fallback: 20, min: 1, max: 200, name: 'limit' }));
  }

  @Get('diff')
  diff(@Query('repoPath') repoPath: string, @Query('file') file?: string) {
    return this.svc.diff(repoPath, file);
  }

  @Post('commit')
  commit(@Body() body: { repoPath: string; message: string; files?: string[] | null; subjectType?: string; subjectId?: string; projectId?: string }) {
    return this.svc.commit(body.repoPath, body.message, body.files ?? null, body.subjectType ?? 'user', body.subjectId ?? 'local-user', body.projectId);
  }

  @Post('checkout')
  checkout(@Body() body: { repoPath: string; branch: string }) {
    return this.svc.switchBranch(body.repoPath, body.branch);
  }

  @Post('discard')
  discard(@Body() body: { repoPath: string; files: string[] }) {
    return this.svc.discard(body.repoPath, body.files);
  }

  @Post('revert')
  revert(@Body() body: { repoPath: string; hash: string }) {
    return this.svc.revertCommit(body.repoPath, body.hash);
  }

  @Post('push')
  push(@Body() body: { repoPath: string; allowPush?: boolean; subjectType?: string; subjectId?: string }) {
    return this.svc.push(body.repoPath, body.allowPush === true, body.subjectType ?? 'user', body.subjectId ?? 'local-user');
  }
}
