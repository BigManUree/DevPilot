import { Body, Controller, Delete, Get, Param, Post, NotFoundException, ConflictException } from '@nestjs/common';
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
  setKey(@Body() body: { provider?: string; apiKey: string; model?: string; baseUrl?: string }) {
    return this.model.setApiKey(body.provider ?? 'deepseek', body.apiKey, { model: body.model, baseUrl: body.baseUrl });
  }

  @Post('models/switch')
  switchProvider(@Body() body: { provider: string }) {
    return this.model.switchProvider(body.provider);
  }

  @Get('models/providers')
  listProviders() {
    return this.model.listProviders();
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

  /** 工具注册中心清单（前端展示 + 审批规则可视化） */
  @Get('tools')
  listTools() {
    return this.agents.listTools();
  }

  // ---- 任务 ----
  @Post('tasks')
  createTask(@Body() body: { goal: string; projectId?: string }) {
    return this.agents.createTask(body);
  }

  /** 外部主体（MCP 等）触发执行：审批双门，pending 时返回 approvalId 供审批中心处理 */
  @Post('tasks/:taskId/run-external')
  runExternal(@Param('taskId') taskId: string) {
    try {
      return this.agents.runExternal(taskId);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      return { started: false, error: err instanceof Error ? err.message : String(err) };
    }
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

  /** 重命名任务会话（仅改显示标题） */
  @Post('tasks/:taskId/rename')
  renameTask(@Param('taskId') taskId: string, @Body() body: { title?: string }) {
    try {
      return this.agents.renameTask(taskId, body?.title ?? '');
    } catch (err) {
      if (err instanceof NotFoundException || err instanceof ConflictException) throw err;
      return { taskId, title: '', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 删除任务会话（级联清理执行记录/计划版本/记忆）；执行中的任务需先取消 */
  @Delete('tasks/:taskId')
  deleteTask(@Param('taskId') taskId: string) {
    try {
      return this.agents.deleteTask(taskId);
    } catch (err) {
      if (err instanceof NotFoundException || err instanceof ConflictException) throw err;
      return { taskId, deleted: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  @Post('tasks/:taskId/pause')
  pauseTask(@Param('taskId') taskId: string) {
    return this.agents.pauseTask(taskId);
  }

  @Post('tasks/:taskId/resume')
  resumeTask(@Param('taskId') taskId: string) {
    return this.agents.resumeTask(taskId);
  }

  @Post('tasks/:taskId/respond-input')
  async respondInput(@Param('taskId') taskId: string, @Body() body: { answer: string; run?: boolean }) {
    return this.agents.respondInput(taskId, body.answer, body.run !== false);
  }
}
