import { Module, OnModuleInit } from '@nestjs/common';
import { TerminalService } from './terminal.service';
import { TerminalController } from './terminal.controller';
import { EventsModule } from '../events.module';
import { EventsGateway } from '../events.gateway';
import { LogsModule } from '../logs/logs.module';

@Module({
  imports: [EventsModule, LogsModule],
  providers: [TerminalService],
  controllers: [TerminalController],
  exports: [TerminalService],
})
export class TerminalModule implements OnModuleInit {
  constructor(
    private readonly events: EventsGateway,
    private readonly terminal: TerminalService,
  ) {}

  onModuleInit() {
    // 终端输入经 WS 网关转发到 TerminalService
    this.events.messageHandler = (msg) => {
      if (msg.type === 'terminal.input' && msg.sessionId && typeof msg.data === 'string') {
        this.terminal.write(msg.sessionId, msg.data);
      }
    };
  }
}
