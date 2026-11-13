import { Injectable } from '@nestjs/common';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../database/database.module';
import { probeAll } from './tool-probes';

/**
 * 环境与依赖检测（PRD 3.11 + WF-04）：
 * - 全局工具探测（PATH + 版本命令）
 * - 项目需求比对：识别结果 → 需要哪些环境 → 缺失/版本不匹配报告
 * - 端口占用检查
 * 缺工具只给检测结论与官方安装入口，不自动安装。
 */
@Injectable()
export class EnvironmentService {
  constructor(private readonly ds: DatabaseService) {}

  async detectAll() {
    const tools = await probeAll();
    // 同步 environments 表
    const upsert = this.ds.db.prepare(
      `INSERT INTO environments (id, name, type, executable_path, version, detect_status, scope, source)
       VALUES (?, ?, 'tool', ?, ?, ?, 'global', 'auto-detect')
       ON CONFLICT(id) DO UPDATE SET version=excluded.version, detect_status=excluded.detect_status`,
    );
    for (const t of tools) upsert.run(t.id, t.name, t.id, t.version ?? null, t.status);
    return tools;
  }

  /** 项目环境需求比对（基于识别事实） */
  async checkProject(projectId: string) {
    const project = this.ds.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | { id: string; language: string | null; framework: string | null; root_path: string }
      | undefined;
    if (!project) throw new Error('project not found');

    const tools = await probeAll();
    const byId = new Map(tools.map((t) => [t.id, t]));

    const requirements: Array<{ toolId: string; reason: string }> = [];
    const lang = project.language ?? '';
    if (/javascript|typescript/.test(lang)) {
      requirements.push({ toolId: 'node', reason: 'JavaScript/TypeScript 运行时' }, { toolId: 'npm', reason: '包管理器' });
      if (fs.existsSync(path.join(project.root_path, 'pnpm-lock.yaml'))) requirements.push({ toolId: 'pnpm', reason: '存在 pnpm-lock.yaml' });
      if (fs.existsSync(path.join(project.root_path, 'yarn.lock'))) requirements.push({ toolId: 'yarn', reason: '存在 yarn.lock' });
    }
    if (/java/.test(lang)) {
      requirements.push({ toolId: 'java', reason: 'Java 运行时' }, { toolId: 'javac', reason: '需要 JDK 编译' });
      if (fs.existsSync(path.join(project.root_path, 'pom.xml'))) requirements.push({ toolId: 'maven', reason: '存在 pom.xml' });
      if (fs.existsSync(path.join(project.root_path, 'build.gradle')) || fs.existsSync(path.join(project.root_path, 'build.gradle.kts')))
        requirements.push({ toolId: 'gradle', reason: '存在 Gradle 构建文件' });
    }
    if (/python/.test(lang)) requirements.push({ toolId: 'python', reason: 'Python 运行时' });
    if (/go/.test(lang)) requirements.push({ toolId: 'go', reason: 'Go 工具链' });
    if (/rust/.test(lang)) requirements.push({ toolId: 'rust', reason: 'Rust 工具链' });
    if (/php/.test(lang)) requirements.push({ toolId: 'php', reason: 'PHP 运行时' }, { toolId: 'composer', reason: 'PHP 依赖管理' });
    // docker-compose 项目
    if (fs.existsSync(path.join(project.root_path, 'docker-compose.yml'))) requirements.push({ toolId: 'docker', reason: '存在 docker-compose.yml' });

    // node_modules 存在性检查
    const depsInstalled = fs.existsSync(path.join(project.root_path, 'node_modules'));

    const report = requirements.map((r) => {
      const t = byId.get(r.toolId);
      return {
        toolId: r.toolId,
        reason: r.reason,
        status: t?.status ?? 'missing',
        version: t?.version,
        installHint: t?.installHint,
      };
    });

    // 端口占用检查
    const services = this.ds.db.prepare('SELECT id, name, port FROM project_services WHERE project_id = ?').all(projectId) as Array<{ id: string; name: string; port: number | null }>;
    const portChecks = [];
    for (const s of services) {
      if (!s.port) continue;
      portChecks.push({ service: s.name, port: s.port, occupied: await this.portOccupied(s.port) });
    }

    // 需求 7.3：missing（未安装，含安装入口）与 error（探测异常，需人工排查）分开报告
    const missing = report.filter((r) => r.status === 'missing');
    const errors = report.filter((r) => r.status === 'error');
    const problems = [...missing, ...errors];
    return {
      projectId,
      requirements: report,
      missing,
      errors,
      problems,
      depsInstalled,
      portChecks,
      overall: problems.length === 0 && !portChecks.some((p) => p.occupied) ? 'ready' : 'action-needed',
    };
  }

  portOccupied(port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port, timeout: timeoutMs });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
      sock.once('error', () => resolve(false));
    });
  }

  // ============ 智能化升级（多版本 / 匹配 / 外部服务 / 环境变量） ============

  /** 多版本扫描：node/java/python/maven/gradle/go/rust/php/docker */
  async scanAllVersions() {
    const { scanAllVersions } = await import('./version-scan');
    return scanAllVersions();
  }

  /** 项目要求 vs 本机多版本匹配（约束来自组件树档案 runtime.languageVersion） */
  async matchProject(projectId: string) {
    const { matchRequirement } = await import('./version-scan');
    const profile = this.getProfile(projectId);
    if (!profile?.components?.length) return { projectId, matches: [], note: '项目尚无组件树档案，请先重新分析' };

    // 按 componentId 去重的语言版本约束
    const reqs: Array<{ componentId: string; componentName: string; toolId: string; requirement: string | null; source: string | null }> = [];
    for (const comp of profile.components) {
      const rt = comp.runtime;
      if (!rt?.languageVersion) continue;
      const map: Record<string, string> = { java: 'java', javascript: 'node', typescript: 'node', python: 'python', go: 'go', rust: 'rust', php: 'php' };
      const toolId = map[comp.language ?? ''];
      if (!toolId) continue;
      reqs.push({ componentId: comp.id, componentName: comp.name, toolId, requirement: rt.languageVersion, source: rt.languageVersionSource });
    }
    // gradle 约束
    for (const comp of profile.components) {
      if (comp.packageManager === 'gradle' && comp.runtime?.packageManagerVersion) {
        reqs.push({ componentId: comp.id, componentName: comp.name, toolId: 'gradle', requirement: comp.runtime.packageManagerVersion, source: comp.runtime.languageVersionSource });
      }
    }

    const matches = [];
    for (const r of reqs) {
      const m = await matchRequirement(r.toolId, r.requirement, r.source);
      matches.push({ component: { id: r.componentId, name: r.componentName }, ...m });
    }
    const overall = matches.some((m) => m.status === 'missing') ? 'missing' : matches.some((m) => m.status === 'mismatch') ? 'mismatch' : matches.length ? 'ready' : 'no-constraints';
    return { projectId, overall, matches };
  }

  /** 外部服务探活：组件档案中的 externalServices + compose 服务 */
  async checkExternalServices(projectId: string) {
    const { execFile } = await import('node:child_process');
    const profile = this.getProfile(projectId);
    const seen = new Map<string, { type: string; port: number | null; source: string }>();
    for (const comp of profile?.components ?? []) {
      for (const svc of comp.runtime?.externalServices ?? []) {
        if (svc.type === 'unknown') continue;
        const key = `${svc.type}:${svc.port ?? ''}`;
        if (!seen.has(key)) seen.set(key, { type: svc.type, port: svc.port, source: `${comp.name}: ${svc.source}` });
      }
    }

    const results = [];
    for (const svc of seen.values()) {
      if (!svc.port) continue;
      const open = await this.portOccupied(svc.port, 1500);
      // 占用时进一步识别监听进程（Windows netstat）
      let processName: string | null = null;
      if (open && process.platform === 'win32') {
        processName = await new Promise<string | null>((resolve) => {
          execFile('powershell.exe', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${svc.port} -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess | ForEach-Object { (Get-Process -Id $_).ProcessName }`], { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
        });
      }
      results.push({
        type: svc.type,
        port: svc.port,
        listening: open,
        processName,
        status: open ? 'running' : 'not-running',
        source: svc.source,
        advice: open ? `${svc.type} 在端口 ${svc.port} 可达${processName ? `（进程 ${processName}）` : ''}。` : `${svc.type} 未在端口 ${svc.port} 监听。可安装/启动该服务，或使用 Docker 启动（需用户确认）。`,
      });
    }
    return { projectId, services: results, overall: results.every((r) => r.listening) ? 'ready' : results.length ? 'action-needed' : 'no-external-services' };
  }

  /** 环境变量检查：档案 envVars vs 项目根 .env 实际内容 */
  async checkEnvVars(projectId: string) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const profile = this.getProfile(projectId);
    const project = this.ds.db.prepare('SELECT root_path, env_json FROM projects WHERE id = ?').get(projectId) as { root_path: string; env_json: string | null } | undefined;
    if (!project) throw new Error('project not found');
    const profile2 = profile as unknown as { components: Array<{ name: string; path: string; runtime: { envVars: Array<{ key: string; source: string; required: boolean; hasDefault: boolean; sensitive: boolean; defaultValue?: string }> } | null }> | undefined };
    const required: Array<{ key: string; source: string; component: string; hasDefault: boolean; sensitive: boolean }> = [];
    for (const comp of profile2?.components ?? []) {
      for (const v of comp.runtime?.envVars ?? []) {
        required.push({ key: v.key, source: v.source, component: comp.name, hasDefault: v.hasDefault, sensitive: v.sensitive });
      }
    }
    if (!required.length) return { projectId, vars: [], missing: [], overall: 'no-requirements' };

    // 已有值：项目根各组件目录下的 .env
    const values = new Map<string, string>();
    const envPath = path.join(project.root_path, '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
        if (m) values.set(m[1], m[2]);
      }
    }
    const results = required.map((r) => {
      const inDotEnv = values.has(r.key);
      const inSystem = !!process.env[r.key];
      return {
        key: r.key,
        component: r.component,
        source: r.source,
        sensitive: r.sensitive,
        provided: inDotEnv || inSystem,
        where: inDotEnv ? '.env' : inSystem ? 'system-env' : null,
        hasDefault: r.hasDefault,
        // 不回显敏感值
        status: inDotEnv || inSystem ? 'provided' : r.hasDefault ? 'default-available' : 'missing',
      };
    });
    const missing = results.filter((r) => r.status === 'missing');
    return {
      projectId,
      vars: results,
      missing,
      overall: missing.length ? 'missing' : 'ready',
      note: missing.length ? `缺失 ${missing.length} 个必填环境变量（不自动生成密钥，请在配置向导中填写）` : null,
    };
  }

  /** 读取项目组件树档案 */
  private getProfile(projectId: string): { components: Array<{ id: string; name: string; path: string; language: string | null; packageManager: string | null; runtime: { languageVersion: string | null; languageVersionSource: string | null; packageManagerVersion: string | null; envVars: Array<{ key: string; source: string; required: boolean; hasDefault: boolean; sensitive: boolean; defaultValue?: string }>; externalServices: Array<{ type: string; host: string | null; port: number | null; source: string }> } | null }> } | null {
    const row = this.ds.db.prepare('SELECT components_json FROM projects WHERE id = ?').get(projectId) as { components_json: string | null } | undefined;
    if (!row?.components_json) return null;
    try {
      return JSON.parse(row.components_json);
    } catch {
      return null;
    }
  }
}
