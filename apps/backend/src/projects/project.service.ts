import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../database/database.module';
import { AuditService } from '../permissions/audit.service';
import { LogService } from '../logs/log.service';
import { ModelService } from '../agents/model.service';
import { ProjectAnalyzer, type AnalysisResult } from './project-analyzer';
import { ProfileEngine } from './analyzer/profile';
import type { ProjectImportSource } from '@devpilot/shared-types';
import { platform as plat } from '@devpilot/platform-adapters';

/**
 * 项目管理（PRD 3.2 + WF-02）：
 * 六种导入入口统一汇总到 analyzeProject；
 * 识别结果为「草案」，预览确认后 config_version 落库；
 * 删除默认只删 DevPilot 记录，不动真实目录。
 * 导入时生成项目简介：规则摘要（清单文件/README）立即落库，
 * Agent 模型异步扫描项目生成更准确的一句话简介，完成后覆盖更新。
 */
@Injectable()
export class ProjectService {
  constructor(
    private readonly ds: DatabaseService,
    private readonly audit: AuditService,
    private readonly model: ModelService,
    private readonly logs: LogService,
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
    // 规则摘要先落库（秒级、不依赖模型），保证卡片立即可展示
    const description = this.ruleDescription(root);

    this.ds.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, project_type, language, framework, description, import_source, analysis_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'drafted', ?, ?)`,
      )
      .run(
        projectId,
        input.name ?? path.basename(root),
        root,
        analysis.facts.project_type ?? null,
        analysis.facts.language ?? null,
        analysis.facts.framework ?? null,
        description,
        input.source,
        now,
        now,
      );

    // Agent 异步扫描项目生成一句话简介，完成后覆盖规则摘要
    this.scheduleAiSummary(projectId, root, analysis);

    // 服务草案入表（状态 Stopped，待确认）
    const insSvc = this.ds.db.prepare(
      `INSERT INTO project_services (id, project_id, name, service_type, workdir, start_command, build_command, port, depends_on_json, shared, usage_hint, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Stopped', ?, ?)`,
    );
    for (const s of analysis.services) {
      insSvc.run(
        randomUUID(), projectId, s.name, s.service_type, s.workdir,
        s.start_command ?? null, s.build_command ?? null, s.port ?? null,
        s.depends_on ? JSON.stringify(s.depends_on) : null, s.shared ? 1 : 0,
        (s as { usage_hint?: unknown }).usage_hint ? JSON.stringify((s as { usage_hint: unknown }).usage_hint) : null,
        now, now,
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
    // 列表附带服务数 / 运行中服务数 / CLI 服务 id（CLI 项目卡片直接给「打开终端」入口），避免前端逐项目拉详情
    return this.ds.db.prepare(`
      SELECT p.*,
        (SELECT COUNT(*) FROM project_services s WHERE s.project_id = p.id) AS service_count,
        (SELECT COUNT(*) FROM project_services s WHERE s.project_id = p.id AND s.status = 'Running') AS running_count,
        (SELECT s.id FROM project_services s WHERE s.project_id = p.id AND s.service_type = 'cli' LIMIT 1) AS cli_service_id
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

  /** 重新分析：重新跑规则引擎，config_version+1；新识别到的服务自动补录入表（同名跳过）；同步刷新组件树档案 */
  reanalyze(projectId: string): AnalysisResult {
    const row = this.ds.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as { root_path: string } | undefined;
    if (!row) throw new Error('project not found');
    const analysis = ProjectAnalyzer.analyze(row.root_path);
    // 组件树档案：指纹变化时刷新（缓存失效机制）
    const profile = ProfileEngine.build(row.root_path);
    const prev = this.ds.db.prepare('SELECT profile_hash FROM projects WHERE id = ?').get(projectId) as { profile_hash: string | null } | undefined;
    const changed = !prev?.profile_hash || prev.profile_hash !== profile.fingerprint;
    this.ds.db
      .prepare('UPDATE projects SET analysis_status=?, updated_at=?, components_json=?, profile_hash=? WHERE id=?')
      .run('drafted', new Date().toISOString(), JSON.stringify(profile), profile.fingerprint, projectId);
    this.saveConfigSnapshot(projectId, analysis);
    if (changed) {
      this.audit.record({ subject: 'user:local-user', action: 'project.profile-refresh', target: projectId, result: 'ok', detail: { fingerprint: profile.fingerprint } });
    }

    // 补录：识别规则升级后（如新增了 Python 子目录入口识别），已导入的项目重新分析即可补上漏掉的服务
    const existing = new Set(
      (this.ds.db.prepare('SELECT name FROM project_services WHERE project_id = ?').all(projectId) as Array<{ name: string }>).map((r) => r.name),
    );
    const now = new Date().toISOString();
    const insSvc = this.ds.db.prepare(
      `INSERT INTO project_services (id, project_id, name, service_type, workdir, start_command, build_command, port, depends_on_json, shared, usage_hint, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Stopped', ?, ?)`,
    );
    const added: string[] = [];
    const syncHint = this.ds.db.prepare('UPDATE project_services SET usage_hint = ?, updated_at = ? WHERE project_id = ? AND name = ?');
    for (const s of analysis.services) {
      const hintJson = (s as { usage_hint?: unknown }).usage_hint ? JSON.stringify((s as { usage_hint: unknown }).usage_hint) : null;
      if (existing.has(s.name)) {
        // 已有服务不重建（保留运行时修正过的启动命令等），但用法提示同步更新（分析器升级后 CLI 用法可能变化）
        if (hintJson) syncHint.run(hintJson, now, projectId, s.name);
        continue;
      }
      insSvc.run(
        randomUUID(), projectId, s.name, s.service_type, s.workdir,
        s.start_command ?? null, s.build_command ?? null, s.port ?? null,
        s.depends_on ? JSON.stringify(s.depends_on) : null, s.shared ? 1 : 0,
        hintJson,
        now, now,
      );
      added.push(s.name);
    }
    if (added.length) {
      this.audit.record({ subject: 'user:local-user', action: 'project.reanalyze', target: projectId, result: 'ok', detail: { added } });
    }
    // 幂等重导入 / 重新分析时若还没有简介，补一次 Agent 生成
    const proj = this.ds.db.prepare('SELECT root_path, description FROM projects WHERE id = ?').get(projectId) as { root_path: string; description: string | null } | undefined;
    if (proj && !proj.description) this.scheduleAiSummary(projectId, proj.root_path, analysis);
    return analysis;
  }

  /** 项目组件树档案（含指纹；档案缺失时现场构建一次） */
  getProfile(projectId: string): Record<string, unknown> {
    const row = this.ds.db.prepare('SELECT root_path, components_json, profile_hash FROM projects WHERE id = ?').get(projectId) as
      | { root_path: string; components_json: string | null; profile_hash: string | null }
      | undefined;
    if (!row) throw new NotFoundException(`项目不存在：${projectId}`);
    if (row.components_json) {
      try { return JSON.parse(row.components_json); } catch { /* 落库数据损坏则重建 */ }
    }
    const profile = ProfileEngine.build(row.root_path);
    this.ds.db.prepare('UPDATE projects SET components_json=?, profile_hash=? WHERE id=?')
      .run(JSON.stringify(profile), profile.fingerprint, projectId);
    return profile as unknown as Record<string, unknown>;
  }

  /** 运行档案 + 修复记录（真实历史，不模拟） */
  getArchives(projectId: string): Record<string, unknown> {
    const runs = this.ds.db.prepare(
      'SELECT run_kind, command, port, pid, status, summary, created_at FROM run_archives WHERE project_id = ? ORDER BY created_at DESC LIMIT 50',
    ).all(projectId);
    const repairs = this.ds.db.prepare(
      'SELECT category, confidence, risk, outcome, verify_command, verify_result, created_at, finished_at FROM repair_records_v2 WHERE project_id = ? ORDER BY created_at DESC LIMIT 50',
    ).all(projectId);
    return { runs, repairs };
  }

  /** 手动重新生成简介（项目详情/卡片上的刷新入口） */
  async regenerateDescription(projectId: string): Promise<{ description: string | null }> {
    const row = this.ds.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string } | undefined;
    if (!row) throw new NotFoundException(`项目不存在：${projectId}`);
    const analysis = ProjectAnalyzer.analyze(row.root_path);
    await this.aiSummarize(projectId, row.root_path, analysis);
    const updated = this.ds.db.prepare('SELECT description FROM projects WHERE id = ?').get(projectId) as { description: string | null };
    return { description: updated.description };
  }

  /**
   * Agent 异步生成项目简介（不阻塞导入主流程）：
   * 模型读 README/清单文件与识别事实，输出一句话中文简介；失败静默保留规则摘要。
   */
  private scheduleAiSummary(projectId: string, root: string, analysis: AnalysisResult): void {
    void this.aiSummarize(projectId, root, analysis).catch((e) => {
      this.logs.log({ level: 'info', sourceModule: 'projects', projectId, message: `项目简介 Agent 生成未完成（保留规则摘要）：${String((e as Error)?.message ?? e).slice(0, 200)}` });
    });
  }

  private async aiSummarize(projectId: string, root: string, analysis: AnalysisResult): Promise<void> {
    const readme = ['README.md', 'readme.md', 'Readme.md', 'README.txt', 'README'].find((f) => fs.existsSync(path.join(root, f)));
    const readmeHead = readme ? fs.readFileSync(path.join(root, readme), 'utf-8').slice(0, 3000) : '';
    const rule = this.ruleDescription(root);
    const facts = analysis.facts;
    const user = [
      `项目名称：${path.basename(root)}`,
      `语言/框架：${[facts.language, facts.framework].filter(Boolean).join(' / ') || '未识别'}`,
      `识别到的服务：${analysis.services.map((s) => `${s.name}(${s.service_type})`).join('、') || '无'}`,
      rule ? `清单文件描述：${rule}` : '',
      readmeHead ? `README 开头内容：\n${readmeHead}` : '无 README',
    ].filter(Boolean).join('\n');

    const out = await this.model.chat([
      { role: 'system', content: '你是项目分析助手。根据给定的项目信息，用一句不超过 60 字的简体中文概括这个项目是做什么的、给谁用的。直接输出简介文本，不要任何前缀、引号、标点编号或解释。' },
      { role: 'user', content: user },
    ]);
    const summary = out.trim().replace(/^["'「『]+|["'」』]+$/g, '').slice(0, 120);
    if (!summary) throw new Error('模型返回空简介');
    this.ds.db
      .prepare('UPDATE projects SET description = ?, updated_at = ? WHERE id = ?')
      .run(summary, new Date().toISOString(), projectId);
    this.logs.log({ level: 'info', sourceModule: 'projects', projectId, message: `项目简介已由 Agent 生成：${summary}` });
  }

  /** 规则摘要（同步、零依赖）：清单文件的 description 字段 → README 首段，兜底按技术栈拼一句 */
  private ruleDescription(root: string): string | null {
    const read = (p: string) => { try { return fs.readFileSync(path.join(root, p), 'utf-8'); } catch { return ''; } };
    let desc = '';

    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try { desc = String((JSON.parse(read('package.json')) as Record<string, unknown>).description ?? ''); } catch { /* 损坏忽略 */ }
    }
    if (!desc && fs.existsSync(path.join(root, 'Cargo.toml'))) {
      desc = /^description\s*=\s*"([^"]+)"/m.exec(read('Cargo.toml'))?.[1] ?? '';
    }
    if (!desc && fs.existsSync(path.join(root, 'pyproject.toml'))) {
      desc = /^description\s*=\s*"([^"]+)"/m.exec(read('pyproject.toml'))?.[1] ?? '';
    }
    if (!desc && fs.existsSync(path.join(root, 'composer.json'))) {
      try { desc = String((JSON.parse(read('composer.json')) as Record<string, unknown>).description ?? ''); } catch { /* 忽略 */ }
    }

    // README 首个非标题/非徽章行
    if (!desc) {
      const readme = ['README.md', 'README.txt', 'README', 'readme.md'].find((f) => fs.existsSync(path.join(root, f)));
      if (readme) {
        for (const raw of read(readme).split(/\r?\n/).slice(0, 40)) {
          const line = raw.trim().replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`#>]/g, '').trim();
          if (!line || /^<|^---|^\||^={3,}/.test(line)) continue;
          desc = line;
          break;
        }
      }
    }

    if (desc) return desc.trim().slice(0, 150);
    return null; // 交给 Agent 生成；Agent 也不可用时卡片不显示简介
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
