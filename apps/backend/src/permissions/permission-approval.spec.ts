import { PermissionService } from './permission.service';
import { makeMemoryDs, stub } from '../testing/helpers';

/** 回归：审批幂等 / taskId 绑定 / 决定回调（审计第二轮新增） */
describe('PermissionService 审批安全（第二轮审计回归）', () => {
  function makePerms() {
    const ds = makeMemoryDs();
    const perms = new PermissionService(stub({ db: ds.db }));
    return { ds, perms };
  }

  function makeAgentCheck(perms: PermissionService, taskId?: string) {
    return perms.check({
      subjectType: 'agent',
      subjectId: 'supervisor',
      category: 'command_execution',
      projectId: 'p1',
      taskId,
    });
  }

  it('越权 check 生成 approval 并绑定 taskId；approve 返回 taskId', () => {
    const { perms } = makePerms();
    const r = makeAgentCheck(perms, 'task-abc');
    expect(r.allowed).toBe(false);
    expect(r.approvalId).toBeTruthy();
    const approved = perms.approve(r.approvalId!);
    expect(approved.taskId).toBe('task-abc');
    expect(approved.permissionId).toBeTruthy();
  });

  it('重复批准同一审批 → 报错（防重放重复授权）', () => {
    const { perms } = makePerms();
    const r = makeAgentCheck(perms, 't1');
    perms.approve(r.approvalId!);
    expect(() => perms.approve(r.approvalId!)).toThrow(/不能重复批准/);
  });

  it('重复拒绝同一审批 → 报错；拒绝后批准 → 报错', () => {
    const { perms } = makePerms();
    const r1 = makeAgentCheck(perms, 't1');
    perms.reject(r1.approvalId!);
    expect(() => perms.reject(r1.approvalId!)).toThrow(/不能重复拒绝/);
    expect(() => perms.approve(r1.approvalId!)).toThrow(/不能重复批准/);
  });

  it('审批决定触发回调（approved=true 携带 taskId）', () => {
    const { perms } = makePerms();
    const fired: Array<{ approved: boolean; taskId?: string }> = [];
    perms.onApprovalDecided((info) => fired.push({ approved: info.approved, taskId: info.taskId }));
    const r = makeAgentCheck(perms, 'task-xyz');
    perms.approve(r.approvalId!);
    expect(fired).toEqual([{ approved: true, taskId: 'task-xyz' }]);
  });

  it('拒绝也触发回调（approved=false）', () => {
    const { perms } = makePerms();
    const fired: Array<{ approved: boolean; taskId?: string }> = [];
    perms.onApprovalDecided((info) => fired.push({ approved: info.approved, taskId: info.taskId }));
    const r = makeAgentCheck(perms, 'task-xyz');
    perms.reject(r.approvalId!);
    expect(fired).toEqual([{ approved: false, taskId: 'task-xyz' }]);
  });

  it('参数级授权：批准后同参数放行（one-shot），不同参数仍需审批', () => {
    const { perms, ds } = makePerms();
    const params = { command: 'npm install', cwd: 'C:/proj' };
    const r = perms.check({
      subjectType: 'agent', subjectId: 'supervisor', category: 'command_execution',
      projectId: 'p1', paramHash: 'hash-a', paramJson: { tool: 'command.exec', params },
    });
    expect(r.allowed).toBe(false);
    perms.approve(r.approvalId!);
    // 同参数 → 放行并消费 one-shot
    const ok = perms.check({
      subjectType: 'agent', subjectId: 'supervisor', category: 'command_execution',
      projectId: 'p1', paramHash: 'hash-a', paramJson: { tool: 'command.exec', params },
    });
    expect(ok.allowed).toBe(true);
    expect(ok.reason).toBe('param-grant');
    // 同参数第二次 → one-shot 已消费 → 再次挂审批
    const again = perms.check({
      subjectType: 'agent', subjectId: 'supervisor', category: 'command_execution',
      projectId: 'p1', paramHash: 'hash-a', paramJson: { tool: 'command.exec', params },
    });
    expect(again.allowed).toBe(false);
    // 不同参数 → 挂审批（改参数必须重新审批）
    const diff = perms.check({
      subjectType: 'agent', subjectId: 'supervisor', category: 'command_execution',
      projectId: 'p1', paramHash: 'hash-b', paramJson: { tool: 'command.exec', params: { command: 'npm install x', cwd: 'C:/proj' } },
    });
    expect(diff.allowed).toBe(false);
    // 授权行验证：scope_kind=param / one_shot=1 / 消费后有 used_at
    const perm = ds.db.prepare(`SELECT * FROM permissions WHERE scope_kind='param' ORDER BY rowid DESC LIMIT 1`).get() as Record<string, unknown>;
    expect(perm.one_shot).toBe(1);
    expect(perm.used_at).toBeTruthy();
  });

  it('L3 高危命令：即使存在类别级授权也强制当次审批', () => {
    const { perms, ds } = makePerms();
    // 预授类别级 command_execution
    ds.db.prepare(
      `INSERT INTO permissions (id, subject_type, subject_id, category, resource_scope, grant_source, expires_at, status, created_at, scope_kind)
       VALUES ('perm-cat', 'agent', 'supervisor', 'command_execution', NULL, 'test', NULL, 'active', ?, 'category')`,
    ).run(new Date().toISOString());
    const r = perms.check({
      subjectType: 'agent', subjectId: 'supervisor', category: 'command_execution',
      projectId: 'p1', risk: 'L3', riskReasons: ['递归删除文件/目录'],
      paramHash: 'hash-rm', paramJson: { tool: 'command.exec', params: { command: 'rm -rf /' } },
    });
    expect(r.allowed).toBe(false);
    const appr = ds.db.prepare(`SELECT risk_level, risk_reasons, action_summary FROM approvals WHERE id=?`).get(r.approvalId!) as Record<string, string>;
    expect(appr.risk_level).toBe('high');
    expect(JSON.parse(appr.risk_reasons)).toContain('递归删除文件/目录');
    expect(appr.action_summary).toContain('L3');
  });

  it('审批摘要包含命令/工作目录/风险与备份说明（审批 UI 展示依据）', () => {
    const { perms } = makePerms();
    const r = perms.check({
      subjectType: 'agent', subjectId: 'supervisor', category: 'command_execution',
      projectId: 'p1', paramHash: 'h', paramJson: { tool: 'command.exec', params: { command: 'npm install express', cwd: 'C:/work/app' } },
    });
    const appr = perms.listApprovals().pop() as { action_summary: string };
    expect(appr.action_summary).toContain('npm install express');
    expect(appr.action_summary).toContain('C:/work/app');
    expect(appr.action_summary).toContain('仅授权本次');
    void r;
  });
});
