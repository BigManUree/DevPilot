import { Body, Controller, Delete, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { WorkflowService, WorkflowDefinition } from './workflow.service';

@Controller('api/v1/workflows')
export class WorkflowController {
  constructor(private readonly svc: WorkflowService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post()
  create(@Body() body: { name: string; definition: WorkflowDefinition }) {
    return this.svc.create(body);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    try {
      return this.svc.get(id);
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      throw new NotFoundException(String(e).slice(0, 100));
    }
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    try {
      return this.svc.remove(id);
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      throw new NotFoundException(String(e).slice(0, 100));
    }
  }

  @Post(':id/enable')
  enable(@Param('id') id: string) {
    try {
      return this.svc.setEnabled(id, true);
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      throw new NotFoundException(String(e).slice(0, 100));
    }
  }

  @Post(':id/disable')
  disable(@Param('id') id: string) {
    try {
      return this.svc.setEnabled(id, false);
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      throw new NotFoundException(String(e).slice(0, 100));
    }
  }

  @Post(':id/run')
  async run(@Param('id') id: string) {
    return this.svc.run(id);
  }

  @Get(':id/runs')
  runs(@Param('id') id: string) {
    return this.svc.listRuns(id);
  }

  @Get('runs/:runId')
  runDetail(@Param('runId') runId: string) {
    try {
      return this.svc.getRun(runId);
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      throw new NotFoundException(String(e).slice(0, 100));
    }
  }
}
