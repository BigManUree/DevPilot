import { ConflictException, Injectable, NotFoundException, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { spawn, execFile, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';
import { AuditService } from '../permissions/audit.service';
import { EventsGateway } from '../events.gateway';
import { LogService } from '../logs/log.service';
import { NotificationService } from '../notifications/notification.service';
import type { ServiceStatus } from '@devpilot/shared-types';
import { platform as plat, cleanServiceEnv } from '@devpilot/platform-adapters';

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
      const r = await this.startService(serviceId, sessionId).catch((e: unknown) => {
        // 失败隔离（审计 S-03 配套）：单个服务启动失败（端口被外部进程占用、
        // 缺启动命令等）只标记该服务，不能让整个项目启动循环中断——
        // 否则一个端口冲突会把同项目里能跑的服务也一起拖成"没启动"。
        const name = services.find((s) => s.id === serviceId)?.name ?? serviceId;
        this.setStatus(serviceId, 'Failed');
        this.logs.log({
          level: 'error',
          sourceModule: `service.${name}`,
          projectId,
          message: `启动失败（继续启动其余服务）：${String((e as Error)?.message ?? e).slice(0, 300)}`,
        });
        return { status: 'Failed' as ServiceStatus };
      });
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

  /**
   * 探测服务的真实浏览器访问路径并落库。
   * 来源优先级：
   *   1) 服务日志里出现的 http://(127.0.0.1|localhost):<port>/<path>（如 wb2api 的 /panel）
   *   2) 根路径 3xx 重定向链终点（如 / → /panel）
   *   3) 都没有 → '/'（前端只显示裸地址）
   * 返回最终 access_path（可能为 '/'）。
   */
  async detectAccessUrl(serviceId: string): Promise<{ accessPath: string; url: string }> {
    let svc = this.ds.db.prepare('SELECT * FROM project_services WHERE id = ?').get(serviceId) as
      | { id: string; name: string; port: number | null }
      | undefined;
    if (!svc) throw new Error('service not found');
    // 端口缺失 → 先从运行日志自学习（Next 自定义 server 等场景），学不到才放弃
    let port = svc.port;
    if (!port) {
      const learned = this.learnPortFromLogs(svc.name);
      if (!learned) throw new Error(`service ${svc.name} 未配置端口且日志中无监听地址`);
      port = learned;
    }

    const fromLog = this.accessPathFromLogs(port, svc.name);
    const fromRedirect = await this.finalPathAfterRedirects(port, '/');
    let accessPath = '/';
    if (fromLog && fromLog !== '/') accessPath = fromLog;
    else if (fromRedirect && fromRedirect !== '/') accessPath = fromRedirect;

    this.ds.db
      .prepare('UPDATE project_services SET access_path = ?, updated_at = ? WHERE id = ?')
      .run(accessPath, new Date().toISOString(), serviceId);
    return { accessPath, url: `http://127.0.0.1:${port}${accessPath === '/' ? '' : accessPath}` };
  }

  /**
   * 为 CLI 型服务打开一个可见的命令行窗口（用户直接使用 CLI 项目）：
   * 在服务工作目录写 .devpilot/terminal.bat（激活 .venv + 打印用法提示），
   * 用 start 在新控制台窗口运行，窗口最后保留交互 shell。
   * CLI 项目不是常驻服务，启动校验通过后「能用的形态」就是这个窗口。
   */
  async openTerminal(serviceId: string): Promise<{ opened: boolean; script: string }> {
    const svc = this.ds.db.prepare('SELECT * FROM project_services WHERE id = ?').get(serviceId) as
      | { id: string; project_id: string; name: string; workdir: string; start_command: string | null; usage_hint?: string | null }
      | undefined;
    if (!svc) throw new Error('service not found');
    if (process.platform !== 'win32') throw new Error('命令行窗口功能目前仅支持 Windows');

    // 用法提示（分析器生成）：args 附加到自动运行的命令（如 sherlock 的 --local），
    // example 是含 <占位符> 的完整示例，展示给用户。
    let hintArgs = '';
    let hintExample = '';
    let hintNote = '';
    if (svc.usage_hint) {
      try {
        const hint = JSON.parse(svc.usage_hint) as { example?: string; note?: string; args?: string };
        hintArgs = (hint.args ?? '').trim();
        hintExample = (hint.example ?? '').trim();
        hintNote = (hint.note ?? '').trim();
      } catch { /* 损坏的 JSON 当没有提示处理 */ }
    }

    const dir = path.join(svc.workdir, '.devpilot');
    fs.mkdirSync(dir, { recursive: true });
    // 真实启动命令：--help 只是启动校验用的冒烟参数，实际使用要去掉；有用法提示时自动附加 args
    const baseCmd = (svc.start_command ?? '').replace(/\s+--help\s*$/i, '').trim();
    const runCmd = [baseCmd, hintArgs].filter(Boolean).join(' ');
    const hasVenv = fs.existsSync(path.join(svc.workdir, '.venv', 'Scripts', 'activate.bat'));
    const bat = [
      '@echo off',
      'chcp 65001 >nul',
      `title DevPilot - ${svc.name}`,
      `cd /d "${svc.workdir}"`,
      hasVenv ? 'call ".venv\\Scripts\\activate.bat"' : 'rem 项目无 .venv，使用系统解释器',
      `echo [DevPilot] ${svc.name} 环境已就绪${hasVenv ? '（.venv 虚拟环境已激活）' : ''}`,
      `echo [DevPilot] 正在启动程序：${runCmd || baseCmd || svc.name}`,
      hintExample ? `echo [DevPilot] 完整用法：${hintExample}` : null,
      hintNote ? `echo [DevPilot] ${hintNote}` : null,
      `echo [DevPilot] 需要参数时（如指定目标），等它退出后直接在下面输入命令传参运行。`,
      'echo.',
      runCmd || baseCmd || `echo [DevPilot] 该服务没有启动命令，可直接在此使用项目。`,
      'echo.',
      `echo [DevPilot] 程序已退出（退出码 %errorlevel%）。窗口保持可用：可直接输入命令继续使用，或查看项目 README 了解参数。`,
      'cmd /k',
    ].filter((l) => l !== null).join('\r\n');
    const batPath = path.join(dir, 'terminal.bat');
    fs.writeFileSync(batPath, bat, 'utf-8');

    // start 在新控制台窗口运行 bat；windowsVerbatimArguments 让引号按字面传递
    const child = spawn('cmd.exe', ['/c', `start "" "${batPath}"`], {
      cwd: svc.workdir,
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    });
    child.unref();
    this.logs.log({
      level: 'info',
      sourceModule: `service.${svc.name}`,
      projectId: svc.project_id,
      message: `已打开命令行窗口并自动启动程序（${runCmd || baseCmd || '无启动命令'}），窗口保留供交互使用`,
    });
    return { opened: true, script: batPath };
  }

  /** 扫服务日志尾部，找 http://127.0.0.1:<port>/<path> 或 http://localhost:<port>/<path>，取最后一次出现的非根路径 */
  private accessPathFromLogs(port: number, svcName: string): string | null {
    try {
      const tail = this.logs.tail(`service.${svcName}`, 300);
      if (!tail) return null;
      const re = new RegExp(`http://(?:127\\.0\\.0\\.1|localhost):${port}(/[^\\s"')\\]]*)`, 'gi');
      let m: RegExpExecArray | null;
      let found: string | null = null;
      while ((m = re.exec(tail))) {
        const p = m[1];
        // 过滤明显不是页面入口的路径（API 前缀 / 探针）
        if (/^\/(api|v1|v2|docs|openapi\.json|favicon|health|metrics)\b/i.test(p)) continue;
        found = p;
      }
      return found;
    } catch {
      return null;
    }
  }

  /** 跟随 3xx 重定向（最多 5 跳），返回最终路径；连接失败/超时返回 null */
  private finalPathAfterRedirects(port: number, startPath: string): Promise<string | null> {
    return new Promise((resolve) => {
      let current = startPath;
      let hops = 0;
      const step = () => {
        if (hops++ >= 5) return resolve(current);
        const req = http.get(
          { host: '127.0.0.1', port, path: current, timeout: 2500, headers: { 'User-Agent': 'DevPilot-probe' } },
          (res) => {
            res.resume();
            const loc = res.headers.location;
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
              try {
                const u = new URL(loc, `http://127.0.0.1:${port}`);
                current = u.pathname + (u.search || '');
                step();
              } catch {
                resolve(current);
              }
            } else {
              resolve(current);
            }
          },
        );
        req.once('error', () => resolve(null));
        req.once('timeout', () => { req.destroy(); resolve(null); });
      };
      step();
    });
  }

  /** 启动成功后异步探测访问路径（不阻塞启动主流程） */
  private refreshAccessPathInBackground(serviceId: string, svcName: string, port: number | null): void {
    // 带重试的访问地址探测：Next 自定义 server / vite 等在启动后数秒才真正可访问，
    // 一次探测失败（页面还在编译）就放弃会导致「启动成功却没有访问地址」。
    // 无端口的服务也探测：从运行日志自动学习真实端口（代码里写死端口但配置没解析到很常见）。
    const attempts = [2000, 7000, 15000];
    const run = (idx: number): void => {
      setTimeout(() => {
        void this.detectAccessUrl(serviceId)
          .then(() => {
            // 成功后广播一次服务事件，前端抽屉轮询/详情立即拿到 access_path
            const svc = this.ds.db.prepare('SELECT project_id FROM project_services WHERE id = ?').get(serviceId) as { project_id: string } | undefined;
            if (svc) this.broadcastServiceEvent(serviceId, svc.project_id);
          })
          .catch(() => {
            if (idx + 1 < attempts.length) run(idx + 1);
            else this.logs.log({ level: 'debug', sourceModule: `service.${svcName}`, message: '访问路径探测多次失败（服务可能未提供 HTTP 入口）' });
          });
      }, attempts[idx]);
    };
    run(0);
  }

  /** 从运行日志学习真实监听端口：http://(localhost|127.0.0.1):<port>；
   *  自定义 server（如 career-ops web 的 server.mjs）代码里写死端口但分析器没解析到时自愈。 */
  private learnPortFromLogs(svcName: string): number | null {
    try {
      const tail = this.logs.tail(`service.${svcName}`, 300);
      if (!tail) return null;
      const counts = new Map<number, number>();
      for (const m of tail.matchAll(/http:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})/gi)) {
        const p = Number(m[1]);
        if (p >= 1024 && p <= 65535) counts.set(p, (counts.get(p) ?? 0) + 1);
      }
      if (!counts.size) return null;
      const port = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      this.ds.db.prepare('UPDATE project_services SET port = ?, updated_at = ? WHERE name = ? AND (port IS NULL OR port != ?)')
        .run(port, new Date().toISOString(), svcName, port);
      this.logs.log({ level: 'info', sourceModule: `service.${svcName}`, message: `从运行日志自动识别到服务端口 ${port}，已更新服务配置` });
      return port;
    } catch { return null; }
  }

  /** 启动单个服务 */
  async startService(serviceId: string, sessionId?: string, opts?: { signal?: AbortSignal }): Promise<{ status: ServiceStatus; pid?: number; adopted?: boolean }> {
    const svc = this.ds.db.prepare('SELECT * FROM project_services WHERE id = ?').get(serviceId) as
      | { id: string; project_id: string; name: string; workdir: string; start_command: string | null; port: number | null; env_json: string | null; health_check_json: string | null }
      | undefined;
    if (!svc) throw new NotFoundException(`服务不存在：${serviceId}`);
    if (!svc.start_command) throw new ConflictException(`服务 ${svc.name} 没有配置启动命令（请先在服务配置里补充）`);
    if (this.tracked.has(serviceId)) return { status: 'Running', pid: this.trackedPid(this.tracked.get(serviceId)!) };

    // 端口预检：端口上已有实例在跑时，直接接管，不再重复拉起。
    // 典型场景：应用自带自动更新（如 wb2api 的 update 流程）在 DevPilot 之外重启了 exe，
    // 旧实现会再 spawn 一个 → bind 失败 → exit 1 → 误标 Failed，而服务其实正常。
    if (svc.port) {
      const occupied = await this.portListening(svc.port);
      if (occupied) {
        const pid = await this.findListenerPid(svc.port);
        // 受管服务互斥：端口上的实例属于本机另一个受管服务时不允许接管/终止
        //（否则 A 项目停止会杀掉 B 项目服务并触发其自愈重启，产生跨项目副作用——第三轮审计实测缺陷）
        const ownerTracked = pid
          ? [...this.tracked.entries()].find(([, t]) => t.child?.pid === pid || t.pid === pid)
          : undefined;
        if (ownerTracked && ownerTracked[0] !== serviceId) {
          const ownerSvc = this.ds.db.prepare('SELECT name, project_id FROM project_services WHERE id = ?').get(ownerTracked[0]) as { name: string; project_id: string } | undefined;
          throw new Error(
            `端口 ${svc.port} 已被本机受管服务「${ownerSvc?.name ?? ownerTracked[0].slice(0, 8)}」占用（PID ${pid}）。` +
            `请先停止该服务，或为本服务改用其它端口；DevPilot 不允许通过接管跨服务终止进程。`,
          );
        }
        const hc = this.healthConfig(svc);
        const httpOk = await this.httpProbe(svc.port, hc.path, hc.expectedStatus, hc.method, hc.contains);
        if (httpOk) {
          // 审计 S-03 修复：接管前必须证明该 PID 属于本项目。
          // 旧实现只按「端口在听 + HTTP 有响应」接管，结果把用户自己的 Vite（PID 15948/5173）
          // 当成 fixture 项目的服务，stop 时直接杀掉了前端开发服务器。
          // 显式信任开关：某些应用会自行重启（自动更新），需要接管旧实例时由用户设置
          // DEVIPILOT_TRUST_EXTERNAL_PORTS=1 恢复旧行为（默认关闭，安全优先）。
          const owned = process.env.DEVIPILOT_TRUST_EXTERNAL_PORTS === '1'
            ? true
            : await this.pidBelongsToProject(pid, svc.project_id);
          if (!owned) {
            const detail = pid ? await this.describeProcess(pid) : '';
            throw new Error(
              `端口 ${svc.port} 已被外部进程${pid ? ` PID ${pid}${detail ? `（${detail}）` : ''}` : ''}占用，` +
              `且没有证据表明它属于本项目（DevPilot 不接管/不终止外部实例，避免误杀无关进程）。` +
              `如确认它是本项目的遗留实例，请先手动结束它，或在服务配置里改用其它端口。`,
            );
          }
          const sid = sessionId ?? randomUUID();
          this.tracked.set(serviceId, { serviceId, sessionId: sid, child: null, pid, adopted: true, startedAt: Date.now() });
          if (pid) this.appendSessionPids(sid, pid);
          this.setStatus(serviceId, 'Running');
          this.broadcastServiceEvent(serviceId, svc.project_id);
          this.refreshAccessPathInBackground(serviceId, svc.name, svc.port);
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
    // 清理宿主注入（NODE_OPTIONS / ELECTRON_RUN_AS_NODE / *_SHIM）：
    // 不清理会让被托管项目继承编辑器的 safe-delete shim，构建工具删临时目录时被拦 → 启动失败。
    const env = cleanServiceEnv(process.env, svc.env_json ? (JSON.parse(svc.env_json) as Record<string, string>) : null);
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

    // 健康检查：有端口走 TCP 探活（60s 覆盖 streamlit / vite 这类冷启动较慢的服务）；
    // 无端口服务（CLI 工具 / 脚本）：退出码 0 = 一次性执行成功（启动校验通过）；
    // 窗口期内仍存活 = 常驻程序，也算成功。秒退且非 0 才是失败（入口/依赖问题）。
    let cliExitCode: number | null | undefined;
    const healthy = svc.port
      ? await this.waitPort(svc.port, 60000, opts?.signal)
      : await new Promise<boolean>((resolve) => {
          // 常驻判定：窗口内存活 = 常驻程序。
          // 审计 P-03：旧值 3000ms 让「不绑端口的常驻服务」每次启动固定多等 3s
          //（实测 4.5s vs 有端口 1.2s）。秒退崩溃由 exit 事件即时捕获，窗口只用于
          // 确认「没有立刻退出」，900ms 足够区分「秒退」与「常驻」。
          const t = setTimeout(() => resolve(child.exitCode === null && child.signalCode === null), 900);
          child.once('exit', (code) => { clearTimeout(t); cliExitCode = code; resolve(code === 0); });
        });
    if (!healthy) {
      // 进程已经退出时不能标 Unhealthy：那是崩溃（Failed），否则会被上层误判成"还在跑但没监听"
      if (child.exitCode !== null || child.signalCode !== null) {
        this.setStatus(serviceId, 'Failed');
        this.broadcastServiceEvent(serviceId, svc.project_id);
        this.logs.log({
          level: 'error', sourceModule: `service.${svc.name}`, projectId: svc.project_id,
          message: svc.port
            ? `服务在端口 ${svc.port} 就绪前已退出（exit=${child.exitCode}），判定为启动失败`
            : `CLI/脚本执行失败（exit=${child.exitCode}）：入口或依赖有问题，详见上方输出`,
        });
        return { status: 'Failed', pid: child.pid };
      }
      this.setStatus(serviceId, 'Unhealthy');
      this.broadcastServiceEvent(serviceId, svc.project_id);
      this.logs.log({
        level: 'warn', sourceModule: `service.${svc.name}`, projectId: svc.project_id,
        message: `进程在运行，但 ${svc.port} 端口 60s 内未监听（可能还没启动完，或监听在其它端口）`,
      });
      return { status: 'Unhealthy', pid: child.pid };
    }

    // CLI 一次性执行成功（exit 0）：进程已正常结束，标记 Stopped；上层以此判定「启动校验通过」
    if (!svc.port && cliExitCode !== undefined) {
      this.setStatus(serviceId, 'Stopped');
      this.broadcastServiceEvent(serviceId, svc.project_id);
      this.logs.log({ level: 'info', sourceModule: `service.${svc.name}`, projectId: svc.project_id, message: 'CLI 执行成功（exit=0），非常驻服务，已正常结束' });
      return { status: 'Stopped', pid: child.pid };
    }

    this.setStatus(serviceId, 'Running');
    this.broadcastServiceEvent(serviceId, svc.project_id);
    this.refreshAccessPathInBackground(serviceId, svc.name, svc.port);
    this.audit.record({ subject: 'user:local-user', action: 'service.start', target: svc.name, result: 'ok', detail: { pid: child.pid, command: svc.start_command } });
    this.writeRunArchive(svc, 'Running', { pid: child.pid, command: svc.start_command, adopted: false });
    return { status: 'Running', pid: child.pid };
  }

  /** 运行档案落库（V17 run_archives）：项目每次真实启动/停止的记录，供项目详情与经验沉淀 */
  private writeRunArchive(svc: { project_id: string; name: string; port: number | null; start_command?: string | null }, status: string, detail: Record<string, unknown>) {
    try {
      const profile = this.ds.db.prepare('SELECT profile_hash FROM projects WHERE id = ?').get(svc.project_id) as { profile_hash: string | null } | undefined;
      this.ds.db.prepare(
        `INSERT INTO run_archives (id, project_id, profile_hash, run_kind, command, port, pid, status, health_json, summary, created_at)
         VALUES (?, ?, ?, 'service', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(), svc.project_id, profile?.profile_hash ?? null,
        svc.start_command, svc.port, (detail.pid as number | undefined) ?? null, status,
        JSON.stringify(detail).slice(0, 2000),
        `${svc.name} → ${status}`,
        new Date().toISOString(),
      );
    } catch { /* 档案写失败不阻断启动 */ }
  }

  /**
   * 停止阶段的时间预算（硬指标：用户点「停止」→ 状态落地 ≤5s，多服务并行后总时长取决于最慢单个）。
   * 旧值 stop_command 优雅期 5000ms + 兜底 600ms，且 stopProject 串行 → 3 个服务能拖到 17s。
   */
  private static readonly STOP_GRACE_MS = 1200;      // stop_command 优雅停止等待上限（超时即强杀）
  private static readonly STOP_CONFIRM_MS = 400;     // 强杀后确认死亡的等待上限（期间实时探测）
  private static readonly STOP_ADOPTED_WAIT_MS = 1500; // 外驻实例 taskkill /T /F 的等待上限
  private static readonly STOP_POLL_MS = 60;         // 存活探测间隔（pidAlive 已是非阻塞系统调用）

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
      if (pid && this.pidAlive(pid)) {
        // 等待确认真正死亡（taskkill 是异步的，fire-and-forget 可能报 stopped 但进程还活着）
        await plat.killTreeWait(pid, RuntimeService.STOP_ADOPTED_WAIT_MS);
      }
      // 条件等待兜底：死亡即继续（替代固定 sleep）
      for (let waited = 0; pid && this.pidAlive(pid) && waited < RuntimeService.STOP_CONFIRM_MS; waited += RuntimeService.STOP_POLL_MS) {
        await new Promise((r) => setTimeout(r, RuntimeService.STOP_POLL_MS));
      }
      const stillAlive = pid ? this.pidAlive(pid) : false;
      this.tracked.delete(serviceId);
      this.setStatus(serviceId, 'Stopped');
      this.broadcastServiceEvent(serviceId, svc.project_id);
      this.audit.record({
        subject: 'user:local-user', action: 'service.stop', target: svc.name, result: 'ok',
        detail: { pid, method: 'adopted-pid', stillAlive },
      });
      this.writeRunArchive(svc, 'Stopped', { pid, method: 'adopted-pid' });
      this.logs.log({
        level: stillAlive ? 'error' : 'info',
        sourceModule: `service.${svc.name}`, projectId: svc.project_id,
        message: stillAlive
          ? `外部实例 PID ${pid} 终止后仍存活（可能有守护重启）。请人工核查进程。`
          : `已终止外部实例 PID ${pid ?? '未知'}（端口 ${svc.port ?? '—'}）`,
      });
      return { stopped: true };
    }

    // 1) 用户配置的 stop_command 优先（优雅停止），最多等 STOP_GRACE_MS，超时立即强杀
    const full = this.ds.db.prepare('SELECT stop_command FROM project_services WHERE id = ?').get(serviceId) as { stop_command: string | null };
    let graceful = false;
    const pid = this.trackedPid(t);
    if (full?.stop_command) {
      const stop = plat.shellFor(full.stop_command);
      spawn(stop.shell, stop.args,
        { cwd: this.getServiceWorkdir(serviceId), windowsHide: true, ...(stop.options ?? {}) });
      const deadline = Date.now() + RuntimeService.STOP_GRACE_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, RuntimeService.STOP_POLL_MS));
        if (t.child?.exitCode !== null && t.child?.exitCode !== undefined) { graceful = true; break; }
        if (!this.pidAlive(pid)) { graceful = true; break; }
      }
      this.logs.log({ level: 'info', sourceModule: 'runtime', message: `service ${svc.name} stop_command issued, graceful=${graceful}` });
    }

    // 2) 回退：会话 PID 树强制终止（按 PID，不按名称）
    if (!graceful) this.killProcessTree(pid);
    // 兜底条件等待：死亡即继续（非阻塞探测，最多 STOP_CONFIRM_MS）
    for (let waited = 0; pid && this.pidAlive(pid) && waited < RuntimeService.STOP_CONFIRM_MS; waited += RuntimeService.STOP_POLL_MS) {
      await new Promise((r) => setTimeout(r, RuntimeService.STOP_POLL_MS));
    }
    this.tracked.delete(serviceId);
    this.setStatus(serviceId, 'Stopped');
    this.broadcastServiceEvent(serviceId, svc.project_id);
    this.audit.record({
      subject: 'user:local-user', action: 'service.stop', target: svc.name, result: 'ok',
      detail: { pid, method: graceful ? 'stop_command' : 'pid-tree' },
    });
    this.writeRunArchive(svc, 'Stopped', { pid, method: graceful ? 'stop_command' : 'pid-tree' });
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

  /** 当前被跟踪的、属于某项目的服务 id 集合（取消启动时的兜底停止目标：含尚未登记进 job 的竞态服务） */
  trackedServiceIdsOfProject(projectId: string): string[] {
    const out: string[] = [];
    for (const serviceId of this.tracked.keys()) {
      const row = this.ds.db.prepare('SELECT project_id FROM project_services WHERE id = ?').get(serviceId) as { project_id: string } | undefined;
      if (row?.project_id === projectId) out.push(serviceId);
    }
    return out;
  }

  /** 单个服务是否仍有被跟踪的进程（前端「停止中」态判断用） */
  isTracked(serviceId: string): boolean {
    return this.tracked.has(serviceId);
  }

  /** PID 是否属于本机受管服务（返回服务名）——端口占用自愈前的安全检查，避免跨服务误杀 */
  getTrackedServiceByPid(pid: number): string | null {
    for (const t of this.tracked.values()) {
      if (this.trackedPid(t) === pid) {
        const s = this.ds.db.prepare('SELECT name FROM project_services WHERE id = ?').get(t.serviceId) as { name: string } | undefined;
        return s?.name ?? t.serviceId.slice(0, 8);
      }
    }
    return null;
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
  private httpProbe(port: number, urlPath = '/', expectedStatus?: number, method = 'GET', contains?: string): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: urlPath, timeout: 2500, method, headers: { 'User-Agent': 'DevPilot-probe' } }, (res) => {
        // 期望状态码优先（用户可配置）；未配置时 4xx/5xx 不算健康：
        // Windows HTTP.sys（Microsoft-HTTPAPI/2.0）对任意 Host 都回 400，
        // 曾经因此把系统占用的端口误判成「项目实例」接管，实际服务根本没起来。
        const statusOk = typeof expectedStatus === 'number'
          ? res.statusCode === expectedStatus
          : typeof res.statusCode === 'number' && res.statusCode < 400;
        if (!statusOk) { res.resume(); resolve(false); return; }
        if (contains) {
          // 响应体内容校验（任务书 §6.3）：状态码对了还不够，响应体必须包含期望内容
          let body = '';
          res.setEncoding('utf-8');
          res.on('data', (c: string) => { body += c; if (body.length > 512 * 1024) res.destroy(); });
          res.on('end', () => resolve(body.includes(contains)));
          res.on('error', () => resolve(false));
        } else {
          res.resume();
          resolve(true);
        }
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    });
  }

  /** health_check_json 配置 → 探针参数（path/method/expectedStatus/contains/timeout） */
  private healthConfig(svc: { health_check_json?: string | null }): { path: string; method: string; expectedStatus?: number; contains?: string; timeoutMs: number } {
    const fallback = { path: '/', method: 'GET', timeoutMs: 2500 };
    try {
      if (!svc.health_check_json) return fallback;
      const h = JSON.parse(svc.health_check_json) as { path?: string; url?: string; method?: string; expectedStatus?: number; timeoutMs?: number; contains?: string; type?: string };
      let pathPart = fallback.path;
      if (h?.path) pathPart = h.path;
      else if (h?.url) {
        const u = new URL(h.url);
        pathPart = `${u.pathname}${u.search}` || '/';
      }
      return {
        path: pathPart,
        method: (h?.method ?? 'GET').toUpperCase(),
        expectedStatus: typeof h?.expectedStatus === 'number' ? h.expectedStatus : undefined,
        contains: typeof h?.contains === 'string' ? h.contains : undefined,
        timeoutMs: typeof h?.timeoutMs === 'number' ? Math.min(h.timeoutMs, 15_000) : fallback.timeoutMs,
      };
    } catch { /* 配置非法则用默认 */ }
    return fallback;
  }

  /**
   * 该 PID 是否可归属于本项目（审计 S-03 修复的核心判据）。
   * 三个正向证据，命中任一即认为属于本项目：
   *   1. run_archives 里本项目记录过这个 PID（DevPilot 自己拉起过的进程，跨后端重启仍有效）
   *   2. runtime_sessions.pids_json 里本项目记录过（当前/历史会话）
   *   3. 进程命令行或可执行路径落在项目 root_path 内（手工在该目录里启动的实例）
   * 都没有 → 视为外部进程：不接管、不终止。
   */
  async pidBelongsToProject(pid: number | undefined, projectId: string): Promise<boolean> {
    if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
    try {
      const arch = this.ds.db
        .prepare('SELECT 1 AS hit FROM run_archives WHERE project_id = ? AND pid = ? LIMIT 1')
        .get(projectId, pid) as { hit: number } | undefined;
      if (arch) return true;
    } catch { /* 老库无该表则跳过 */ }
    try {
      const rows = this.ds.db
        .prepare('SELECT pids_json FROM runtime_sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT 30')
        .all(projectId) as Array<{ pids_json: string | null }>;
      for (const r of rows) {
        try {
          const pids = JSON.parse(r.pids_json ?? '[]') as unknown[];
          if (pids.map(Number).includes(pid)) return true;
        } catch { /* 坏 JSON 忽略 */ }
      }
    } catch { /* 忽略 */ }
    const info = await this.processExecutableInfo(pid);
    if (!info) return false;
    const row = this.ds.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string } | undefined;
    if (!row?.root_path) return false;
    const norm = (s: string) => s.replace(/\//g, '\\').toLowerCase();
    const root = norm(row.root_path).replace(/\\+$/, '');
    const inRoot = (s: string | undefined) => !!s && norm(s).includes(root);
    return inRoot(info.commandLine) || inRoot(info.executablePath);
  }

  /** 进程可执行路径 + 命令行（Windows 走 CIM；其它平台走 ps），取不到返回 null */
  private processExecutableInfo(pid: number): Promise<{ commandLine: string; executablePath: string } | null> {
    if (process.platform !== 'win32') {
      return new Promise((resolve) => {
        execFile('ps', ['-p', String(pid), '-o', 'args='], { timeout: 4000 }, (err, out) =>
          resolve(err ? null : { commandLine: String(out ?? '').trim(), executablePath: '' }));
      });
    }
    return new Promise((resolve) => {
      const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { $p.ExecutablePath; '---'; $p.CommandLine }`;
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 }, (err, out) => {
        if (err) return resolve(null);
        const [exe = '', cmd = ''] = String(out ?? '').split('---');
        if (!exe.trim() && !cmd.trim()) return resolve(null);
        resolve({ executablePath: exe.trim(), commandLine: cmd.trim() });
      });
    });
  }

  /** 按端口反查监听进程 PID（Windows netstat / *nix lsof），失败返回 undefined */
  private findListenerPid(port: number): Promise<number | undefined> {    return new Promise((resolve) => {
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

  /**
   * 停止整个项目：仅处理本项目会话创建的进程；共享服务按引用保护跳过。
   * 并行停止（旧实现串行 await，N 个服务 × 单服务等待 → 3 个服务能到 17s）：
   * 总时长 = 最慢的单个服务，配合 stopService 内部预算保证 ≤5s 硬指标。
   */
  async stopProject(projectId: string): Promise<Array<{ serviceId: string; stopped: boolean; reason?: string }>> {
    const rows = this.ds.db
      .prepare(`SELECT id FROM project_services WHERE project_id = ? AND status IN ('Running','Starting','Unhealthy','Stopping')`)
      .all(projectId) as Array<{ id: string }>;
    const ids = new Set(rows.map((r) => r.id));
    // 兜底：DB 状态可能滞后（启动中刚 spawn、状态还没落库），tracked 里属于本项目的服务一并停
    for (const serviceId of this.tracked.keys()) {
      if (ids.has(serviceId)) continue;
      const row = this.ds.db.prepare('SELECT project_id FROM project_services WHERE id = ?').get(serviceId) as { project_id: string } | undefined;
      if (row?.project_id === projectId) ids.add(serviceId);
    }
    const list = [...ids];
    const settled = await Promise.allSettled(list.map((serviceId) => this.stopService(serviceId)));
    const results = list.map((serviceId, i) => {
      const s = settled[i];
      return s.status === 'fulfilled'
        ? { serviceId, ...s.value }
        : { serviceId, stopped: false, reason: String((s.reason as Error)?.message ?? s.reason) };
    });
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
  private waitPort(port: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const attempt = () => {
        if (signal?.aborted) { resolve(false); return; }
        const sock = net.connect({ host: '127.0.0.1', port, timeout: 1500 });
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => {
          sock.destroy();
          if (Date.now() > deadline) resolve(false);
          else setTimeout(attempt, 150);
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
