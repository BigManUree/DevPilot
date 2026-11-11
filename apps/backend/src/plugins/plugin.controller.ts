import { Body, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { PluginService } from './plugin.service';

@Controller('api/v1/plugins')
export class PluginController {
  constructor(private readonly svc: PluginService) {}

  @Get()
  list() {
    return this.svc.list();
  }

  @Post('reload')
  reload() {
    return this.svc.reload();
  }

  @Post(':id/enable')
  enable(@Param('id') id: string) {
    try {
      return this.svc.setEnabled(id, true);
    } catch {
      throw new NotFoundException(`插件不存在：${id}`);
    }
  }

  @Post(':id/disable')
  disable(@Param('id') id: string) {
    try {
      return this.svc.setEnabled(id, false);
    } catch {
      throw new NotFoundException(`插件不存在：${id}`);
    }
  }
}
