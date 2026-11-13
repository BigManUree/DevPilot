import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../database/database.module';
import { ProjectService } from './project.service';

/**
 * 从 GitHub（或任意 git 远端）导入项目：
 *   校验地址 → 克隆（浅克隆，失败回退完整克隆）→ 识别 → 建项目记录 → 交给自动启动闭环。
 *
 * 设计取舍：
 * - 克隆放在异步 job 里：大仓库可能几分钟，HTTP 同步会超时，UI 需要看得到进度；
 * - 默认克隆到 `<用户目录>\DevPilotProjects\<repo>`，可用 targetDir 覆盖；
 * - 目标目录已存在且 origin 一致 → 直接复用，不重复下载；不一致则加后缀避让，不覆盖用户目录。
 */

export type GitImportPhase = 'detect' | 'clone' | 'import' | 'done' | 'failed';

export interface GitImportStep {
  at: string;
  phase: GitImportPhase;
  message: string;
  detail?: string;
}

export interface GitImportJob {
  id: string;
  repoUrl: string;
  normalizedUrl: string;
  branch?: string | null;
  targetDir?: string | null;
  status: 'Running' | 'Success' | 'Failed';
  startedAt: string;
  finishedAt?: string;
  projectId?: string;
  projectName?: string;
  rootPath?: string;
  report?: string;
  steps: GitImportStep[];
}

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

@Injectable()
export class GitImportService {
  private jobs = new Map<string, GitImportJob>();

  constructor(
    private readonly ds: DatabaseService,
    private readonly projects: ProjectService,
  ) {}

  get(id: string): GitImportJob | undefined {
    return this.jobs.get(id);
  }

  start(input: { repoUrl: string; branch?: string; targetDir?: string; name?: string }): { jobId: string } {
    const raw = String(input.repoUrl ?? '').trim();
    if (!raw) throw new Error('请填写仓库地址');
    const normalizedUrl = this.normalizeRepoUrl(raw);

    const job: GitImportJob = {
      id: randomUUID(),
      repoUrl: raw,
      normalizedUrl,
      branch: input.branch?.trim() || null,
      targetDir: input.targetDir?.trim() || null,
      status: 'Running',
      startedAt: new Date().toISOString(),
      steps: [],
    };
    this.jobs.set(job.id, job);
    void this.run(job, input.name).catch((e) => {
      job.status = 'Failed';
      job.finishedAt = new Date().toISOString();
      job.report = `导入失败：${String(e).slice(0, 400)}`;
      this.step(job, 'failed', job.report);
    });
    return { jobId: job.id };
  }

  private step(job: GitImportJob, phase: GitImportPhase, message: string, detail?: string) {
    job.steps.push({ at: new Date().toISOString(), phase, message, detail });
  }

  private async run(job: GitImportJob, nameOverride?: string): Promise<void> {
    // 1) 环境检查
    const version = await this.gitVersion();
    if (!version) {
      job.status = 'Failed';
      job.finishedAt = new Date().toISOString();
      job.report = '本机没有可用的 git。安装 Git for Windows 后重试（安装时勾选添加到 PATH）。';
      this.step(job, 'failed', job.report);
      return;
    }
    this.step(job, 'detect', `git ${version} 可用`, job.normalizedUrl);

    // 2) 决定落地目录
    const repoName = this.repoName(job.normalizedUrl);
    const baseDir = job.targetDir
      ? path.resolve(this.expandHome(job.targetDir))
      : path.join(os.homedir(), 'DevPilotProjects');
    fs.mkdirSync(baseDir, { recursive: true });
    const dest = this.pickDest(baseDir, repoName, job.normalizedUrl);
    job.rootPath = dest;
    this.step(job, 'detect', `克隆到 ${dest}`);

    // 3) 克隆
    if (this.isSameOrigin(dest, job.normalizedUrl)) {
      this.step(job, 'clone', '目标目录已存在且 origin 一致，复用现有代码（不重复下载）');
    } else {
      this.step(job, 'clone', `正在克隆 ${job.normalizedUrl}${job.branch ? `（分支 ${job.branch}）` : ''}…`);
      // 三步回退，覆盖本机代理失效 / 需要完整历史这两类常见失败
      const mirror = this.mirrorUrl(job.normalizedUrl);
      const attempts: Array<{ label: string; url: string; shallow: boolean; proxy: boolean }> = [
        { label: '浅克隆', url: job.normalizedUrl, shallow: true, proxy: true },
        { label: '浅克隆（跳过代理）', url: job.normalizedUrl, shallow: true, proxy: false },
      ];
      if (mirror) {
        // GitHub 直连常被网络环境阻断：用公开镜像再试一轮（与 wb2api 更新用的是同一类加速入口）
        attempts.push({ label: '镜像加速浅克隆', url: mirror, shallow: true, proxy: false });
        attempts.push({ label: '镜像加速完整克隆', url: mirror, shallow: false, proxy: false });
      }
      attempts.push({ label: '完整克隆（跳过代理）', url: job.normalizedUrl, shallow: false, proxy: false });
      let lastError = '';
      let done = false;
      for (const a of attempts) {
        const r = await this.clone(a.url, dest, job.branch ?? undefined, a.shallow, a.proxy);
        if (r.ok) {
          done = true;
          if (a.label !== '浅克隆') this.step(job, 'clone', `已用「${a.label}」成功`);
          break;
        }
        lastError = r.error ?? '';
        fs.rmSync(dest, { recursive: true, force: true });
        this.step(job, 'clone', `${a.label}失败，重试下一种方式`, lastError.slice(-500));
      }
      if (!done) {
        job.status = 'Failed';
        job.finishedAt = new Date().toISOString();
        job.report = [
          '克隆失败，git 最后输出：',
          lastError.slice(-1500),
          '',
          '常见原因：仓库私有（需要本机已登录的 git 凭据）、地址拼错、网络到 GitHub 不通、代理失效。',
        ].join('\n');
        this.step(job, 'failed', '克隆失败', lastError.slice(-1500));
        return;
      }
      this.step(job, 'clone', '克隆完成', await this.headSummary(dest));
    }

    // 4) 识别 + 建项目
    this.step(job, 'import', '正在识别项目结构…');
    const result = this.projects.import({ source: 'folder', rootPath: dest });
    const name = (nameOverride?.trim() || repoName).slice(0, 80);
    this.ds.db
      .prepare("UPDATE projects SET import_source = 'git', name = ?, updated_at = ? WHERE id = ?")
      .run(name, new Date().toISOString(), result.projectId);
    job.projectId = result.projectId;
    job.projectName = name;
    const svcCount = result.analysis.services.length;
    this.step(
      job,
      'import',
      `识别完成：${result.analysis.facts.language || '未知语言'}${result.analysis.facts.framework ? ' / ' + result.analysis.facts.framework : ''}，${svcCount} 个服务`,
      result.analysis.services.map((s) => `${s.name}: ${s.start_command ?? '（无启动命令）'}`).join('\n'),
    );

    job.status = 'Success';
    job.finishedAt = new Date().toISOString();
    job.report = `项目 ${name} 已导入到 ${dest}`;
    this.step(job, 'done', job.report);
  }

  /** 允许 owner/repo、github.com/x/y、https://…、git@host:owner/repo.git、ssh://… */
  private normalizeRepoUrl(raw: string): string {
    const s = raw.trim().replace(/^git\+/, '');
    if (/^git@[^:]+:.+/.test(s) || /^(ssh|git|https?):\/\//i.test(s)) return s;
    if (/^github\.com\//i.test(s)) return `https://${s.replace(/^github\.com\//i, 'github.com/')}`.replace(/\/+$/, '') + (s.endsWith('.git') ? '' : '.git');
    if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://github.com/${s.replace(/\.git$/, '')}.git`;
    throw new Error(`无法识别的仓库地址：${raw}（支持 owner/repo 或完整 git 地址）`);
  }

  private repoName(url: string): string {
    const cleaned = url.replace(/\/+$/, '').replace(/\.git$/i, '');
    const tail = cleaned.split(/[\/:]/).filter(Boolean).pop() ?? 'repo';
    return tail.replace(/[^\w.\-]+/g, '-').slice(0, 60) || 'repo';
  }

  private expandHome(p: string): string {
    return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
  }

  /** 目录不存在 → 直接用；已存在且 origin 一致 → 复用；否则加后缀 */
  private pickDest(baseDir: string, repoName: string, url: string): string {
    let dest = path.join(baseDir, repoName);
    let i = 1;
    while (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
      if (this.isSameOrigin(dest, url)) return dest;
      i += 1;
      dest = path.join(baseDir, `${repoName}-${i}`);
    }
    return dest;
  }

  /** GitHub 直连不通时的镜像地址；非 GitHub 返回 null */
  private mirrorUrl(url: string): string | null {
    const m = url.match(/^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
    if (!m) return null;
    return `https://ghfast.top/https://github.com/${m[1]}/${m[2]}.git`;
  }

  private isSameOrigin(dir: string, url: string): boolean {
    try {
      const gitDir = path.join(dir, '.git');
      if (!fs.existsSync(gitDir)) return false;
      const out = require('node:child_process').execFileSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 8000 });
      const origin = String(out).trim();
      return this.sameRepo(origin, url);
    } catch {
      return false;
    }
  }

  private sameRepo(a: string, b: string): boolean {
    const norm = (u: string) =>
      u
        .replace(/^git@([^:]+):/, 'https://$1/')
        .replace(/\.git$/i, '')
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '')
        .toLowerCase();
    return norm(a) === norm(b);
  }

  private gitVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile('git', ['--version'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout).replace(/^git version\s*/i, '').trim());
      });
    });
  }

  private clone(url: string, dest: string, branch: string | undefined, shallow: boolean, useProxy: boolean): Promise<{ ok: boolean; error?: string }> {
    const args = ['clone', '--single-branch'];
    if (shallow) args.push('--depth', '1');
    if (branch) args.push('--branch', branch);
    args.push(url, dest);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (!useProxy) {
      // 本机代理已失效时（常见于 Clash 未启动 / 沙箱注入的 127.0.0.1 代理），
      // 直连才可能成功：同时清 env 与 git 配置层的代理。
      for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
      args.unshift('-c', 'http.proxy=', '-c', 'https.proxy=');
    }
    return new Promise((resolve) => {
      execFile('git', args, { timeout: CLONE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env }, (err, _stdout, stderr) => {
        if (err) return resolve({ ok: false, error: String(stderr || err.message) });
        resolve({ ok: true });
      });
    });
  }

  private async headSummary(dir: string): Promise<string> {
    return new Promise((resolve) => {
      execFile('git', ['-C', dir, 'log', '-1', '--pretty=%h %s (%cr)'], { timeout: 8000, windowsHide: true }, (_e, out) => {
        resolve(String(out ?? '').trim());
      });
    });
  }
}
