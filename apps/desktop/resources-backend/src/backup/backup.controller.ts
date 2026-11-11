import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { BackupService } from './backup.service';

@Controller('api/v1/backups')
export class BackupController {
  constructor(private readonly svc: BackupService) {}

  @Post()
  create(@Body() body: { backupType?: 'full' | 'manual' }) {
    return this.svc.create(body?.backupType ?? 'manual');
  }

  @Get()
  list() { return this.svc.list(); }

  @Post(':id/verify')
  verify(@Param('id') id: string) { return this.svc.verify(id); }

  @Post(':id/restore')
  restore(@Param('id') id: string) { return this.svc.restore(id); }

  @Post('export-project')
  exportProject(@Body() body: { projectId: string }) { return this.svc.exportProject(body.projectId); }

  @Post('import-project')
  importProject(@Body() body: { bundlePath: string }) { return this.svc.importProject(body.bundlePath); }
}
