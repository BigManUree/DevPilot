import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { NotificationService } from './notification.service';

@Controller('api/v1/notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationService) {}

  @Get()
  list(@Query('unreadOnly') unreadOnly?: string, @Query('limit') limit?: string) {
    return this.svc.list({ unreadOnly: unreadOnly === '1', limit: limit ? Number(limit) : undefined });
  }

  @Get('unread-count')
  unreadCount() { return this.svc.unreadCount(); }

  @Post()
  create(@Body() body: { type: string; title: string; content?: string; priority?: number }) {
    return { id: this.svc.create(body) };
  }

  @Post(':id/read')
  markRead(@Param('id') id: string) { return this.svc.markRead(id); }

  @Post('read-all')
  markAllRead() { return this.svc.markAllRead(); }

  @Delete(':id')
  remove(@Param('id') id: string) { return this.svc.remove(id); }
}
