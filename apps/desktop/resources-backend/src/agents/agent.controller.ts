import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ModelService } from './model.service';
import { AgentService } from './agent.service';

@Controller('api/v1')
export class AgentController {
  constructor(
    private readonly model: ModelService,
    private readonly agents: AgentService,
  ) {}

  // ---- 模型配置 ----
  @Post('models/config')
  setKey(@Body() body: { provider?: 'deepseek'; apiKey: string }) {
    return this.model.setApiKey(body.provider ?? 'deepseek', body.apiKey);
  }

  @Get('models/status')
  modelStatus() {
    return this.model.status();
  }

  // ---- Agent ----
  @Get('agents')
  listAgents() {
    return this.agents.list();
  }

  // ---- 任务 ----
  @Post('tasks')
  createTask(@Body() body: { goal: string; projectId?: string }) {
    return this.agents.createTask(body);
  }

  @Post('tasks/:taskId/run')
  async runTask(@Param('taskId') taskId: string) {
    try {
      return await this.agents.runTask(taskId);
    } catch (err) {
      return { status: 'Failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Get('tasks')
  listTasks() {
    return this.agents.listTasks();
  }

  @Get('tasks/:taskId')
  getTask(@Param('taskId') taskId: string) {
    return this.agents.getTask(taskId);
  }

  @Post('tasks/:taskId/cancel')
  cancelTask(@Param('taskId') taskId: string) {
    return this.agents.cancelTask(taskId);
  }
}
