import { Controller, Get } from '@nestjs/common';

@Controller('api/v1')
export class HealthController {
  @Get('health')
  health() {
    return { status: 'ok', version: '0.1.0', time: new Date().toISOString() };
  }
}
