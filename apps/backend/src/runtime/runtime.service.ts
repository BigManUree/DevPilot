import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { spawn, execFile, ChildProcess } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';
import { AuditService } from '../permissions/audit.service';
import { EventsGateway } from '../events.gateway';
import { LogService } from '../logs/log.service';
import { NotificationService } from '../notifications/notification.service';
import type { ServiceStatus } from '@devpilot/shared-types';
import { platform as plat } from '@devpilot/platform-adapters';

interface TrackedProcess {
  serviceId: string;
  sessionId: string;
  /** 外驻实例（非 DevPilot 拉起）没有 child，只有 pid */
  child: ChildProcess | null;
  pid?: number;
  /** true = 端口上已有实例，DevPilot 只接管不重启（如应用自带自动更新拉起的进程） */
  adopted?: boolean;
  startedAt: number;
}

/**
 * 运行时管理（PRD 3.3 + WF-05/06 + 核心执行机制第 4 节）：
 * - 依赖拓扑排序生成启动计划（串行）
 * - 启动会话记录 PID；停止只处理会话内进程（taskkill /T /F 按 PID，不按名称）
 * - 失败隔离：单服务失败只标记该服务，无依赖服务继续
 * - 共享服务保护：被其他项目引用时停止单项目不停止共享服务
 */
@Injectable()
export class RuntimeService implements OnApplicationShutdown, OnModuleInit {
  private tracked = new Map<string, TrackedProcess>(); // serviceId → process

  constructor(
    private readonly ds: DatabaseService,
    private readonly audit: AuditService,
    private readonly events: EventsGateway,
    private readonly logs: LogService,
    private readonly notify: NotificationService,
  ) {}

  onApplicationShutdown() {
    // 后端退出清理：只终止本进程拉起的子进程；外驻实例（adopted）不属我们，不杀
    for (const t of this.tracked.values()) {
      if (t.adopted) continue;
      if (t.child?.pid) this.killProcessTree(t.child.pid);
    }
  }

  /** 异常退出恢复（测试场景 20）：后端被 kill -9 后重启，tracked 会话已丢失，
   *  收敛残留的非终态服务状态并关闭未结束的会话记录。
   *  孤儿子进程（Windows 下父死后仍存活）按 S6 安全设计不主动杀——留给运行中心显式接管。 */
  onModuleInit() {
    const stale = this.ds.db
      .prepare(`SELECT id, name, status FROM project_services WHERE status IN ('Running','Starting','Stopping','Unhealthy')`)
      .all() as Array<{ id: string; name: string; status: string }>;
    for (const s of stale) {
      this.setStatus(s.id, 'Stopped');
      this.logs.log({ level: 'warn', sourceModule: 'runtime.recovery', message: `服务 ${s.name} 状态收敛 Running(${s.status})→Stopped（后端重启恢复）` });
    }
    const closed = this.ds.db
      .prepare('UPDATE runtime_sessions SET stopped_at = ? WHERE stopped_at IS NULL')
      .run(new Date().toISOString());
    if (stale.length || closed.changes) {
      this.logs.log({ level: 'info', sourceModule: 'runtime.recovery', message: `异常退出恢复完成：收敛服务 ${stale.length} 个、关闭会话 ${closed.changes} 个` });
    }
  }

  /** 拓扑排序：depends_on 声明依赖；环检测失败抛错 */
  topoSort(services: Array<{ id: string; name: string; depends_on_json: string | null }>): string[] {
    const deps = new Map<string, string[]>();
    const nameToId = new Map(services.map((s) => [s.name, s.id]));
    for (const s of services) {
      const list = s.depends_on_json ? (JSON.parse(s.depends_on_json) as string[]) : [];
      deps.set(s.id, list.map((n) => nameToId.get(n)).filter(Boolean) as string[]);
    }
    const order: string[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string) => {
      if (state.get(id) === 'done') return;
      if (state.get(id) === 'visiting') throw new Error('service dependency cycle detected');
      state.set(id, 'visiting');
      for (const d of deps.get(id) ?? []) visit(d);
      state.set(id, 'done');
      order.push(id);
    };
    for (const s of services) visit(s.id);
    return order;
  }

  /** 启动整个项目：按拓扑顺序串行启动；失败隔离 */
  async startProject(projectId: string): Promise<{ sessionId: string; plan: Array<{ serviceId: string; status: string }> }> {
    const sessionId = randomUUID();
    const services = this.ds.db
      .prepare('SELECT * FROM project_services WHERE project_id = ?')
      .all(projectId) as Array<{ id: string; name: string; depends_on_json: string | null }>;
    const plan = this.topoSort(services);

    this.ds.db
      .prepare('INSERT INTO runtime_sessions (id, project_id, started_at, pids_json, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, projectId, new Date().toISOString(), '[]', 'user');

    const results: Array<{ serviceId: string; status: string }> = [];
    const startedServices = new Set<string>();
    for (const serviceId of plan) {
      const deps = this.getDepIds(serviceId, services);
      const blocked = deps.some((d) => !startedServices.has(d));
      if (blocked) {
        results.push({ serviceId, status: 'Blocked' });
        this.setStatus(serviceId, 'Failed');
        continue;
      }
      const r = await this.startService(serviceId, sessionId);
      results.push({ serviceId, status: r.status });
      if (r.status === 'Running') startedServices.add(serviceId);
    }
    return { sessionId, plan: results };
  }

  private getDepIds(serviceId: string, services: Array<{ id: string; name: string; depends_on_json: string | null }>): string[] {
    const svc = services.find((s) => s.id === serviceId);
    if (!svc?.depends_on_json) return [];
    const nameToId = new Map(services.map((s) => [s.name, s.id]));
    return (JSON.parse(svc.depends_on_json) as string[])
      .map((n) => nameToId.get(n))
      .filter(Boolean) as string[];
  }

  /** 启动单个服务 */
  async startService(serviceId: string, sessionId?: string): Promise<{ status: ServiceStatus; pid?: number; adopted?: boolean }> {
    const svc = this.ds.db.prepare('SELECT * FROM project_services WHERE id = ?').get(serviceId) as
      | { id: string; project_id: string; name: string; workdir: string; start_command: string | null; port: number | null; env_json: string | null; health_check_json: string | null }
      | undefined;
    if (!svc) throw new Error('service not found');
    if (!svc.start_command) throw new Error(`service ${svc.name} has no start_command`);
    if (this.tracked.has(serviceId)) return { status: 'Running', pid: this.trackedPid(this.tracked.get(serviceId)!) };

    // 端口预检：端口上已有实例在跑时，直接接管，不再重复拉起。
    // 典型场景：应用自带自动更新（如 wb2api 的 update 流程）在 DevPilot 之外重启了 exe，
    // 旧实现会再 spawn 一个 → bind 失败 → exit 1 → 误标 Failed，而服务其实正常。
    if (svc.port) {
      const occupied = await this.portListening(svc.port);
      if (occupied) {
        const pid = await this.findListenerPid(svc.port);
        const httpOk = await this.httpProbe(svc.port, this.healthPath(svc));
        if (httpOk) {
          const sid = sessionId ?? randomUUID();
          this.tracked.set(serviceId, { serviceId, sessionId: sid, child: null, pid, adopted: true, startedAt: Date.now() });
          if (pid) this.appendSessionPids(sid, pid);
          this.setStatus(serviceId, 'Running');
          this.broadcastServiceEvent(serviceId, svc.project_id);
          this.logs.log({
            level: 'warn',
            sourceModule: `service.${svc.name}`,
            projectId: svc.project_id,
            message: `端口 ${svc.port} 已有实例在运行（PID ${pid ?? '未知'}），已接管为外部实例，未重复启动。点「停止」会终止该 PID。`,
          });
          this.audit.record({ subject: 'user:local-user', action: 'service.adopt', target: svc.name, result: 'ok', detail: { pid, port: svc.port } });
          return { status: 'Running', pid, adopted: true };
        }
        const who = pid ? `PID ${pid}` : '其它进程';
        const detail = pid ? await this.describeProcess(pid) : '';
        throw new Error(
          `端口 ${svc.port} 已被 ${who}${detail ? `（${detail}）` : ''} 占用且不响应 HTTP，无法启动。` +
          `请先结束该进程，或在服务配置里改用其它端口。`,
        );
      }
    }

    this.setStatus(serviceId, 'Starting');
    const sid = sessionId ?? randomUUID();
    const { shell, args } = plat.shellFor(svc.start_command);
    const env = svc.env_json ? { ...process.env, ...(JSON.parse(svc.env_json) as Record<string, string>) } : process.env;
    const child = spawn(shell, args, { cwd: svc.workdir, env, windowsHide: true, ...(plat.shellFor(svc.start_command).options ?? {}) });

    this.tracked.set(serviceId, { serviceId, sessionId: sid, child, pid: child.pid, startedAt: Date.now() });
    this.appendSessionPids(sid, child.pid);

    // 输出级别按内容判定，而不是"stderr 一律 error"：
    // Go/Java 等程序把 INFO 也写 stderr（如 wb2api），旧逻辑会把正常运行日志全标红，
    // 既误导人，也会把错误日志喂给诊断 Agent 得出错误根因。
    const emit = (chunk: Buffer | string) => {
      const text = String(chunk).trim();
      if (!text) return;
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logs.log({ level: this.classifyLog(line), sourceModule: `service.${svc.name}`, projectId: svc.project_id, message: line });
      }
    };
    child.stdout?.on('data', emit);
    child.stderr?.on('data', emit);
    // 启动命令本身无法执行（exe 不存在 / 无执行权限）时，exit 事件不一定触发，这里兜底
    child.on('error', (e) => {
      this.tracked.delete(serviceId);
      this.setStatus(serviceId, 'Failed');
      this.broadcastServiceEvent(serviceId, svc.project_id);
      this.logs.log({
        level: 'error', sourceModule: `service.${svc.name}`, projectId: svc.project_id,
        message: `无法执行启动命令「${svc.start_command}」：${e.message}（检查 workdir 下文件是否存在、是否有执行权限）`,
      });
    });
    child.on('exit', (code) => {
      this.tracked.delete(serviceId);
      const current = this.getStatus(serviceId);
      // Stopping 由 stopService 显式处理；其余退出视为 Failed（崩溃）
      if (current === 'Starting' || current === 'Running') {
        this.setStatus(serviceId, code === 0 ? 'Stopped' : 'Failed');
        this.broadcastServiceEvent(serviceId, svc.project_id);
        this.logs.log({ level: code === 0 ? 'info' : 'error', sourceModule: `service.${svc.name}`, projectId: svc.project_id, message: `service exited code=${code}` });
        // 失败原因补充：端口被占用是本地服务最常见的崩溃原因，直接点明，省得只看到 code=1
        if (code !== 0 && svc.port) {
          void (async () => {
            const busy = await this.portListening(svc.port!);
            if (!busy) return;
            const pid = await this.findListenerPid(svc.port!);
            const detail = pid ? `（PID ${pid}${await this.describeProcess(pid) ? `，${await this.describeProcess(pid)}` : ''}）` : '';
            this.logs.log({
              level: 'error', sourceModule: `service.${svc.name}`, projectId: svc.project_id,
              message: `启动失败原因：端口 ${svc.port} 已被其它进程占用${detail}。结束该进程后重新启动即可；再次点「启动」会自动接管已在运行的实例。`,
            });
          })();
        }
        // 自愈：on-failure 策略下自动重启，最多 3 次（PRD 3.9 有限且可配置，不允许无限重启）
        if (code !== 0) void this.maybeAutoRestart(serviceId, svc);
      }
    });

    // 健康检查（端口探活）：25s 覆盖 streamlit / vite 这类冷启动较慢的服务
    const healthy = svc.port ? await this.waitPort(svc.port, 25000) : true;
    if (!healthy) {
      // 进程已经退出时不能标 Unhealthy：那是崩溃（Failed），否则会被上层误判成"还在跑但没监听"
      if (child.exitCode !== null) {
        this.setStatus(serviceId, 'Failed');
        this.broadcastServiceEvent(serviceId, svc.project_id);
        this.logs.log({
          level: 'error', sourceModule: `service.${svc.name}`, projectId: svc.project_id,
          message: `服务在端口 ${svc.port} 就绪前已退出（exit=${child.exitCode}），判定为启动失败`,
        });
        return { status: 'Failed', pid: child.pid };
      }
      this.setStatus(serviceId, 'Unhealthy');
      this.broadcastServiceEvent(serviceId, svc.project_id);
      this.logs.log({
        level: 'warn', sourceModule: `service.${svc.name}`, projectId: svc.project_id,
        message: `进程在运行，但 ${svc.port} 端口 25s 内未监听（可能还没启动完，或监听在其它端口）`,
      });
      return { status: 'Unhealthy', pid: child.pid };
    }

    this.setStatus(serviceId, 'Running');
    this.broadcastServiceEvent(serviceId, svc.project_id);
    this.audit.record({ subject: 'user:local-user', action: 'service.start', target: svc.name, result: 'ok', detail: { pid: child.pid, command: svc.start_command } });
    return { status: 'Running', pid: child.pid };
  }

  /** 停止单个服务：共享服务引用保护 */
  async stopService(serviceId: string, force = false): Promise<{ stopped: boolean; reason?: string }> {
    const svc = this.ds.db.prepare('SELECT * FROM project_services WHERE id = ?').get(serviceId) as
      | { id: string; project_id: string; name: string; shared: number; port: number | null }
      | undefined;
    if (!svc) throw new Error('service not found');

    // 共享服务保护：其他项目是否依赖同名服务；force=true 由用户显式解除保护（落审计）
    if (svc.shared && !force) {
      const otherRefs = this.ds.db
        .prepare(
          `SELECT COUNT(*) n FROM project_services ps
           JOIN projects p ON p.id = ps.project_id
           WHERE ps.name = ? AND ps.project_id != ? AND ps.status IN ('Running','Starting')`,
        )
        .get(svc.name, svc.project_id) as { n: number };
      if (otherRefs.n > 0) {
        return { stopped: false, reason: `shared service ${svc.name} referenced by ${otherRefs.n} other running project(s)` };
      }
    }

    const t = this.tracked.get(serviceId);
    if (!t) {
      this.setStatus(serviceId, 'Stopped');
      return { stopped: true };
    }
    if (force) {
      this.audit.record({ subject: 'user:local-user', action: 'service.stop.force', target: svc.name, result: 'ok', detail: { serviceId } });
    }
    this.setStatus(serviceId, 'Stopping');

    // 外驻实例（接管来的，不归 DevPilot spawn）：只能按 PID 终止
    if (t.adopted) {
      const pid = this.trackedPid(t);
      if (pid && this.pidAlive(pid)) this.killProcessTree(pid);
      await new Promise((r) => setTimeout(r, 800));
      this.tracked.delete(serviceId);
      this.setStatus(serviceId, 'Stopped');
      this.broadcastServiceEvent(serviceId, svc.project_id);
      this.audit.record({
        subject: 'user:local-user', action: 'service.stop', target: svc.name, result: 'ok',
        detail: { pid, method: 'adopted-pid' },
      });
      this.logs.log({ level: 'info', sourceModule: `service.${svc.name}`, projectId: svc.project_id, message: `已终止外部实例 PID ${pid ?? '未知'}（端口 ${svc.port ?? '—'}）` });
      return { stopped: true };
    }

    // 1) 用户配置的 stop_command 优先（优雅停止），等待最多 5 秒
    const full = this.ds.db.prepare('SELECT stop_command FROM project_services WHERE id = ?').get(serviceId) as { stop_command: string | null };
    let graceful = false;
    const pid = this.trackedPid(t);
    if (full?.stop_command) {
      const stop = plat.shellFor(full.stop_command);
      spawn(stop.shell, stop.args,
        { cwd: this.getServiceWorkdir(serviceId), windowsHide: true, ...(stop.options ?? {}) });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        if (t.child?.exitCode !== null && t.child?.exitCode !== undefined) { graceful = true; break; }
        if (!this.pidAlive(pid)) { graceful = true; break; }
      }
      this.logs.log({ level: 'info', sourceModule: 'runtime', message: `service ${svc.name} stop_command issued, graceful=${graceful}` });
    }

    // 2) 回退：会话 PID 树强制终止（按 PID，不按名称）
    if (!graceful) this.killProcessTree(pid);
    // 兜底等待退出
    await new Promise((r) => setTimeout(r, 600));
    this.tracked.delete(serviceId);
    this.setStatus(serviceId, 'Stopped');
    this.broadcastServiceEvent(serviceId, svc.project_id);
    this.audit.record({
      subject: 'user:local-user', action: 'service.stop', target: svc.name, result: 'ok',
      detail: { pid, method: graceful ? 'stop_command' : 'pid-tree' },
    });
    return { stopped: true };
  }

  /** 从单行日志推断级别（stderr 不等于错误：很多运行时会话都写 stderr） */
  private classifyLog(line: string): 'error' | 'warn' | 'info' {
    if (/\b(fatal|panic|traceback)\b|\bERROR\b|\bERR\b|错误|失败|异常|cannot|refused|denied|not found|EADDRINUSE|bind:/i.test(line)) return 'error';
    if (/\bWARN\b|\bWARNING\b|警告|deprecated|retry|timed? ?out/i.test(line)) return 'warn';
    return 'info';
  }

  private trackedPid(t: TrackedProcess): number | undefined {
    return t.pid ?? t.child?.pid;
  }

  /** 单次端口连通检测（不重试，用于启动前预检） */
  private portListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port, timeout: 1200 });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
    });
  }

  /** HTTP 探活：任意响应（含 4xx/5xx）即认为该端口上是一个可用的 HTTP 服务 */
  private httpProbe(port: number, urlPath = '/'): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: urlPath, timeout: 2500, headers: { 'User-Agent': 'DevPilot-probe' } }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
  }

  /** health_check_json 里若给了 http 探针路径则用它，否则探 / */
  private healthPath(svc: { health_check_json?: string | null }): string {
    try {
      if (!svc.health_check_json) return '/';
      const h = JSON.parse(svc.health_check_json) as { path?: string; url?: string };
      if (h?.path) return h.path;
      if (h?.url) {
        const u = new URL(h.url);
        return `${u.pathname}${u.search}` || '/';
      }
    } catch { /* 配置非法则用默认 */ }
    return '/';
  }

  /** 按端口反查监听进程 PID（Windows netstat / *nix lsof），失败返回 undefined */
  private findListenerPid(port: number): Promise<number | undefined> {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const cmd = isWin ? 'netstat' : 'lsof';
      const args = isWin ? ['-ano', '-p', 'TCP'] : ['-ti', `tcp:${port}`, '-sTCP:LISTEN'];
      execFile(cmd, args, { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return resolve(undefined);
        try {
          if (isWin) {
            for (const line of String(stdout).split(/\r?\n/)) {
              if (!/LISTENING/i.test(line)) continue;
              const cols = line.trim().split(/\s+/);
              const local = cols[1] ?? '';
              if (!local.endsWith(`:${port}`)) continue;
              const pid = Number(cols[cols.length - 1]);
              if (Number.isFinite(pid) && pid > 0) return resolve(pid);
            }
            return resolve(undefined);
          }
          const pid = Number(String(stdout).trim().split(/\s+/)[0]);
          resolve(Number.isFinite(pid) && pid > 0 ? pid : undefined);
        } catch { resolve(undefined); }
      });
    });
  }

  /** 进程名 + 可执行路径，用于把"端口被谁占用"讲清楚 */
  private describeProcess(pid: number): Promise<string> {
    if (process.platform !== 'win32') {
      return new Promise((resolve) => execFile('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 4000 }, (_e, out) => resolve(String(out ?? '').trim())));
    }
    return new Promise((resolve) => {
      execFile('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`], { windowsHide: true, timeout: 6000 }, (_e, out) => {
        const name = String(out ?? '').trim();
        resolve(name ? `${name}.exe` : '');
      });
    });
  }

  /** 当前被跟踪的服务（含接管状态），供运行中心区分「DevPilot 启动」与「外部实例」 */
  trackedServices(): Array<{ serviceId: string; sessionId: string; pid?: number; adopted: boolean; startedAt: number }> {
    return [...this.tracked.values()].map((t) => ({
      serviceId: t.serviceId, sessionId: t.sessionId, pid: this.trackedPid(t), adopted: !!t.adopted, startedAt: t.startedAt,
    }));
  }

  private getServiceWorkdir(serviceId: string): string {
    const r = this.ds.db.prepare('SELECT workdir FROM project_services WHERE id = ?').get(serviceId) as { workdir: string } | undefined;
    return r?.workdir ?? process.cwd();
  }

  private pidAlive(pid?: number): boolean {
    if (!pid) return false;
    return plat.pidAlive(pid);
  }

  /** 停止整个项目：仅处理本项目会话创建的进程；共享服务按引用保护跳过 */
  async stopProject(projectId: string): Promise<Array<{ serviceId: string; stopped: boolean; reason?: string }>> {
    const services = this.ds.db
      .prepare(`SELECT id FROM project_services WHERE project_id = ? AND status IN ('Running','Starting','Unhealthy')`)
      .all(projectId) as Array<{ id: string }>;
    const results = [];
    for (const s of services) {
      results.push({ serviceId: s.id, ...(await this.stopService(s.id)) });
    }
    // 会话关闭
    this.ds.db
      .prepare(`UPDATE runtime_sessions SET stopped_at=?, pids_json=? WHERE project_id = ? AND stopped_at IS NULL`)
      .run(new Date().toISOString(), '[]', projectId);
    return results;
  }

  sessions() {
    return this.ds.db.prepare('SELECT * FROM runtime_sessions ORDER BY started_at DESC LIMIT 50').all();
  }

  /** 健康探针：TCP 端口连通 */
  private waitPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const attempt = () => {
        const sock = net.connect({ host: '127.0.0.1', port, timeout: 1500 });
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => {
          sock.destroy();
          if (Date.now() > deadline) resolve(false);
          else setTimeout(attempt, 500);
        });
        sock.once('timeout', () => sock.destroy());
      };
      attempt();
    });
  }

  /** 崩溃自动重启：策略 on-failure 且本后端周期内重启次数 < 3（上限写死，防风暴） */
  private static readonly MAX_AUTO_RESTARTS = 3;
  private restartCounts = new Map<string, number>();

  private async maybeAutoRestart(serviceId: string, svc: { id: string; name: string; project_id: string }): Promise<void> {
    const row = this.ds.db.prepare('SELECT restart_policy FROM project_services WHERE id = ?').get(serviceId) as { restart_policy?: string } | undefined;
    if (!row || row.restart_policy !== 'on-failure') return;
    const count = (this.restartCounts.get(serviceId) ?? 0) + 1;
    if (count > RuntimeService.MAX_AUTO_RESTARTS) {
      this.notify.create({ type: 'service.restart.exhausted', title: `服务 ${svc.name} 自动重启已达上限（3 次）`, content: '请人工排查后手动启动；重启计数在后端重启或手动 start/stop 后清零', priority: 2 });
      this.logs.log({ level: 'error', sourceModule: `service.${svc.name}`, projectId: svc.project_id, message: 'auto-restart limit reached (3), giving up' });
      return;
    }
    this.restartCounts.set(serviceId, count);
    this.logs.log({ level: 'warn', sourceModule: `service.${svc.name}`, projectId: svc.project_id, message: `auto-restarting (${count}/3) after crash` });
    this.notify.create({ type: 'service.restarted', title: `服务 ${svc.name} 崩溃，已自动重启（${count}/3）`, priority: 3 });
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await this.startService(serviceId);
    } catch (e) {
      this.logs.log({ level: 'error', sourceModule: `service.${svc.name}`, projectId: svc.project_id, message: `auto-restart failed: ${String(e).slice(0, 120)}` });
    }
  }

  /** 设置自动重启策略：off | on-failure */
  setRestartPolicy(serviceId: string, policy: 'off' | 'on-failure'): { serviceId: string; restartPolicy: string } {
    const r = this.ds.db.prepare('UPDATE project_services SET restart_policy=? WHERE id=?').run(policy, serviceId);
    if (r.changes === 0) throw new Error('service not found');
    if (policy === 'off') this.restartCounts.delete(serviceId);
    return { serviceId, restartPolicy: policy };
  }

  /** 平台进程树终止：按 PID，不按名称（实现收敛到 platform-adapters） */
  private killProcessTree(pid?: number) {
    if (!pid) return;
    plat.killTree(pid);
  }

  private getStatus(serviceId: string): ServiceStatus {
    const r = this.ds.db.prepare('SELECT status FROM project_services WHERE id = ?').get(serviceId) as { status: ServiceStatus } | undefined;
    return r?.status ?? 'Unknown';
  }

  private setStatus(serviceId: string, status: ServiceStatus) {
    this.ds.db.prepare('UPDATE project_services SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), serviceId);
  }

  private appendSessionPids(sessionId: string, pid?: number) {
    if (!pid) return;
    const row = this.ds.db.prepare('SELECT pids_json FROM runtime_sessions WHERE id = ?').get(sessionId) as { pids_json: string } | undefined;
    if (!row) return;
    const pids = JSON.parse(row.pids_json) as number[];
    pids.push(pid);
    this.ds.db.prepare('UPDATE runtime_sessions SET pids_json = ? WHERE id = ?').run(JSON.stringify(pids), sessionId);
  }

  private broadcastServiceEvent(serviceId: string, projectId: string) {
    const status = this.getStatus(serviceId);
    this.events.broadcast({
      event_id: randomUUID(),
      event_type: 'service.status.changed',
      timestamp: new Date().toISOString(),
      source_module: 'runtime-manager',
      project_id: projectId,
      trace_id: randomUUID(),
      severity: 'info',
      payload: { serviceId, status },
    });
  }
}
