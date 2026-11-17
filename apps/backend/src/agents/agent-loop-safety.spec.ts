import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentService } from './agent.service';
import { PermissionService } from '../permissions/permission.service';
import { makeMemoryDs, stub } from '../testing/helpers';

/** 回归：任务重入保护 / 审批后自动恢复 / 无效指令上限（审计第二轮新增） */
describe('AgentService 执行安全（第二轮审计回归）', () => {
  function makeService(modelOverrides: Record<string, unknown> = {}) {
    const ds = makeMemoryDs();
    const realPerms = new PermissionService(stub({ db: ds.db }));
    const permsStub: PermissionService = stub({
      check: () => ({ allowed: true, reason: 'test' }),
      onApprovalDecided: (cb: unknown) => realPerms.onApprovalDecided(cb as never),
    });
    const svc = new AgentService(
      stub(ds),
      permsStub,
      stub({ call: jest.fn() }),
      stub({ hasKey: () => true, loadKeyFromStore: async () => false, chat: jest.fn(), ...modelOverrides }),
      stub({}),
      stub({ broadcast: jest.fn() }),
      stub({ record: jest.fn() }),
      stub({ create: jest.fn() }),
      stub({ execute: jest.fn(), descriptors: () => [], describeForPrompt: () => '' }),
    );
    svc.onModuleInit(); // 落 agents 内置行（tool_calls/agent_executions FK 需要）+ 注册审批恢复回调
    return { ds, svc, realPerms };
  }

  it('runTask 重入保护：活循环在跑时再次启动 → 409（DB 状态陈旧但无活循环则允许自愈重跑）', async () => {
    // 真实并发：第一轮 chat 给一个工具动作，第二轮 chat 挂在 gate 上，循环保持存活
    let release!: () => void;
    const gate = new Promise<string>((resolve) => { release = () => resolve('{"action":"finish","status":"success","summary":"done"}'); });
    const chat = jest.fn()
      .mockResolvedValueOnce('{"action":"tool","tool":"fs.list","params":{}}')
      .mockImplementationOnce(() => gate);
    const { svc } = makeService({ chat });
    // registry stub 默认 execute 返回 undefined 会让循环崩进异常兜底——给一个正常结果
    (svc as unknown as { registry: Record<string, unknown> }).registry = {
      execute: jest.fn().mockResolvedValue({ ok: true, data: [] }),
      descriptors: () => [],
      describeForPrompt: () => '',
    };
    const { taskId } = svc.createTask({ goal: '并发' });
    const p = svc.runTask(taskId);
    // 等循环进入第二轮 chat（liveRuns 已登记）
    await new Promise((r) => setTimeout(r, 200));
    await expect(svc.runTask(taskId)).rejects.toMatchObject({ status: 409 });
    release();
    const r = await p;
    expect(r.status).toBe('Completed');
    // 活循环结束后 liveRuns 清空
    expect((svc as unknown as { liveRuns: Set<string> }).liveRuns.has(taskId)).toBe(false);
  }, 30_000);

  it('陈旧 Running 自愈：进程重启后 DB=Running 但无活循环 → runTask 可重新启动（不再永久 409）', async () => {
    const { ds, svc } = makeService({ chat: jest.fn().mockResolvedValue('{"action":"finish","status":"success","summary":"自愈完成"}') });
    const { taskId } = svc.createTask({ goal: 'g' });
    ds.db.prepare(`UPDATE tasks SET status='Running' WHERE id=?`).run(taskId);
    const r = await svc.runTask(taskId);
    expect(r.status).toBe('Completed');
  }, 30_000);

  it('活循环：执行中暂停 → 恢复后从门点继续推进到完成（不重跑、不重复执行工具）', async () => {
    let release2!: () => void;
    let release3!: () => void;
    const step2 = new Promise<string>((res) => { release2 = () => res('{"action":"tool","tool":"fs.list","params":{}}'); });
    const step3 = new Promise<string>((res) => { release3 = () => res('{"action":"finish","status":"success","summary":"暂停恢复后完成"}'); });
    const chat = jest.fn()
      .mockResolvedValueOnce('{"action":"tool","tool":"fs.list","params":{}}')
      .mockImplementationOnce(() => step2)
      .mockImplementationOnce(() => step3);
    const { svc } = makeService({ chat });
    (svc as unknown as { registry: Record<string, unknown> }).registry = {
      execute: jest.fn().mockResolvedValue({ ok: true, data: [] }),
      descriptors: () => [],
      describeForPrompt: () => '',
    };
    const { taskId } = svc.createTask({ goal: '暂停恢复' });
    const p = svc.runTask(taskId);
    // 等第一轮工具执行完、循环进入第二轮 chat（在 step2 上挂起）
    await new Promise((r) => setTimeout(r, 200));
    svc.pauseTask(taskId); // 暂停：DB=Paused，循环此时还挂在 chat 上
    release2(); // chat 返回又一个工具动作 → 循环顶部到达暂停门 → 应阻塞
    await new Promise((r) => setTimeout(r, 300));
    // 门生效：chat3 未被调用（没有继续消耗 LLM/工具）
    expect(chat).toHaveBeenCalledTimes(2);
    // 恢复：liveRuns 有活循环 → 只改状态唤醒门，不重复拉起
    const r0 = svc.resumeTask(taskId);
    expect(r0.status).toBe('Running');
    release3();
    const r = await p;
    expect(r.status).toBe('Completed');
    expect(chat).toHaveBeenCalledTimes(3);
    expect((svc as unknown as { liveRuns: Set<string> }).liveRuns.has(taskId)).toBe(false);
  }, 30_000);

  it('暂停后循环已死（如后端重启）→ resumeTask 重新拉起执行循环并完成任务', async () => {
    const { ds, svc } = makeService({ chat: jest.fn().mockResolvedValue('{"action":"finish","status":"success","summary":"恢复后完成"}') });
    const { taskId } = svc.createTask({ goal: 'g' });
    // 模拟"暂停后进程重启"：DB=Paused，内存无活循环
    ds.db.prepare(`UPDATE tasks SET status='Paused' WHERE id=?`).run(taskId);
    const r = svc.resumeTask(taskId);
    expect(r.status).toBe('Running');
    // 异步拉起的 runTask 应真正跑完
    let status = '';
    for (let i = 0; i < 50; i++) {
      await new Promise((res) => setTimeout(res, 100));
      status = (ds.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string }).status;
      if (['Completed', 'Failed'].includes(status)) break;
    }
    expect(status).toBe('Completed');
    expect((svc as unknown as { liveRuns: Set<string> }).liveRuns.has(taskId)).toBe(false);
  }, 30_000);

  it('模型连续输出无效指令 → 5 次内终止为 Failed（防无限空转烧预算）', async () => {
    const { svc } = makeService({ chat: jest.fn().mockResolvedValue('{"action":"bogus"}') });
    const { taskId } = svc.createTask({ goal: 'g' });
    const r = await svc.runTask(taskId);
    expect(r.status).toBe('Failed');
    expect(String(r.summary)).toContain('无效指令');
    const t = svc.getTask(taskId);
    expect((t.task as { status: string }).status).toBe('Failed');
  }, 30_000);

  it('模型持续输出非 JSON → 终止为 Failed（不无限重试）', async () => {
    const { svc } = makeService({ chat: jest.fn().mockResolvedValue('这不是JSON') });
    const { taskId } = svc.createTask({ goal: 'g' });
    const r = await svc.runTask(taskId);
    expect(r.status).toBe('Failed');
    expect(String(r.summary)).toContain('无效指令');
  }, 30_000);

  it('审批通过 → WaitingApproval 任务自动恢复执行（修复批准后永久滞留）', async () => {
    const chat = jest.fn()
      .mockResolvedValueOnce('{"action":"finish","status":"success","summary":"恢复后完成"}');
    const { ds, svc, realPerms } = makeService({ chat });
    const { taskId } = svc.createTask({ goal: 'g' });
    ds.db.prepare(`UPDATE tasks SET status='WaitingApproval' WHERE id=?`).run(taskId);

    // 模拟网关越权时生成的审批（绑定 taskId），用户批准
    const check = realPerms.check({ subjectType: 'agent', subjectId: 'supervisor', category: 'command_execution', projectId: 'p1', taskId });
    expect(check.allowed).toBe(false);
    svc.onModuleInit(); // 注册审批恢复回调
    realPerms.approve(check.approvalId!);

    // 异步 runTask 跑完
    await new Promise((r) => setTimeout(r, 300));
    const t = ds.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string };
    expect(t.status).toBe('Completed');
    expect(chat).toHaveBeenCalled();
  }, 30_000);

  it('拒绝审批 → WaitingApproval 任务保持等待（不自动恢复）', async () => {
    const { ds, svc, realPerms } = makeService({ chat: jest.fn() });
    const { taskId } = svc.createTask({ goal: 'g' });
    ds.db.prepare(`UPDATE tasks SET status='WaitingApproval' WHERE id=?`).run(taskId);
    const check = realPerms.check({ subjectType: 'agent', subjectId: 'supervisor', category: 'command_execution', projectId: 'p1', taskId });
    svc.onModuleInit();
    realPerms.reject(check.approvalId!);
    await new Promise((r) => setTimeout(r, 200));
    const t = ds.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string };
    expect(t.status).toBe('WaitingApproval');
  }, 30_000);

  it('deleteTask：终态任务删除并级联清理；执行中任务拒绝删除', async () => {
    const { ds, svc } = makeService();
    const { taskId } = svc.createTask({ goal: '待删除' });
    ds.db.prepare(`UPDATE tasks SET status='Failed', finished_at=? WHERE id=?`).run(new Date().toISOString(), taskId);
    svc.getTask(taskId); // 生成 subtask 无、checkpoints 无，但确保读取路径正常
    const r = svc.deleteTask(taskId);
    expect(r.deleted).toBe(true);
    expect((ds.db.prepare('SELECT COUNT(*) c FROM tasks WHERE id=?').get(taskId) as { c: number }).c).toBe(0);
    expect(() => svc.getTask(taskId)).toThrow(/任务不存在/);
    // 不存在的任务 → 404（getTaskRow 文案为 任务不存在）
    expect(() => svc.deleteTask('no-such')).toThrow(/任务不存在/);
  }, 30_000);

  it('renameTask：改名落库、空名拒绝、不存在的任务 404', async () => {
    const { svc } = makeService();
    const { taskId } = svc.createTask({ goal: '旧标题' });
    const r = svc.renameTask(taskId, '  新标题  ');
    expect(r.title).toBe('新标题');
    expect((svc.getTask(taskId).task as { input_summary: string }).input_summary).toBe('新标题');
    expect(() => svc.renameTask(taskId, '   ')).toThrow(/不能为空/);
    expect(() => svc.renameTask('no-such', 'x')).toThrow(/任务不存在/);
  }, 30_000);

  it('deleteTask：Running 状态拒绝删除（防止运行循环写已删除的行）', async () => {
    const { ds, svc } = makeService();
    const { taskId } = svc.createTask({ goal: '运行中' });
    ds.db.prepare(`UPDATE tasks SET status='Running' WHERE id=?`).run(taskId);
    expect(() => svc.deleteTask(taskId)).toThrow(/先取消再删除/);
    // 取消后可删
    svc.cancelTask(taskId);
    expect(svc.deleteTask(taskId).deleted).toBe(true);
  }, 30_000);

  it('已取消的任务不再被审批恢复', async () => {
    const { ds, svc, realPerms } = makeService({ chat: jest.fn() });
    const { taskId } = svc.createTask({ goal: 'g' });
    ds.db.prepare(`UPDATE tasks SET status='Cancelled' WHERE id=?`).run(taskId);
    const check = realPerms.check({ subjectType: 'agent', subjectId: 'supervisor', category: 'command_execution', projectId: 'p1', taskId });
    svc.onModuleInit();
    realPerms.approve(check.approvalId!);
    await new Promise((r) => setTimeout(r, 200));
    const t = ds.db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId) as { status: string };
    expect(t.status).toBe('Cancelled');
  }, 30_000);

  it('预算耗尽 → 进入收尾模式：模型违规 2 次后强制收尾（如实报告，不谎称已完成）', async () => {
    const chat = jest.fn().mockImplementation(() => {
      const n = chat.mock.calls.length;
      if (n <= 80) return Promise.resolve('{"action":"tool","tool":"fs.list","params":{}}');
      return Promise.resolve('{"action":"tool","tool":"fs.list","params":{}}');
    });
    const { svc } = makeService({ chat });
    (svc as unknown as { registry: Record<string, unknown> }).registry = {
      execute: jest.fn().mockResolvedValue({ ok: true, data: [] }),
      descriptors: () => [], describeForPrompt: () => '',
    };
    const { taskId } = svc.createTask({ goal: '写脚本' });
    const r = await svc.runTask(taskId);
    expect(r.status).toBe('Failed');
    expect(String(r.summary)).toContain('预算');
    expect(String(r.summary)).toContain('未能在预算内完成');
    expect(String(r.summary)).not.toContain('已完成步骤');
  }, 60_000);

  it('预算耗尽 → 收尾模式中模型输出 finish → 按其 status 正常完成', async () => {
    const chat = jest.fn().mockImplementation(() => {
      const n = chat.mock.calls.length;
      if (n <= 80) return Promise.resolve('{"action":"tool","tool":"fs.write","params":{}}');
      if (n === 81) return Promise.resolve('{"action":"tool","tool":"fs.list","params":{}}');
      return Promise.resolve('{"action":"finish","status":"success","summary":"一键启动脚本已写入 start.mjs，任务完成"}');
    });
    const { svc } = makeService({ chat });
    (svc as unknown as { registry: Record<string, unknown> }).registry = {
      execute: jest.fn().mockResolvedValue({ ok: true, data: [] }),
      descriptors: () => [], describeForPrompt: () => '',
    };
    const { taskId } = svc.createTask({ goal: '写脚本' });
    const r = await svc.runTask(taskId);
    expect(r.status).toBe('Completed');
    expect(String(r.summary)).toContain('start.mjs');
  }, 60_000);

});
