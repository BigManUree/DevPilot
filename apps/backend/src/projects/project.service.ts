import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../database/database.module';
import { AuditService } from '../permissions/audit.service';
import { ProjectAnalyzer, type AnalysisResult } from './project-analyzer';
import type { ProjectImportSource } from '@devpilot/shared-types';
import { platform as plat } from '@devpilot/platform-adapters';

/**
 * 项目管理（PRD 3.2 + WF-02）：
 * 六种导入入口统一汇总到 analyzeProject；
 * 识别结果为「草案」，预览确认后 config_version 落库；
 * 删除默认只删 DevPilot 记录，不动真实目录。
 */
@Injectable()
export class ProjectService {
  constructor(
    private readonly ds: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** 统一导入：source ∈ folder|drag|script|git|archive|scan */
  import(input: {
    source: ProjectImportSource;
    rootPath?: string;
    gitUrl?: string;
    archivePath?: string;
    scanDir?: string;
    name?: string;
  }): { projectId: string; analysis: AnalysisResult } {
    let root = input.rootPath;

    if (input.source === 'git' && input.gitUrl) {
      root = this.cloneRepo(input.gitUrl);
    } else if (input.source === 'archive' && input.archivePath) {
      root = this.extractArchive(input.archivePath);
    } else if (input.source === 'scan' && input.scanDir) {
      const first = this.scanDirectories(input.scanDir)[0];
      if (!first) throw new Error(`scan: no project found in ${input.scanDir}`);
      root = first;
    }

    if (input.source === 'script') {
      // script 导入：脚本所在目录视为项目根（可后续调整）
      root = path.dirname(input.rootPath ?? '');
    }
    if (!root || !fs.existsSync(root)) throw new Error(`path not found: ${root}`);
    root = path.resolve(root);

    // 幂等导入：同一路径已存在则重分析并返回
    const existing = this.ds.db
      .prepare('SELECT id FROM projects WHERE root_path = ?')
      .get(root) as { id: string } | undefined;
    if (existing) {
      return { projectId: existing.id, analysis: this.reanalyze(existing.id) };
    }

    const projectId = randomUUID();
    const now = new Date().toISOString();
    const analysis = ProjectAnalyzer.analyze(root);

    this.ds.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, project_type, language, framework, import_source, analysis_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'drafted', ?, ?)`,
      )
      .run(
        projectId,
        input.name ?? path.basename(root),
        root,
        analysis.facts.project_type ?? null,
        analysis.facts.language ?? null,
        analysis.facts.framework ?? null,
        input.source,
        now,
        now,
      );

    // 服务草案入表（状态 Stopped，待确认）
    const insSvc = this.ds.db.prepare(
      `INSERT INTO project_services (id, project_id, name, service_type, workdir, start_command, build_command, port, depends_on_json, shared, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Stopped', ?, ?)`,
    );
    for (const s of analysis.services) {
      insSvc.run(
        randomUUID(), projectId, s.name, s.service_type, s.workdir,
        s.start_command ?? null, s.build_command ?? null, s.port ?? null,
        s.depends_on ? JSON.stringify(s.depends_on) : null, s.shared ? 1 : 0, now, now,
      );
    }

    // 配置草案 JSON 快照
    this.saveConfigSnapshot(projectId, analysis);

    this.audit.record({
      subject: 'user:local-user',
      action: 'project.import',
      target: root,
      result: 'ok',
      detail: { source: input.source, projectId, unknowns: analysis.unknowns },
    });

    return { projectId, analysis };
  }

  /** 创建/更新服务配置 */
  createService(projectId: string, input: {
    name: string;
    service_type?: string;
    workdir?: string;
    start_command?: string;
    stop_command?: string;
    build_command?: string;
    port?: number;
    env?: Record<string, string>;
    health_check?: Record<string, unknown>;
    depends_on?: string[];
    shared?: boolean;
  }): { serviceId: string } {
    const p = this.ds.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!p) throw new NotFoundException(`项目不存在：${projectId}`);
    // 同名冲突预检（UNIQUE(project_id, name)）→ 409
    const dupe = this.ds.db.prepare('SELECT id FROM project_services WHERE project_id = ? AND name = ?')
      .get(projectId, input.name) as { id: string } | undefined;
    if (dupe) throw new ConflictException(`同名服务已存在：${input.name}（同项目下服务名不可重复）`);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.ds.db
      .prepare(
        `INSERT INTO project_services (id, project_id, name, service_type, workdir, start_command, stop_command, build_command, port, env_json, health_check_json, depends_on_json, shared, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Stopped', ?, ?)`,
      )
      .run(
        id, projectId, input.name, input.service_type ?? 'custom',
        input.workdir ?? '', input.start_command ?? null, input.stop_command ?? null,
        input.build_command ?? null, input.port ?? null,
        input.env ? JSON.stringify(input.env) : null,
        input.health_check ? JSON.stringify(input.health_check) : null,
        input.depends_on ? JSON.stringify(input.depends_on) : null,
        input.shared ? 1 : 0, now, now,
      );
    return { serviceId: id };
  }

  list() {
    // 列表附带服务数 / 运行中服务数，避免前端逐项目拉详情
    return this.ds.db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM project_services s WHERE s.project_id = p.id) AS service_count,
        (SELECT COUNT(*) FROM project_services s WHERE s.project_id = p.id AND s.status = 'Running') AS running_count
      FROM projects p
      ORDER BY p.created_at DESC
    `).all();
  }

  get(projectId: string) {
    const project = this.ds.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) throw new Error('project not found');
    const services = this.ds.db
      .prepare('SELECT * FROM project_services WHERE project_id = ?')
      .all(projectId);
    const configs = this.ds.db
      .prepare('SELECT * FROM project_configs WHERE project_id = ?')
      .all(projectId);
    return { project, services, configs };
  }

  /** 重新分析：重新跑规则引擎，config_version+1；新识别到的服务自动补录入表（同名跳过） */
  reanalyze(projectId: string): AnalysisResult {
    const row = this.ds.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as { root_path: string } | undefined;
    if (!row) throw new Error('project not found');
    const analysis = ProjectAnalyzer.analyze(row.root_path);
    this.ds.db
      .prepare('UPDATE projects SET analysis_status=?, updated_at=? WHERE id=?')
      .run('drafted', new Date().toISOString(), projectId);
    this.saveConfigSnapshot(projectId, analysis);

    // 补录：识别规则升级后（如新增了 Python 子目录入口识别），已导入的项目重新分析即可补上漏掉的服务
    const existing = new Set(
      (this.ds.db.prepare('SELECT name FROM project_services WHERE project_id = ?').all(projectId) as Array<{ name: string }>).map((r) => r.name),
    );
    const now = new Date().toISOString();
    const insSvc = this.ds.db.prepare(
      `INSERT INTO project_services (id, project_id, name, service_type, workdir, start_command, build_command, port, depends_on_json, shared, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Stopped', ?, ?)`,
    );
    const added: string[] = [];
    for (const s of analysis.services) {
      if (existing.has(s.name)) continue;
      insSvc.run(
        randomUUID(), projectId, s.name, s.service_type, s.workdir,
        s.start_command ?? null, s.build_command ?? null, s.port ?? null,
        s.depends_on ? JSON.stringify(s.depends_on) : null, s.shared ? 1 : 0, now, now,
      );
      added.push(s.name);
    }
    if (added.length) {
      this.audit.record({ subject: 'user:local-user', action: 'project.reanalyze', target: projectId, result: 'ok', detail: { added } });
    }
    return analysis;
  }

  /** 用户确认草案：状态 → confirmed */
  confirm(projectId: string) {
    const r = this.ds.db
      .prepare(`UPDATE projects SET analysis_status='confirmed', config_version=config_version+1, updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), projectId);
    if (r.changes === 0) throw new Error('project not found');
    return { projectId, status: 'confirmed' };
  }

  /** 删除：默认仅删 DevPilot 记录；deleteFiles 需显式传入（UI 另有确认弹窗） */
  remove(projectId: string, deleteFiles = false) {
    const row = this.ds.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string } | undefined;
    if (!row) throw new Error('project not found');
    this.ds.db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    this.audit.record({
      subject: 'user:local-user',
      action: 'project.delete',
      target: row.root_path,
      result: 'ok',
      detail: { deleteFiles, note: deleteFiles ? '磁盘文件已删除' : '仅删除 DevPilot 记录' },
    });
    if (deleteFiles) fs.rmSync(row.root_path, { recursive: true, force: true });
    return { projectId, deletedRecord: true, deletedFiles: deleteFiles };
  }

  /** scan：列出候选项目目录（含 package.json/pom.xml/.git 等标记的一级子目录） */
  scanDirectories(scanDir: string): string[] {
    if (!fs.existsSync(scanDir)) return [];
    const markers = ['package.json', 'pom.xml', 'build.gradle', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'composer.json', '.git'];
    return fs
      .readdirSync(scanDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(scanDir, d.name))
      .filter((p) => markers.some((m) => fs.existsSync(path.join(p, m))));
  }

  private saveConfigSnapshot(projectId: string, analysis: AnalysisResult) {
    const dataDir = process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data');
    const cfgDir = path.join(dataDir, 'configs', projectId);
    fs.mkdirSync(cfgDir, { recursive: true });
    const version = Math.floor(Date.now() / 1000);
    const file = path.join(cfgDir, `draft.v${version}.json`);
    fs.writeFileSync(file, JSON.stringify(analysis, null, 2), 'utf-8');
    this.ds.db
      .prepare(
        `INSERT INTO project_configs (id, project_id, config_type, version, content_ref, source, created_at)
         VALUES (?, ?, 'start-config', 1, ?, 'rule-engine', ?)`,
      )
      .run(randomUUID(), projectId, file, new Date().toISOString());
  }

  private cloneRepo(url: string): string {
    const dataDir = process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data');
    const reposDir = path.join(dataDir, 'repos');
    fs.mkdirSync(reposDir, { recursive: true });
    const name = url.split('/').pop()?.replace(/\.git$/, '') ?? randomUUID();
    const dest = path.join(reposDir, `${name}.${Date.now()}`);
    // 同步克隆用 execSync 保证时序（克隆属于导入关键路径）
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    execSync(`git clone ${JSON.stringify(url)} ${JSON.stringify(dest)}`, { stdio: 'pipe' });
    return dest;
  }

  private extractArchive(archivePath: string): string {
    const dataDir = process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data');
    const dest = path.join(dataDir, 'archives', `${path.basename(archivePath)}.${Date.now()}`);
    fs.mkdirSync(dest, { recursive: true });
    // 解压实现收敛到 platform-adapters（win32 Expand-Archive / posix unzip）
    plat.extractArchive(archivePath, dest);
    return dest;
  }
}
