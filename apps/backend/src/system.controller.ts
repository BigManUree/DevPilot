import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from './database/database.module';

@Controller('api/v1/system')
export class SystemController {
  constructor(private readonly ds: DatabaseService) {}

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
      const manifest = JSON.parse(text) as { latestVersion: string; downloadUrl?: string; notes?: string };
      const newer = this.compareVersions(manifest.latestVersion, current) > 0;
      return { ...base, latestVersion: manifest.latestVersion, downloadUrl: manifest.downloadUrl ?? null, notes: manifest.notes ?? null, updateAvailable: newer };
    } catch (e) {
      return { ...base, error: String(e).slice(0, 150) };
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
