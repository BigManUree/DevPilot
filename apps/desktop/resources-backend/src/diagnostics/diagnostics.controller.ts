import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { RepairLoopService } from './repair-loop.service';

@Controller('api/v1')
export class DiagnosticsController {
  constructor(private readonly svc: RepairLoopService) {}

  @Post('diagnostics')
  run(@Body() body: { projectId?: string; logExcerpt: string; verifyCommand: string; cwd?: string }) {
    return this.svc.diagnose(body);
  }

  @Get('diagnostics/:id')
  get(@Param('id') id: string) {
    return this.svc.get(id) ?? { error: 'not found' };
  }
}
