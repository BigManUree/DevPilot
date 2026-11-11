import { AgentService } from './agent.service';
import { makeMemoryDs, stub } from '../testing/helpers';

function makeService(modelOverrides: Record<string, unknown> = {}) {
  const ds = makeMemoryDs();
  const svc = new AgentService(
    stub(ds),
    stub({}),                                                   // perms
    stub({ call: jest.fn() }),                                  // gateway
    stub({ hasKey: () => true, chat: jest.fn(), ...modelOverrides }), // model
    stub({}),                                                   // logs
    stub({ broadcast: jest.fn() }),                             // events
    stub({ record: jest.fn() }),                                // audit
    stub({ create: jest.fn() }),                                // notify
  );
  return { ds, svc };
}

describe('AgentService 任务状态机（pause/resume/respondInput）', () => {
  it('pauseTask：Pending → ConflictException 409', () => {
    const { ds, svc } = makeService();
    const { taskId } = svc.createTask({ goal: 'g' });
    expect(() => svc.pauseTask(taskId)).toThrow(/仅执行中的任务可暂停/);
    try {
      svc.pauseTask(taskId);
    } catch (e: any) {
      expect(e.getStatus()).toBe(409);
    }
    void ds;
  });

  it('pauseTask：Running → Paused（DB 状态落库）', () => {
    const { ds, svc } = makeService();
    const { taskId } = svc.createTask({ goal: 'g' });
    ds.db.prepare(`UPDATE tasks SET status='Running' WHERE id=?`).run(taskId);
    expect(svc.pauseTask(taskId)).toEqual({ taskId, status: 'Paused' });
    const t = ds.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string };
    expect(t.status).toBe('Paused');
  });

  it('resumeTask：Paused → Running；非 Paused → 409', () => {
    const { ds, svc } = makeService();
    const { taskId } = svc.createTask({ goal: 'g' });
    expect(() => svc.resumeTask(taskId)).toThrow(/仅已暂停的任务可恢复/);
    ds.db.prepare(`UPDATE tasks SET status='Paused' WHERE id=?`).run(taskId);
    expect(svc.resumeTask(taskId)).toEqual({ taskId, status: 'Running' });
    expect(() => svc.resumeTask(taskId)).toThrow(/仅已暂停的任务可恢复/);
  });

  it('pause/resume/respondInput 不存在的任务 → 404', async () => {
    const { svc } = makeService();
    const expect404 = async (fn: () => unknown, sync = false) => {
      try {
        if (sync) fn(); else await fn();
        throw new Error('should have thrown');
      } catch (e: any) {
        expect(typeof e.getStatus).toBe('function');
        expect(e.getStatus()).toBe(404);
        expect(e.message).toContain('任务不存在');
      }
    };
    await expect404(() => svc.pauseTask('no-such'), true);
    await expect404(() => svc.resumeTask('no-such'), true);
    await expect404(() => svc.respondInput('no-such', 'a', false));
  });

  it('waitWhilePaused：Paused 挂起直至 resume，返回未取消', async () => {
    const { ds, svc } = makeService();
    const { taskId } = svc.createTask({ goal: 'g' });
    ds.db.prepare(`UPDATE tasks SET status='Paused' WHERE id=?`).run(taskId);
    const p = (svc as unknown as { waitWhilePaused: (id: string) => Promise<{ cancelled: boolean }> })
      .waitWhilePaused(taskId);
    setTimeout(() => ds.db.prepare(`UPDATE tasks SET status='Running' WHERE id=?`).run(taskId), 300);
    const gate = await p;
    expect(gate.cancelled).toBe(false);
  });

  it('waitWhilePaused：Cancelled 直接终止', async () => {
    const { ds, svc } = makeService();
    const { taskId } = svc.createTask({ goal: 'g' });
    ds.db.prepare(`UPDATE tasks SET status='Paused' WHERE id=?`).run(taskId);
    const p = (svc as unknown as { waitWhilePaused: (id: string) => Promise<{ cancelled: boolean }> })
      .waitWhilePaused(taskId);
    setTimeout(() => ds.db.prepare(`UPDATE tasks SET status='Cancelled' WHERE id=?`).run(taskId), 300);
    const gate = await p;
    expect(gate.cancelled).toBe(true);
  });

  it('respondInput(run=false)：合并补充 + 转 Pending', async () => {
    const { ds, svc } = makeService();
    const { taskId } = svc.createTask({ goal: '原始目标' });
    ds.db.prepare(`UPDATE tasks SET status='WaitingInput' WHERE id=?`).run(taskId);
    await svc.respondInput(taskId, '补充：路径为 C:/demo', false);
    const t = ds.db.prepare('SELECT status, input_summary FROM tasks WHERE id=?').get(taskId) as { status: string; input_summary: string };
    expect(t.status).toBe('Pending');
    expect(t.input_summary).toContain('原始目标');
    expect(t.input_summary).toContain('[用户补充');
    expect(t.input_summary).toContain('C:/demo');
  });

  it('respondInput：非 WaitingInput → 409', async () => {
    const { svc } = makeService();
    const { taskId } = svc.createTask({ goal: 'g' });
    try {
      await svc.respondInput(taskId, 'a', false);
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.getStatus()).toBe(409);
      expect(e.message).toContain('等待输入状态');
    }
  });

  it('runTask 无 Key：任务标 Failed 并抛错（守门）', async () => {
    const { svc } = makeService({ hasKey: () => false });
    const { taskId } = svc.createTask({ goal: 'g' });
    await expect(svc.runTask(taskId)).rejects.toThrow('model api key not configured');
  });

  it('cancelTask 后不可再 pause（状态保护链）', () => {
    const { svc } = makeService();
    const { taskId } = svc.createTask({ goal: 'g' });
    svc.cancelTask(taskId);
    expect(() => svc.pauseTask(taskId)).toThrow(/仅执行中的任务可暂停/);
  });
});
