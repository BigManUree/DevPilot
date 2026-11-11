import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { TerminalService } from './terminal.service';
import { LogService } from '../logs/log.service';

/**
 * 终端与日志 REST（API 设计：日志与诊断域 + 终端域）。
 */
@Controller('api/v1')
export class TerminalController {
  constructor(
    private readonly terminal: TerminalService,
    private readonly logs: LogService,
  ) {}

  // ---- 终端 ----
  @Post('terminal/sessions')
  createTerminal(@Body() body: { cwd?: string }) {
    return this.terminal.create(body?.cwd);
  }

  @Get('terminal/sessions')
  listTerminals() {
    return this.terminal.list();
  }

  @Get('terminal/sessions/:sessionId/buffer')
  terminalBuffer(@Param('sessionId') sessionId: string) {
    return { buffer: this.terminal.getBuffer(sessionId) ?? '' };
  }

  @Delete('terminal/sessions/:sessionId')
  killTerminal(@Param('sessionId') sessionId: string) {
    return { killed: this.terminal.kill(sessionId) };
  }

  // ---- 日志 ----
  @Get('logs')
  queryLogs(
    @Query('level') level?: string,
    @Query('sourceModule') sourceModule?: string,
    @Query('projectId') projectId?: string,
    @Query('taskId') taskId?: string,
    @Query('traceId') traceId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.logs.query({
      level, sourceModule, projectId, taskId, traceId,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('logs/tail')
  tailLogs(@Query('sourceModule') sourceModule: string, @Query('lines') lines?: string) {
    return { sourceModule, tail: this.logs.tail(sourceModule, lines ? Number(lines) : 200) };
  }
}
