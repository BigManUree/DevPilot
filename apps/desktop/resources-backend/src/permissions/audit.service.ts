import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';

/**
 * 审计管理器（安全设计第 11 节）：
 * 记录主体、动作、目标、结果、trace_id 与脱敏后的参数摘要。
 */
@Injectable()
export class AuditService {
  constructor(private readonly ds: DatabaseService) {}

  record(input: {
    subject: string;
    action: string;
    target?: string;
    result: 'ok' | 'denied' | 'error';
    traceId?: string;
    detail?: Record<string, unknown>;
  }): string {
    const id = randomUUID();
    // detail 脱敏：抹掉疑似密钥字段
    const detailSummary = input.detail ? this.redact(input.detail) : null;
    this.ds.db
      .prepare(
        `INSERT INTO audit_records (id, subject, action, target, result, trace_id, detail_summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.subject,
        input.action,
        input.target ?? null,
        input.result,
        input.traceId ?? null,
        detailSummary ? JSON.stringify(detailSummary) : null,
        new Date().toISOString(),
      );
    return id;
  }

  private SENSITIVE_KEY = /(api[_-]?key|token|secret|password|credential|authorization)/i;

  redact(obj: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (this.SENSITIVE_KEY.test(k)) out[k] = '***REDACTED***';
      else if (v && typeof v === 'object' && !Array.isArray(v))
        out[k] = this.redact(v as Record<string, unknown>);
      else out[k] = v;
    }
    return out;
  }

  list(limit = 100) {
    return this.ds.db
      .prepare('SELECT * FROM audit_records ORDER BY created_at DESC LIMIT ?')
      .all(limit);
  }
}
