import fs from 'node:fs';
import path from 'node:path';

/**
 * 启动计时（冷启动性能可观测化）。
 *
 * 口径：以「主进程创建」为 0 点（`process.uptime()` 即从进程创建算起），
 * 每次 mark 记录相对启动毫秒数与墙钟，追加写入 `<APPDATA>/devpilot/startup-trace.jsonl`。
 * 渲染层的首帧同样会上报（经 preload → IPC），所以「窗口画出来花了多久」是可测的，
 * 不再靠人肉秒表。scripts/startup-bench.mjs 读取该文件给出各阶段耗时。
 *
 * 关闭：DEVIPILOT_STARTUP_TRACE=0；输出到 stdout：DEVIPILOT_STARTUP_TRACE=console。
 * 开销：每条 mark 一次同步 append（<1ms），文件按行数滚动（保留最近 400 行）。
 */

export interface StartupMark {
  mark: string;
  sinceProcessStartMs: number;
  wall: number;
}

const MAX_LINES = 400;
let traceFile: string | null = null;
let wroteCount = 0;

function resolveTraceFile(): string | null {
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

function rotateIfNeeded(file: string): void {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 256 * 1024) {
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
      fs.writeFileSync(file, lines.slice(-MAX_LINES).join('\n') + '\n');
      wroteCount = Math.min(lines.length, MAX_LINES);
    }
  } catch { /* 文件不存在或不可读：忽略 */ }
}

/** 记录一个启动阶段 */
export function markStartup(mark: string, detail?: Record<string, unknown>): void {
  if (process.env.DEVIPILOT_STARTUP_TRACE === '0') return;
  const rec: StartupMark & Record<string, unknown> = {
    mark,
    sinceProcessStartMs: Math.round(process.uptime() * 1000),
    wall: Date.now(),
    ...detail,
  };
  if (process.env.DEVIPILOT_STARTUP_TRACE === 'console') {
    // eslint-disable-next-line no-console
    console.log(`[startup] ${rec.sinceProcessStartMs}ms ${mark}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  }
  if (!traceFile) traceFile = resolveTraceFile();
  if (!traceFile) return;
  try {
    if (wroteCount === 0) rotateIfNeeded(traceFile);
    fs.appendFileSync(traceFile, JSON.stringify(rec) + '\n');
    wroteCount += 1;
  } catch { /* 落盘失败不影响启动 */ }
}

/** 最近一次运行的 marks（供 UI/测试读取；进程重启后自然变化） */
export function readStartupTrace(): StartupMark[] {
  if (!traceFile) traceFile = resolveTraceFile();
  if (!traceFile) return [];
  try {
    const lines = fs.readFileSync(traceFile, 'utf-8').trim().split('\n');
    const all = lines.map((l) => { try { return JSON.parse(l) as StartupMark; } catch { return null; } })
      .filter((x): x is StartupMark => !!x);
    // 以 processStart 为界截取本次运行
    const startIdx = all.map((m) => m.mark).lastIndexOf('process.start');
    return startIdx >= 0 ? all.slice(startIdx) : all;
  } catch {
    return [];
  }
}
