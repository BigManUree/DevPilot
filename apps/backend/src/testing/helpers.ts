/** 测试基础设施：内存 SQLite + 真实 MIGRATIONS，构造与生产一致形状的 DatabaseService 替身 */
import Database from 'better-sqlite3';
import { MIGRATIONS } from '../database/database';

export function makeMemoryDs(): { db: Database.Database } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  for (const m of MIGRATIONS) {
    m.up(db);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(m.version, m.name, new Date().toISOString());
  }
  return { db };
}

/** 通用 stub 构造：用对象形状冒充任意注入依赖 */
export function stub<T>(overrides: Partial<Record<string, unknown>> = {}): T {
  return overrides as unknown as T;
}
