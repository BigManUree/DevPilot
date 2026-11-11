import { WorkflowService, WorkflowDefinition } from './workflow.service';
import { makeMemoryDs, stub } from '../testing/helpers';
import { NotFoundException } from '@nestjs/common';

function makeService(overrides?: { toolGateway?: Record<string, unknown>; agents?: Record<string, unknown> }) {
  const ds = makeMemoryDs();
  const toolGateway = overrides?.toolGateway ?? { call: jest.fn().mockResolvedValue({ ok: true, data: { exitCode: 0, stdout: 'ok' } }) };
  const agents = overrides?.agents ?? {
    createTask: jest.fn().mockReturnValue({ taskId: 'task-123' }),
    runTask: jest.fn().mockResolvedValue({ status: 'Completed', results: '任务完成' }),
  };
  const notify = { create: jest.fn().mockReturnValue('n-1') };
  const events = { broadcast: jest.fn() };
  const svc = new WorkflowService(stub(ds), stub(toolGateway), stub(agents), stub(notify), stub(events), stub({ log: jest.fn() })) as unknown as WorkflowService;
  return { ds, svc, toolGateway, agents, notify, events };
}

const linearDef: WorkflowDefinition = {
  name: '线性流',
  steps: [
    { id: 'a', type: 'command', command: 'echo step-a' },
    { id: 'b', type: 'notify', title: '步骤 a 输出：${a.output}' },
  ],
};

describe('WorkflowService 定义校验', () => {
  const base = { ...linearDef };
  it('合法定义通过', () => {
    const { svc } = makeService();
    expect(svc.validateDefinition(base).ok).toBe(true);
  });
  it('空 steps / 重复 id / 未知类型 / task 缺 goal / command 缺 command → 拒绝', () => {
    const { svc } = makeService();
    expect(svc.validateDefinition({ ...base, steps: [] }).ok).toBe(false);
    expect(svc.validateDefinition({ ...base, steps: [{ id: 'x', type: 'task' }, { id: 'x', type: 'notify' }] }).ok).toBe(false);
    expect(svc.validateDefinition({ ...base, steps: [{ id: 'x', type: 'evil' as never }] }).ok).toBe(false);
    expect(svc.validateDefinition({ ...base, steps: [{ id: 'x', type: 'task' }] }).ok).toBe(false);
    expect(svc.validateDefinition({ ...base, steps: [{ id: 'x', type: 'command' }] }).ok).toBe(false);
  });
  it('condition 跳转目标不存在 → 拒绝；缺 left/op/right → 拒绝', () => {
    const { svc } = makeService();
    expect(svc.validateDefinition({ ...base, steps: [{ id: 'c', type: 'condition', left: 'x', op: 'eq', right: '1', gotoOnTrue: 'nope' }] }).ok).toBe(false);
    expect(svc.validateDefinition({ ...base, steps: [{ id: 'c', type: 'condition', left: 'x' }] }).ok).toBe(false);
  });
});

describe('WorkflowService 执行引擎', () => {
  it('线性执行：command 走 tool-gateway、变量插值进 notify、run Completed 且上下文落库', async () => {
    const { ds, svc, toolGateway, notify } = makeService();
    const w = svc.create({ name: '线性', definition: linearDef });
    const r = await svc.run(w.id);
    expect(r.status).toBe('Completed');
    expect(r.context.a.ok).toBe(true);
    expect(r.context.b.notified).toBe(true);
    expect(toolGateway.call).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: 'workflow', tool: 'command.exec', params: { command: 'echo step-a', cwd: undefined } }),
      'plugin',
    );
    expect(notify.create).toHaveBeenCalledWith(expect.objectContaining({ title: '步骤 a 输出：ok' }));
    const run = svc.getRun(r.runId);
    expect(run.status).toBe('Completed');
    expect(run.current_step).toBe('b');
  });

  it('task step：创建并执行 Agent 任务，结果进上下文', async () => {
    const { ds, svc, agents } = makeService();
    const w = svc.create({ name: '任务流', definition: { name: '任务流', steps: [{ id: 't1', type: 'task', goal: '检查健康' }] } });
    const r = await svc.run(w.id);
    expect(r.status).toBe('Completed');
    expect(r.context.t1.taskId).toBe('task-123');
    expect(r.context.t1.status).toBe('Completed');
    expect(agents.createTask).toHaveBeenCalledWith({ goal: '检查健康', projectId: undefined });
  });

  it('condition 跳转：eq 命中走 gotoOnTrue 分支；变量取 ${stepId.field}', async () => {
    const { svc } = makeService();
    const def: WorkflowDefinition = {
      name: '条件流',
      steps: [
        { id: 'cmd', type: 'command', command: 'echo ok' },
        { id: 'check', type: 'condition', left: '${cmd.exitCode}', op: 'eq', right: '0', gotoOnTrue: 'good', gotoOnFalse: 'bad' },
        { id: 'good', type: 'notify', title: '成功分支' },
        { id: 'after-good', type: 'condition', left: '1', op: 'eq', right: '1', gotoOnTrue: 'end' },
        { id: 'bad', type: 'notify', title: '失败分支' },
      ],
    };
    const w = svc.create({ name: '条件', definition: def });
    const r = await svc.run(w.id);
    expect(r.status).toBe('Completed');
    expect(r.context.check.condition).toBe(true);
    expect(r.context.good.notified).toBe(true);
    expect(r.context.bad).toBeUndefined();
  });

  it('step 失败 → run Failed 落 __error；continueOnError 则继续', async () => {
    const { svc } = makeService({ toolGateway: { call: jest.fn().mockRejectedValue(new Error('boom')) } });
    const failWf = svc.create({ name: '失败流', definition: { name: '失败流', steps: [{ id: 'a', type: 'command', command: 'x' }] } });
    const fr = await svc.run(failWf.id);
    expect(fr.status).toBe('Failed');
    expect(fr.context.__error).toContain('boom');
    expect(svc.getRun(fr.runId).status).toBe('Failed');

    const contWf = svc.create({ name: '容错流', definition: { name: '容错流', steps: [
      { id: 'a', type: 'command', command: 'x', continueOnError: true },
      { id: 'b', type: 'notify', title: '仍继续' },
    ] } });
    const cr = await svc.run(contWf.id);
    expect(cr.status).toBe('Completed');
    expect(cr.context.a.error).toContain('boom');
    expect(cr.context.b.notified).toBe(true);
  });

  it('停用的工作流不可运行；不存在 → NotFoundException', async () => {
    const { svc } = makeService();
    const w = svc.create({ name: '停用流', definition: linearDef });
    svc.setEnabled(w.id, false);
    await expect(svc.run(w.id)).rejects.toThrow(NotFoundException);
    await expect(svc.run('no-such')).rejects.toThrow(NotFoundException);
  });
});

describe('WorkflowService cron 触发器', () => {
  it('schedule 校验：非法 cron 拒绝，合法通过', () => {
    const { svc } = makeService();
    const bad = svc.validateDefinition({ ...linearDef, trigger: { type: 'schedule', cron: '99 * * * *' } });
    expect(bad.ok).toBe(false);
    if (bad.ok === false) expect(bad.error).toContain('cron');
    expect(svc.validateDefinition({ ...linearDef, trigger: { type: 'schedule', cron: '0 9 * * 1-5' } }).ok).toBe(true);
    expect(svc.validateDefinition({ ...linearDef, trigger: { type: 'event' } }).ok).toBe(false);
  });

  it('cron 命中当前分钟 → 触发一次；同分钟内再扫不重入', async () => {
    const { svc, notify } = makeService();
    const w = svc.create({ name: 'cron流', definition: {
      name: 'cron流',
      trigger: { type: 'schedule', cron: '* * * * *' }, // 每分钟都命中
      steps: [{ id: 'n1', type: 'notify', title: 'cron 触发' }],
    } });
    svc.setEnabled(w.id, true);
    await (svc as unknown as { fireScheduleTriggers(): Promise<void> }).fireScheduleTriggers();
    expect(notify.create).toHaveBeenCalledTimes(1);
    await (svc as unknown as { fireScheduleTriggers(): Promise<void> }).fireScheduleTriggers();
    expect(notify.create).toHaveBeenCalledTimes(1); // 同分钟去重
  });

  it('cron 不命中 → 不触发', async () => {
    const { svc, notify } = makeService();
    const w = svc.create({ name: '不命中', definition: {
      name: '不命中',
      trigger: { type: 'schedule', cron: '0 0 1 1 *' }, // 元旦 0 点，当前必不命中
      steps: [{ id: 'n1', type: 'notify', title: 'x' }],
    } });
    svc.setEnabled(w.id, true);
    await (svc as unknown as { fireScheduleTriggers(): Promise<void> }).fireScheduleTriggers();
    expect(notify.create).not.toHaveBeenCalled();
  });

  it('list() 返回触发器摘要', () => {
    const { svc } = makeService();
    svc.create({ name: '手', definition: linearDef });
    svc.create({ name: '周', definition: { ...linearDef, trigger: { type: 'schedule', cron: '0 9 * * 1-5' } } });
    svc.create({ name: '隔', definition: { ...linearDef, trigger: { type: 'schedule', intervalMinutes: 30 } } });
    svc.create({ name: '件', definition: { ...linearDef, trigger: { type: 'event', eventType: 'task.failed' } } });
    const rows = svc.list();
    const byName = new Map(rows.map((r) => [r.name, r.trigger]));
    expect(byName.get('手')).toBe('手动');
    expect(byName.get('周')).toBe('cron 0 9 * * 1-5');
    expect(byName.get('隔')).toBe('每 30 分钟');
    expect(byName.get('件')).toBe('事件 task.failed');
  });
});
