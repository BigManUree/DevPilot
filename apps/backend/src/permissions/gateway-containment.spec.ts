import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolGatewayService } from './tool-gateway.service';
import { PermissionService } from './permission.service';
import type { AuditService } from './audit.service';
import { makeMemoryDs, stub } from '../testing/helpers';

/** 回归：网关 fs 路径包含校验（审计 S1 缺口修复——agent 主体 fs 只能访问绑定项目内路径） */
describe('ToolGateway fs 项目包含校验（第二轮审计回归）', () => {
  let root: string;
  let insideFile: string;
  let ds: ReturnType<typeof makeMemoryDs>;
  let gateway: ToolGatewayService;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-audit-'));
    fs.writeFileSync(path.join(root, 'app.js'), 'console.log(1)');
    insideFile = path.join(root, 'app.js');
  });

  afterAll(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    ds = makeMemoryDs();
    ds.db.prepare(
      `INSERT INTO projects (id, name, root_path, project_type, import_source, analysis_status, config_version, created_at, updated_at) VALUES ('proj-1', 'audit-proj', ?, 'web', 'folder', 'analyzed', 1, ?, ?)`,
    ).run(root, new Date().toISOString(), new Date().toISOString());
    const perms = new PermissionService(stub({ db: ds.db }));
    // 预授权 agent supervisor 的 project_analysis（读）
    ds.db.prepare(
      `INSERT INTO permissions (id, subject_type, subject_id, category, resource_scope, grant_source, expires_at, status, created_at)
       VALUES ('perm-read', 'agent', 'supervisor', 'project_analysis', NULL, 'test', NULL, 'active', ?)`,
    ).run(new Date().toISOString());
    const audit: AuditService = stub({ redact: (p: unknown) => p, record: jest.fn(), list: jest.fn() });
    gateway = new ToolGatewayService(perms, audit, stub({ db: ds.db }));
  });

  const agentRead = (p: string, projectId?: string) =>
    gateway.call({ subjectType: 'agent', subjectId: 'supervisor', tool: 'fs.read', params: { path: p }, projectId });

  it('agent fs.read 项目内文件 → 放行', async () => {
    const r = await agentRead(insideFile, 'proj-1');
    expect(r.ok).toBe(true);
    expect((r.data as { content: string }).content).toContain('console.log');
  });

  it('agent fs.read 项目外路径（系统文件）→ 拒绝', async () => {
    const outside = path.join(os.tmpdir(), 'definitely-outside-audit.txt');
    fs.writeFileSync(outside, 'secret');
    try {
      const r = await agentRead(outside, 'proj-1');
      expect(r.ok).toBe(false);
      expect(String(r.error)).toMatch(/拒绝访问|不在项目/);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('agent fs.read 无 projectId → 拒绝（不再允许任意盘读）', async () => {
    const r = await agentRead(insideFile);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/必须绑定项目/);
  });

  it('agent fs.write 项目外路径 → 拒绝（防写入任意位置）', async () => {
    // 预授权 modify_project_config，确保走到路径包含校验这一层（而非权限挂起）
    ds.db.prepare(
      `INSERT INTO permissions (id, subject_type, subject_id, category, resource_scope, grant_source, expires_at, status, created_at)
       VALUES ('perm-write', 'agent', 'supervisor', 'modify_project_config', NULL, 'test', NULL, 'active', ?)`,
    ).run(new Date().toISOString());
    const outside = path.join(os.tmpdir(), 'definitely-outside-write.txt');
    const r = await gateway.call({ subjectType: 'agent', subjectId: 'supervisor', tool: 'fs.write', params: { path: outside, content: 'x' }, projectId: 'proj-1' }, 'modify_project_config');
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/拒绝访问|不在项目/);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('agent fs.write 项目外路径且未授权 → 先挂审批（权限门在包含校验之前）', async () => {
    const outside = path.join(os.tmpdir(), 'definitely-outside-write2.txt');
    const r = await gateway.call({ subjectType: 'agent', subjectId: 'supervisor', tool: 'fs.write', params: { path: outside, content: 'x' }, projectId: 'proj-1' }, 'modify_project_config');
    expect(r.ok).toBe(false);
    expect(r.permission).toBe('pending_approval');
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('user 主体不受项目包含限制（工作区 UI / 自动修复沿用控制器校验）', async () => {
    const outside = path.join(os.tmpdir(), 'user-readable.txt');
    fs.writeFileSync(outside, 'ok');
    try {
      const r = await gateway.call({ subjectType: 'user', subjectId: 'local-user', tool: 'fs.read', params: { path: outside } });
      expect(r.ok).toBe(true);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('路径穿越（../ 逃出项目）→ 拒绝', async () => {
    const escape = path.join(root, '..', 'escaped.txt');
    const r = await agentRead(escape, 'proj-1');
    expect(r.ok).toBe(false);
  });
});
