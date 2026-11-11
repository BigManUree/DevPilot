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
    const dir = path.join(
      process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data'),
      'logs',
      new Date().toISOString().slice(0, 10),
    );
    fs.mkdirSync(dir, { recursive: true });
    return dir;
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
    const file = path.join(this.logDir(), `${input.sourceModule}.log`);
    fs.appendFileSync(file, `[${now}] [${input.level.toUpperCase()}] ${input.message}\n`, 'utf-8');
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
    const file = path.join(this.logDir(), `${sourceModule}.log`);
    if (!fs.existsSync(file)) return '';
    const content = fs.readFileSync(file, 'utf-8');
    const arr = content.split('\n');
    return arr.slice(Math.max(0, arr.length - lines)).join('\n');
  }
}
