import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, WebSocket } from 'ws';
// 显式导入 WebSocket：Electron 内置 Node 20 无全局 WebSocket（Node 22+ 才有），
// 依赖全局会在桌面壳拉起时于装饰器元数据处 ReferenceError
import type { DevPilotEvent } from '@devpilot/shared-types';

/**
 * WebSocket 网关：实时事件推送通道。
 * 客户端可发送 { type: 'terminal.input', sessionId, data } 做终端输入；
 * 其余消息类型由 messageHandler 注册方处理。
 */
@WebSocketGateway({ path: '/ws' })
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  /** 注册消息处理器（供 terminal 等模块使用） */
  messageHandler?: (data: { type?: string; sessionId?: string; data?: string }) => void;

  private clients = new Set<WebSocket>();

  afterInit() {
    // eslint-disable-next-line no-console
    console.log('[ws] gateway initialized on /ws');
  }

  handleConnection(client: WebSocket) {
    this.clients.add(client);
  }

  handleDisconnect(client: WebSocket) {
    this.clients.delete(client);
  }

  broadcast(event: DevPilotEvent) {
    const data = JSON.stringify(event);
    for (const c of this.clients) {
      if (c.readyState === WebSocket.OPEN) c.send(data);
    }
  }

  /** WsAdapter 按 message.event 路由；兼容 message.type 写法 */
  @SubscribeMessage('terminal.input')
  onTerminalInput(client: WebSocket, payload: { sessionId?: string; data?: string }) {
    this.messageHandler?.({ type: 'terminal.input', sessionId: payload.sessionId, data: payload.data });
    return { event: 'terminal.ack', data: 'ok' };
  }
}
