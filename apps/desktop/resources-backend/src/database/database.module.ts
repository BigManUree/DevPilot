import { Global, Module, OnApplicationShutdown, Injectable } from '@nestjs/common';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from './database';

export const DATA_DIR = process.env.DEVIPILOT_DATA_DIR
  ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data');

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly db: Database.Database;

  constructor() {
    applyPendingRestore(DATA_DIR);
    this.db = openDatabase(DATA_DIR);
  }

  onApplicationShutdown() {
    this.db.close();
  }
}

/**
 * 统一备份迁移：恢复支持。
 * 恢复操作不直接覆盖打开中的 DB 文件，而是落 devpilot.restore.db + restore.pending.json，
 * 下次后端启动在打开数据库前执行替换。
 */
function applyPendingRestore(dataDir: string) {
  const marker = path.join(dataDir, 'restore.pending.json');
  if (!fs.existsSync(marker)) return;
  const restoreDb = path.join(dataDir, 'devpilot.restore.db');
  const target = path.join(dataDir, 'devpilot.db');
  if (fs.existsSync(restoreDb)) {
    fs.copyFileSync(restoreDb, target);
    fs.rmSync(restoreDb, { force: true });
  }
  fs.rmSync(marker, { force: true });
}

@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
