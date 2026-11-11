import { Controller, Get, Post, Query, Body, Param } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';

/**
 * 记忆系统：三层 scope（global / project / task）+ 关键词检索。
 * content_ref 即正文（本地实现直接存文本；跨设备迁移时才换对象存储引用）。
 */
@Controller('api/v1/memories')
export class MemoryController {
  constructor(private readonly ds: DatabaseService) {}

  @Post()
  create(@Body() b: { scope: 'global' | 'project' | 'task'; content: string; projectId?: string; taskId?: string; agentId?: string; source?: string; confidence?: number }) {
    if (!['global', 'project', 'task'].includes(b.scope)) throw new Error('scope must be global|project|task');
    const id = randomUUID();
    this.ds.db.prepare(
      `INSERT INTO memories (id, scope, project_id, task_id, agent_id, content_ref, source, confidence, version, access_policy, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'local', ?)`,
    ).run(id, b.scope, b.projectId ?? null, b.taskId ?? null, b.agentId ?? null,
      b.content, b.source ?? 'manual', b.confidence ?? 0.5, new Date().toISOString());
    return { id, scope: b.scope };
  }

  /** 关键词检索（LIKE 分词 AND 匹配），scope 过滤，按 confidence+时间排序 */
  @Get('search')
  search(@Query('q') q: string, @Query('scope') scope?: string, @Query('projectId') projectId?: string, @Query('limit') limit = '20') {
    const terms = (q || '').trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return { rows: [] };
    const where: string[] = [];
    const args: string[] = [];
    if (scope) { where.push('scope = ?'); args.push(scope); }
    if (projectId) { where.push('project_id = ?'); args.push(projectId); }
    for (const t of terms) { where.push('content_ref LIKE ?'); args.push(`%${t}%`); }
    const rows = this.ds.db.prepare(
      `SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY confidence DESC, created_at DESC LIMIT ?`,
    ).all(...args, Number(limit));
    return { rows, total: rows.length };
  }

  @Get()
  list(@Query('scope') scope?: string, @Query('projectId') projectId?: string, @Query('limit') limit = '50') {
    const where: string[] = [];
    const args: string[] = [];
    if (scope) { where.push('scope = ?'); args.push(scope); }
    if (projectId) { where.push('project_id = ?'); args.push(projectId); }
    const sql = `SELECT * FROM memories ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
    return this.ds.db.prepare(sql).all(...args, Number(limit));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    // 访问即提升 confidence（越用越可信，文档 04 记忆规则）
    this.ds.db.prepare('UPDATE memories SET confidence = MIN(1.0, confidence + 0.05) WHERE id = ?').run(id);
    return this.ds.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as any ?? null;
  }

  @Post(':id/delete')
  remove(@Param('id') id: string) {
    this.ds.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return { deleted: true };
  }
}
