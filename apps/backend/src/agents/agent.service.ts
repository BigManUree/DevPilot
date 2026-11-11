import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';
import { PermissionService } from '../permissions/permission.service';
import { ToolGatewayService } from '../permissions/tool-gateway.service';
import { ModelService } from './model.service';
import { LogService } from '../logs/log.service';
import { EventsGateway } from '../events.gateway';
import { AuditService } from '../permissions/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { ValidationStatus } from '@devpilot/shared-types';

/**
 * Agent 注册表 + Supervisor 执行引擎（多 Agent 设计文档）。
 * - 内置专业 Agent 注册（能力声明、所需权限）
 * - Supervisor：LLM 生成计划（JSON）→ 顺序执行子任务（经 ToolGateway，越权自动生成审批）
 * - 每步落 checkpoints；Validation 规则校验完成条件
 */

const BUILTIN_AGENTS = [
  { id: 'supervisor', type: 'supervisor', name: 'Supervisor 主控', capabilities: ['intent', 'planning', 'delegation'], categories: ['project_analysis'] },
  { id: 'project-analyzer', type: 'project_analyzer', name: 'Project Analyzer', capabilities: ['structure_scan', 'stack_detect'], categories: ['project_analysis'] },
  { id: 'diagnostic', type: 'diagnostic', name: 'Diagnostic Agent', capabilities: ['log_analysis', 'root_cause'], categories: ['project_analysis', 'command_execution'] },
  { id: 'repair', type: 'repair', name: 'Repair Agent', capabilities: ['config_fix', 'code_fix'], categories: ['modify_project_config', 'modify_code', 'auto_retry'] },
  { id: 'validation', type: 'validation', name: 'Validation Agent', capabilities: ['rule_check', 'result_verify'], categories: ['project_analysis'] },
  { id: 'git-agent', type: 'git', name: 'Git Agent', capabilities: ['status', 'commit'], categories: ['git_operation'] },
];

export interface SubTask {
  title: string;
  agent: string;
  tool: 'fs.read' | 'fs.write' | 'command.exec';
  params: Record<string, unknown>;
  completion_criteria?: string;
}

export interface TaskPlan {
  goal: string;
  subtasks: SubTask[];
}

@Injectable()
export class AgentService implements OnModuleInit {
  constructor(
    private readonly ds: DatabaseService,
    private readonly perms: PermissionService,
    private readonly gateway: ToolGatewayService,
    private readonly model: ModelService,
    private readonly logs: LogService,
    private readonly events: EventsGateway,
    private readonly audit: AuditService,
    private readonly notify: NotificationService,
  ) {}

  onModuleInit() {
    const ins = this.ds.db.prepare(
      `INSERT INTO agents (id, type, name, version, origin, capabilities_json, status)
       VALUES (?, ?, ?, '0.1.0', 'builtin', ?, 'registered')
       ON CONFLICT(id) DO NOTHING`,
    );
    for (const a of BUILTIN_AGENTS) ins.run(a.id, a.type, a.name, JSON.stringify(a.capabilities));
  }

  list() {
    return this.ds.db.prepare('SELECT id, type, name, version, origin, capabilities_json, status FROM agents').all();
  }

  /** 创建任务（Pending） */
  createTask(input: { goal: string; projectId?: string }): { taskId: string } {
    const id = randomUUID();
    this.ds.db
      .prepare(`INSERT INTO tasks (id, project_scope, task_type, input_summary, status, priority, created_at)
                VALUES (?, ?, 'ai-task', ?, 'Pending', 5, ?)`)
      .run(id, input.projectId ?? null, input.goal, new Date().toISOString());
    return { taskId: id };
  }

  listTasks() {
    return this.ds.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 50').all();
  }

  getTask(taskId: string) {
    const task = this.ds.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) throw new Error('task not found');
    const subtasks = this.ds.db.prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY rowid').all(taskId);
    const checkpoints = this.ds.db.prepare('SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC').all(taskId);
    return { task, subtasks, checkpoints };
  }

  cancelTask(taskId: string) {
    const r = this.ds.db
      .prepare(`UPDATE tasks SET status='Cancelled', finished_at=? WHERE id=? AND status IN ('Pending','Preparing','Running','Paused','WaitingApproval','WaitingInput')`)
      .run(new Date().toISOString(), taskId);
    if (r.changes === 0) throw new Error('task not cancellable');
    return { taskId, status: 'Cancelled' };
  }

  /** 暂停任务（测试场景 12）：仅 Preparing/Running 中的任务可暂停，执行循环在每个子任务前检查 */
  pauseTask(taskId: string) {
    const t = this.getTaskRow(taskId);
    if (!['Preparing', 'Running'].includes(t.status)) {
      throw new ConflictException(`仅执行中的任务可暂停，当前状态：${t.status}`);
    }
    this.ds.db.prepare(`UPDATE tasks SET status='Paused' WHERE id=?`).run(taskId);
    this.broadcastTask(taskId, 'Paused');
    return { taskId, status: 'Paused' };
  }

  /** 恢复任务：Paused → Running，执行循环自动继续 */
  resumeTask(taskId: string) {
    const t = this.getTaskRow(taskId);
    if (t.status !== 'Paused') {
      throw new ConflictException(`仅已暂停的任务可恢复，当前状态：${t.status}`);
    }
    this.ds.db.prepare(`UPDATE tasks SET status='Running' WHERE id=?`).run(taskId);
    this.broadcastTask(taskId, 'Running');
    return { taskId, status: 'Running' };
  }

  /** 用户补充信息（需求 5.2）：WaitingInput → 合并输入 → 重新执行 */
  async respondInput(taskId: string, answer: string, run = true) {
    const t = this.getTaskRow(taskId);
    if (t.status !== 'WaitingInput') {
      throw new ConflictException(`任务不在等待输入状态，当前状态：${t.status}`);
    }
    const merged = `${t.input_summary}\n[用户补充 ${new Date().toISOString()}] ${answer}`;
    this.ds.db.prepare(`UPDATE tasks SET input_summary=?, status='Pending' WHERE id=?`).run(merged, taskId);
    this.broadcastTask(taskId, 'Pending');
    if (run) return this.runTask(taskId);
    return { taskId, status: 'Pending' };
  }

  private getTaskRow(taskId: string): { id: string; status: string; input_summary: string; project_scope: string | null } {
    const t = this.ds.db.prepare('SELECT id, status, input_summary, project_scope FROM tasks WHERE id = ?').get(taskId) as
      | { id: string; status: string; input_summary: string; project_scope: string | null }
      | undefined;
    if (!t) throw new NotFoundException(`任务不存在：${taskId}`);
    return t;
  }

  /** 暂停等待点：DB 状态为 Paused 时轮询挂起，Cancelled 时终止循环 */
  private async waitWhilePaused(taskId: string): Promise<{ cancelled: boolean }> {
    for (;;) {
      const t = this.ds.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string } | undefined;
      if (!t) return { cancelled: true };
      if (t.status === 'Paused') {
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      return { cancelled: t.status === 'Cancelled' };
    }
  }

  /** Supervisor 主流程：规划 → 顺序执行 → 汇总 */
  async runTask(taskId: string): Promise<{ status: string; plan?: TaskPlan; results?: unknown; blocked?: unknown; question?: string }> {
    const task = this.ds.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      | { id: string; project_scope: string | null; input_summary: string; status: string }
      | undefined;
    if (!task) throw new Error('task not found');
    if (!this.model.hasKey()) {
      this.ds.db.prepare(`UPDATE tasks SET status='Failed', finished_at=? WHERE id=?`).run(new Date().toISOString(), taskId);
      throw new Error('model api key not configured');
    }
    this.ds.db.prepare(`UPDATE tasks SET status='Preparing', started_at=? WHERE id=?`).run(new Date().toISOString(), taskId);
    this.broadcastTask(taskId, 'Preparing');

    // 1) LLM 规划（JSON 输出）；无法识别 → 转 WaitingInput 向用户追问（需求 5.2）
    let plan: TaskPlan;
    try {
      const prompt = this.planPrompt(task.input_summary, task.project_scope ?? undefined);
      const raw = await this.model.chat([
        { role: 'system', content: '你是 DevPilot Supervisor。只能输出 JSON，格式 {"goal":string,"subtasks":[{"title":string,"agent":"project-analyzer|diagnostic|repair|validation","tool":"fs.read|fs.write|command.exec","params":object,"completion_criteria":string}]}。params 中 fs.read 用 {path}，command.exec 用 {command, cwd}，fs.write 用 {path, content}。子任务不超过 5 个。' },
        { role: 'user', content: prompt },
      ], { json: true });
      plan = JSON.parse(raw) as TaskPlan;
      if (!plan?.subtasks?.length) throw new Error('empty plan');
    } catch (err) {
      const question = `无法为该目标生成可执行计划（${String(err).slice(0, 120)}）。请补充说明：1) 任务目标与期望结果；2) 涉及哪个项目/服务或路径；3) 有无前置条件。`;
      this.ds.db.prepare(`UPDATE tasks SET status='WaitingInput', result_summary=? WHERE id=?`).run(question.slice(0, 300), taskId);
      this.broadcastTask(taskId, 'WaitingInput');
      this.notify.create({ type: 'task.waiting_input', title: `任务需要补充信息：${task.input_summary.slice(0, 40)}`, content: question, priority: 3 });
      return { status: 'WaitingInput', question };
    }

    // 2) 子任务落库
    const insSub = this.ds.db.prepare(
      `INSERT INTO subtasks (id, task_id, assigned_agent, input_json, status, completion_criteria) VALUES (?, ?, ?, ?, 'Pending', ?)`,
    );
    const subIds: string[] = [];
    for (const s of plan.subtasks.slice(0, 5)) {
      const sid = randomUUID();
      insSub.run(sid, taskId, s.agent, JSON.stringify(s), s.completion_criteria ?? null);
      subIds.push(sid);
    }
    // 规划完成进入执行：若期间已被暂停（Preparing→Paused），保持 Paused，由子任务循环的等待点接管
    this.ds.db.prepare(
      `UPDATE tasks SET status = CASE WHEN status='Paused' THEN 'Paused' ELSE 'Running' END, plan_version=plan_version+1 WHERE id=?`,
    ).run(taskId);
    this.broadcastTask(taskId, 'Running');
    // 本次任务运行的 agent_executions 记录（tool_calls FK 依赖）
    const execId = randomUUID();
    this.ds.db.prepare(
      `INSERT INTO agent_executions (id, task_id, agent_id, started_at, status, trace_id) VALUES (?, ?, 'supervisor', ?, 'Running', ?)`,
    ).run(execId, taskId, new Date().toISOString(), randomUUID());

    // 3) 顺序执行（Agent 身份走权限网关；越权 → WaitingApproval 并停）
    const results: Array<{ subtaskId: string; title: string; ok: boolean; blocked?: boolean; data?: unknown; error?: string }> = [];
    for (let i = 0; i < plan.subtasks.length; i++) {
      const s = plan.subtasks[i];
      const sid = subIds[i];
      // 暂停等待点（测试场景 12）：Paused 挂起、Cancelled 终止
      const gate = await this.waitWhilePaused(taskId);
      if (gate.cancelled) {
        this.notify.create({ type: 'task.cancelled', title: `任务已取消：${plan.goal.slice(0, 40)}`, content: `在子任务「${s.title}」前取消`, priority: 3 });
        return { status: 'Cancelled', plan, results };
      }
      this.ds.db.prepare(`UPDATE subtasks SET status='Running' WHERE id=?`).run(sid);
      // checkpoint
      this.ds.db.prepare(
        `INSERT INTO checkpoints (id, task_id, plan_version, state_snapshot, completed_subtasks_json, created_at)
         VALUES (?, ?, 1, ?, ?, ?)`,
      ).run(randomUUID(), taskId, JSON.stringify({ current: s.title }), JSON.stringify(subIds.slice(0, i)), new Date().toISOString());

      const r = await this.gateway.call(
        {
          subjectType: 'agent',
          subjectId: s.agent,
          tool: s.tool,
          params: s.params ?? {},
          projectId: task.project_scope ?? undefined,
          taskId,
          executionId: execId,
        },
        this.categoryFor(s.tool, s.agent),
      );

      if (!r.ok && r.permission === 'pending_approval') {
        this.ds.db.prepare(`UPDATE subtasks SET status='WaitingApproval' WHERE id=?`).run(sid);
        this.ds.db.prepare(`UPDATE tasks SET status='WaitingApproval' WHERE id=?`).run(taskId);
        results.push({ subtaskId: sid, title: s.title, ok: false, blocked: true, error: r.error });
        this.broadcastTask(taskId, 'WaitingApproval');
        this.notify.create({ type: 'approval.pending', title: `任务等待审批：${plan.goal.slice(0, 40)}`, content: `子任务「${s.title}」需授权，前往审批中心处理`, priority: 3 });
        return { status: 'WaitingApproval', blocked: { results, approvalId: r.approvalId } };
      }
      results.push({ subtaskId: sid, title: s.title, ok: r.ok, data: r.data, error: r.error });
      this.ds.db.prepare(`UPDATE subtasks SET status='${r.ok ? 'Completed' : 'Failed'}', output_ref=? WHERE id=?`)
        .run(JSON.stringify({ ok: r.ok, error: r.error }).slice(0, 1000), sid);
      if (!r.ok) {
        this.ds.db.prepare(`UPDATE tasks SET status='Failed', result_summary=? WHERE id=?`)
          .run(`subtask failed: ${s.title}: ${r.error}`, taskId);
        this.notify.create({ type: 'task.failed', title: `任务失败：${plan.goal.slice(0, 40)}`, content: `${s.title}: ${r.error ?? ''}`.slice(0, 300), priority: 2 });
        return { status: 'Failed', plan, results };
      }
    }

    // 4) Validation 规则校验
    const allCompleted = results.every((r) => r.ok);
    const status: ValidationStatus = allCompleted ? 'PASSED' : 'PARTIAL';
    const summary = `goal=${plan.goal} validation=${status} subtasks=${results.length} ok=${results.filter(r => r.ok).length}`;
    this.ds.db.prepare(`UPDATE tasks SET status='Completed', result_summary=?, finished_at=? WHERE id=?`)
      .run(summary, new Date().toISOString(), taskId);
    this.broadcastTask(taskId, 'Completed');
    this.notify.create({ type: 'task.completed', title: `任务完成：${plan.goal.slice(0, 40)}`, content: summary, priority: 5 });
    this.audit.record({ subject: 'agent:supervisor', action: 'task.run', target: taskId, result: 'ok', detail: { summary } });
    // 记忆沉淀：任务结果写入 task 层记忆，供后续任务检索
    this.ds.db.prepare(
      `INSERT INTO memories (id, scope, project_id, task_id, agent_id, content_ref, source, confidence, version, access_policy, created_at)
       VALUES (?, 'task', ?, ?, 'supervisor', ?, 'supervisor', 0.7, 1, 'local', ?)`,
    ).run(randomUUID(), task.project_scope ?? null, taskId,
      `任务[${taskId.slice(0, 8)}] goal=${plan.goal}; 结果=${summary}; 子任务=${results.map(r => r.title).join(' / ')}`,
      new Date().toISOString());
    return { status: 'Completed', plan, results };
  }

  private categoryFor(tool: string, agent: string): string | undefined {
    if (tool === 'fs.write') return agent === 'repair' ? 'modify_code' : 'modify_project_config';
    return undefined;
  }

  private planPrompt(goal: string, projectId?: string): string {
    let ctx = `目标：${goal}`;
    if (projectId) {
      const p = this.ds.db.prepare('SELECT name, language, framework, root_path FROM projects WHERE id = ?').get(projectId) as { name: string; language: string | null; framework: string | null; root_path: string } | undefined;
      if (p) ctx += `\n项目上下文：name=${p.name} language=${p.language ?? 'unknown'} framework=${p.framework ?? 'unknown'} root=${p.root_path}`;
    }
    return ctx;
  }

  private broadcastTask(taskId: string, status: string) {
    this.events.broadcast({
      event_id: randomUUID(),
      event_type: 'task.status.changed',
      timestamp: new Date().toISOString(),
      source_module: 'task-manager',
      task_id: taskId,
      trace_id: randomUUID(),
      severity: 'info',
      payload: { status },
    });
  }
}
