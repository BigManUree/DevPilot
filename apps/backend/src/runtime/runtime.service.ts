import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { spawn, ChildProcess } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';
import { AuditService } from '../permissions/audit.service';
import { EventsGateway } from '../events.gateway';
import { LogService } from '../logs/log.service';
import type { ServiceStatus } from '@devpilot/shared-types';
import { platform as plat } from '@devpilot/platform-adapters';

interface TrackedProcess {
  serviceId: string;
  sessionId: string;
  child: ChildProcess;
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
  ) {}

  onApplicationShutdown() {
    // 后端退出清理：终止全部会话进程
    for (const t of this.tracked.values()) this.killProcessTree(t.child.pid);
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
  async startService(serviceId: string, sessionId?: string): Promise<{ status: ServiceStatus; pid?: number }> {
    const svc = this.ds.db.prepare('SELECT * FROM project_services WHERE id = ?').get(serviceId) as
      | { id: string; project_id: string; name: string; workdir: string; start_command: string | null; port: number | null; env_json: string | null }
      | undefined;
    if (!svc) throw new Error('service not found');
    if (!svc.start_command) throw new Error(`service ${svc.name} has no start_command`);
    if (this.tracked.has(serviceId)) return { status: 'Running', pid: this.tracked.get(serviceId)!.child.pid };

    this.setStatus(serviceId, 'Starting');
    const sid = sessionId ?? randomUUID();
    const { shell, args } = plat.shellFor(svc.start_command);
    const env = svc.env_json ? { ...process.env, ...(JSON.parse(svc.env_json) as Record<string, string>) } : process.env;
    const child = spawn(shell, args, { cwd: svc.workdir, env, windowsHide: true });

    this.tracked.set(serviceId, { serviceId, sessionId: sid, child, startedAt: Date.now() });
    this.appendSessionPids(sid, child.pid);

    child.stdout?.on('data', (d) => this.logs.log({ level: 'info', sourceModule: `service.${svc.name}`, projectId: svc.project_id, message: String(d).trim() }));
    child.stderr?.on('data', (d) => this.logs.log({ level: 'error', sourceModule: `service.${svc.name}`, projectId: svc.project_id, message: String(d).trim() }));
    child.on('exit', (code) => {
      this.tracked.delete(serviceId);
      const current = this.getStatus(serviceId);
      // Stopping 由 stopService 显式处理；其余退出视为 Failed（崩溃）
      if (current === 'Starting' || current === 'Running') {
        this.setStatus(serviceId, code === 0 ? 'Stopped' : 'Failed');
        this.broadcastServiceEvent(serviceId, svc.project_id);
        this.logs.log({ level: code === 0 ? 'info' : 'error', sourceModule: `service.${svc.name}`, projectId: svc.project_id, message: `service exited code=${code}` });
      }
    });

    // 健康检查（端口探活）
    const healthy = svc.port ? await this.waitPort(svc.port, 15000) : true;
    if (!healthy) {
      this.setStatus(serviceId, 'Unhealthy');
      this.broadcastServiceEvent(serviceId, svc.project_id);
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
      | { id: string; project_id: string; name: string; shared: number }
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

    // 1) 用户配置的 stop_command 优先（优雅停止），等待最多 5 秒
    const full = this.ds.db.prepare('SELECT stop_command FROM project_services WHERE id = ?').get(serviceId) as { stop_command: string | null };
    let graceful = false;
    if (full?.stop_command) {
      const stop = plat.shellFor(full.stop_command);
      spawn(stop.shell, stop.args,
        { cwd: this.getServiceWorkdir(serviceId), windowsHide: true });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        if (t.child.exitCode !== null || !this.pidAlive(t.child.pid)) { graceful = true; break; }
      }
      this.logs.log({ level: 'info', sourceModule: 'runtime', message: `service ${svc.name} stop_command issued, graceful=${graceful}` });
    }

    // 2) 回退：会话 PID 树强制终止（按 PID，不按名称）
    if (!graceful) this.killProcessTree(t.child.pid);
    // 兜底等待退出
    await new Promise((r) => setTimeout(r, 600));
    this.tracked.delete(serviceId);
    this.setStatus(serviceId, 'Stopped');
    this.broadcastServiceEvent(serviceId, svc.project_id);
    this.audit.record({
      subject: 'user:local-user', action: 'service.stop', target: svc.name, result: 'ok',
      detail: { pid: t.child.pid, method: graceful ? 'stop_command' : 'pid-tree' },
    });
    return { stopped: true };
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
