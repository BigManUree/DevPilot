import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from './database/database.module';

@Controller('api/v1/system')
export class SystemController {
  constructor(private readonly ds: DatabaseService) {}

  @Get('data-status')
  dataStatus() {
    const v = this.ds.db.prepare('SELECT MAX(version) v, COUNT(*) n FROM schema_migrations').get() as { v: number | null; n: number };
    const tables = (this.ds.db.prepare(
      "SELECT COUNT(*) n FROM sqlite_master WHERE type='table'",
    ).get() as { n: number }).n;
    return { schema_version: v.v, migrations_applied: v.n, tables, status: 'ok' };
  }
}
