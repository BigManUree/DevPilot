import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { DatabaseService } from '../database/database.module';
import { PermissionService } from '../permissions/permission.service';
import { ToolGatewayService } from '../permissions/tool-gateway.service';
import { ModelService } from './model.service';
import { LogService } from '../logs/log.service';
import { EventsGateway } from '../events.gateway';
import { AuditService } from '../permissions/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { ToolRegistryService, type ToolCallCtx } from './tool-registry';
import { ValidationStatus, AGENT_BUDGET_DEFAULT } from '@devpilot/shared-types';

/**
 * Agent 注册表 + Supervisor 执行引擎（智能化升级版）：
 * - 内置专业 Agent 注册（能力声明、所需权限）
 * - Supervisor：LLM 工具循环（观察→推理→调用工具→读真实结果→再推理），失败不整体终止，支持重规划
 * - 计划版本化：task_plan_versions 记录每次计划变更与原因
 * - 预算：工具调用次数 / 计划迭代 / 总时长，超限保存状态与失败原因
 * - 每步落 checkpoints 与 subtasks；副作用工具经 ToolGateway（越权自动生成审批）
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

const SYSTEM_PROMPT = `你是 DevPilot Supervisor，负责把用户的软件项目真正运行起来（或在失败时诊断修复）。

工作方式：确定性检测优先 + 规则判断 + 你的推理 + 受控工具调用 + 真实结果验证。你不能凭空猜测事实，所有事实必须来自工具返回。

可用的工具（真实执行）：
{{TOOLS}}

每轮你只能输出一个 JSON 对象（不要 markdown 代码块）：
- 调工具：{"action":"tool","tool":"<工具名>","params":{...},"note":"为什么调它"}
- 更新计划（可选，在关键节点输出）：{"action":"plan","steps":[{"title":"..."}],"reason":"计划调整原因"}
- 结束：{"action":"finish","status":"success|failed|blocked","summary":"做了什么/验证结果/证据"}

规则：
1. 先 project.inspect / project.get_profile 了解项目，再 env.match / env.check_vars / env.check_services 体检环境。
2. 装依赖、改文件、启动服务前先确认所需工具存在（env.match）。版本不匹配时优先找本机已有版本，不擅自安装系统级软件。
3. terminal.exec 用于装依赖/构建等命令；启动项目用 runtime.start；验证用 runtime.health_check。
4. 启动失败时：runtime.logs 读真实日志 → diagnostics.classify 分类 → diagnostics.repair 或 terminal.exec 修复 → 再启动验证。修复尝试不超过 2 次，连续失败就 finish(status=failed) 并给出人工建议。
5. 任务完成标准：服务 Running 且健康检查通过（有端口时）。只成功启动但未验证不算完成。
6. 所有命令只在项目目录内执行；不删除用户数据；不执行破坏性命令。`;

interface LoopTurn {
  action: 'tool' | 'finish' | 'plan' | 'invalid';
  tool?: string;
  params?: Record<string, unknown>;
  note?: string;
  steps?: Array<{ title: string }>;
  reason?: string;
  status?: 'success' | 'failed' | 'blocked';
  summary?: string;
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
    private readonly registry: ToolRegistryService,
  ) {}

  onModuleInit() {
    const ins = this.ds.db.prepare(
      `INSERT INTO agents (id, type, name, version, origin, capabilities_json, status)
       VALUES (?, ?, ?, '0.2.0', 'builtin', ?, 'registered')
       ON CONFLICT(id) DO NOTHING`,
    );
    for (const a of BUILTIN_AGENTS) ins.run(a.id, a.type, a.name, JSON.stringify(a.capabilities));
    // 风险分级默认策略（升级任务书 §10.3）：L0 只读检查可自动执行——
    // supervisor 的 project_analysis（只读）与 task.run 预置授权，副作用工具（fs.write/command.exec）
    // 仍走审批双门。grant_source 标记为 builtin-default，用户可在权限中心回收。
    const permIns = this.ds.db.prepare(
      `INSERT INTO permissions (id, subject_type, subject_id, category, resource_scope, grant_source, expires_at, status, created_at)
       SELECT ?, 'agent', 'supervisor', ?, NULL, 'builtin-default', NULL, 'active', ?
       WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE subject_type='agent' AND subject_id='supervisor' AND category=? AND status='active')`,
    );
    const now = new Date().toISOString();
    permIns.run(randomUUID(), 'project_analysis', now, 'project_analysis');
    permIns.run(randomUUID(), 'task.run', now, 'task.run');
  }

  list() {
    return this.ds.db.prepare('SELECT id, type, name, version, origin, capabilities_json, status FROM agents').all();
  }

  /** 工具清单（前端工作区展示用） */
  listTools() {
    return this.registry.descriptors();
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
    const plans = this.ds.db.prepare('SELECT version, plan_json, change_reason, created_at FROM task_plan_versions WHERE task_id = ? ORDER BY version').all(taskId);
    return { task, subtasks, checkpoints, plans };
  }

  cancelTask(taskId: string) {
    const r = this.ds.db
      .prepare(`UPDATE tasks SET status='Cancelled', finished_at=? WHERE id=? AND status IN ('Pending','Preparing','Running','Paused','WaitingApproval','WaitingInput')`)
      .run(new Date().toISOString(), taskId);
    if (r.changes === 0) throw new Error('task not cancellable');
    return { taskId, status: 'Cancelled' };
  }

  pauseTask(taskId: string) {
    const t = this.getTaskRow(taskId);
    if (!['Preparing', 'Running'].includes(t.status)) {
      throw new ConflictException(`仅执行中的任务可暂停，当前状态：${t.status}`);
    }
    this.ds.db.prepare(`UPDATE tasks SET status='Paused' WHERE id=?`).run(taskId);
    this.broadcastTask(taskId, 'Paused');
    return { taskId, status: 'Paused' };
  }

  resumeTask(taskId: string) {
    const t = this.getTaskRow(taskId);
    if (t.status !== 'Paused') {
      throw new ConflictException(`仅已暂停的任务可恢复，当前状态：${t.status}`);
    }
    this.ds.db.prepare(`UPDATE tasks SET status='Running' WHERE id=?`).run(taskId);
    this.broadcastTask(taskId, 'Running');
    return { taskId, status: 'Running' };
  }

  respondInput(taskId: string, answer: string, run = true) {
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

  /** 外部主体（MCP 客户端等）触发执行：走审批双门 */
  runExternal(taskId: string): { started?: boolean; taskId?: string; pendingApproval?: boolean; approvalId?: string; reason?: string } {
    const task = this.ds.db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskId) as { id: string; status: string } | undefined;
    if (!task) throw new NotFoundException(`任务不存在：${taskId}`);
    const check = this.perms.check({ subjectType: 'external', subjectId: 'mcp-client', category: 'task.run' });
    if (!check.allowed) {
      this.audit.record({ subject: 'external:mcp-client', action: 'task.run-external', target: taskId, result: 'denied', detail: { approvalId: check.approvalId } });
      return { pendingApproval: true, approvalId: check.approvalId, reason: check.reason };
    }
    void this.runTask(taskId).catch(() => {});
    this.audit.record({ subject: 'external:mcp-client', action: 'task.run-external', target: taskId, result: 'ok' });
    return { started: true, taskId };
  }

  // ============ Supervisor：LLM 工具循环 ============

  /** 项目上下文（按需裁剪，不塞全库） */
  private buildProjectContext(projectId?: string): string {
    if (!projectId) return '（无项目上下文：任务不绑定具体项目）';
    const p = this.ds.db.prepare('SELECT id,name,root_path,language,framework,project_type,description FROM projects WHERE id = ?').get(projectId) as Record<string, string | null> | undefined;
    if (!p) return '（projectId 无效）';
    const services = this.ds.db.prepare('SELECT id,name,service_type,port,status,start_command FROM project_services WHERE project_id = ?').all(projectId) as Array<Record<string, unknown>>;
    let profileSummary = '';
    const profRow = this.ds.db.prepare('SELECT components_json FROM projects WHERE id = ?').get(projectId) as { components_json: string | null } | undefined;
    if (profRow?.components_json) {
      try {
        const prof = JSON.parse(profRow.components_json) as {
          fingerprint: string;
          components: Array<{ id: string; name: string; kind: string; language: string | null; framework: string | null; packageManager: string | null; runtime: { languageVersion: string | null; devStartCommand: string | null; port: number | null; externalServices: Array<{ type: string; port: number | null }> } | null }>;
        };
        profileSummary = `\n组件树：${prof.components.map((c) => `${c.name}(${c.kind},${c.language ?? '?'},${c.framework ?? ''},版本要求 ${c.runtime?.languageVersion ?? '未声明'},启动 ${c.runtime?.devStartCommand ?? '未知'})`).join('; ')}`;
      } catch { /* ignore */ }
    }
    return [
      `项目：name=${p.name} root=${p.root_path}`,
      `已识别：language=${p.language ?? '?'} framework=${p.framework ?? '?'} type=${p.project_type ?? '?'}`,
      profileSummary,
      `服务：${services.map((s) => `${s.name}(${s.service_type},端口${s.port ?? '-'},状态${s.status},id=${s.id})`).join('; ') || '无'}`,
    ].filter(Boolean).join('\n');
  }

  private savePlanVersion(taskId: string, version: number, plan: { steps: Array<{ title: string }> } | { goal: string; subtasks: SubTask[] }, reason?: string) {
    const steps = 'subtasks' in plan ? plan.subtasks.map((s) => ({ title: s.title })) : plan.steps;
    this.ds.db.prepare(
      `INSERT INTO task_plan_versions (id, task_id, version, plan_json, change_reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), taskId, version, JSON.stringify({ steps }), reason ?? null, new Date().toISOString());
    this.ds.db.prepare('UPDATE tasks SET plan_version=? WHERE id=?').run(version, taskId);
  }

  /** Supervisor 主流程：上下文构建 → 工具循环（重规划） → 验证 → 汇总 */
  async runTask(taskId: string): Promise<{ status: string; summary?: string; results?: unknown; blocked?: unknown; question?: string }> {
    const task = this.ds.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
      | { id: string; project_scope: string | null; input_summary: string; status: string }
      | undefined;
    if (!task) throw new Error('task not found');
    if (!this.model.hasKey() && !(await this.model.loadKeyFromStore())) {
      this.ds.db.prepare(`UPDATE tasks SET status='Failed', finished_at=? WHERE id=?`).run(new Date().toISOString(), taskId);
      throw new Error('model api key not configured');
    }
    this.ds.db.prepare(`UPDATE tasks SET status='Preparing', started_at=? WHERE id=?`).run(new Date().toISOString(), taskId);
    this.broadcastTask(taskId, 'Preparing');

    // 执行记录（tool_calls FK）
    const execId = randomUUID();
    this.ds.db.prepare(
      `INSERT INTO agent_executions (id, task_id, agent_id, started_at, status, trace_id) VALUES (?, ?, 'supervisor', ?, 'Running', ?)`,
    ).run(execId, taskId, new Date().toISOString(), randomUUID());

    const ctx: ToolCallCtx = { projectId: task.project_scope ?? undefined, taskId, executionId: execId, agentId: 'supervisor' };

    // 初始计划版本 v1
    this.savePlanVersion(taskId, 1, { steps: [{ title: `目标：${task.input_summary}` }] }, '初始计划');

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: SYSTEM_PROMPT.replace('{{TOOLS}}', this.registry.describeForPrompt()) },
      { role: 'user', content: `任务目标：${task.input_summary}\n\n项目上下文：\n${this.buildProjectContext(task.project_scope ?? undefined)}` },
    ];

    const budget = { ...AGENT_BUDGET_DEFAULT };
    const startedAt = Date.now();
    let toolCalls = 0;
    let planIterations = 1;
    let planVersion = 1;
    const toolResults: Array<{ tool: string; note?: string; ok: boolean; error?: string; exitCode?: number | null }> = [];
    const insSub = this.ds.db.prepare(
      `INSERT INTO subtasks (id, task_id, assigned_agent, input_json, status, output_ref) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const updSub = this.ds.db.prepare(`UPDATE subtasks SET status=?, output_ref=? WHERE id=?`);

    const finish = async (status: string, summary: string, validation: ValidationStatus) => {
      const resultSummary = `${summary} [validation=${validation} toolCalls=${toolCalls} planVersions=${planVersion}]`.slice(0, 500);
      const finalStatus = status === 'success' ? 'Completed' : status === 'blocked' ? 'WaitingApproval' : 'Failed';
      this.ds.db.prepare(`UPDATE tasks SET status=?, result_summary=?, finished_at=? WHERE id=?`)
        .run(finalStatus, resultSummary, new Date().toISOString(), taskId);
      this.broadcastTask(taskId, finalStatus);
      this.notify.create({
        type: status === 'success' ? 'task.completed' : 'task.failed',
        title: `${status === 'success' ? '任务完成' : '任务未完成'}：${task.input_summary.slice(0, 40)}`,
        content: resultSummary, priority: status === 'success' ? 5 : 2,
      });
      this.audit.record({ subject: 'agent:supervisor', action: 'task.run', target: taskId, result: status === 'success' ? 'ok' : 'error', detail: { summary: resultSummary } });
      // 经验沉淀（记忆层，供后续任务检索）
      this.ds.db.prepare(
        `INSERT INTO memories (id, scope, project_id, task_id, agent_id, content_ref, source, confidence, version, access_policy, created_at)
         VALUES (?, 'task', ?, ?, 'supervisor', ?, 'supervisor', 0.7, 1, 'local', ?)`,
      ).run(randomUUID(), task.project_scope ?? null, taskId, `任务[${taskId.slice(0, 8)}] goal=${task.input_summary.slice(0, 120)}; 结果=${resultSummary}; 工具链=${toolResults.map((r) => `${r.tool}${r.ok ? '' : '(失败)'}`).join('>')}`, new Date().toISOString());
      return { status: finalStatus, summary: resultSummary, results: toolResults };
    };

    this.ds.db.prepare(`UPDATE tasks SET status='Running' WHERE id=?`).run(taskId);
    this.broadcastTask(taskId, 'Running');

    try {
      while (toolCalls < budget.maxToolCalls && Date.now() - startedAt < budget.maxDurationMs) {
        // 暂停/取消等待点
        const gate = await this.waitWhilePaused(taskId);
        if (gate.cancelled) {
          return await finish('failed', '任务被用户取消', 'BLOCKED');
        }

        // LLM 决策（单步）
        let turn: LoopTurn;
        try {
          const raw = await this.model.chat(messages, { json: true });
          turn = this.parseTurn(raw);
        } catch (err) {
          // 模型输出无法解析 → 最多重试一次，仍失败则转人工
          if (planIterations - 1 >= budget.maxPlanIterations) {
            return await finish('failed', `模型输出无法解析：${String(err).slice(0, 150)}`, 'FAILED');
          }
          planIterations++;
          messages.push({ role: 'user', content: '你的上一条输出不是合法 JSON。请严格输出一个 JSON 对象：{"action":"tool",...} 或 {"action":"finish",...}。' });
          continue;
        }

        if (turn.action === 'finish') {
          // 真实验证收尾：若声称 success 且项目有端口服务，抽验端口连通
          let validation: ValidationStatus = turn.status === 'success' ? 'PASSED' : 'FAILED';
          if (turn.status === 'success' && ctx.projectId) {
            const ports = this.ds.db.prepare('SELECT port,status FROM project_services WHERE project_id=? AND port IS NOT NULL').all(ctx.projectId) as Array<{ port: number; status: string }>;
            const runningPorts = ports.filter((s) => s.status === 'Running');
            if (runningPorts.length) {
              const results = await Promise.all(runningPorts.map((s) => this.tcpCheck(s.port)));
              validation = results.every(Boolean) ? 'PASSED' : 'FAILED';
              if (validation === 'FAILED') {
                turn.summary += '（校验失败：存在 Running 状态服务但其端口未监听）';
                turn.status = 'failed';
              }
            }
          }
          return await finish(turn.status === 'success' ? 'success' : turn.status === 'blocked' ? 'blocked' : 'failed', turn.summary ?? '（无总结）', validation);
        }

        if (turn.action === 'plan') {
          if (planIterations >= budget.maxPlanIterations) {
            messages.push({ role: 'user', content: `计划迭代已达上限 ${budget.maxPlanIterations}，请直接执行或 finish。` });
            continue;
          }
          planIterations++;
          planVersion++;
          this.savePlanVersion(taskId, planVersion, { steps: turn.steps ?? [] }, turn.reason);
          messages.push({ role: 'user', content: `计划已更新到 v${planVersion}。继续执行下一步。` });
          continue;
        }

        if (turn.action === 'invalid' || !turn.tool) {
          messages.push({ role: 'user', content: '无效指令。请输出 {"action":"tool","tool":"工具名","params":{...},"note":"..."} 或 {"action":"finish","status":"...","summary":"..."}。' });
          continue;
        }

        // 执行工具
        toolCalls++;
        const sid = randomUUID();
        insSub.run(sid, taskId, 'supervisor', JSON.stringify({ tool: turn.tool, params: turn.params ?? {}, note: turn.note }), 'Running', null);
        this.broadcastTask(taskId, 'Running');

        const result = await this.registry.execute(turn.tool, turn.params ?? {}, ctx);
        toolResults.push({ tool: turn.tool, note: turn.note, ok: result.ok, error: result.error, exitCode: result.exitCode });

        updSub.run(result.ok ? 'Completed' : 'Failed', JSON.stringify({ ok: result.ok, error: result.error, exitCode: result.exitCode }).slice(0, 1000), sid);
        // checkpoint
        this.ds.db.prepare(
          `INSERT INTO checkpoints (id, task_id, plan_version, state_snapshot, completed_subtasks_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), taskId, planVersion, JSON.stringify({ last: turn.tool, ok: result.ok }), JSON.stringify(toolResults.map((r) => r.tool)), new Date().toISOString());

        // 审批等待：副作用工具越权 → 任务挂起等审批
        if (!result.ok && result.error && /审批|approval|pending/i.test(result.error)) {
          this.ds.db.prepare(`UPDATE tasks SET status='WaitingApproval' WHERE id=?`).run(taskId);
          this.broadcastTask(taskId, 'WaitingApproval');
          this.notify.create({ type: 'approval.pending', title: `任务等待审批：${task.input_summary.slice(0, 40)}`, content: `工具 ${turn.tool} 需要授权（${turn.note ?? ''}），前往审批中心处理`, priority: 3 });
          return { status: 'WaitingApproval', blocked: { toolResults } };
        }

        // 工具失败 → 重规划机会（把错误喂回去；连续失败计数在 LLM 决策里体现）
        const feedback = result.ok
          ? JSON.stringify({ ok: true, tool: turn.tool, data: result.data, exitCode: result.exitCode }).slice(0, 6000)
          : JSON.stringify({ ok: false, tool: turn.tool, error: result.error, exitCode: result.exitCode, hint: '工具执行失败。分析原因：若可重试请换参数重试（同一工具连续失败 2 次后请换方案）；若需诊断先 runtime.logs + diagnostics.classify。' }).slice(0, 6000);
        messages.push({ role: 'assistant', content: JSON.stringify({ action: 'tool', tool: turn.tool, params: turn.params ?? {}, note: turn.note ?? '' }) });
        messages.push({ role: 'user', content: `工具执行结果：\n${feedback}\n\n（已用 ${toolCalls}/${budget.maxToolCalls} 次工具调用，剩余时间 ${Math.round((budget.maxDurationMs - (Date.now() - startedAt)) / 1000)}s）` });
      }

      if (toolCalls >= budget.maxToolCalls) {
        return await finish('failed', `达到工具调用预算上限（${budget.maxToolCalls} 次）。已完成步骤：${toolResults.map((r) => r.tool).join('>')}`, 'PARTIAL');
      }
      return await finish('failed', `达到执行时长上限。已完成步骤：${toolResults.map((r) => r.tool).join('>')}`, 'PARTIAL');
    } catch (err) {
      return await finish('failed', `执行异常：${String(err).slice(0, 200)}`, 'FAILED');
    }
  }

  private parseTurn(raw: string): LoopTurn {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // 容忍 markdown 包裹
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return { action: 'invalid' };
      try { obj = JSON.parse(m[0]) as Record<string, unknown>; } catch { return { action: 'invalid' }; }
    }
    const action = obj['action'];
    if (action === 'finish') {
      const status = obj['status'];
      return { action: 'finish', status: status === 'success' ? 'success' : status === 'blocked' ? 'blocked' : 'failed', summary: String(obj['summary'] ?? '') };
    }
    if (action === 'plan') {
      const steps = Array.isArray(obj['steps']) ? (obj['steps'] as Array<Record<string, unknown>>).map((s) => ({ title: String(s['title'] ?? '') })) : [];
      return { action: 'plan', steps, reason: obj['reason'] ? String(obj['reason']) : undefined };
    }
    if (action === 'tool' && typeof obj['tool'] === 'string') {
      return { action: 'tool', tool: obj['tool'], params: (obj['params'] as Record<string, unknown>) ?? {}, note: obj['note'] ? String(obj['note']) : undefined };
    }
    return { action: 'invalid' };
  }

  private tcpCheck(port: number, timeoutMs = 3000): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port, timeout: timeoutMs });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
      sock.once('error', () => resolve(false));
    });
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
