import fs from 'node:fs';
import path from 'node:path';

/**
 * 后端启动计时。与 Electron 主进程共用同一份 trace 文件与同一 0 点：
 * 主进程 spawn 时通过 DEVIPILOT_STARTUP_T0 传入自己的绝对启动时刻，
 * 因此这里记下的毫秒数可以直接和「窗口首帧」「后端可服务」放在同一时间轴上比较。
 */
const T0 = Number(process.env.DEVIPILOT_STARTUP_T0) || (Date.now() - Math.round(process.uptime() * 1000));

function traceFile(): string | null {
  if (process.env.DEVIPILOT_STARTUP_TRACE === '0') return null;
  const base = process.env.DEVIPILOT_DATA_DIR
    ? path.dirname(process.env.DEVIPILOT_DATA_DIR)
    : path.join(process.env.APPDATA ?? process.cwd(), 'devpilot');
  try {
    fs.mkdirSync(base, { recursive: true });
    return path.join(base, 'startup-trace.jsonl');
  } catch {
    return null;
  }
}

export function markBackend(mark: string, detail?: Record<string, unknown>): void {
  const file = traceFile();
  if (!file) return;
  const rec = {
    mark: `backend.${mark}`,
    sinceProcessStartMs: Date.now() - T0,
    wall: Date.now(),
    pid: process.pid,
    ...detail,
  };
  try {
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  } catch { /* 落盘失败不影响启动 */ }
  if (process.env.DEVIPILOT_STARTUP_TRACE === 'console') {
    // eslint-disable-next-line no-console
    console.log(`[startup] ${rec.sinceProcessStartMs}ms ${rec.mark}`);
  }
}
