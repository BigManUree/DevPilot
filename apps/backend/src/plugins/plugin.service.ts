import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../database/database.module';
import { EventsGateway } from '../events.gateway';
import { ToolGatewayService } from '../permissions/tool-gateway.service';
import { AuditService } from '../permissions/audit.service';
import { LogService } from '../logs/log.service';

/**
 * 插件运行时（第三阶段 9.19 首批：本地声明式插件）。
 * - Manifest：plugins 目录下每个子目录的 plugin.json
 * - 隔离：第一批为声明式插件，不执行第三方 JS——action 白名单（log/notify/command），
 *   command 走 tool-gateway（审批双门 + 权限 + 审计），天然满足隔离与权限要求
 * - 生命周期：reload（扫描安装）→ enable/disable → dispatch（事件钩子）
 * - 事件挂接：onModuleInit 包装 EventsGateway.broadcast，广播后分发给启用插件的钩子
 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  kind: 'hook';
  permissions?: string[];
  /** 依赖的其他插件（reload 时校验：目标已安装且版本满足范围，否则整个插件拒绝安装） */
  dependencies?: Array<{ id: string; versionRange?: string }>;
  /** 兼容性声明：宿主版本范围（semver range，对 backend version）与平台白名单 */
  compat?: { appVersion?: string; platforms?: string[] };
  hooks: Array<{ event: string; action: 'log' | 'notify' | 'command'; params?: Record<string, unknown> }>;
}

const KNOWN_EVENTS = new Set([
  'notification.new', 'task.created', 'task.completed', 'task.failed',
  'approval.created', 'approval.resolved', 'service.started', 'service.stopped',
  'project.imported', 'backup.imported', 'git.push',
]);
const KNOWN_ACTIONS = new Set(['log', 'notify', 'command']);

@Injectable()
export class PluginService implements OnModuleInit {
  constructor(
    private readonly ds: DatabaseService,
    private readonly events: EventsGateway,
    private readonly toolGateway: ToolGatewayService,
    private readonly audit: AuditService,
    private readonly logs: LogService,
  ) {}

  /** 插件目录：%APPDATA%/devpilot/plugins/<id>/plugin.json */
  private pluginsDir(): string {
    return path.join(
      process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data'),
      'plugins',
    );
  }

  private readonly APP_VERSION = '0.1.0';

  /** 极简 semver range：^x.y.z / ~x.y.z / x.y.z / >=x.y.z；不满足返回 false */
  private versionSatisfies(version: string, range?: string): boolean {
    if (!range) return true;
    const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10));
    const [rv, rm, rp] = parse(version);
    const m = range.match(/^(\^|~|>=|)(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const [, op, mj, mn, pt] = m;
    const [aj, an, ap] = [parseInt(mj, 10), parseInt(mn, 10), parseInt(pt, 10)];
    if (op === '') return rv === aj && rm === an && rp === ap;
    if (op === '>=') return rv > aj || (rv === aj && (rm > an || (rm === an && rp >= ap)));
    if (op === '^') return rv === aj && (rm > an || (rm === an && rp >= ap));
    if (op === '~') return rv === aj && rm === an && rp >= ap;
    return false;
  }

  /** 依赖与兼容校验：deps 目标须已安装且版本满足；compat 平台与宿主版本匹配 */
  private checkDepsCompat(manifest: PluginManifest, installedVersions: Map<string, string>): string | null {
    for (const dep of manifest.dependencies ?? []) {
      const have = installedVersions.get(dep.id);
      if (!have) return `依赖的插件未安装：${dep.id}`;
      if (!this.versionSatisfies(have, dep.versionRange)) return `依赖插件 ${dep.id} 版本 ${have} 不满足范围 ${dep.versionRange}`;
    }
    const compat = manifest.compat;
    if (compat) {
      if (compat.platforms && !compat.platforms.includes(process.platform)) return `平台不兼容：需 ${compat.platforms.join('/')}，当前 ${process.platform}`;
      if (compat.appVersion && !this.versionSatisfies(this.APP_VERSION, compat.appVersion)) return `宿主版本不兼容：需 ${compat.appVersion}，当前 ${this.APP_VERSION}`;
    }
    return null;
  }

  /** Manifest 校验：id/name/version/kind/hooks 必填；event/action 白名单（兼容与安全门） */
  validateManifest(m: unknown): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
    const t = m as PluginManifest;
    if (!t || typeof t !== 'object') return { ok: false, error: 'manifest 不是对象' };
    if (!t.id || !/^[\w-]{2,64}$/.test(t.id)) return { ok: false, error: 'id 缺失或格式非法（2-64 位字母数字-_）' };
    if (!t.name) return { ok: false, error: 'name 缺失' };
    if (!t.version || !/^\d+\.\d+\.\d+$/.test(t.version)) return { ok: false, error: 'version 缺失或非 semver' };
    if (t.kind !== 'hook') return { ok: false, error: `不支持的插件类型：${t.kind}（首批仅 hook）` };
    if (!Array.isArray(t.hooks) || t.hooks.length === 0) return { ok: false, error: 'hooks 缺失或为空' };
    for (const h of t.hooks) {
      if (!h.event || !KNOWN_EVENTS.has(h.event)) return { ok: false, error: `未知事件：${h.event}` };
      if (!h.action || !KNOWN_ACTIONS.has(h.action)) return { ok: false, error: `未知 action：${h.action}（白名单 log/notify/command）` };
    }
    return { ok: true, manifest: t };
  }

  /** 扫描插件目录并入库（upsert：已存在则刷新 manifest，enabled 保持不变） */
  reload(): { installed: number; rejected: Array<{ dir: string; error: string }> } {
    const dir = this.pluginsDir();
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString();
    const installed: string[] = [];
    const rejected: Array<{ dir: string; error: string }> = [];
    // 已安装版本表（供依赖校验）：目录扫描以 manifest 为准
    const installedVersions = new Map<string, string>();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mf0 = path.join(dir, entry.name, 'plugin.json');
      if (!fs.existsSync(mf0)) continue;
      try {
        const m0 = JSON.parse(fs.readFileSync(mf0, 'utf-8')) as PluginManifest;
        if (m0.id && m0.version) installedVersions.set(m0.id, m0.version);
      } catch { /* 坏 JSON 由下方正式校验报告 */ }
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mf = path.join(dir, entry.name, 'plugin.json');
      if (!fs.existsSync(mf)) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(mf, 'utf-8'));
      } catch (e) {
        rejected.push({ dir: entry.name, error: `plugin.json 解析失败：${String(e).slice(0, 120)}` });
        continue;
      }
      const v = this.validateManifest(raw);
      if (v.ok === false) {
        rejected.push({ dir: entry.name, error: v.error });
        continue;
      }
      const depErr = this.checkDepsCompat(v.manifest, installedVersions);
      if (depErr) {
        rejected.push({ dir: entry.name, error: depErr });
        continue;
      }
      // 对齐 V2 骨架表：status=installed（不禁用既有启用态）、manifest_ref 指向 plugin.json
      this.ds.db.prepare(
        `INSERT INTO plugins (id, name, version, type, origin, manifest_ref, status, permissions_json, updated_at)
         VALUES (?, ?, ?, 'hook', 'local', ?, 'installed', ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version,
           manifest_ref=excluded.manifest_ref, permissions_json=excluded.permissions_json, updated_at=excluded.updated_at`,
      ).run(v.manifest.id, v.manifest.name, v.manifest.version, mf, JSON.stringify(v.manifest.permissions ?? []), now);
      // 依赖表同步：先清后插（第一批只记直接依赖与范围约束）
      this.ds.db.prepare('DELETE FROM plugin_dependencies WHERE plugin_id = ?').run(v.manifest.id);
      for (const dep of v.manifest.dependencies ?? []) {
        this.ds.db.prepare('INSERT OR REPLACE INTO plugin_dependencies (plugin_id, depends_plugin_id, version_constraint) VALUES (?, ?, ?)')
          .run(v.manifest.id, dep.id, dep.versionRange ?? null);
      }
      installed.push(v.manifest.id);
    }
    this.audit.record({ subject: 'system:plugin-runtime', action: 'plugin.reload', target: dir, result: 'ok', detail: { installed, rejected } });
    return { installed: installed.length, rejected };
  }

  setEnabled(id: string, enabled: boolean): { id: string; enabled: boolean } {
    const r = this.ds.db.prepare("UPDATE plugins SET status=?, updated_at=? WHERE id=?").run(enabled ? 'enabled' : 'disabled', new Date().toISOString(), id);
    if (r.changes === 0) throw new NotFoundException(`插件不存在：${id}`);
    this.audit.record({ subject: 'user:local-user', action: enabled ? 'plugin.enable' : 'plugin.disable', target: id, result: 'ok' });
    return { id, enabled };
  }

  list(): Array<PluginManifest & { enabled: boolean; status: string }> {
    const rows = this.ds.db.prepare('SELECT * FROM plugins ORDER BY id').all() as any[];
    return rows.map((r) => {
      // manifest 主体从 manifest_ref 文件热读；文件缺失时降级用表内登记列
      let manifest: Partial<PluginManifest> = {};
      try { manifest = JSON.parse(fs.readFileSync(r.manifest_ref, 'utf-8')); } catch { /* 文件被移除 */ }
      return {
        id: r.id, name: manifest.name ?? r.name, version: manifest.version ?? r.version,
        kind: 'hook', hooks: manifest.hooks ?? [], description: manifest.description,
        permissions: manifest.permissions ?? JSON.parse(r.permissions_json ?? '[]'),
        enabled: r.status === 'enabled', status: r.status,
      };
    });
  }

  /** 事件分发：广播后调用；启用插件的匹配钩子按 action 白名单执行 */
  async dispatch(event: { event_type: string; payload?: Record<string, unknown> }): Promise<void> {
    const rows = this.ds.db.prepare("SELECT id, manifest_ref FROM plugins WHERE status='enabled'").all() as Array<{ id: string; manifest_ref: string }>;
    for (const row of rows) {
      let m: PluginManifest;
      try { m = JSON.parse(fs.readFileSync(row.manifest_ref, 'utf-8')) as PluginManifest; } catch { continue; }
      for (const hook of m.hooks) {
        if (hook.event !== event.event_type) continue;
        try {
          await this.runAction(row.id, hook.action, hook.params ?? {}, event);
        } catch (e) {
          this.logs.log({ level: 'error', sourceModule: 'plugin.runtime', message: `hook failed: plugin=${row.id} event=${event.event_type} err=${String(e).slice(0, 150)}` });
        }
      }
    }
  }

  private async runAction(pluginId: string, action: string, params: Record<string, unknown>, event: { event_type: string; payload?: Record<string, unknown> }): Promise<void> {
    const summary = String(event.payload?.title ?? event.event_type).slice(0, 80);
    if (action === 'log') {
      this.logs.log({ level: 'info', sourceModule: `plugin:${pluginId}`, message: `[hook] ${event.event_type}: ${summary}` });
    } else if (action === 'notify') {
      this.events.broadcast({
        event_id: randomUUID(),
        event_type: 'notification.new',
        timestamp: new Date().toISOString(),
        source_module: `plugin:${pluginId}`,
        trace_id: randomUUID(),
        severity: 'info',
        payload: { notificationId: randomUUID(), type: `plugin.${pluginId}`, title: params.title ? String(params.title) : `插件事件：${event.event_type}`, content: summary },
      });
    } else if (action === 'command') {
      // 插件命令走 tool-gateway：subjectType=plugin（权限审批双门 + 审计），隔离由网关保障
      await this.toolGateway.call(
        {
          subjectType: 'plugin',
          subjectId: pluginId,
          tool: 'command.exec',
          params: { command: String(params.command ?? ''), cwd: params.cwd ? String(params.cwd) : undefined },
        },
        'plugin',
      );
    }
  }

  /** 事件挂接：包装 broadcast，广播后异步分发（不阻塞广播方；分发异常已在内部吞掉） */
  onModuleInit(): void {
    const original = this.events.broadcast.bind(this.events);
    (this.events as { broadcast: (ev: unknown) => void }).broadcast = (ev: unknown) => {
      original(ev as never);
      void this.dispatch(ev as { event_type: string; payload?: Record<string, unknown> });
    };
  }
}
