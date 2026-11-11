import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { DatabaseService, DATA_DIR } from '../database/database.module';
import { AuditService } from '../permissions/audit.service';

/**
 * 统一备份与迁移：
 * - 全量备份：SQLite db.backup（WAL 一致快照）+ SHA256 校验 + backups 登记
 * - 恢复：校验 hash → 落 devpilot.restore.db + restore.pending.json → 下次启动生效
 * - 项目导出：projects + services + env_profiles 打包 JSON
 * - 项目导入：按 root_path 幂等恢复（存在则跳过，不存在则重建）
 */
@Injectable()
export class BackupService {
  constructor(
    private readonly ds: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private backupDir(): string {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private sha256(file: string): string {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }

  /** 全量备份 */
  async create(backupType: 'full' | 'manual' = 'manual'): Promise<{ id: string; file: string; size: number; hash: string }> {
    const id = randomUUID();
    const file = path.join(this.backupDir(), `devpilot-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    await this.ds.db.backup(file);
    const size = fs.statSync(file).size;
    const hash = this.sha256(file);
    const dataVersion = (this.ds.db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number }).v;
    this.ds.db.prepare(
      `INSERT INTO backups (id, backup_type, scope, file_path, hash, size_bytes, app_version, data_version, verify_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?)`,
    ).run(id, backupType, 'global', file, hash, size, '1.0.0', String(dataVersion), new Date().toISOString());
    this.audit.record({ subject: 'user:local-user', action: 'backup.create', target: file, result: 'ok', detail: { size, dataVersion } });
    return { id, file, size, hash };
  }

  list() {
    return this.ds.db.prepare('SELECT id, backup_type, scope, file_path, hash, size_bytes, data_version, verify_status, created_at FROM backups ORDER BY created_at DESC').all();
  }

  /** 校验备份完整性 */
  verify(id: string) {
    const b = this.ds.db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as { file_path: string; hash: string } | undefined;
    if (!b) throw new Error('backup not found');
    if (!fs.existsSync(b.file_path)) {
      this.ds.db.prepare('UPDATE backups SET verify_status = ? WHERE id = ?').run('missing', id);
      return { ok: false, error: '备份文件已丢失' };
    }
    const ok = this.sha256(b.file_path) === b.hash;
    this.ds.db.prepare('UPDATE backups SET verify_status = ? WHERE id = ?').run(ok ? 'verified' : 'corrupted', id);
    return { ok };
  }

  /** 恢复：校验后落 pending 标记，下次后端启动替换生效 */
  restore(id: string) {
    const b = this.ds.db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as { file_path: string; hash: string } | undefined;
    if (!b) throw new Error('backup not found');
    const v = this.verify(id);
    if (!v.ok) return { ok: false, error: '备份校验失败：' + (v as { error?: string }).error };
    const restoreDb = path.join(DATA_DIR, 'devpilot.restore.db');
    fs.copyFileSync(b.file_path, restoreDb);
    fs.writeFileSync(path.join(DATA_DIR, 'restore.pending.json'), JSON.stringify({ backupId: id, requestedAt: new Date().toISOString() }), 'utf-8');
    this.audit.record({ subject: 'user:local-user', action: 'backup.restore', target: b.file_path, result: 'ok', detail: { backupId: id } });
    return { ok: true, requiresRestart: true, message: '恢复包已就绪，重启后端后生效' };
  }

  /** 项目导出包：project + services + env_profiles → JSON 文件 */
  exportProject(projectId: string): { file: string; counts: { services: number; profiles: number } } {
    const project = this.ds.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined;
    if (!project) throw new Error('project not found');
    const services = this.ds.db.prepare('SELECT * FROM project_services WHERE project_id = ?').all(projectId);
    const profiles = this.ds.db.prepare('SELECT id, name, variables_json, active FROM env_profiles WHERE project_id = ?').all(projectId);
    const bundle = {
      format: 'devpilot-project-bundle/v1',
      exportedAt: new Date().toISOString(),
      project,
      services,
      profiles,
    };
    const file = path.join(this.backupDir(), `project-${projectId}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf-8');
    this.audit.record({ subject: 'user:local-user', action: 'backup.export-project', target: file, result: 'ok' });
    return { file, counts: { services: services.length, profiles: profiles.length } };
  }

  /** 项目导入：按 root_path 幂等（已存在则跳过项目行，仅恢复缺失的 services/profiles） */
  importProject(bundlePath: string): { ok: boolean; projectId?: string; skipped?: boolean; created: { services: number; profiles: number }; error?: string } {
    const raw = fs.readFileSync(bundlePath, 'utf-8');
    const bundle = JSON.parse(raw) as {
      format: string;
      project: { id: string; name: string; root_path: string; project_type?: string; language?: string; framework?: string };
      services: any[];
      profiles: Array<{ id: string; name: string; variables_json: string; active: number }>;
    };
    if (bundle.format !== 'devpilot-project-bundle/v1') return { ok: false, created: { services: 0, profiles: 0 }, error: '不支持的导出格式' };
    const now = new Date().toISOString();
    const existing = this.ds.db.prepare('SELECT id FROM projects WHERE root_path = ?').get(bundle.project.root_path) as { id: string } | undefined;
    const pid = existing?.id ?? bundle.project.id;
    let createdServices = 0;
    let createdProfiles = 0;
    const tx = this.ds.db.transaction(() => {
      if (!existing) {
        this.ds.db.prepare(
          `INSERT INTO projects (id, name, root_path, project_type, language, framework, import_source, analysis_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'bundle-import', 'confirmed', ?, ?)`,
        ).run(pid, bundle.project.name, bundle.project.root_path, bundle.project.project_type ?? null, bundle.project.language ?? null, bundle.project.framework ?? null, now, now);
      }
      for (const s of bundle.services) {
        const dupe = this.ds.db.prepare('SELECT id FROM project_services WHERE id = ?').get(s.id);
        if (dupe) continue;
        this.ds.db.prepare(
          `INSERT INTO project_services (id, project_id, name, service_type, workdir, start_command, stop_command, restart_command, build_command, port, env_json, health_check_json, depends_on_json, shared, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Stopped', ?, ?)`,
        ).run(s.id, pid, s.name, s.service_type, s.workdir, s.start_command, s.stop_command, s.restart_command, s.build_command, s.port, s.env_json, s.health_check_json, s.depends_on_json, s.shared ?? 0, s.created_at ?? now, s.updated_at ?? now);
        createdServices++;
      }
      for (const p of bundle.profiles ?? []) {
        const dupe = this.ds.db.prepare('SELECT id FROM env_profiles WHERE project_id = ? AND name = ?').get(pid, p.name);
        if (dupe) continue;
        this.ds.db.prepare(
          `INSERT INTO env_profiles (id, project_id, name, variables_json, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(p.id, pid, p.name, p.variables_json, p.active, now, now);
        createdProfiles++;
      }
    });
    tx();
    this.audit.record({ subject: 'user:local-user', action: 'backup.import-project', target: bundlePath, result: 'ok', detail: { projectId: pid } });
    return { ok: true, projectId: pid, skipped: !!existing, created: { services: createdServices, profiles: createdProfiles } };
  }
}
