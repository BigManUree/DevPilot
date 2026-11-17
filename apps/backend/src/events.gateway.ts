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
import { authToken } from './auth';

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

  /** 允许的 WS 来源：本地开发前端 + 无 Origin（非浏览器客户端/测试） */
  private static readonly ALLOWED_ORIGINS = new Set([
    'http://localhost:5173', 'http://127.0.0.1:5173',
    'http://localhost:4173', 'http://127.0.0.1:4173',
  ]);

  handleConnection(client: WebSocket, ...args: unknown[]) {
    // 防浏览器跨站 WebSocket（drive-by）：任意网页可尝试连接 ws://127.0.0.1:37100/ws
    // 并注入 terminal.input / 读取事件流。浏览器一定带 Origin 头，校验不通过即断开。
    //
    // 审计 S-02 修复：旧实现放行 `origin === 'null'`，而 `<iframe sandbox="allow-scripts">`
    // 发起的 WS，Origin 恰好就是字符串 `null` → 任意网页可劫持终端。现在：
    // - 白名单来源：放行（DevPilot 自己的前端）
    // - 无 Origin：放行（curl/脚本等非浏览器客户端）
    // - `null` / file:// / 其它来源：必须携带 ?token=<本机 token>，否则 1008 断开
    const req = (args[0] ?? {}) as { headers?: Record<string, string | string[] | undefined>; url?: string };
    const rawOrigin = req.headers?.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;

    const url = req.url ?? '';
    const qs = url.includes('?') ? new URLSearchParams(url.slice(url.indexOf('?') + 1)) : new URLSearchParams();
    const token = qs.get('token') ?? '';

    let allowed: boolean;
    if (origin === undefined) {
      allowed = true; // 非浏览器客户端
    } else if (EventsGateway.ALLOWED_ORIGINS.has(origin)) {
      allowed = true; // DevPilot 开发前端
    } else {
      // `null`（sandbox iframe / data: / file:）与任意第三方站点：必须带本机 token
      allowed = !!token && token === authToken();
    }

    if (!allowed) {
      try { client.close(1008, 'origin not allowed'); } catch { /* ignore */ }
      return;
    }
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
