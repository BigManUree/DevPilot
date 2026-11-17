import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistryService } from './tool-registry';
import { ToolGatewayService } from '../permissions/tool-gateway.service';
import { PermissionService } from '../permissions/permission.service';
import type { AuditService } from '../permissions/audit.service';
import { makeMemoryDs, stub } from '../testing/helpers';

/** 回归：fs.list / fs.search 项目包含校验 + pendingApproval 结构化标志（审计第二轮新增） */
describe('ToolRegistry fs 工具包含与审批标志（第二轮审计回归）', () => {
  let root: string;
  let ds: ReturnType<typeof makeMemoryDs>;
  let registry: ToolRegistryService;
  let executeSpy: jest.Mock;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-registry-'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'world hello');
  });

  afterAll(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  beforeEach(() => {
    ds = makeMemoryDs();
    ds.db.prepare(
      `INSERT INTO projects (id, name, root_path, project_type, import_source, analysis_status, config_version, created_at, updated_at) VALUES ('proj-1', 'r', ?, 'web', 'folder', 'analyzed', 1, ?, ?)`,
    ).run(root, new Date().toISOString(), new Date().toISOString());
    ds.db.prepare(
      `INSERT INTO permissions (id, subject_type, subject_id, category, resource_scope, grant_source, expires_at, status, created_at)
       VALUES ('perm-read', 'agent', 'supervisor', 'project_analysis', NULL, 'test', NULL, 'active', ?)`,
    ).run(new Date().toISOString());
    const perms = new PermissionService(stub({ db: ds.db }));
    const audit: AuditService = stub({ redact: (p: unknown) => p, record: jest.fn(), list: jest.fn() });
    const gateway = new ToolGatewayService(perms, audit, stub({ db: ds.db }));
    registry = new ToolRegistryService(
      stub({ db: ds.db }),
      gateway,
      stub({}),
      stub({ startService: jest.fn(), stopService: jest.fn(async () => ({ stopped: true })) }),
      stub({}),
    );
  });

  const ctx = { projectId: 'proj-1', taskId: 't1' };

  it('fs.list 项目内 → 返回条目', async () => {
    const r = await registry.execute('fs.list', {}, ctx);
    expect(r.ok).toBe(true);
    const names = (r.data as Array<{ name: string }>).map((e) => e.name);
    expect(names).toContain('a.txt');
    expect(names).toContain('sub');
  });

  it('fs.list 项目外目录 → 拒绝', async () => {
    const r = await registry.execute('fs.list', { path: os.tmpdir() }, ctx);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/不在项目内/);
  });

  it('fs.list 无项目上下文 → 拒绝', async () => {
    const r = await registry.execute('fs.list', {}, {});
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/需要项目上下文/);
  });

  it('fs.search 项目内命中内容', async () => {
    const r = await registry.execute('fs.search', { query: 'hello' }, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as Array<{ file: string }>).length).toBeGreaterThanOrEqual(2);
  });

  it('fs.search 项目外 → 拒绝', async () => {
    const r = await registry.execute('fs.search', { query: 'x', path: 'C:\\Windows' }, ctx);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/不在项目内|拒绝搜索/);
  });

  it('fs.read 项目外 → pendingApproval=false 且失败（路径校验错误，不是审批挂起）', async () => {
    const r = await registry.execute('fs.read', { path: 'C:\\Windows\\win.ini' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.pendingApproval).toBe(false);
  });

  it('terminal.exec 权限挂起 → pendingApproval=true（结构化标志，不再依赖错误文案）', async () => {
    // 无 command_execution 权限 → 网关生成审批
    const r = await registry.execute('terminal.exec', { command: 'echo hi' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.pendingApproval).toBe(true);
    // 审批记录已落库并绑定 taskId
    const appr = ds.db.prepare(`SELECT target_ref FROM approvals WHERE approval_status='pending'`).get() as { target_ref: string };
    expect(JSON.parse(appr.target_ref)).toMatchObject({ taskId: 't1', projectId: 'proj-1' });
  });
});
