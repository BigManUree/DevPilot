import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';
import { PermissionService } from '../permissions/permission.service';
import { AuditService } from '../permissions/audit.service';
import { LogService } from '../logs/log.service';

const exec = promisify(execFile);

/**
 * Git 管理（PRD 3.14 + WF-10）：
 * - 仓库识别/status/branches/log/diff/add/commit/branch 切换
 * - 执行前检查工作区（有未提交修改时 commit 前自动列出）
 * - push 默认拒绝：需显式 allowPush=true 且走 git_operation 审批
 * - agent 身份操作必须持有 git_operation 权限，否则生成审批
 */
@Injectable()
export class GitService {
  constructor(
    private readonly ds: DatabaseService,
    private readonly perms: PermissionService,
    private readonly audit: AuditService,
    private readonly logs: LogService,
  ) {}

  private async run(repoPath: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await exec('git', args, { cwd: repoPath, timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
      return { ok: true, stdout, stderr };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return { ok: false, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? String(err) };
    }
  }

  private isRepo(repoPath: string): boolean {
    return fs.existsSync(path.join(repoPath, '.git'));
  }

  /** 权限检查：user 隐式放行；agent/plug 需 git_operation 授权 */
  private checkPermission(subjectType: string, subjectId: string, projectId?: string): { allowed: boolean; approvalId?: string } {
    const r = this.perms.check({
      subjectType: subjectType as 'user' | 'supervisor' | 'agent' | 'plugin',
      subjectId,
      category: 'git_operation',
      projectId,
    });
    return { allowed: r.allowed, approvalId: r.approvalId };
  }

  /** 仓库识别并登记 */
  async register(projectId: string, repoPath: string) {
    if (!this.isRepo(repoPath)) throw new Error('not a git repository');
    const st = await this.run(repoPath, ['remote', 'get-url', 'origin']);
    const br = await this.run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const id = randomUUID();
    this.ds.db
      .prepare(`INSERT INTO git_repositories (id, project_id, repo_path, remote_url, current_branch, last_checked_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, projectId, repoPath, st.stdout.trim() || null, br.stdout.trim() || null, new Date().toISOString());
    return { repoId: id, branch: br.stdout.trim(), remote: st.stdout.trim() || null };
  }

  listRepos() {
    return this.ds.db.prepare('SELECT * FROM git_repositories ORDER BY last_checked_at DESC').all();
  }

  async status(repoPath: string) {
    if (!this.isRepo(repoPath)) throw new Error('not a git repository');
    const [st, br, log] = await Promise.all([
      this.run(repoPath, ['status', '--porcelain=v1', '-b']),
      this.run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      this.run(repoPath, ['log', '--oneline', '-5']),
    ]);
    const lines = st.stdout.split('\n').filter(Boolean);
    const branchLine = lines.find((l) => l.startsWith('##')) ?? '';
    return {
      branch: br.stdout.trim(),
      aheadBehind: branchLine.match(/ahead (\d+)|behind (\d+)/g) ?? [],
      clean: lines.filter((l) => !l.startsWith('##')).length === 0,
      files: lines.filter((l) => !l.startsWith('##')).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) })),
      recentCommits: log.stdout.split('\n').filter(Boolean),
    };
  }

  async branches(repoPath: string) {
    const r = await this.run(repoPath, ['branch', '-a']);
    return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  }

  async log(repoPath: string, limit = 20) {
    const r = await this.run(repoPath, ['log', `--pretty=format:%h|%an|%ad|%s`, '--date=iso', `-n${limit}`]);
    return r.stdout.split('\n').filter(Boolean).map((l) => {
      const [hash, author, date, ...rest] = l.split('|');
      return { hash, author, date, subject: rest.join('|') };
    });
  }

  async diff(repoPath: string, file?: string) {
    const args = ['diff', '--stat'];
    if (file) args.push('--', file);
    const stat = await this.run(repoPath, args);
    const full = await this.run(repoPath, file ? ['diff', '--', file] : ['diff']);
    return { stat: stat.stdout, diff: full.stdout.slice(0, 200_000) };
  }

  /** add + commit（可指定 agent 身份 → 权限校验） */
  async commit(repoPath: string, message: string, files: string[] | null, subjectType: string, subjectId: string, projectId?: string) {
    const perm = this.checkPermission(subjectType, subjectId, projectId);
    if (!perm.allowed) return { ok: false, pendingApproval: true, approvalId: perm.approvalId, error: 'PERMISSION_DENIED_PENDING_APPROVAL' };

    if (!this.isRepo(repoPath)) throw new Error('not a git repository');
    if (files?.length) await this.run(repoPath, ['add', '--', ...files]);
    else await this.run(repoPath, ['add', '-A']);
    const r = await this.run(repoPath, ['commit', '-m', message]);
    const ok = r.ok && !r.stderr.includes('nothing to commit');
    this.audit.record({ subject: `${subjectType}:${subjectId}`, action: 'git.commit', target: repoPath, result: ok ? 'ok' : 'error', detail: { message, files } });
    this.logs.log({ level: ok ? 'info' : 'warn', sourceModule: 'git', projectId, message: `commit ${ok ? 'ok' : 'skipped'}: ${message}` });
    return { ok, output: (r.stdout || r.stderr).slice(0, 2000) };
  }

  /** 分支切换（工作区不干净时拒绝，保护未提交修改） */
  async switchBranch(repoPath: string, branch: string) {
    const st = await this.status(repoPath);
    if (!st.clean) return { ok: false, error: '工作区有未提交修改，已阻止切换', dirtyFiles: st.files };
    const r = await this.run(repoPath, ['checkout', branch]);
    return { ok: r.ok, output: (r.stdout || r.stderr).slice(0, 1000) };
  }

  /** push：默认拒绝，需显式 allowPush（UI 二次确认）+ D02 策略五道门 */
  async push(repoPath: string, allowPush: boolean, subjectType: string, subjectId: string) {
    if (!allowPush) {
      this.audit.record({ subject: `${subjectType}:${subjectId}`, action: 'git.push', target: repoPath, result: 'denied', detail: { reason: 'not authorized' } });
      return { ok: false, error: 'PUSH_BLOCKED：向远程推送需显式 allowPush=true 授权' };
    }
    const perm = this.checkPermission(subjectType, subjectId);
    if (!perm.allowed) return { ok: false, pendingApproval: true, approvalId: perm.approvalId };

    // D02-1 远程白名单：remote.url 必须在 git_repositories 登记过
    const rem = await this.run(repoPath, ['remote', 'get-url', 'origin']);
    const remoteUrl = rem.ok ? rem.stdout.trim() : '';
    if (!remoteUrl) {
      this.audit.record({ subject: `${subjectType}:${subjectId}`, action: 'git.push', target: repoPath, result: 'denied', detail: { reason: 'no origin remote' } });
      return { ok: false, error: 'PUSH_BLOCKED：仓库未配置 origin 远程' };
    }
    const whitelisted = this.ds.db.prepare('SELECT id FROM git_repositories WHERE remote_url = ?').get(remoteUrl) as { id: string } | undefined;
    if (!whitelisted) {
      this.audit.record({ subject: `${subjectType}:${subjectId}`, action: 'git.push', target: repoPath, result: 'denied', detail: { reason: 'remote not whitelisted', remote: remoteUrl } });
      return { ok: false, error: `PUSH_BLOCKED：远程 ${remoteUrl} 未在 Git 中心登记（远程白名单策略，D02）` };
    }

    // D02-2 分支保护：main/master 工作区必须干净；args 由本方法构造，天然无 --force/--delete
    const branch = (await this.run(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']));
    const branchName = branch.ok ? branch.stdout.trim() : '';
    const isProtected = /^(main|master)$/.test(branchName);
    if (isProtected) {
      const dirty = await this.run(repoPath, ['status', '--porcelain']);
      if (dirty.ok && dirty.stdout.trim()) {
        this.audit.record({ subject: `${subjectType}:${subjectId}`, action: 'git.push', target: repoPath, result: 'denied', detail: { reason: 'dirty worktree on protected branch', branch: branchName } });
        return { ok: false, error: `PUSH_BLOCKED：保护分支 ${branchName} 存在未提交变更，先 commit 或 stash` };
      }
    }

    // D02-3 密钥扫描：推送范围内的提交内容（origin/<branch>..HEAD，无上游则扫全部本地提交的变更）
    const range = isProtected ? `origin/${branchName}..HEAD` : null;
    // 扫描源：有上游 ref 用 diff，diff 失败（无上游/新分支）回退 log -p 全量本地提交——fail-closed，绝不静默放行
    let scan = range
      ? await this.run(repoPath, ['diff', range, '-U0'])
      : await this.run(repoPath, ['log', '-p', '--max-count=20']);
    if (!scan.ok && range) scan = await this.run(repoPath, ['log', '-p', '--max-count=20']);
    const scanText = scan.ok ? scan.stdout : '';
    const secretHit = scan.ok ? scanText.match(/sk-[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/) : 'SCAN_FAILED';
    if (secretHit) {
      this.audit.record({ subject: `${subjectType}:${subjectId}`, action: 'git.push', target: repoPath, result: 'denied', detail: { reason: 'secret pattern in commits', pattern: secretHit[0].slice(0, 12) } });
      return { ok: false, error: `PUSH_BLOCKED：待推送提交中疑似包含密钥（${secretHit[0].slice(0, 6)}…），已拦截` };
    }

    // 推送
    const r = await this.run(repoPath, ['push']);
    const commits = range ? (await this.run(repoPath, ['rev-list', '--count', range])).stdout.trim() : 'n/a';
    this.audit.record({ subject: `${subjectType}:${subjectId}`, action: 'git.push', target: repoPath, result: r.ok ? 'ok' : 'error', detail: { remote: remoteUrl, branch: branchName, commits: isProtected ? commits : 'n/a' } });
    return { ok: r.ok, output: (r.stdout || r.stderr).slice(0, 2000) };
  }
}
