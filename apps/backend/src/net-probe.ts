import net from 'node:net';

/**
 * TCP 连通性探测（统一实现）。
 *
 * 原先 `environments/environment.service.ts`、`projects/config-check.service.ts`、
 * `databases/databases.service.ts` 各写了一份语义相同的实现（参数顺序还不一致），
 * 合并到这里，避免三处各自演进（超时、host 默认值）不一致。
 */

/** 探测 host:port 是否可建立 TCP 连接；超时/拒绝/解析失败一律返回 false，不抛错 */
export function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return resolve(false);
    const sock = net.connect({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** 本机端口是否已被占用（默认 600ms，用于「启动前端口预检」这类快速判断） */
export function portOccupied(port: number, timeoutMs = 600): Promise<boolean> {
  return tcpProbe('127.0.0.1', port, timeoutMs);
}
