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
}
