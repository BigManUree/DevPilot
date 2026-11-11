import { Module } from '@nestjs/common';
import { LogService } from './log.service';
import { EventsModule } from '../events.module';

@Module({
  imports: [EventsModule],
  providers: [LogService],
  exports: [LogService],
})
export class LogsModule {}
