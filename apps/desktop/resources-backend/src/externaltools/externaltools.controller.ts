import { Body, Controller, Get, Post } from '@nestjs/common';
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
}
