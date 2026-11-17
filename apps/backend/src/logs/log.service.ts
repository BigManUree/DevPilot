import { Injectable } from '@nestjs/common';
import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../database/database.module';
import { EventsGateway } from '../events.gateway';

/**
 * 日志管理（PRD 3.12）：
 * - 正文写入文件 data/logs/YYYY-MM-DD/<source>.log，元数据入 logs 表（body_ref 引用）
 * - WS runtime.log 实时推送
 * - 检索：级别/来源/项目/任务/trace 过滤 + 文件尾部读取
 */
@Injectable()
export class LogService {
  constructor(
    private readonly ds: DatabaseService,
    private readonly events: EventsGateway,
  ) {}

  private logDir(): string {
    const base = path.join(
      process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data'),
      'logs',
    );
    const dir = path.join(base, new Date().toISOString().slice(0, 10));
    fs.mkdirSync(dir, { recursive: true });
    this.pruneOldLogs(base);
    return dir;
  }

  /** 日志保留策略（审计 P-04）：只保留最近 N 天（默认 14，DEVIPILOT_LOG_KEEP_DAYS 可调）。
   *  每天首次写日志时检查一次；只删形如 YYYY-MM-DD 的目录，其它文件不碰。 */
  private pruneOldLogs(base: string): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.prunedOn === today) return;
    this.prunedOn = today;
    const keepDays = Math.max(1, Number(process.env.DEVIPILOT_LOG_KEEP_DAYS ?? 14) || 14);
    const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
    try {
      for (const name of fs.readdirSync(base)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
        const dir = path.join(base, name);
        let st: fs.Stats;
        try { st = fs.statSync(dir); } catch { continue; }
        if (!st.isDirectory() || st.mtimeMs >= cutoff) continue;
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          // eslint-disable-next-line no-console
          console.log(`[logs] 清理过期日志目录 ${name}（保留 ${keepDays} 天）`);
        } catch { /* 单个目录删不掉不影响写日志 */ }
      }
    } catch { /* 目录不可读忽略 */ }
  }

  private prunedOn: string | null = null;

  /** 日志文件名清洗：sourceModule 可能来自用户/npm 包名（如 `@career-ops/web`），
   *  其中的 / \ : 等字符会被当成路径分隔符 → ENOENT → 未捕获异常炸掉整个后端进程。 */
  private safeFileName(sourceModule: string): string {
    return sourceModule.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'unnamed';
  }

  log(input: {
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
    sourceModule: string;
    message: string;
    projectId?: string;
    taskId?: string;
    agentId?: string;
    traceId?: string;
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    // 日志写失败只降级（DB/WS 仍保留该条），绝不炸进程——日志是旁路不是关键路径
    let file = '';
    try {
      file = path.join(this.logDir(), `${this.safeFileName(input.sourceModule)}.log`);
      fs.appendFileSync(file, `[${now}] [${input.level.toUpperCase()}] ${input.message}\n`, 'utf-8');
    } catch { /* 磁盘满/权限等：静默降级 */ }
    this.ds.db
      .prepare(
        `INSERT INTO logs (id, level, source_module, project_id, task_id, agent_id, trace_id, created_at, body_ref, redacted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(id, input.level, input.sourceModule, input.projectId ?? null, input.taskId ?? null, input.agentId ?? null, input.traceId ?? null, now, file);

    this.events.broadcast({
      event_id: id,
      event_type: 'runtime.log',
      timestamp: now,
      source_module: input.sourceModule,
      project_id: input.projectId,
      task_id: input.taskId,
      agent_id: input.agentId,
      trace_id: input.traceId ?? randomUUID(),
      severity: input.level,
      payload: { message: input.message },
    });
    return id;
  }

  /** 检索：过滤条件 + 分页 */
  query(filter: {
    level?: string;
    sourceModule?: string;
    projectId?: string;
    taskId?: string;
    traceId?: string;
    limit?: number;
    offset?: number;
  }) {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.level) { conds.push('level = ?'); params.push(filter.level); }
    if (filter.sourceModule) { conds.push('source_module = ?'); params.push(filter.sourceModule); }
    if (filter.projectId) { conds.push('project_id = ?'); params.push(filter.projectId); }
    if (filter.taskId) { conds.push('task_id = ?'); params.push(filter.taskId); }
    if (filter.traceId) { conds.push('trace_id = ?'); params.push(filter.traceId); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = this.ds.db
      .prepare(`SELECT * FROM logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, filter.limit ?? 100, filter.offset ?? 0);
    const total = (this.ds.db.prepare(`SELECT COUNT(*) n FROM logs ${where}`).get(...params) as { n: number }).n;
    return { total, rows };
  }

  /** 读取某来源日志文件尾部 */
  tail(sourceModule: string, lines = 200): string {
    const file = path.join(this.logDir(), `${this.safeFileName(sourceModule)}.log`);
    if (!fs.existsSync(file)) return '';
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const arr = content.split('\n');
      return arr.slice(Math.max(0, arr.length - lines)).join('\n');
    } catch { return ''; }
  }
}
