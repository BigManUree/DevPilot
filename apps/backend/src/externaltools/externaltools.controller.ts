import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ExternalToolsService } from './externaltools.service';

@Controller('api/v1/external-tools')
export class ExternalToolsController {
  constructor(private readonly svc: ExternalToolsService) {}

  @Get()
  detect() { return this.svc.detectTools(); }

  @Post('open-ide')
  openIde(@Body() body: { toolId: string; projectPath: string }) {
    return this.svc.openInIde(body.toolId, body.projectPath);
  }

  @Post('open-url')
  openUrl(@Body() body: { toolId?: string; url: string }) {
    return this.svc.openUrl(body.toolId ?? null, body.url);
  }

  @Get('avds')
  avds() { return this.svc.listAvds(); }

  @Post('launch-emulator')
  launch(@Body() body: { avd: string }) { return this.svc.launchEmulator(body.avd); }

  // ---- 命令级联动（需求 7.2 分级 2 级）----
  @Get(':toolId/actions')
  listActions(@Param('toolId') toolId: string) { return this.svc.listActions(toolId); }

  @Post(':toolId/actions')
  createAction(@Param('toolId') toolId: string, @Body() body: { actionName: string; commandTemplate: string; timeoutMs?: number }) {
    return this.svc.createAction(toolId, body);
  }

  @Post(':toolId/actions/:actionId/run')
  runAction(@Param('toolId') toolId: string, @Param('actionId') actionId: string, @Body() body: { vars?: Record<string, string> }) {
    return this.svc.runAction(toolId, actionId, body?.vars);
  }

  @Delete(':toolId/actions/:actionId')
  removeAction(@Param('toolId') toolId: string, @Param('actionId') actionId: string) {
    return this.svc.removeAction(toolId, actionId);
  }
}
