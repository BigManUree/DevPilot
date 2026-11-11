import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ConfigCenterService } from './configcenter.service';

@Controller('api/v1/config-center')
export class ConfigCenterController {
  constructor(private readonly svc: ConfigCenterService) {}

  @Get('profiles')
  list(@Query('projectId') projectId: string) { return this.svc.listProfiles(projectId); }

  @Post('profiles')
  upsert(@Body() body: { projectId: string; id?: string; name: string; variables: Record<string, string> }) {
    return this.svc.upsertProfile(body.projectId, { id: body.id, name: body.name, variables: body.variables ?? {} });
  }

  @Delete('profiles/:id')
  remove(@Param('id') id: string) { return this.svc.deleteProfile(id); }

  @Post('profiles/:id/activate')
  activate(@Param('id') id: string, @Body() body: { projectId: string }) {
    return this.svc.activate(body.projectId, id);
  }

  @Post('diff')
  diff(@Body() body: { projectId: string; profileA: string; profileB: string }) {
    return this.svc.diffProfiles(body.projectId, body.profileA, body.profileB);
  }
}
