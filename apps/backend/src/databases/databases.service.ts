import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import net from 'node:net';
import fs from 'node:fs';
import { execFile, spawn, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';
import { AuditService } from '../permissions/audit.service';
import { LogService } from '../logs/log.service';

const exec = promisify(execFile);

/** 常见本地数据服务探测定义：端口 + 探测方式 */
const COMMON_LOCAL_SERVICES = [
  { kind: 'mysql', name: 'MySQL', port: 3306, winServiceNames: ['MySQL', 'MySQL80', 'MySQL57', 'mysql'] },
  { kind: 'postgres', name: 'PostgreSQL', port: 5432, winServiceNames: ['postgresql', 'postgresql-x64-16', 'postgresql-x64-15'] },
  { kind: 'redis', name: 'Redis', port: 6379, winServiceNames: ['Redis', 'redis'] },
  { kind: 'mongo', name: 'MongoDB', port: 27017, winServiceNames: ['MongoDB', 'mongodb', 'MongoDB Server'] },
  { kind: 'mssql', name: 'SQL Server', port: 1433, winServiceNames: ['MSSQLSERVER', 'MSSQL$SQLEXPRESS'] },
];

function tcpProbe(port: number, host = '127.0.0.1', timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * 数据库连接与本地服务管理：
 * - 连接登记（mysql/postgres/mongo/redis/mssql/sqlite）+ 连通性测试
 * - 本地服务探测（端口 + Windows 服务查询）
 * - 本地服务登记/启动/停止（进程树管理，仅本会话 PID）
 */
@Injectable()
export class DatabasesService {
  private tracked = new Map<string, { child: ChildProcess; startedAt: number }>();

  constructor(
    private readonly ds: DatabaseService,
    private readonly audit: AuditService,
    private readonly logs: LogService,
  ) {}

  /* ---------------- 数据库连接 ---------------- */

  listConnections() {
    // credential_ref 只回是否存在，不回内容
    return (this.ds.db.prepare('SELECT * FROM database_connections ORDER BY name').all() as any[])
      .map((r) => ({ ...r, credential_ref: r.credential_ref ? '<configured>' : null }));
  }

  upsertConnection(body: {
    id?: string; name: string; dbType: string; host?: string; port?: number;
    databaseName?: string; credential?: string;
  }) {
    const now = new Date().toISOString();
    let credentialRef: string | null = null;
    if (body.credential) {
      // 凭据落盘 credentials/ 目录（0600），表内只存引用
      const dir = process.env.DEVIPILOT_DATA_DIR ?? '';
      if (dir) {
        fs.mkdirSync(`${dir}/credentials`, { recursive: true });
        const credFile = `${dir}/credentials/${randomUUID()}.json`;
        fs.writeFileSync(credFile, body.credential, { encoding: 'utf-8', mode: 0o600 });
        credentialRef = credFile;
      }
    }
    if (body.id) {
      this.ds.db.prepare(
        `UPDATE database_connections SET name=?, db_type=?, host=?, port=?, database_name=?,
         credential_ref=COALESCE(?, credential_ref) WHERE id=?`,
      ).run(body.name, body.dbType, body.host ?? null, body.port ?? null, body.databaseName ?? null, credentialRef, body.id);
      return { id: body.id };
    }
    const id = randomUUID();
    this.ds.db.prepare(
      `INSERT INTO database_connections (id, name, db_type, host, port, database_name, credential_ref, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown')`,
    ).run(id, body.name, body.dbType, body.host ?? null, body.port ?? null, body.databaseName ?? null, credentialRef);
    this.audit.record({ subject: 'user:local-user', action: 'db.connection.create', target: body.name, result: 'ok', detail: { dbType: body.dbType } });
    return { id };
  }

  deleteConnection(id: string) {
    this.ds.db.prepare('DELETE FROM database_connections WHERE id = ?').run(id);
    return { ok: true };
  }

  async testConnection(id: string): Promise<{ ok: boolean; detail: string }> {
    const c = this.ds.db.prepare('SELECT * FROM database_connections WHERE id = ?').get(id) as
      | { db_type: string; host: string | null; port: number | null; database_name: string | null } | undefined;
    if (!c) throw new NotFoundException(`数据库连接不存在：${id}`);
    let ok = false;
    let detail = '';
    if (c.db_type === 'sqlite') {
      ok = !!c.database_name && fs.existsSync(c.database_name);
      detail = ok ? 'sqlite 文件存在' : 'sqlite 文件不存在';
    } else {
      const port = c.port ?? ({ mysql: 3306, postgres: 5432, redis: 6379, mongo: 27017, mssql: 1433 } as Record<string, number>)[c.db_type];
      if (!port) return { ok: false, detail: '未知 db_type，无法确定端口' };
      ok = await tcpProbe(port, c.host ?? '127.0.0.1');
      detail = ok ? `TCP ${c.host ?? '127.0.0.1'}:${port} 可达` : `TCP ${c.host ?? '127.0.0.1'}:${port} 连接失败`;
    }
    this.ds.db.prepare('UPDATE database_connections SET status = ? WHERE id = ?').run(ok ? 'connected' : 'unreachable', id);
    return { ok, detail };
  }

  /* ---------------- 本地服务探测 ---------------- */

  /** 探测常见本地数据服务：TCP 端口 + Windows 服务名 */
  async detectLocalServices() {
    const results: Array<{ kind: string; name: string; port: number; portOpen: boolean; winService?: string | null; winServiceRunning?: boolean }> = [];
    for (const def of COMMON_LOCAL_SERVICES) {
      const portOpen = await tcpProbe(def.port);
      let winService: string | null = null;
      let winServiceRunning = false;
      // net start 仅列运行中服务；未在列表 = 未运行
      const { stdout } = await exec('net', ['start'], { timeout: 10_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      const lower = stdout.toLowerCase();
      const hit = def.winServiceNames.find((n) => lower.includes(n.toLowerCase()));
      if (hit) {
        winService = hit;
        winServiceRunning = true;
      }
      results.push({ kind: def.kind, name: def.name, port: def.port, portOpen, winService, winServiceRunning });
    }
    return results;
  }

  /* ---------------- 本地服务登记与生命周期 ---------------- */

  listLocalServices() {
    return this.ds.db.prepare('SELECT * FROM local_services ORDER BY name').all();
  }

  upsertLocalService(body: {
    id?: string; name: string; serviceKind: string; exePath: string; args?: string[];
    workdir?: string; port?: number; env?: Record<string, string>;
  }) {
    const now = new Date().toISOString();
    const argsJson = body.args?.length ? JSON.stringify(body.args) : null;
    const envJson = body.env && Object.keys(body.env).length ? JSON.stringify(body.env) : null;
    // 同名冲突预检（local_services.name UNIQUE）→ 409
    const dupe = this.ds.db.prepare('SELECT id FROM local_services WHERE name = ?').get(body.name) as { id: string } | undefined;
    if (body.id) {
      if (dupe && dupe.id !== body.id) {
        throw new ConflictException(`同名本地服务已存在：${body.name}（服务名全局唯一）`);
      }
      const res = this.ds.db.prepare(
        `UPDATE local_services SET name=?, service_kind=?, exe_path=?, args_json=?, workdir=?, port=?, env_json=?, updated_at=? WHERE id=?`,
      ).run(body.name, body.serviceKind, body.exePath, argsJson, body.workdir ?? null, body.port ?? null, envJson, now, body.id);
      if (res.changes === 0) throw new NotFoundException(`本地服务不存在：${body.id}`);
      return { id: body.id };
    }
    if (dupe) {
      throw new ConflictException(`同名本地服务已存在：${body.name}（服务名全局唯一，请换名或更新已有服务）`);
    }
    const id = randomUUID();
    this.ds.db.prepare(
      `INSERT INTO local_services (id, name, service_kind, exe_path, args_json, workdir, port, env_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Stopped', ?, ?)`,
    ).run(id, body.name, body.serviceKind, body.exePath, argsJson, body.workdir ?? null, body.port ?? null, envJson, now, now);
    return { id };
  }

  deleteLocalService(id: string) {
    const s = this.ds.db.prepare('SELECT * FROM local_services WHERE id = ?').get(id) as { name: string } | undefined;
    if (!s) throw new NotFoundException(`本地服务不存在：${id}`);
    void this.stopLocalService(id).catch(() => {});
    this.ds.db.prepare('DELETE FROM local_services WHERE id = ?').run(id);
    return { ok: true };
  }

  async startLocalService(id: string): Promise<{ ok: boolean; pid?: number; error?: string }> {
    const s = this.ds.db.prepare('SELECT * FROM local_services WHERE id = ?').get(id) as
      | { id: string; name: string; exe_path: string; args_json: string | null; workdir: string | null; env_json: string | null } | undefined;
    if (!s) throw new NotFoundException(`本地服务不存在：${id}`);
    if (this.tracked.has(id)) return { ok: true, pid: this.tracked.get(id)!.child.pid };
    const args = s.args_json ? (JSON.parse(s.args_json) as string[]) : [];
    const env = s.env_json ? { ...process.env, ...(JSON.parse(s.env_json) as Record<string, string>) } : process.env;
    let child: ChildProcess;
    try {
      child = spawn(s.exe_path, args, { cwd: s.workdir ?? undefined, env, windowsHide: true, stdio: 'ignore' });
    } catch (err) {
      this.setStatus(id, 'Failed');
      return { ok: false, error: String(err) };
    }
    // spawn 的 ENOENT 是异步 error 事件
    const errPromise = new Promise<string>((resolve) => child.once('error', (e) => resolve(String(e))));
    const err = await Promise.race([errPromise, new Promise<string>((r) => setTimeout(() => r(''), 1500))]);
    if (err) {
      this.setStatus(id, 'Failed');
      return { ok: false, error: err.slice(0, 300) };
    }
    this.tracked.set(id, { child, startedAt: Date.now() });
    this.setStatus(id, 'Running', child.pid);
    this.audit.record({ subject: 'user:local-user', action: 'local-service.start', target: s.name, result: 'ok', detail: { pid: child.pid } });
    this.logs.log({ level: 'info', sourceModule: 'local-services', message: `started ${s.name} pid=${child.pid}` });
    if (child.pid) this.appendSessionPids(child.pid);
    return { ok: true, pid: child.pid };
  }

  async stopLocalService(id: string): Promise<{ ok: boolean; error?: string }> {
    const s = this.ds.db.prepare('SELECT * FROM local_services WHERE id = ?').get(id) as { name: string } | undefined;
    if (!s) throw new NotFoundException(`本地服务不存在：${id}`);
    const t = this.tracked.get(id);
    if (!t) return { ok: false, error: 'not managed in this session' };
    try {
      if (process.platform === 'win32' && t.child.pid) {
        await exec('taskkill', ['/T', '/F', '/PID', String(t.child.pid)], { timeout: 10_000, windowsHide: true });
      } else {
        t.child.kill();
      }
    } catch { /* 已退出 */ }
    this.tracked.delete(id);
    this.setStatus(id, 'Stopped');
    this.audit.record({ subject: 'user:local-user', action: 'local-service.stop', target: s.name, result: 'ok' });
    this.logs.log({ level: 'info', sourceModule: 'local-services', message: `stopped ${s.name}` });
    return { ok: true };
  }

  /** 端口探活作为健康检查 */
  async checkLocalService(id: string) {
    const s = this.ds.db.prepare('SELECT port FROM local_services WHERE id = ?').get(id) as { port: number | null } | undefined;
    if (!s) throw new NotFoundException(`本地服务不存在：${id}`);
    if (this.tracked.has(id)) {
      const alive = s.port ? await tcpProbe(s.port) : true;
      if (!alive) this.setStatus(id, 'Unhealthy');
      else this.setStatus(id, 'Running');
      return { alive, port: s.port };
    }
    const alive = s.port ? await tcpProbe(s.port) : false;
    return { alive, port: s.port };
  }

  private setStatus(id: string, status: string, pid?: number) {
    this.ds.db.prepare('UPDATE local_services SET status = ?, pid = ?, updated_at = ? WHERE id = ?')
      .run(status, pid ?? null, new Date().toISOString(), id);
  }

  private appendSessionPids(pid: number) {
    // 与 runtime_sessions 不混用：本地服务用独立内存登记即可，重启后按端口探活恢复状态
    void pid;
  }
}
