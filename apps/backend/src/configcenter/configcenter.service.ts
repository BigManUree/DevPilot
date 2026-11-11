import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';
import { AuditService } from '../permissions/audit.service';

/**
 * 多环境配置中心：
 * - 项目级环境档案（dev/test/prod/...），变量集合独立维护
 * - activate：切换激活档案，并把变量合并写入项目各服务的 env_json
 * - 敏感变量标记（key 含 secret/password/token 时前端不回显值）
 */
@Injectable()
export class ConfigCenterService {
  constructor(
    private readonly ds: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  listProfiles(projectId: string) {
    const rows = this.ds.db
      .prepare('SELECT * FROM env_profiles WHERE project_id = ? ORDER BY active DESC, name').all(projectId) as Array<{
      id: string; name: string; variables_json: string; active: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      active: !!r.active,
      variables: this.mask(JSON.parse(r.variables_json) as Record<string, string>),
    }));
  }

  upsertProfile(projectId: string, body: { id?: string; name: string; variables: Record<string, string> }) {
    const now = new Date().toISOString();
    const varsJson = JSON.stringify(body.variables ?? {});
    // 同名冲突预检（UNIQUE(project_id, name)）→ 409，避免 SQLite 约束错误冒泡成 500
    const dupe = this.ds.db
      .prepare('SELECT id FROM env_profiles WHERE project_id = ? AND name = ?')
      .get(projectId, body.name) as { id: string } | undefined;
    if (body.id) {
      if (dupe && dupe.id !== body.id) {
        throw new ConflictException(`同名环境档案已存在：${body.name}（同项目下档案名不可重复）`);
      }
      const res = this.ds.db.prepare('UPDATE env_profiles SET name=?, variables_json=?, updated_at=? WHERE id=? AND project_id=?')
        .run(body.name, varsJson, now, body.id, projectId);
      if (res.changes === 0) throw new NotFoundException(`环境档案不存在：${body.id}`);
      return { id: body.id };
    }
    if (dupe) {
      throw new ConflictException(`同名环境档案已存在：${body.name}（同项目下档案名不可重复，可改用更新或换名）`);
    }
    const id = randomUUID();
    this.ds.db.prepare(
      `INSERT INTO env_profiles (id, project_id, name, variables_json, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, projectId, body.name, varsJson, now, now);
    this.audit.record({ subject: 'user:local-user', action: 'config.profile.upsert', target: `${projectId}/${body.name}`, result: 'ok' });
    return { id };
  }

  deleteProfile(profileId: string) {
    this.ds.db.prepare('DELETE FROM env_profiles WHERE id = ?').run(profileId);
    return { ok: true };
  }

  /** 激活：单选；变量合并进项目服务 env_json（激活前先清除同 key 旧值） */
  activate(projectId: string, profileId: string) {
    const p = this.ds.db.prepare('SELECT * FROM env_profiles WHERE id = ? AND project_id = ?').get(profileId, projectId) as
      | { id: string; name: string; variables_json: string } | undefined;
    if (!p) throw new NotFoundException(`环境档案不存在：${profileId}`);
    const vars = JSON.parse(p.variables_json) as Record<string, string>;
    const keys = Object.keys(vars);

    const services = this.ds.db.prepare('SELECT id, env_json FROM project_services WHERE project_id = ?').all(projectId) as Array<{
      id: string; env_json: string | null;
    }>;
    const tx = this.ds.db.transaction(() => {
      this.ds.db.prepare('UPDATE env_profiles SET active = 0 WHERE project_id = ?').run(projectId);
      this.ds.db.prepare('UPDATE env_profiles SET active = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), profileId);
      for (const s of services) {
        const cur = s.env_json ? (JSON.parse(s.env_json) as Record<string, string>) : {};
        for (const k of keys) delete cur[k];
        Object.assign(cur, vars);
        this.ds.db.prepare('UPDATE project_services SET env_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(cur), new Date().toISOString(), s.id);
      }
    });
    tx();
    this.audit.record({ subject: 'user:local-user', action: 'config.profile.activate', target: `${projectId}/${p.name}`, result: 'ok', detail: { keys: keys.length } });
    return { ok: true, profile: p.name, servicesUpdated: services.length };
  }

  /** 对比两个档案变量差异 */
  diffProfiles(projectId: string, aId: string, bId: string) {
    const get = (id: string) => {
      const r = this.ds.db.prepare('SELECT variables_json, name FROM env_profiles WHERE id = ? AND project_id = ?').get(id, projectId) as
        | { variables_json: string; name: string } | undefined;
      if (!r) throw new NotFoundException(`环境档案不存在：${id}`);
      return { name: r.name, vars: JSON.parse(r.variables_json) as Record<string, string> };
    };
    const a = get(aId);
    const b = get(bId);
    const onlyA: Record<string, string> = {};
    const onlyB: Record<string, string> = {};
    const changed: Array<{ key: string; from: string; to: string }> = [];
    const same: string[] = [];
    for (const [k, v] of Object.entries(a.vars)) {
      if (!(k in b.vars)) onlyA[k] = v;
      else if (b.vars[k] !== v) changed.push({ key: k, from: v, to: b.vars[k] });
      else same.push(k);
    }
    for (const [k, v] of Object.entries(b.vars)) if (!(k in a.vars)) onlyB[k] = v;
    return { a: a.name, b: b.name, onlyA: this.mask(onlyA), onlyB: this.mask(onlyB), changed: changed.map((c) => ({ ...c, from: this.maskVal(c.key, c.from), to: this.maskVal(c.key, c.to) })), same };
  }

  private SENSITIVE = /(secret|password|token|key|credential)/i;

  private maskVal(key: string, v: string) {
    return this.SENSITIVE.test(key) ? '***' : v;
  }

  private mask(vars: Record<string, string>) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) out[k] = this.maskVal(k, v);
    return out;
  }
}
