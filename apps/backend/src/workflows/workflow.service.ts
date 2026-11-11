import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';
import { ToolGatewayService } from '../permissions/tool-gateway.service';
import { AgentService } from '../agents/agent.service';
import { NotificationService } from '../notifications/notification.service';
import { EventsGateway } from '../events.gateway';
import { LogService } from '../logs/log.service';

/**
 * 高级工作流（第三阶段，DSL 第一批）：
 * - 定义：线性 steps，step 类型 task（Agent 任务）/ command（审批双门命令）/ notify；
 *   condition step 按 ${stepId.field} 变量求值做扁平跳转（gotoOnTrue/gotoOnFalse）
 * - 安全：command 走 tool-gateway（subjectType=workflow，审批双门 + 审计）；task 复用 AgentService
 * - 隔离与上限：单 run 最多 50 步推进（防循环死转）；step 失败默认终止 run（continueOnError 可覆盖）
 */
export interface WorkflowStep {
  id: string;
  type: 'task' | 'command' | 'notify' | 'condition';
  /** task：Agent 任务目标；执行产出写入上下文 ${<id>.result} */
  goal?: string;
  projectId?: string;
  /** command */
  command?: string;
  cwd?: string;
  /** notify */
  title?: string;
  content?: string;
  /** condition：left 取上下文变量或字面量，op ∈ eq/ne/gt/lt，right 为字面量 */
  left?: string;
  op?: 'eq' | 'ne' | 'gt' | 'lt';
  right?: string;
  gotoOnTrue?: string;
  gotoOnFalse?: string;
  continueOnError?: boolean;
}

export interface WorkflowTrigger {
  /** manual（默认，不写 trigger 即手动）/ schedule（intervalMinutes）/ event（eventType 匹配广播） */
  type: 'schedule' | 'event';
  /** schedule：触发间隔（分钟） */
  intervalMinutes?: number;
  /** event：匹配的事件类型（精确匹配 event_type） */
  eventType?: string;
}

export interface WorkflowDefinition {
  name: string;
  trigger?: WorkflowTrigger;
  steps: WorkflowStep[];
}

const MAX_STEP_EXECUTIONS = 50;

@Injectable()
export class WorkflowService implements OnModuleInit {
  /** 运行中工作流（防 event 触发重入） */
  private runningWorkflows = new Set<string>();
  constructor(
    private readonly ds: DatabaseService,
    private readonly toolGateway: ToolGatewayService,
    private readonly agents: AgentService,
    private readonly notify: NotificationService,
    private readonly events: EventsGateway,
    private readonly logs: LogService,
  ) {}

  /** 定义校验：非空 steps、step.id 唯一、condition 必须有跳转目标且目标存在 */
  validateDefinition(d: unknown): { ok: true; definition: WorkflowDefinition } | { ok: false; error: string } {
    const def = d as WorkflowDefinition;
    if (!def || typeof def !== 'object') return { ok: false, error: '定义不是对象' };
    if (!def.name || typeof def.name !== 'string') return { ok: false, error: 'name 缺失' };
    if (!Array.isArray(def.steps) || def.steps.length === 0) return { ok: false, error: 'steps 缺失或为空' };
    const ids = new Set<string>();
    const knownTypes = new Set(['task', 'command', 'notify', 'condition']);
    for (const st of def.steps) {
      if (!st.id || !/^[\w-]{1,64}$/.test(st.id)) return { ok: false, error: `step id 非法：${st.id}` };
      if (ids.has(st.id)) return { ok: false, error: `step id 重复：${st.id}` };
      ids.add(st.id);
      if (!knownTypes.has(st.type)) return { ok: false, error: `step ${st.id} 类型未知：${st.type}` };
      if (st.type === 'task' && !st.goal) return { ok: false, error: `task step ${st.id} 缺 goal` };
      if (st.type === 'command' && !st.command) return { ok: false, error: `command step ${st.id} 缺 command` };
    }
    for (const st of def.steps) {
      if (st.type !== 'condition') continue;
      if (!st.left || !st.op || st.right === undefined) return { ok: false, error: `condition step ${st.id} 缺 left/op/right` };
      for (const g of [st.gotoOnTrue, st.gotoOnFalse]) {
        if (g && g !== 'end' && !ids.has(g)) return { ok: false, error: `condition step ${st.id} 跳转目标不存在：${g}` };
      }
    }
    return { ok: true, definition: def };
  }

  list(): Array<{ id: string; name: string; enabled: boolean; steps: number; updated_at: string }> {
    const rows = this.ds.db.prepare('SELECT id, name, definition_json, enabled, updated_at FROM workflows ORDER BY updated_at DESC').all() as any[];
    return rows.map((r) => { let d: WorkflowDefinition; try { d = JSON.parse(r.definition_json); } catch { d = { name: r.name, steps: [] }; } return { id: r.id, name: r.name, enabled: !!r.enabled, steps: d.steps.length, updated_at: r.updated_at }; });
  }

  create(body: { name: string; definition: WorkflowDefinition }) {
    const v = this.validateDefinition(body.definition);
    if (v.ok === false) throw new NotFoundException(v.error);
    const id = randomUUID();
    const now = new Date().toISOString();
    try {
      this.ds.db.prepare('INSERT INTO workflows (id, name, definition_json, enabled, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
        .run(id, body.name ?? v.definition.name, JSON.stringify(v.definition), now, now);
    } catch (e: any) {
      if (String(e).includes('UNIQUE')) throw new NotFoundException(`同名工作流已存在：${body.name}`);
      throw e;
    }
    return { id, name: body.name };
  }

  get(id: string) {
    const row = this.ds.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as any;
    if (!row) throw new NotFoundException(`工作流不存在：${id}`);
    return { id: row.id, name: row.name, definition: JSON.parse(row.definition_json), enabled: !!row.enabled, created_at: row.created_at, updated_at: row.updated_at };
  }

  remove(id: string) {
    const r = this.ds.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
    if (r.changes === 0) throw new NotFoundException(`工作流不存在：${id}`);
    return { id, deleted: true };
  }

  setEnabled(id: string, enabled: boolean) {
    const r = this.ds.db.prepare('UPDATE workflows SET enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, new Date().toISOString(), id);
    if (r.changes === 0) throw new NotFoundException(`工作流不存在：${id}`);
    return { id, enabled };
  }

  listRuns(workflowId?: string) {
    const rows = workflowId
      ? this.ds.db.prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT 50').all(workflowId)
      : this.ds.db.prepare('SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT 50').all();
    return (rows as any[]).map((r) => ({ ...r, context: r.context_json ? JSON.parse(r.context_json) : {} }));
  }

  getRun(runId: string) {
    const row = this.ds.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as any;
    if (!row) throw new NotFoundException(`运行不存在：${runId}`);
    return { ...row, context: row.context_json ? JSON.parse(row.context_json) : {} };
  }

  /** 变量插值：${stepId.field} → 上下文值；未命中保持原样 */
  private interpolate(text: string, ctx: Record<string, any>): string {
    return text.replace(/\$\{([\w-]+)\.([\w-]+)\}/g, (_, sid, field) => {
      const v = ctx[sid]?.[field];
      return v === undefined || v === null ? `\${${sid}.${field}}` : String(v);
    });
  }

  private evalCondition(step: WorkflowStep, ctx: Record<string, any>): boolean {
    const left = this.interpolate(step.left ?? '', ctx);
    const right = this.interpolate(step.right ?? '', ctx);
    const ln = Number(left);
    const rn = Number(right);
    switch (step.op) {
      case 'eq': return left === right || (!Number.isNaN(ln) && !Number.isNaN(rn) && ln === rn);
      case 'ne': return left !== right;
      case 'gt': return !Number.isNaN(ln) && !Number.isNaN(rn) && ln > rn;
      case 'lt': return !Number.isNaN(ln) && !Number.isNaN(rn) && ln < rn;
      default: return false;
    }
  }

  /** 触发器：event（包装广播分发）+ schedule（每分钟扫描 intervalMinutes 到期的工作流） */
  onModuleInit(): void {
    const original = this.events.broadcast.bind(this.events);
    (this.events as { broadcast: (ev: unknown) => void }).broadcast = (ev: unknown) => {
      original(ev as never);
      const e = ev as { event_type?: string };
      if (!e.event_type || e.event_type === 'workflow.progress') return;
      void this.fireEventTriggers(e.event_type);
    };
    setInterval(() => void this.fireScheduleTriggers(), 60_000).unref();
  }

  private async fireEventTriggers(eventType: string): Promise<void> {
    const rows = this.ds.db.prepare('SELECT id, definition_json FROM workflows WHERE enabled=1').all() as Array<{ id: string; definition_json: string }>;
    for (const row of rows) {
      if (this.runningWorkflows.has(row.id)) continue;
      let def: WorkflowDefinition;
      try { def = JSON.parse(row.definition_json); } catch { continue; }
      if (def.trigger?.type !== 'event' || def.trigger.eventType !== eventType) continue;
      try {
        await this.run(row.id);
        this.logs.log({ level: 'info', sourceModule: 'workflow.trigger', message: `event trigger fired: workflow=${row.id} event=${eventType}` });
      } catch { /* 运行中/已停用等正常竞态 */ }
    }
  }

  private async fireScheduleTriggers(): Promise<void> {
    const rows = this.ds.db.prepare('SELECT id, definition_json FROM workflows WHERE enabled=1').all() as Array<{ id: string; definition_json: string }>;
    for (const row of rows) {
      if (this.runningWorkflows.has(row.id)) continue;
      let def: WorkflowDefinition;
      try { def = JSON.parse(row.definition_json); } catch { continue; }
      if (def.trigger?.type !== 'schedule' || !def.trigger.intervalMinutes || def.trigger.intervalMinutes < 1) continue;
      const last = this.ds.db.prepare('SELECT MAX(started_at) t FROM workflow_runs WHERE workflow_id = ?').get(row.id) as { t: string | null };
      if (last.t && Date.now() - new Date(last.t).getTime() < def.trigger.intervalMinutes * 60_000) continue;
      try {
        await this.run(row.id);
        this.logs.log({ level: 'info', sourceModule: 'workflow.trigger', message: `schedule trigger fired: workflow=${row.id} every=${def.trigger.intervalMinutes}min` });
      } catch { /* 竞态忽略 */ }
    }
  }

  private broadcast(runId: string, wfId: string, stepId: string | null, status: string) {
    this.events.broadcast({
      event_id: randomUUID(),
      event_type: 'workflow.progress',
      timestamp: new Date().toISOString(),
      source_module: 'workflow',
      trace_id: randomUUID(),
      severity: 'info',
      payload: { runId, workflowId: wfId, stepId, status },
    });
  }

  /** 执行工作流：同步推进（步骤均轻量或经审批门），最多 50 步推进防循环 */
  async run(id: string): Promise<{ runId: string; status: string; context: Record<string, any> }> {
    if (this.runningWorkflows.has(id)) throw new NotFoundException(`工作流正在运行中：${id}`);
    const wf = this.get(id);
    if (!wf.enabled) throw new NotFoundException(`工作流已停用：${id}`);
    this.runningWorkflows.add(id);
    try {
      return await this.runInner(id, wf.definition as WorkflowDefinition);
    } finally {
      this.runningWorkflows.delete(id);
    }
  }

  private async runInner(id: string, def: WorkflowDefinition): Promise<{ runId: string; status: string; context: Record<string, any> }> {
    const runId = randomUUID();
    const ctx: Record<string, any> = {};
    const now = new Date().toISOString();
    this.ds.db.prepare('INSERT INTO workflow_runs (id, workflow_id, status, current_step, context_json, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, id, 'Running', def.steps[0]?.id ?? null, JSON.stringify(ctx), now);

    const index = new Map<string, number>();
    def.steps.forEach((st, i) => index.set(st.id, i));
    let cursor = 0;
    let executions = 0;
    try {
      while (cursor < def.steps.length && executions < MAX_STEP_EXECUTIONS) {
        executions++;
        const step = def.steps[cursor];
        this.ds.db.prepare('UPDATE workflow_runs SET current_step=?, context_json=? WHERE id=?').run(step.id, JSON.stringify(ctx), runId);
        this.broadcast(runId, id, step.id, 'step-start');
        try {
          if (step.type === 'task') {
            const goal = this.interpolate(step.goal ?? '', ctx);
            const created = this.agents.createTask({ goal, projectId: step.projectId });
            const r = await this.agents.runTask(created.taskId);
            ctx[step.id] = { taskId: created.taskId, status: r.status, result: typeof r.results === 'string' ? r.results.slice(0, 500) : (r.results ?? r.question ?? r.blocked ?? null) };
          } else if (step.type === 'command') {
            const command = this.interpolate(step.command ?? '', ctx);
            const r = await this.toolGateway.call(
              { subjectType: 'workflow', subjectId: id, tool: 'command.exec', params: { command, cwd: step.cwd } },
              'plugin',
            );
            ctx[step.id] = { ok: r.ok, exitCode: (r.data as any)?.exitCode ?? 0, output: String((r.data as any)?.stdout ?? r.error ?? '').slice(0, 500) };
          } else if (step.type === 'notify') {
            this.notify.create({
              type: 'workflow.notify',
              title: this.interpolate(step.title ?? `工作流 ${def.name}`, ctx),
              content: this.interpolate(step.content ?? '', ctx),
              priority: 4,
            });
            ctx[step.id] = { notified: true };
          } else if (step.type === 'condition') {
            const truthy = this.evalCondition(step, ctx);
            ctx[step.id] = { condition: truthy };
            const target = truthy ? step.gotoOnTrue : step.gotoOnFalse;
            if (target) { cursor = index.get(target) ?? def.steps.length; continue; }
          }
        } catch (e) {
          ctx[step.id] = { error: String(e).slice(0, 300) };
          if (!step.continueOnError) throw e;
        }
        cursor++;
      }
      const status = executions >= MAX_STEP_EXECUTIONS ? 'Failed' : 'Completed';
      this.finishRun(runId, status, ctx);
      return { runId, status, context: ctx };
    } catch (e) {
      ctx.__error = String(e).slice(0, 300);
      this.finishRun(runId, 'Failed', ctx);
      return { runId, status: 'Failed', context: ctx };
    }
  }

  private finishRun(runId: string, status: string, ctx: Record<string, any>) {
    this.ds.db.prepare('UPDATE workflow_runs SET status=?, context_json=?, finished_at=? WHERE id=?')
      .run(status, JSON.stringify(ctx), new Date().toISOString(), runId);
    this.broadcast(runId, '', null, status);
  }
}
