import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { parseBoundedInt } from '../http-params';

@Controller('api/v1/notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationService) {}

  @Get()
  list(@Query('unreadOnly') unreadOnly?: string, @Query('limit') limit?: string) {
    return this.svc.list({ unreadOnly: unreadOnly === '1', limit: parseBoundedInt(limit, { fallback: 100, min: 1, max: 500, name: 'limit' }) });
  }

  @Get('unread-count')
  unreadCount() { return this.svc.unreadCount(); }

  @Post()
  create(@Body() body: { type: string; title: string; content?: string; priority?: number }) {
    if (!body || typeof body.type !== 'string' || !body.type.trim()) throw new BadRequestException('type 不能为空');
    if (typeof body.title !== 'string' || !body.title.trim()) throw new BadRequestException('title 不能为空');
    return { id: this.svc.create(body) };
  }

  @Post(':id/read')
  markRead(@Param('id') id: string) { return this.svc.markRead(id); }

  @Post('read-all')
  markAllRead() { return this.svc.markAllRead(); }

  /** 批量删除（勾选的通知，一次最多 500 条） */
  @Post('delete-batch')
  removeBatch(@Body() body: { ids?: string[] }) {
    return this.svc.removeBatch(Array.isArray(body?.ids) ? body.ids : []);
  }

  // ---- 通知规则订阅（二阶段 #6）----
  @Get('rules')
  listRules() { return this.svc.listRules(); }

  @Post('rules')
  createRule(@Body() body: { name: string; typePattern?: string; projectId?: string; minPriority?: number }) {
    return this.svc.createRule(body);
  }

  @Post('rules/:id/update')
  updateRule(@Param('id') id: string, @Body() body: { enabled?: boolean; minPriority?: number; typePattern?: string }) {
    return this.svc.updateRule(id, body);
  }

  @Delete('rules/:id')
  removeRule(@Param('id') id: string) { return this.svc.removeRule(id); }

  @Delete(':id')
  remove(@Param('id') id: string) { return this.svc.remove(id); }
}
