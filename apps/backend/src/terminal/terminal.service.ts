import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventsGateway } from '../events.gateway';
import { LogService } from '../logs/log.service';
import { platform as plat } from '@devpilot/platform-adapters';

/**
 * 终端会话管理（PRD 3.10）：
 * - 每个会话独立 shell 子进程，cwd 可指定项目/服务目录
 * - stdout/stderr 流式经 WS terminal.data 推送；用户输入经 WS terminal.input 写入 stdin
 * - 会话列表与终止；后端退出清理全部会话
 */
@Injectable()
export class TerminalService implements OnApplicationShutdown {
  private sessions = new Map<string, { child: ChildProcess; cwd: string; buffer: string[] }>();

  constructor(
    private readonly events: EventsGateway,
    private readonly logs: LogService,
  ) {}

  onApplicationShutdown() {
    for (const s of this.sessions.values()) s.child.kill();
  }

  create(cwd?: string): { sessionId: string; cwd: string } {
    const sessionId = randomUUID();
    const workdir = cwd ?? process.cwd();
    const ishell = plat.interactiveShell();
    const child = spawn(ishell.shell, ishell.args, { cwd: workdir, windowsHide: true });

    const session = { child, cwd: workdir, buffer: [] as string[] };
    this.sessions.set(sessionId, session);

    const push = (data: string) => {
      session.buffer.push(data);
      if (session.buffer.length > 5000) session.buffer.shift();
      this.events.broadcast({
        event_id: randomUUID(),
        event_type: 'terminal.data',
        timestamp: new Date().toISOString(),
        source_module: 'terminal',
        trace_id: sessionId,
        severity: 'info',
        payload: { sessionId, data },
      });
    };
    child.stdout?.on('data', (d) => push(String(d)));
    child.stderr?.on('data', (d) => push(String(d)));
    child.on('exit', (code) => {
      push(`\r\n[session exited code=${code}]\r\n`);
      this.sessions.delete(sessionId);
    });
    this.logs.log({ level: 'info', sourceModule: 'terminal', message: `session created cwd=${workdir}` });
    return { sessionId, cwd: workdir };
  }

  write(sessionId: string, input: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.child.stdin?.write(input);
    return true;
  }

  kill(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.child.kill();
    this.sessions.delete(sessionId);
    return true;
  }

  list(): Array<{ sessionId: string; cwd: string; running: boolean }> {
    return [...this.sessions.entries()].map(([id, s]) => ({
      sessionId: id,
      cwd: s.cwd,
      running: !s.child.killed && s.child.exitCode === null,
    }));
  }

  /** 取会话输出缓冲（断线恢复用） */
  getBuffer(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.buffer.join('');
  }
}
