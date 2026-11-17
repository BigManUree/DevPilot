import { spawn } from 'node:child_process';
import { ToolRegistryService } from './tool-registry';
import { ToolGatewayService } from '../permissions/tool-gateway.service';
import { PermissionService } from '../permissions/permission.service';
import { classifyCommandRisk, paramDigest } from '../permissions/tool-gateway.service';
import type { AuditService } from '../permissions/audit.service';
import { makeMemoryDs, stub } from '../testing/helpers';

/**
 * 进程管理工具（第三轮用户反馈 #4）：
 * 「杀掉 PID 20928」类请求的受控通道 —— L0 列进程 / L3 杀进程（强制当次审批 + 终止验证）。
 * 真实执行：真实 spawn 子进程 + 真实 tasklist/killTreeWait。
 */
describe('process.list / process.kill（真实进程）', () => {
  let ds: ReturnType<typeof makeMemoryDs>;
  let registry: ToolRegistryService;
  let perms: PermissionService;
  const ctx = { projectId: undefined, taskId: 't-proc' };

  beforeEach(() => {
    ds = makeMemoryDs();
    perms = new PermissionService(stub({ db: ds.db }));
    const audit: AuditService = stub({ redact: (p: unknown) => p, record: jest.fn(), list: jest.fn() });
    const gateway = new ToolGatewayService(perms, audit, stub({ db: ds.db }));
    registry = new ToolRegistryService(
      stub({ db: ds.db }),
      gateway,
      stub({}),
      stub({ startService: jest.fn(), stopService: jest.fn() }),
      stub({}),
    );
  });

  it('classifyCommandRisk：内部 kill-pid 形态为 L3', () => {
    expect(classifyCommandRisk('devpilot-internal:kill-pid:29028').level).toBe('L3');
    expect(paramDigest('command.exec', { command: 'devpilot-internal:kill-pid:29028', cwd: 'C:/x' })).not.toBe(
      paramDigest('command.exec', { command: 'devpilot-internal:kill-pid:29029', cwd: 'C:/x' }),
    );
  });

  it('process.list：返回本机进程且能按 pid 过滤（含自身 node 进程）', async () => {
    const r = await registry.execute('process.list', { filter: String(process.pid) }, ctx);
    expect(r.ok).toBe(true);
    const rows = r.data as Array<{ pid: number; name: string }>;
    expect(rows.some((row) => row.pid === process.pid)).toBe(true);
  });

  it('process.kill：不存在的 PID → alreadyDead（不挂审批直接完成）', async () => {
    const r = await registry.execute('process.kill', { pid: 4_000_000 }, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as { alreadyDead: boolean }).alreadyDead).toBe(true);
  });

  it('process.kill：agent 身份杀真实子进程 → 挂 L3 审批；批准后真杀且验证死亡', async () => {
    // 真实子进程：长眠 node
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 600));
    try {
      // 第一次：无授权 → 挂审批（L3 不放行）
      const denied = await registry.execute('process.kill', { pid: child.pid! }, ctx);
      expect(denied.ok).toBe(false);
      expect(denied.pendingApproval).toBe(true);
      const approvals = ds.db.prepare(`SELECT param_hash, risk_level FROM approvals WHERE approval_status='pending'`).all() as Array<{ param_hash: string; risk_level: string }>;
      expect(approvals.length).toBe(1);
      expect(approvals[0].risk_level).toBe('high');
      expect(approvals[0].param_hash).toBeTruthy();

      // 批准 → 参数级 one-shot 授权
      const apprId = (ds.db.prepare(`SELECT id FROM approvals WHERE approval_status='pending'`).get() as { id: string }).id;
      const approved = perms.approve(apprId);
      expect(approved.scope).toBe('param');

      // 第二次同 PID → 放行，真实终止 + 验证
      const kill = await registry.execute('process.kill', { pid: child.pid! }, ctx);
      expect(kill.ok).toBe(true);
      expect((kill.data as { killed: boolean }).killed).toBe(true);
      expect(String((kill.data as { verify: string }).verify)).toContain('已终止');

      // 进程确实死了
      await new Promise((r) => setTimeout(r, 300));
      const alive = await registry.execute('process.list', { filter: String(child.pid) }, ctx);
      expect((alive.data as Array<{ pid: number }>).some((row) => row.pid === child.pid)).toBe(false);

      // one-shot 已消费：再杀同 PID 会走 alreadyDead（进程已不在），但换个活 PID 需重新审批
      const again = await registry.execute('process.kill', { pid: child.pid! }, ctx);
      expect((again.data as { alreadyDead: boolean }).alreadyDead).toBe(true);
    } finally {
      try { child.kill(); } catch { /* ignore */ }
    }
  }, 30_000);

  it('process.kill：拒绝杀 DevPilot 自身', async () => {
    const r = await registry.execute('process.kill', { pid: process.pid }, ctx);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('自身');
  });
});
