import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';
import { EventsGateway } from '../events.gateway';

/**
 * 通知中心：
 * - 通知落库（notifications 表 V1 已有）+ WS 实时推送 notification.new
 * - 通知规则订阅（二阶段 #6）：存在启用规则时，通知须命中至少一条规则才落库推送；
 *   无规则时保持全量通过（向后兼容）
 * - NotificationService 导出，供 agents/diagnostics 等模块在任务完成、审批产生时调用
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly ds: DatabaseService,
    private readonly events: EventsGateway,
  ) {}

  /** 规则匹配：type_pattern 支持 * 与前缀通配（task.*），min_priority 只收 priority ≤ 阈值的通知 */
  private matches(rule: { type_pattern: string; project_id: string | null; min_priority: number }, type: string, priority: number): boolean {
    const pat = rule.type_pattern;
    if (pat !== '*' && !pat.endsWith('*') && pat !== type && !type.startsWith(pat + '.')) return false;
    if (pat.endsWith('*') && pat !== '*' && !type.startsWith(pat.slice(0, -1))) return false;
    if (priority > rule.min_priority) return false;
    return true;
  }

  create(input: { type: string; title: string; content?: string; priority?: number; eventId?: string; projectId?: string }): string {
    const rules = this.ds.db.prepare('SELECT * FROM notification_rules WHERE enabled = 1').all() as Array<{
      type_pattern: string; project_id: string | null; min_priority: number;
    }>;
    if (rules.length > 0) {
      const priority = input.priority ?? 5;
      const hit = rules.some((r) => this.matches(r, input.type, priority));
      if (!hit) return ''; // 被规则过滤：不落库不推送
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.ds.db.prepare(
      `INSERT INTO notifications (id, event_id, type, title, content_summary, read, priority, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, input.eventId ?? null, input.type, input.title, input.content ?? null, input.priority ?? 5, now);
    this.events.broadcast({
      event_id: id,
      event_type: 'notification.new',
      timestamp: now,
      source_module: 'notifications',
      trace_id: randomUUID(),
      severity: input.priority !== undefined && input.priority <= 3 ? 'warn' : 'info',
      payload: { notificationId: id, type: input.type, title: input.title, content: input.content ?? '' },
    });
    return id;
  }

  // ---- 通知规则订阅（二阶段 #6） ----
  listRules() {
    return this.ds.db.prepare('SELECT * FROM notification_rules ORDER BY created_at DESC').all();
  }

  createRule(body: { name: string; typePattern?: string; projectId?: string; minPriority?: number }) {
    if (!body.name?.trim()) throw new ConflictException('规则名称不能为空');
    const dup = this.ds.db.prepare('SELECT id FROM notification_rules WHERE name = ?').get(body.name) as { id: string } | undefined;
    if (dup) throw new ConflictException(`同名通知规则已存在：${body.name}`);
    const id = randomUUID();
    this.ds.db.prepare(
      `INSERT INTO notification_rules (id, name, type_pattern, project_id, min_priority, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).run(id, body.name, body.typePattern ?? '*', body.projectId ?? null, body.minPriority ?? 5, new Date().toISOString());
    return { id };
  }

  updateRule(id: string, body: { enabled?: boolean; minPriority?: number; typePattern?: string }) {
    const r = this.ds.db.prepare('SELECT id FROM notification_rules WHERE id = ?').get(id) as { id: string } | undefined;
    if (!r) throw new NotFoundException(`通知规则不存在：${id}`);
    if (body.enabled !== undefined) this.ds.db.prepare('UPDATE notification_rules SET enabled = ? WHERE id = ?').run(body.enabled ? 1 : 0, id);
    if (body.minPriority !== undefined) this.ds.db.prepare('UPDATE notification_rules SET min_priority = ? WHERE id = ?').run(body.minPriority, id);
    if (body.typePattern !== undefined) this.ds.db.prepare('UPDATE notification_rules SET type_pattern = ? WHERE id = ?').run(body.typePattern, id);
    return { id };
  }

  removeRule(id: string) {
    const r = this.ds.db.prepare('DELETE FROM notification_rules WHERE id = ?').run(id);
    if (r.changes === 0) throw new NotFoundException(`通知规则不存在：${id}`);
    return { ok: true };
  }

  list(filter: { unreadOnly?: boolean; limit?: number }) {
    const where = filter.unreadOnly ? 'WHERE read = 0' : '';
    return this.ds.db.prepare(`SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(filter.limit ?? 100);
  }

  unreadCount() {
    return (this.ds.db.prepare('SELECT COUNT(*) n FROM notifications WHERE read = 0').get() as { n: number }).n;
  }

  markRead(id: string) {
    this.ds.db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
    return { ok: true };
  }

  markAllRead() {
    this.ds.db.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
    return { ok: true };
  }

  remove(id: string) {
    this.ds.db.prepare('DELETE FROM notifications WHERE id = ?').run(id);
    return { ok: true };
  }

  /** 批量删除：仅允许传入存在且数量受控的 ID 清单 */
  removeBatch(ids: string[]): { ok: boolean; deleted: number; error?: string } {
    if (!Array.isArray(ids) || !ids.length) return { ok: false, deleted: 0, error: 'ids 不能为空' };
    if (ids.length > 500) return { ok: false, deleted: 0, error: '单次最多删除 500 条' };
    const stmt = this.ds.db.prepare('DELETE FROM notifications WHERE id = ?');
    const run = this.ds.db.transaction(() => {
      let deleted = 0;
      for (const id of ids) {
        if (typeof id !== 'string' || !id.trim()) continue;
        deleted += stmt.run(id).changes;
      }
      return deleted;
    });
    return { ok: true, deleted: run() };
  }
}
