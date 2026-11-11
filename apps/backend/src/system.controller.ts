import { Body, Controller, Get, Post } from '@nestjs/common';
import { DatabaseService } from './database/database.module';
import { NotificationService } from './notifications/notification.service';

@Controller('api/v1/system')
export class SystemController {
  constructor(private readonly ds: DatabaseService, private readonly notify: NotificationService) {}

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
  @Get('update-check')
  updateCheck() {
    const current = '0.1.0';
    const source = process.env.DEVIPILOT_UPDATE_MANIFEST;
    const base = { currentVersion: current, source: source ?? null, updateAvailable: false, latestVersion: current as string | null, downloadUrl: null as string | null, notes: null as string | null, error: null as string | null };
    if (!source) return base;
    try {
      let text: string;
      if (/^https?:\/\//.test(source)) {
        // 同步获取成本可接受（检查频率低）；超时 5s
        const { execSync } = require('node:child_process') as typeof import('node:child_process');
        text = execSync(`node -e "fetch(process.argv[1]).then(r=>r.text()).then(t=>console.log(t))" "${source}"`, { timeout: 6000, windowsHide: true }).toString();
      } else {
        text = require('node:fs').readFileSync(source, 'utf-8');
      }
      const manifest = JSON.parse(text) as { latestVersion: string; downloadUrl?: string; notes?: string; sha256?: string };
      const newer = this.compareVersions(manifest.latestVersion, current) > 0;
      return { ...base, latestVersion: manifest.latestVersion, downloadUrl: manifest.downloadUrl ?? null, notes: manifest.notes ?? null, updateAvailable: newer, ...(manifest.sha256 ? { __sha: manifest.sha256 } : {}) };
    } catch (e) {
      return { ...base, error: String(e).slice(0, 150) };
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
    const check = this.updateCheck();
    if (!check.updateAvailable) return { ok: false, error: check.error ?? '无可用更新' };
    if (!check.downloadUrl) return { ok: false, error: '清单未提供 downloadUrl' };
    const dir = path.join(process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data'), 'downloads');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `devpilot-${check.latestVersion}.zip`);
    try {
      const res = await fetch(check.downloadUrl);
      if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('empty payload');
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (checkNotesSha(check as any) && checkNotesSha(check as any) !== sha) {
        return { ok: false, error: `SHA256 校验失败：expected ${checkNotesSha(check as any)} got ${sha}` };
      }
      fs.writeFileSync(file, buf);
      this.notify.create({ type: 'update.downloaded', title: `新版本 ${check.latestVersion} 已下载就绪`, content: file, priority: 3 });
      return { ok: true, file, size: buf.length, sha256: sha };
    } catch (e) {
      return { ok: false, error: String(e).slice(0, 200) };
    }
    function checkNotesSha(c: any): string | null { return (c as any).__sha ?? null; }
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
