import { Module, Global } from '@nestjs/common';
import { MemoryController } from './memory.controller';
import { DatabaseModule } from '../database/database.module';

@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [MemoryController],
})
export class MemoryModule {}
