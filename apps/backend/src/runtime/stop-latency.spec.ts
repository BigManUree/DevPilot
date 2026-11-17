import Database from 'better-sqlite3';
import { spawn, ChildProcess } from 'node:child_process';
import { RuntimeService } from './runtime.service';

/**
 * 「停止项目」时延回归测试（硬指标：点击停止 → 状态落地 ≤5s）。
 *
 * 覆盖三条停止路径：
 *  1) 多个受管服务（DevPilot spawn）→ 必须并行停止，总耗时 = 最慢单个，而非累加；
 *  2) 配置了 stop_command 的服务 → 优雅期封顶后立即强杀，不再等满 5s；
 *  3) 外驻实例（adopted，只有 PID）→ taskkill 等待封顶 1.5s。
 *
 * 计时使用真实子进程与真实 taskkill/信号，不做 sleep 伪造。
 */

const NODE = process.execPath;

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE project_services (
      id TEXT PRIMARY KEY, project_id TEXT, name TEXT, shared INTEGER DEFAULT 0,
      port INTEGER, status TEXT, stop_command TEXT, workdir TEXT, start_command TEXT, updated_at TEXT
    );
    CREATE TABLE runtime_sessions (id TEXT PRIMARY KEY, project_id TEXT, stopped_at TEXT, pids_json TEXT);
    CREATE TABLE run_archives (
      id TEXT PRIMARY KEY, project_id TEXT, profile_hash TEXT, run_kind TEXT, command TEXT,
      port INTEGER, pid INTEGER, status TEXT, health_json TEXT, summary TEXT, created_at TEXT
    );
  `);
  return db;
}

function makeService(db: Database.Database): RuntimeService {
  const noop = () => undefined;
  return new RuntimeService(
    { db } as never,
    { record: noop } as never,
    { broadcast: noop } as never,
    { log: noop } as never,
    { create: noop } as never,
  );
}

/** 长跑子进程：模拟 dev server */
function spawnSleeper(): ChildProcess {
  return spawn(NODE, ['-e', 'setTimeout(()=>{},120000)'], { windowsHide: true, stdio: 'ignore' });
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function seedService(
  db: Database.Database,
  serviceId: string,
  projectId: string,
  opts: { stopCommand?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO project_services (id, project_id, name, shared, port, status, stop_command, workdir, start_command, updated_at)
     VALUES (?, ?, ?, 0, NULL, 'Running', ?, ?, 'node server.js', ?)`,
  ).run(serviceId, projectId, serviceId, opts.stopCommand ?? null, process.cwd(), new Date().toISOString());
}

describe('停止项目时延（≤5s 硬指标）', () => {
  jest.setTimeout(20_000);

  const spawned: ChildProcess[] = [];
  afterEach(() => {
    for (const c of spawned) {
      if (c.pid && alive(c.pid)) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* 已退出 */ } }
    }
    spawned.length = 0;
  });

  it('三个受管服务并行停止，总耗时 < 5s（旧串行实现会累加）', async () => {
    const db = makeDb();
    const svc = makeService(db);
    const units = ['s1', 's2', 's3'].map((id) => {
      const child = spawnSleeper();
      spawned.push(child);
      seedService(db, id, 'p1');
      (svc as unknown as { tracked: Map<string, unknown> }).tracked.set(id, {
        serviceId: id, sessionId: 'sess', child, pid: child.pid, startedAt: Date.now(),
      });
      return child;
    });
    await new Promise((r) => setTimeout(r, 150)); // 让子进程真正起来

    const t0 = Date.now();
    const results = await svc.stopProject('p1');
    const cost = Date.now() - t0;

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.stopped)).toBe(true);
    expect(cost).toBeLessThan(5000);
    for (const u of units) expect(alive(u.pid)).toBe(false);
    // 并行证据：3 个服务总耗时不超过单服务预算的两倍（串行串起来会是 3 倍以上）
    expect(cost).toBeLessThan(2000);
  });

  it('stop_command 优雅期封顶：进程不响应时约 1.2s 后强杀，整体 < 5s', async () => {
    const db = makeDb();
    const svc = makeService(db);
    const child = spawnSleeper();
    spawned.push(child);
    // stop_command 立即返回但不杀进程（模拟「优雅停止无效」的最坏情况）
    seedService(db, 's1', 'p1', { stopCommand: 'node -e "process.exit(0)"' });
    (svc as unknown as { tracked: Map<string, unknown> }).tracked.set('s1', {
      serviceId: 's1', sessionId: 'sess', child, pid: child.pid, startedAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 150));

    const t0 = Date.now();
    const r = await svc.stopService('s1');
    const cost = Date.now() - t0;

    expect(r.stopped).toBe(true);
    expect(cost).toBeLessThan(5000);
    expect(alive(child.pid)).toBe(false);
  });

  it('外驻实例（adopted，仅 PID）停止 < 5s', async () => {
    const db = makeDb();
    const svc = makeService(db);
    const child = spawnSleeper();
    spawned.push(child);
    seedService(db, 's1', 'p1');
    (svc as unknown as { tracked: Map<string, unknown> }).tracked.set('s1', {
      serviceId: 's1', sessionId: 'sess', child: null, pid: child.pid, adopted: true, startedAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 150));

    const t0 = Date.now();
    const r = await svc.stopService('s1');
    const cost = Date.now() - t0;

    expect(r.stopped).toBe(true);
    expect(cost).toBeLessThan(5000);
    expect(alive(child.pid)).toBe(false);
  });
});
