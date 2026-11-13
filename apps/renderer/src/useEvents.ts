import { useEffect, useRef } from 'react';
import { wsUrl } from './api';

export interface DevPilotEvent {
  event_id: string;
  event_type: string;
  timestamp: string;
  source_module: string;
  task_id?: string;
  project_id?: string;
  severity: string;
  payload: Record<string, unknown>;
}

type Listener = (event: DevPilotEvent) => void;

/** 全局 WS 事件总线（单连接多订阅），订阅后返回取消函数 */
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let connecting = false;

function ensureSocket() {
  if (socket || connecting) return;
  connecting = true;
  void wsUrl().then((url) => {
    try {
      socket = new WebSocket(url);
      socket.addEventListener('message', (msg) => {
        try {
          const data = JSON.parse(String(msg.data)) as DevPilotEvent;
          for (const fn of listeners) {
            try { fn(data); } catch { /* 单个订阅者异常不影响其他 */ }
          }
        } catch { /* 非 JSON 帧忽略 */ }
      });
      socket.addEventListener('close', () => {
        socket = null;
        connecting = false;
        // 断线重连（3s）
        setTimeout(ensureSocket, 3000);
      });
      socket.addEventListener('error', () => { /* close 会跟进 */ });
      connecting = false;
    } catch {
      socket = null;
      connecting = false;
    }
  });
}

/** React Hook：订阅指定事件类型（支持通配 '*'） */
export function useDevPilotEvents(types: string[], handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    ensureSocket();
    const fn: Listener = (event) => {
      if (types.includes('*') || types.includes(event.event_type)) ref.current(event);
    };
    listeners.add(fn);
    return () => { listeners.delete(fn); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.join(',')]);
}
