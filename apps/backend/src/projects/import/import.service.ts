import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../../database/database.module';
import { EventsGateway } from '../../events.gateway';
import { ProjectAnalyzer, type AnalysisResult } from '../project-analyzer';
import { ProfileEngine } from '../analyzer/profile';
import { safeExtractArchive } from './safe-archive';
import { GitImportService } from '../git-import.service';
import { ConfigCheckService } from '../config-check.service';

/**
 * 统一项目导入（升级任务书 §三）：
 * - SourceAdapter 架构：folder/git/archive/http/docker/scan 各自负责"获取文件"，后续分析/保存完全统一
 * - 任务化：import_jobs 表持久化，真实进度（phase/percent），支持取消，失败清理
 * - HTTP 下载：SSRF 防护（拒绝内网/环回/云元数据地址，DNS 解析后复验 IP，重定向逐跳复验），大小/超时/协议限制
 * - Docker：识别 Compose/Dockerfile 项目（真实 docker 操作走后续 runtime，导入阶段只做文件识别与引擎可用性检查）
 */

export interface UnifiedImportRequest {
  source: 'folder' | 'git' | 'archive' | 'http' | 'docker' | 'scan';
  /** folder/scan: 本地路径；archive: 压缩包路径；http: 下载 URL；git: 仓库 URL；docker: compose 项目路径 */
  ref: string;
  name?: string;
  branch?: string;
  /** docker 项目：compose 文件路径（可选，默认在 ref 目录中找） */
  composeFile?: string;
}

interface JobCtx {
  id: string;
  source: string;
  ref: string;
  cancelled: boolean;
  tmpDir?: string;
}

const DOWNLOAD_LIMITS = { maxBytes: 1024 * 1024 * 1024, timeoutMs: 5 * 60_000, maxRedirects: 5 };

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local（含云元数据 169.254.169.254）
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 0) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
    return false;
  }
  return true;
}

/** SSRF 防护：校验 URL 目标（协议/主机/DNS 解析后的 IP） */
async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`非法 URL：${rawUrl}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`仅允许 http/https 协议，拒绝 ${url.protocol}`);
  const host = url.hostname;
  // 直接以 IP/localhost 表达的主机
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|\[::\])/i.test(host)) throw new Error(`拒绝下载本机/环回地址：${host}`);
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error(`拒绝下载内网地址：${host}`);
  // DNS 解析后复验（防 DNS 重绑定的一跳校验）
  if (!net.isIP(host)) {
    const addrs = await new Promise<string[]>((resolve) => dns.lookup(host, { all: true }, (err, res) => resolve(err ? [] : res.map((r) => r.address))));
    if (!addrs.length) throw new Error(`域名解析失败：${host}`);
    for (const a of addrs) {
      if (isPrivateAddress(a)) throw new Error(`域名 ${host} 解析到内网地址 ${a}，拒绝下载（SSRF 防护）`);
    }
  }
  return url;
}

/** 带安全校验的 HTTP 下载（重定向逐跳复验） */
async function safeDownload(url: URL, destPath: string, ctx: JobCtx, onProgress: (got: number, total: number | null) => void): Promise<void> {
  let current = url;
  for (let redirects = 0; redirects <= DOWNLOAD_LIMITS.maxRedirects; redirects++) {
    await assertSafeUrl(current.toString());
    if (ctx.cancelled) throw new Error('任务已取消');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_LIMITS.timeoutMs);
    try {
      const res = await fetch(current, { signal: ctrl.signal, redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`重定向缺少 Location（HTTP ${res.status}）`);
        current = new URL(loc, current);
        continue; // 下一跳重新走 assertSafeUrl
      }
      if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`);

      const total = Number(res.headers.get('content-length')) || null;
      if (total && total > DOWNLOAD_LIMITS.maxBytes) throw new Error(`文件 ${total}B 超过下载上限 ${DOWNLOAD_LIMITS.maxBytes}B`);
      const out = fs.createWriteStream(destPath);
      let got = 0;
      const reader = res.body?.getReader();
      if (!reader) throw new Error('响应无内容');
      for (;;) {
        if (ctx.cancelled) throw new Error('任务已取消');
        const { done, value } = await reader.read();
        if (done) break;
        got += value.byteLength;
        if (got > DOWNLOAD_LIMITS.maxBytes) throw new Error(`下载超出 ${DOWNLOAD_LIMITS.maxBytes}B 上限，已中止`);
        await new Promise<void>((resolve, reject) => {
          out.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
        });
        onProgress(got, total);
      }
      await new Promise<void>((resolve) => out.end(resolve));
      return;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`重定向次数超过 ${DOWNLOAD_LIMITS.maxRedirects} 上限`);
}

@Injectable()
export class UnifiedImportService {
  private jobs = new Map<string, JobCtx>();

  constructor(
    private readonly ds: DatabaseService,
    private readonly events: EventsGateway,
    private readonly gitImport: GitImportService,
    private readonly configCheck: ConfigCheckService,
  ) {}

  /** 发起统一导入（异步 job，返回 jobId） */
  start(req: UnifiedImportRequest): { jobId: string } {
    if (!req.ref || typeof req.ref !== 'string') throw new Error('缺少来源引用 ref');
    const id = randomUUID();
    const now = new Date().toISOString();
    this.ds.db
      .prepare(`INSERT INTO import_jobs (id, source, source_ref, status, phase, percent, created_at) VALUES (?, ?, ?, 'queued', 'queued', 0, ?)`)
      .run(id, req.source, req.ref, now);
    const ctx: JobCtx = { id, source: req.source, ref: req.ref, cancelled: false };
    this.jobs.set(id, ctx);
    // 异步执行，不阻塞 HTTP 响应
    void this.run(ctx, req).catch((err) => {
      this.fail(ctx, err instanceof Error ? err.message : String(err));
    });
    return { jobId: id };
  }

  get(jobId: string) {
    const row = this.ds.db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  /** 取消：真实终止（下载中即断流；解压在条目间检查） */
  cancel(jobId: string): { cancelled: boolean } {
    const ctx = this.jobs.get(jobId);
    if (!ctx) return { cancelled: false };
    ctx.cancelled = true;
    const row = this.ds.db.prepare('SELECT status FROM import_jobs WHERE id=?').get(jobId) as { status: string } | undefined;
    if (row && ['queued', 'running'].includes(row.status)) {
      this.ds.db.prepare(`UPDATE import_jobs SET status='cancelled', phase='cancelled', finished_at=?, updated_at=? WHERE id=?`)
        .run(new Date().toISOString(), new Date().toISOString(), jobId);
      this.broadcast(ctx, { phase: 'cancelled', percent: 0, message: '导入已取消' });
    }
    return { cancelled: true };
  }

  private broadcast(ctx: JobCtx, p: { phase: string; percent: number; message: string; detail?: string }) {
    this.ds.db.prepare('UPDATE import_jobs SET phase=?, percent=?, message=?, updated_at=? WHERE id=?')
      .run(p.phase, p.percent, p.message + (p.detail ? ` — ${p.detail}` : ''), new Date().toISOString(), ctx.id);
    this.events.broadcast({
      event_id: randomUUID(),
      event_type: 'import.progress',
      timestamp: new Date().toISOString(),
      source_module: 'import',
      trace_id: ctx.id,
      severity: 'info',
      payload: { jobId: ctx.id, ...p },
    });
  }

  private fail(ctx: JobCtx, message: string) {
    this.ds.db.prepare(`UPDATE import_jobs SET status='failed', phase='failed', error=?, finished_at=?, updated_at=? WHERE id=?`)
      .run(message.slice(0, 500), new Date().toISOString(), new Date().toISOString(), ctx.id);
    // 失败清理临时目录
    if (ctx.tmpDir) { try { fs.rmSync(ctx.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    this.broadcast(ctx, { phase: 'failed', percent: 0, message: '导入失败', detail: message.slice(0, 200) });
  }

  private async run(ctx: JobCtx, req: UnifiedImportRequest): Promise<void> {
    this.ds.db.prepare(`UPDATE import_jobs SET status='running', updated_at=? WHERE id=?`).run(new Date().toISOString(), ctx.id);
    const dataDir = this.dataDir();
    let projectRoot: string | null = null;
    let sourceMeta: Record<string, unknown> = { source: req.source, ref: req.ref };

    try {
      switch (req.source) {
        case 'folder':
        case 'scan': {
          this.broadcast(ctx, { phase: 'validating', percent: 5, message: '校验本地目录' });
          const p = path.resolve(req.ref);
          if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`目录不存在：${req.ref}`);
          projectRoot = p;
          break;
        }
        case 'git': {
          this.broadcast(ctx, { phase: 'fetching', percent: 10, message: 'git clone 开始' });
          const job = this.gitImport.start({ repoUrl: req.ref, branch: req.branch, name: req.name });
          // 轮询复用现有 GitImportService（含镜像回退/进度/失败清理）
          projectRoot = await this.waitForGitJob(job.jobId, ctx);
          sourceMeta = { ...sourceMeta, gitJobId: job.jobId };
          break;
        }
        case 'archive': {
          this.broadcast(ctx, { phase: 'validating', percent: 10, message: '校验压缩包' });
          const p = path.resolve(req.ref);
          if (!fs.existsSync(p)) throw new Error(`压缩包不存在：${req.ref}`);
          const dest = path.join(dataDir, 'imports', `${Date.now()}-${path.basename(p).replace(/\.[^.]+$/, '').replace(/[^\w.-]/g, '_') || 'archive'}`);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          ctx.tmpDir = dest;
          this.broadcast(ctx, { phase: 'extracting', percent: 30, message: '安全解压中', detail: path.basename(p) });
          const r = safeExtractArchive(p, dest);
          projectRoot = await this.resolveProjectDir(r.dir, ctx);
          sourceMeta = { ...sourceMeta, archive: path.basename(p), extractedFiles: r.files, extractedBytes: r.totalBytes };
          ctx.tmpDir = undefined; // 解压成功，目录即为项目本体，不再清理
          break;
        }
        case 'http': {
          this.broadcast(ctx, { phase: 'fetching', percent: 10, message: '安全校验下载地址' });
          const url = await assertSafeUrl(req.ref);
          const fileName = path.basename(decodeURIComponent(url.pathname)) || `download-${Date.now()}.zip`;
          if (!/\.(zip|7z|rar|tar|gz)$/i.test(fileName)) throw new Error(`下载地址未指向压缩包（${fileName}）。仅支持 zip/7z/rar 归档下载导入`);
          const tmpFile = path.join(dataDir, 'downloads', `${Date.now()}-${fileName.replace(/[^\w.-]/g, '_')}`);
          fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
          ctx.tmpDir = tmpFile;
          this.broadcast(ctx, { phase: 'fetching', percent: 20, message: '下载中', detail: url.host });
          await safeDownload(url, tmpFile, ctx, (got, total) => {
            const pct = total ? Math.min(60, 20 + Math.round((got / total) * 40)) : 40;
            this.broadcast(ctx, { phase: 'fetching', percent: pct, message: '下载中', detail: `${(got / 1024 / 1024).toFixed(1)}MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)}MB` : ''}` });
          });
          this.broadcast(ctx, { phase: 'extracting', percent: 65, message: '安全解压中' });
          const dest = path.join(dataDir, 'imports', `${Date.now()}-${fileName.replace(/\.[^.]+$/, '').replace(/[^\w.-]/g, '_')}`);
          const r = safeExtractArchive(tmpFile, dest);
          projectRoot = await this.resolveProjectDir(r.dir, ctx);
          sourceMeta = { ...sourceMeta, url: req.ref, downloadedBytes: fs.statSync(tmpFile).size, extractedFiles: r.files };
          ctx.tmpDir = undefined;
          try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
          break;
        }
        case 'docker': {
          this.broadcast(ctx, { phase: 'validating', percent: 15, message: '识别 Docker 项目' });
          const p = path.resolve(req.ref);
          if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`目录不存在：${req.ref}`);
          const compose = req.composeFile ?? ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml']
            .map((f) => path.join(p, f)).find((f) => fs.existsSync(f));
          const hasDockerfile = fs.existsSync(path.join(p, 'Dockerfile'));
          if (!compose && !hasDockerfile) throw new Error('目录中未找到 docker-compose.yml/compose.yaml/Dockerfile，不是 Docker 项目');
          projectRoot = p;
          sourceMeta = { ...sourceMeta, compose: compose ? path.basename(compose) : null, dockerfile: hasDockerfile };
          // Docker Engine 可用性检查（只读，不拉镜像不启动）
          this.broadcast(ctx, { phase: 'validating', percent: 30, message: '检查 Docker Engine' });
          const { execFile } = require('node:child_process') as typeof import('node:child_process');
          const dockerInfo = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
            execFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
              resolve(err ? { ok: false, detail: `Docker Engine 不可用：${String(err).slice(0, 120)}` } : { ok: true, detail: `Engine ${stdout.trim()}` });
            });
          });
          sourceMeta = { ...sourceMeta, dockerEngine: dockerInfo };
          break;
        }
        default:
          throw new Error(`未知导入来源：${req.source}`);
      }

      if (ctx.cancelled) throw new Error('任务已取消');
      if (!projectRoot) throw new Error('未能获得项目目录');

      // 统一分析（所有来源同一入口）
      this.broadcast(ctx, { phase: 'analyzing', percent: 75, message: '分析项目结构与技术栈' });
      const analysis: AnalysisResult = ProjectAnalyzer.analyze(projectRoot);
      const profile = ProfileEngine.build(projectRoot);
      this.broadcast(ctx, { phase: 'analyzing', percent: 90, message: `识别 ${profile.components.length} 个组件`, detail: analysis.services.map((s) => s.name).join(', ') || '无服务' });

      this.broadcast(ctx, { phase: 'saving', percent: 95, message: '保存项目档案' });
      // 去重：同 root_path 已存在则返回已有项目
      const existing = this.ds.db.prepare('SELECT id FROM projects WHERE root_path = ?').get(projectRoot) as { id: string } | undefined;
      let projectId: string;
      if (existing) {
        projectId = existing.id;
        this.ds.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(new Date().toISOString(), projectId);
      } else {
        projectId = randomUUID();
        const now = new Date().toISOString();
        this.ds.db.prepare(
          `INSERT INTO projects (id, name, root_path, project_type, language, framework, import_source, analysis_status, config_version, created_at, updated_at, components_json, profile_hash, source_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'analyzed', 1, ?, ?, ?, ?, ?)`,
        ).run(
          projectId,
          req.name ?? path.basename(projectRoot),
          projectRoot,
          analysis.facts.project_type ?? null,
          analysis.facts.language ?? null,
          analysis.facts.framework ?? null,
          req.source,
          now, now,
          JSON.stringify(profile),
          profile.fingerprint,
          JSON.stringify(sourceMeta),
        );
        // 落服务草案
        const insSvc = this.ds.db.prepare(
          `INSERT INTO project_services (id, project_id, name, service_type, workdir, start_command, build_command, port, depends_on_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const s of analysis.services) {
          const hasCmd = !!(s.start_command || s.build_command);
          if (!hasCmd) continue;
          const conflict = this.ds.db.prepare('SELECT id FROM project_services WHERE project_id=? AND name=?').get(projectId, s.name);
          if (conflict) continue;
          insSvc.run(randomUUID(), projectId, s.name, s.service_type, s.workdir, s.start_command ?? null, s.build_command ?? null, s.port ?? null, s.depends_on ? JSON.stringify(s.depends_on) : null, now, now);
        }
      }

      // 配置体检（导入即验证）：.env 完整性、Key 真实可用性、DB 连通、端口、启动命令可疑性。
      // 失败只记录警告，不阻断导入——项目仍可导入后再修配置。
      let cfgSummary = '';
      try {
        this.broadcast(ctx, { phase: 'config-check', percent: 95, message: '正在校验项目配置（.env / API Key / 数据库 / 端口）…' });
        const cfg = await this.configCheck.check(projectId, { probe: true });
        const bad = cfg.items.filter((i) => i.status === 'fail');
        const warn = cfg.items.filter((i) => i.status === 'warn');
        cfgSummary = cfg.overall === 'ok' ? '，配置体检通过' : `，配置体检 ${bad.length} 项不通过 / ${warn.length} 项需注意（详情见项目详情 → 配置体检）`;
        this.broadcast(ctx, {
          phase: 'config-check',
          percent: 98,
          message: `配置体检：${cfg.overall === 'ok' ? '全部通过' : `${bad.length} 项不通过 / ${warn.length} 项需注意`}`,
          detail: [...bad, ...warn].slice(0, 6).map((i) => `${i.label}：${i.detail}`).join('\n'),
        });
      } catch (e) {
        this.broadcast(ctx, { phase: 'config-check', percent: 98, message: `配置体检未能完成（不影响导入）：${String((e as Error)?.message ?? e).slice(0, 120)}` });
      }

      this.ds.db.prepare(`UPDATE import_jobs SET status='done', phase='done', percent=100, project_id=?, message=?, finished_at=?, updated_at=? WHERE id=?`)
        .run(projectId, `导入完成：${profile.components.length} 组件 / ${analysis.services.length} 服务${cfgSummary}`, new Date().toISOString(), new Date().toISOString(), ctx.id);
      this.broadcast(ctx, { phase: 'done', percent: 100, message: `导入完成（项目 ${projectId.slice(0, 8)}）` });
    } catch (err) {
      if (ctx.cancelled) return; // cancel() 已更新状态
      throw err;
    }
  }

  /** git job 轮询等待完成 */
  private async waitForGitJob(gitJobId: string, ctx: JobCtx): Promise<string> {
    for (;;) {
      if (ctx.cancelled) throw new Error('任务已取消');
      await new Promise((r) => setTimeout(r, 1000));
      const job = this.gitImport.get(gitJobId) as { status?: string; rootPath?: string; steps?: Array<{ phase: string; message?: string }> } | undefined;
      if (!job) throw new Error('git 导入任务丢失');
      const lastStep = job.steps?.[job.steps.length - 1];
      if (lastStep) this.broadcast(ctx, { phase: 'fetching', percent: 40, message: `git: ${lastStep.phase}`, detail: lastStep.message });
      if (job.status === 'Success' && job.rootPath) return job.rootPath;
      if (job.status === 'Failed') throw new Error('git clone 失败（详见 git 导入任务日志）');
    }
  }

  /** 解压后定位真实项目根：单顶层目录时进入该目录，否则解压目录本身 */
  private async resolveProjectDir(extractedDir: string, ctx: JobCtx): Promise<string> {
    this.broadcast(ctx, { phase: 'validating', percent: 70, message: '定位项目根目录' });
    const entries = fs.readdirSync(extractedDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && e.name !== '__MACOSX');
    const files = entries.filter((e) => e.isFile());
    const manifestHere = ['package.json', 'pom.xml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'composer.json', '.env.example', 'Dockerfile', 'docker-compose.yml']
      .some((f) => fs.existsSync(path.join(extractedDir, f)));
    if (manifestHere) return extractedDir;
    if (dirs.length === 1 && files.length === 0) return path.join(extractedDir, dirs[0].name);
    return extractedDir;
  }

  private dataDir(): string {
    return process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? '', 'devpilot', 'data');
  }
}
