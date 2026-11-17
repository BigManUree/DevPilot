import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { DatabaseService } from './database/database.module';
import { NotificationService } from './notifications/notification.service';

@Controller('api/v1/system')
export class SystemController {
  constructor(private readonly ds: DatabaseService, private readonly notify: NotificationService) {}

  /**
   * 列出指定路径下的子目录（浏览器模式的「选择项目目录」兜底）。
   * path 为空时：Windows 返回可用盘符列表，其他平台从 / 开始。
   * 返回 { path, parent, dirs: [{name, path}], error? }；parent 为 null 表示已到根。
   */
  @Get('fs/dirs')
  fsDirs(@Query('path') p?: string) {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    if (!p || !p.trim()) {
      if (process.platform === 'win32') {
        const drives = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
          .map((d) => `${d}:\\`)
          .filter((d) => { try { fs.accessSync(d); return true; } catch { return false; } });
        return { path: '', parent: null, dirs: drives.map((d) => ({ name: d, path: d })) };
      }
      p = '/';
    }
    try {
      const resolved = path.resolve(p);
      if (!fs.statSync(resolved).isDirectory()) return { error: `不是目录：${resolved}` };
      const dirs = fs.readdirSync(resolved, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !/^\$/.test(e.name))
        .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      const root = path.parse(resolved).root;
      const parent = path.dirname(resolved);
      return { path: resolved, parent: parent === resolved || parent === root && resolved === root ? null : parent, dirs };
    } catch (e) {
      return { error: String(e).slice(0, 200) };
    }
  }

  @Get('data-status')
  dataStatus() {
    const v = this.ds.db.prepare('SELECT MAX(version) v, COUNT(*) n FROM schema_migrations').get() as { v: number | null; n: number };
    const tables = (this.ds.db.prepare(
      "SELECT COUNT(*) n FROM sqlite_master WHERE type='table'",
    ).get() as { n: number }).n;
    return { schema_version: v.v, migrations_applied: v.n, tables, status: 'ok' };
  }

  /**
   * 更新检查（第三阶段 9.x 自动更新第一批）：
   * 更新清单来源 DEVIPILOT_UPDATE_MANIFEST（URL 或本地文件），缺省 → updateAvailable=false。
   * 清单格式：{ "latestVersion": "x.y.z", "downloadUrl": "...", "notes"?: "..." }
   */
  /** 清单缓存：10 分钟内复用，避免每次打开设置页都打远端（审计 P-01） */
  private manifestCache: { source: string; at: number; value: UpdateCheckResult } | null = null;
  private static readonly MANIFEST_TTL_MS = 10 * 60_000;

  @Get('update-check')
  async updateCheck() {
    const current = '0.1.0';
    const source = process.env.DEVIPILOT_UPDATE_MANIFEST;
    const base: UpdateCheckResult = {
      currentVersion: current,
      source: source ?? null,
      updateAvailable: false,
      latestVersion: current as string | null,
      downloadUrl: null as string | null,
      notes: null as string | null,
      error: null as string | null,
    };
    if (!source) return base;
    if (this.manifestCache && this.manifestCache.source === source && Date.now() - this.manifestCache.at < SystemController.MANIFEST_TTL_MS) {
      return this.manifestCache.value;
    }
    try {
      // 审计 P-01：旧实现用 execSync 起子进程取清单，会阻塞整个事件循环（实测 /health 被卡 4s）。
      // 改成本进程异步 fetch + 5s 超时；失败只在 error 字段里体现，不抛。
      let text: string;
      if (/^https?:\/\//.test(source)) {
        const res = await fetch(source, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        text = await res.text();
      } else {
        text = require('node:fs').readFileSync(source, 'utf-8');
      }
      const manifest = JSON.parse(text) as { latestVersion?: string; downloadUrl?: string; notes?: string; sha256?: string };
      if (!manifest?.latestVersion || typeof manifest.latestVersion !== 'string') throw new Error('清单缺少 latestVersion 字段');
      const newer = this.compareVersions(manifest.latestVersion, current) > 0;
      const value: UpdateCheckResult = {
        ...base,
        latestVersion: manifest.latestVersion,
        downloadUrl: manifest.downloadUrl ?? null,
        notes: manifest.notes ?? null,
        updateAvailable: newer,
        ...(manifest.sha256 ? { __sha: manifest.sha256 } : {}),
      };
      this.manifestCache = { source, at: Date.now(), value };
      return value;
    } catch (e) {
      return { ...base, error: String((e as Error)?.message ?? e).slice(0, 150) };
    }
  }

  /**
   * 下载更新包（B4）：读清单 → 流式下载 downloadUrl 到 downloads 目录 →
   * SHA256 校验（清单可选 sha256 字段）→ 落就绪通知。替换/回滚留给安装流程（运行中进程不可自替换）。
   */
  @Post('update-download')
  async updateDownload() {
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const check = await this.updateCheck();
    if (!check.updateAvailable) return { ok: false, error: check.error ?? '无可用更新' };
    if (!check.downloadUrl) return { ok: false, error: '清单未提供 downloadUrl' };
    const dir = path.join(process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data'), 'downloads');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `devpilot-${check.latestVersion}.zip`);
    try {
      const res = await fetch(check.downloadUrl, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('empty payload');
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const expected = (check as unknown as { __sha?: string }).__sha ?? null;
      if (expected && expected !== sha) {
        return { ok: false, error: `SHA256 校验失败：expected ${expected} got ${sha}` };
      }
      fs.writeFileSync(file, buf);
      this.notify.create({ type: 'update.downloaded', title: `新版本 ${check.latestVersion} 已下载就绪`, content: file, priority: 3 });
      return { ok: true, file, size: buf.length, sha256: sha };
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  }

  /** 逐段数值比较：>0 表示 a 更新 */
  private compareVersions(a: string, b: string): number {
    const pa = a.replace(/^v/, '').split('.').map(Number);
    const pb = b.replace(/^v/, '').split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
    return 0;
  }
}

/** 更新检查结果（缓存与前端共用同一形状） */
interface UpdateCheckResult {
  currentVersion: string;
  source: string | null;
  updateAvailable: boolean;
  latestVersion: string | null;
  downloadUrl: string | null;
  notes: string | null;
  error: string | null;
  __sha?: string;
}
