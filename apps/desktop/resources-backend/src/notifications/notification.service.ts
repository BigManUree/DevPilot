import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';
import { EventsGateway } from '../events.gateway';

/**
 * 通知中心：
 * - 通知落库（notifications 表 V1 已有）+ WS 实时推送 notification.new
 * - NotificationService 导出，供 agents/diagnostics 等模块在任务完成、审批产生时调用
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly ds: DatabaseService,
    private readonly events: EventsGateway,
  ) {}

  create(input: { type: string; title: string; content?: string; priority?: number; eventId?: string }): string {
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
}
