import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../database/database.module';
import { LogService } from '../logs/log.service';
import { judgeFix } from './fix-guard';
import { NotificationService } from '../notifications/notification.service';
import { RuntimeService } from './runtime.service';
import { AutoFixerService, type FixOutcome } from './auto-fixer.service';
import { detectLaunchScript } from '../projects/launch-script';

/**
 * 一键自动启动（导入后闭环）：
 *  1. 项目根目录若自带一键启动脚本（start.bat / 运行.ps1 / dev.sh / package.json scripts…）→ 直接采用脚本里的启动命令；
 *  2. 没有脚本 → 交给 Agent 分析应当如何启动（给出 startCommand + 准备命令）；
 *  3. 启动失败 → 抓日志 → Agent 自动修复（装依赖 / 换解释器 / 改启动命令）→ 重试；
 *  4. 成功 → 状态 Running + 通知「项目已成功启动」；失败 → 明确写出三次尝试都做了什么。
 */

export type AutoStartPhase = 'detect' | 'start' | 'verify' | 'repair' | 'retry' | 'done' | 'failed';

export interface AutoStartStep {
  at: string;
  phase: AutoStartPhase;
  message: string;
  detail?: string;
}

export interface AutoStartJob {
  id: string;
  projectId: string;
  projectName: string;
  status: 'Running' | 'Success' | 'Failed' | 'Cancelled';
  startedAt: string;
  finishedAt?: string;
  attempt: number;
  maxAttempts: number;
  command?: string | null;
  port?: number | null;
  pid?: number;
  report?: string;
  steps: AutoStartStep[];
  /** 用户手动取消：启动循环在各检查点检测并尽快收尾 */
  cancelRequested?: boolean;
  /** 本 job 已成功启动的服务：取消时逐个停止，避免留下半启动状态 */
  startedServiceIds: string[];
}

@Injectable()
export class AutoStartService {
  private jobs = new Map<string, AutoStartJob>();
  private byProject = new Map<string, string>();

  /** 热启动缓存：记录最近一次「同一命令 + 端口」通过健康校验的服务，下次启动改用轻量校验提速 */
  private warmStarts = new Map<string, { command: string; port: number | null; at: number }>();
  private static readonly WARM_TTL_MS = 24 * 60 * 60 * 1000;

  private isWarmStart(serviceId: string, command: string, port: number | null): boolean {
    const w = this.warmStarts.get(serviceId);
    return !!w && w.command === command && w.port === port && Date.now() - w.at < AutoStartService.WARM_TTL_MS;
  }

  private recordWarmStart(serviceId: string, command: string, port: number | null): void {
    this.warmStarts.set(serviceId, { command, port, at: Date.now() });
  }

  private invalidateWarmStart(serviceId: string): void {
    this.warmStarts.delete(serviceId);
  }
  /** 每个 job 的取消信号：cancel() 触发 abort，中断 LLM 修复/端口等待/探测等长操作（取消 5 秒硬指标） */
  private jobAbort = new Map<string, AbortController>();

  constructor(
    private readonly ds: DatabaseService,
    private readonly runtime: RuntimeService,
    private readonly fixer: AutoFixerService,
    private readonly logs: LogService,
    private readonly notify: NotificationService,
  ) {}

  get(jobId: string): AutoStartJob | undefined {
    return this.jobs.get(jobId);
  }

  /** 用户手动取消启动：停掉已成功启动的服务，循环在检查点尽快收尾（Cancelled）。
  /** 用户手动取消启动（5 秒硬指标）：立即置终态并广播 + abort 中断当前长操作
   *  （LLM 修复 / 端口等待 / 探测），并停止已拉起的服务。循环检测到取消后只做兜底清理。 */
  cancel(jobId: string): { ok: boolean; message: string } {
    const job = this.jobs.get(jobId);
    if (!job) return { ok: false, message: '启动任务不存在或已过期' };
    if (job.status !== 'Running') return { ok: false, message: `任务已结束（${job.status}），无需取消` };
    job.cancelRequested = true;
    job.status = 'Cancelled';
    job.finishedAt = new Date().toISOString();
    job.report = '用户手动取消启动';
    this.step(job, 'failed', '启动已被用户手动取消，正在停止已启动的服务…');
    this.notify.create({
      type: 'project.autostart.cancelled',
      title: `项目 ${job.projectName} 启动已取消`,
      content: '已停止启动流程并清理已启动的服务；可随时重新点「启动」',
      priority: 3,
      projectId: job.projectId,
    });
    // 中断当前长操作：所有长 await 都监听该信号，LLM 修复/端口等待/探测立即中断
    this.jobAbort.get(jobId)?.abort();
    this.jobAbort.delete(jobId);
    // 立即并行停止：已登记成功的服务 + tracked 中属于本项目但尚未登记的服务（启动竞态窗口），
    // 不阻塞 cancel 响应（用户点击后接口即刻返回，进程在后台被终止）
    const targets = new Set<string>(job.startedServiceIds);
    try {
      for (const sid of this.runtime.trackedServiceIdsOfProject(job.projectId)) targets.add(sid);
    } catch { /* 追踪表读取失败不影响取消 */ }
    const list = [...targets];
    void Promise.allSettled(list.map((sid) => this.runtime.stopService(sid, true))).then((settled) => {
      const stopped = settled.filter((r) => r.status === 'fulfilled').length;
      this.step(job, 'failed', `已停止 ${stopped}/${list.length} 个服务`);
    });
    // 保留终态 60s 供前端轮询读到 Cancelled（旧实现立即 delete，前端轮询拿到 404
    // 后会一直停在「进行中」，体感是「点了停止没反应」），随后回收
    const reaper = setTimeout(() => {
      if (this.jobs.get(jobId) === job) this.jobs.delete(jobId);
    }, 60_000);
    reaper.unref?.();
    return { ok: true, message: list.length ? `已取消启动，正在停止 ${list.length} 个服务` : '已取消启动' };
  }

  latest(projectId: string): AutoStartJob | undefined {
    const id = this.byProject.get(projectId);
    return id ? this.jobs.get(id) : undefined;
  }

  /** 异步开跑：立刻返回 jobId，前端轮询 /autostart/:jobId 显示进度 */
  start(projectId: string): { jobId: string } {
    const project = this.ds.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | { id: string; name: string; root_path: string; language: string | null; project_type: string }
      | undefined;
    if (!project) throw new Error('项目不存在');
    if (!fs.existsSync(project.root_path)) throw new Error(`项目目录不存在：${project.root_path}`);

    const running = this.byProject.get(projectId);
    const prev = running ? this.jobs.get(running) : undefined;
    if (prev?.status === 'Running') return { jobId: prev.id };

    const job: AutoStartJob = {
      id: randomUUID(),
      projectId,
      projectName: project.name,
      status: 'Running',
      startedAt: new Date().toISOString(),
      attempt: 0,
      // Python 类项目常见「每轮只缺一个包」的依赖链，3 轮不够装完，放宽到 6
      maxAttempts: 6,
      steps: [],
      startedServiceIds: [],
    };
    this.jobs.set(job.id, job);
    this.byProject.set(projectId, job.id);
    this.jobAbort.set(job.id, new AbortController());
    void this.run(job, project).catch((e) => {
      // 用户已取消：终态 Cancelled 已广播，异常兜底不覆盖（多为 abort 导致的 LL 中断）
      if (job.cancelRequested) return;
      job.status = 'Failed';
      job.finishedAt = new Date().toISOString();
      job.report = `自动启动异常：${String(e).slice(0, 300)}`;
      this.step(job, 'failed', job.report);
      this.notify.create({ type: 'project.autostart.failed', title: `项目 ${job.projectName} 自动启动失败`, content: job.report, priority: 2 });
    });
    return { jobId: job.id };
  }

  private step(job: AutoStartJob, phase: AutoStartPhase, message: string, detail?: string) {
    job.steps.push({ at: new Date().toISOString(), phase, message, detail });
    this.logs.log({ level: phase === 'failed' ? 'error' : 'info', sourceModule: 'autostart', projectId: job.projectId, message });
  }

  private async run(job: AutoStartJob, project: { id: string; name: string; root_path: string; language: string | null; project_type: string }): Promise<void> {
    const root = project.root_path;
    const isBinary = project.project_type === 'binary' || project.language === 'binary-distribution';
    const services = this.allServices(project.id);
    if (!services.length) {
      // 只含 README / 静态文件的仓库解析不出服务：建一个占位服务，让 Agent 决定怎么跑
      const sid = randomUUID();
      const now = new Date().toISOString();
      this.ds.db
        .prepare(
          `INSERT INTO project_services (id, project_id, name, service_type, workdir, start_command, port, shared, status, created_at, updated_at)
           VALUES (?, ?, ?, 'app', ?, NULL, NULL, 0, 'Stopped', ?, ?)`,
        )
        .run(sid, project.id, project.name, root, now, now);
      this.step(job, 'detect', '项目里没有识别到服务，已创建占位服务，交由 Agent 分析启动方式');
    }

    const list = this.allServices(project.id);
    if (!list.length) throw new Error('创建服务配置失败');

    // 依赖预检（确定性，不依赖模型）：node 项目 node_modules 缺失时先安装依赖，
    // 避免「代码没问题却因为没装依赖起不来」这种最常见的一键启动失败。
    if (!isBinary) {
      try {
        const installed = await this.fixer.ensureNodeDeps({ projectId: project.id, rootPath: root, projectName: project.name });
        if (installed) this.step(job, 'detect', '检测到 node 项目的 node_modules 缺失，已自动安装依赖');
      } catch (e) {
        this.step(job, 'detect', `依赖预检失败（不阻断启动，失败会进入自动修复）：${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
      // Python 项目依赖预检：没有虚拟环境就建 .venv 并安装依赖（确定性，不依赖模型）
      const isPython = project.language === 'python' || fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt'));
      if (isPython) {
        try {
          const installed = await this.fixer.ensurePythonDeps({ projectId: project.id, rootPath: root, projectName: project.name });
          if (installed) this.step(job, 'detect', '检测到 python 项目缺少虚拟环境，已创建 .venv 并安装依赖');
        } catch (e) {
          this.step(job, 'detect', `python 依赖预检失败（不阻断启动，失败会进入自动修复）：${String((e as Error)?.message ?? e).slice(0, 200)}`);
        }
      }
    }

    // 多服务项目（前后端分层等）：按依赖顺序逐个启动，不套用单一启动脚本——
    // 根目录脚本通常只覆盖一个服务，按服务各自的启动命令更精确。
    if (list.length > 1) {
      await this.runMulti(job, project, list, isBinary);
      return;
    }
    await this.runSingle(job, project, list[0], isBinary);
  }

  /** 多服务：基础设施(database/cache/mq) → backend → app → frontend 顺序，逐个启动+修复 */
  private async runMulti(
    job: AutoStartJob,
    project: { id: string; name: string; root_path: string; language: string | null },
    services: Array<{ id: string; name: string; service_type: string; start_command: string | null; port: number | null; workdir: string }>,
    isBinary: boolean,
  ): Promise<void> {
    this.step(job, 'detect', `识别到 ${services.length} 个服务：${services.map((s) => `${s.name}(${s.service_type})`).join('、')}，按依赖顺序启动`);

    const results: string[] = [];
    let allOk = true;

    // 启动编排（二次启动提速关键）：
    // - 基础设施（database/cache/mq）串行完整启动（其余服务依赖它们，必须先就绪）；
    // - 其余服务按依赖顺序快速 spawn——只保证拉起顺序，不互相等待端口/校验，
    //   验证并行进行，墙钟时间从「各服务耗时之和」变为「最慢的那个」；
    // - 热启动（同一命令此前健康校验通过）用轻量校验（单次 HTTP 探测），
    //   跳过 4s 观察窗口与逐模块探测；轻量校验不过自动回落全量校验；
    // - 任何失败服务随后逐个进入原有「启动 → 修复 → 重试」闭环。
    const INFR_TYPES = new Set(['database', 'cache', 'mq']);
    const infraList = services.filter((s) => INFR_TYPES.has(s.service_type));
    const restList = services.filter((s) => !INFR_TYPES.has(s.service_type));

    for (const svc of infraList) {
      if (job.cancelRequested) break;
      const out = await this.startOneServiceWithRepair(job, project, svc, isBinary);
      results.push(out.ok
        ? `✓ ${svc.name}：${out.cmd}${out.port ? `（端口 ${out.port}）` : ''}`
        : `✗ ${svc.name}：启动失败（详见上方日志）`);
      if (!out.ok) allOk = false;
    }

    type SpawnTask = {
      svc: typeof restList[number];
      port: number | null;
      attemptStartedAt: string;
      cmd: string;
      promise: Promise<{ r: Awaited<ReturnType<RuntimeService['startService']>> | null; err: string | null }>;
    };
    const spawns: SpawnTask[] = [];
    for (const svc of restList) {
      // 取消检查点：用户手动中止 → 停止拉起后续服务，尽快收尾
      if (job.cancelRequested) break;
      const cur = this.getService(svc.id);
      if (!cur?.start_command) {
        // 无启动命令（通常是首次启动）：走完整链路（含 Agent 分析），串行处理
        const out = await this.startOneServiceWithRepair(job, project, svc, isBinary);
        results.push(out.ok
          ? `✓ ${svc.name}：${out.cmd}${out.port ? `（端口 ${out.port}）` : ''}`
          : `✗ ${svc.name}：启动失败（详见上方日志）`);
        if (!out.ok) allOk = false;
        continue;
      }
      const refined = this.refineStartCommand(project.root_path, cur.start_command);
      if (refined.changed) {
        this.applyServiceConfig(svc.id, { start_command: refined.command });
        this.step(job, 'detect', `[${svc.name}] ${refined.note}`, refined.command);
      }
      const cmd = refined.command;
      this.step(job, 'start', `启动 ${svc.name}（${cur.service_type}）：${cmd}`);
      const attemptStartedAt = new Date().toISOString();
      try {
        await this.runtime.stopService(svc.id, true);
      } catch { /* 没在跑就忽略 */ }
      spawns.push({
        svc,
        port: this.getService(svc.id)?.port ?? cur.port,
        attemptStartedAt,
        cmd,
        promise: this.runtime.startService(svc.id).then(
          (r) => ({ r, err: null as string | null }),
          (e) => ({ r: null, err: String((e as Error)?.message ?? e) }),
        ),
      });
      // spawn 间隔 120ms：保持拉起顺序（先 backend 后 frontend），又不等待前一个就绪
      await new Promise((r) => setTimeout(r, 120));
    }

    // 并行收 spawn 结果并做健康校验；失败服务收集后进入修复闭环
    const failed: typeof restList = [];
    await Promise.all(spawns.map(async (sp) => {
      let { r, err: startError } = await sp.promise;
      // 端口占用自愈：确定性终止占用进程并立即重试一次（不消耗修复次数，不进 LLM）
      if (startError && await this.tryKillPortOccupier(startError, job, sp.svc.name)) {
        try { r = await this.runtime.startService(sp.svc.id); startError = null; } catch (e) { r = null; startError = String((e as Error)?.message ?? e); }
      }
      if (r?.status === 'Stopped' && !sp.port) {
        // CLI 工具型服务：一次性命令 exit 0 = 启动校验通过（依赖齐、入口可用）。
        let terminalNote = '';
        try {
          await this.runtime.openTerminal(sp.svc.id);
          terminalNote = '，已自动打开命令行窗口';
        } catch (e) {
          terminalNote = `，命令行窗口打开失败（${String((e as Error)?.message ?? e).slice(0, 80)}），可在详情里点「打开终端」重试`;
        }
        job.startedServiceIds.push(sp.svc.id);
        results.push(`✓ ${sp.svc.name}：CLI 启动校验通过（${sp.cmd}，exit 0）${terminalNote}`);
        this.step(job, 'done', `${sp.svc.name} CLI 启动校验通过${terminalNote}，直接在弹出的窗口里使用本项目`);
        return;
      }
      if (r?.status === 'Running') {
        const light = this.isWarmStart(sp.svc.id, sp.cmd, sp.port);
        const verify = await this.verifyRunning(sp.svc.name, sp.port, sp.attemptStartedAt, light);
        if (verify.ok) {
          job.startedServiceIds.push(sp.svc.id);
          results.push(`✓ ${sp.svc.name}：${sp.cmd}${sp.port ? `（端口 ${sp.port}）` : ''}${r.adopted ? '，接管已有实例' : ''}`);
          this.step(job, 'done', `${sp.svc.name} 启动成功${sp.port ? `，端口 ${sp.port}` : ''}${light ? '（热启动快速校验通过）' : '（健康校验通过）'}`);
          this.recordWarmStart(sp.svc.id, sp.cmd, sp.port);
          return;
        }
        this.invalidateWarmStart(sp.svc.id);
        this.step(job, 'verify', `${sp.svc.name} 端口已监听，但健康校验未通过（服务实际不可用），判定为本次启动失败`, verify.detail.slice(0, 800));
        failed.push(sp.svc);
        return;
      }
      this.invalidateWarmStart(sp.svc.id);
      this.step(job, 'repair', `${sp.svc.name} 启动失败（${startError ? `异常：${startError}` : r?.status ?? '未知状态'}），交给 Agent 修复`);
      failed.push(sp.svc);
    }));

    // 失败的服务逐个进入「启动 → 修复 → 重试」闭环（热启动通常为空）
    for (const svc of failed) {
      if (job.cancelRequested) break;
      const out = await this.startOneServiceWithRepair(job, project, svc, isBinary);
      results.push(out.ok
        ? `✓ ${svc.name}：修复后启动成功：${out.cmd}${out.port ? `（端口 ${out.port}）` : ''}`
        : `✗ ${svc.name}：启动失败（详见上方日志）`);
      if (!out.ok) allOk = false;
    }

    // 取消语义优先：无论循环走到哪一步，用户取消即终态 Cancelled
    if (job.cancelRequested) {
      // cancel() 已经置过终态并弹过通知（finishedAt 有值）→ 这里只补流程明细，不重复通知用户
      const alreadyFinal = !!job.finishedAt;
      job.status = 'Cancelled';
      job.finishedAt = job.finishedAt ?? new Date().toISOString();
      // 兜底统一停止：cancel() 与启动完成存在竞态窗口（cancel 快照后又有服务启动成功），
      // 这里对全部已启动服务再停一遍（stopService 幂等，并行以免逐个等待拖慢收尾）
      const settled = await Promise.allSettled(job.startedServiceIds.map((sid) => this.runtime.stopService(sid, true)));
      const stopped = settled.filter((r) => r.status === 'fulfilled').length;
      results.push(`✗ 用户手动取消启动（已停止 ${stopped} 个服务）`);
      job.report = results.join('\n');
      this.step(job, 'failed', '启动已被用户手动取消');
      if (!alreadyFinal) {
        this.notify.create({ type: 'project.autostart.cancelled', title: `项目 ${project.name} 启动已取消`, content: `已停止 ${stopped} 个服务；可随时重新点「启动」`, priority: 3 });
      }
      return;
    }
    job.status = allOk ? 'Success' : 'Failed';
    job.finishedAt = new Date().toISOString();
    // 用户入口默认取最后一个前端服务的端口（没有前端则取第一个有端口的服务）
    const front = [...services].reverse().find((s) => s.service_type === 'frontend' && s.port);
    const anyPort = services.find((s) => s.port);
    job.port = (front ?? anyPort)?.port ?? null;
    job.report = results.join('\n');
    this.step(job, allOk ? 'done' : 'failed', allOk ? `全部 ${services.length} 个服务已启动` : '部分服务启动失败', job.report);
    this.notify.create({
      type: allOk ? 'project.autostart.ok' : 'project.autostart.failed',
      title: allOk ? `项目 ${project.name} 已启动（${services.length} 个服务）` : `项目 ${project.name} 部分服务启动失败`,
      content: job.report.slice(0, 800),
      priority: allOk ? 4 : 2,
      projectId: project.id,
    });
  }

  /** 单个服务完整启动链路：无命令先让 Agent 分析 → 启动 → 失败修复 → 重试。并行编排与基础设施串行共用 */
  private async startOneServiceWithRepair(
    job: AutoStartJob,
    project: { id: string; name: string; root_path: string; language: string | null },
    svc: { id: string; name: string; service_type: string; start_command: string | null; port: number | null; workdir: string },
    isBinary: boolean,
  ): Promise<{ ok: boolean; cmd: string; port: number | null }> {
    // 1) 无启动命令的服务先让 Agent 分析
    let fresh = this.getService(svc.id);
    if (!fresh?.start_command) {
      this.step(job, 'detect', `服务 ${svc.name} 没有启动命令，交由 Agent 分析启动方式`);
      const analysis = await this.fixer.fix({
        projectId: project.id,
        rootPath: project.root_path,
        projectName: project.name,
        language: project.language ?? 'unknown',
        isBinary,
        startCommand: null,
        port: fresh?.port ?? null,
        logText: '（尚未启动：没有可用的启动命令）',
        attempt: 0,
        mode: 'analyze-start',
      });
      this.applyFixOutcome(job, svc.id, analysis);
      fresh = this.getService(svc.id);
      if (!fresh?.start_command) {
        this.step(job, 'failed', `${svc.name}：无法确定启动方式`);
        return { ok: false, cmd: '', port: fresh?.port ?? null };
      }
    }

    // 2) 启动 → 失败修复 → 重试
    let lastCmd = '';
    for (let attempt = 1; attempt <= job.maxAttempts; attempt++) {
      if (job.cancelRequested) break;
      job.attempt = attempt;
      const cur = this.getService(svc.id)!;
      const refined = this.refineStartCommand(project.root_path, cur.start_command);
      if (refined.changed) {
        this.applyServiceConfig(svc.id, { start_command: refined.command });
        this.step(job, 'detect', `[${svc.name}] ${refined.note}`, refined.command);
      }
      const cmd = refined.command;
      lastCmd = cmd;
      this.step(job, attempt === 1 ? 'start' : 'retry', `启动 ${svc.name}（${cur.service_type}）：${cmd}`);
      const attemptStartedAt = new Date().toISOString();
      try {
        await this.runtime.stopService(svc.id, true);
      } catch { /* 没在跑就忽略 */ }

      let r: Awaited<ReturnType<RuntimeService['startService']>> | null = null;
      let startError: string | null = null;
      let verifyFailed = false;
      try {
        r = await this.runtime.startService(svc.id);
      } catch (e) {
        startError = String((e as Error)?.message ?? e);
      }
      // 端口占用自愈：确定性终止占用进程并立即重试一次（不消耗修复次数，不进 LLM）
      if (startError && await this.tryKillPortOccupier(startError, job, svc.name)) {
        try { r = await this.runtime.startService(svc.id); startError = null; } catch (e) { startError = String((e as Error)?.message ?? e); r = null; }
      }

      if (r?.status === 'Stopped' && !cur.port) {
        // CLI 工具型服务：一次性命令 exit 0 = 启动校验通过（依赖齐、入口可用）。
        let terminalNote = '';
        try {
          await this.runtime.openTerminal(svc.id);
          terminalNote = '，已自动打开命令行窗口';
        } catch (e) {
          terminalNote = `，命令行窗口打开失败（${String((e as Error)?.message ?? e).slice(0, 80)}），可在详情里点「打开终端」重试`;
        }
        job.startedServiceIds.push(svc.id);
        this.step(job, 'done', `${svc.name} CLI 启动校验通过（${cmd}，exit 0）${terminalNote}`);
        return { ok: true, cmd, port: cur.port };
      }

      if (r?.status === 'Running') {
        const light = this.isWarmStart(svc.id, cmd, cur.port);
        const verify = await this.verifyRunning(svc.name, cur.port, attemptStartedAt, light);
        if (verify.ok) {
          job.startedServiceIds.push(svc.id);
          this.step(job, 'done', `${svc.name} 启动成功${cur.port ? `，端口 ${cur.port}` : ''}${light ? '（热启动快速校验通过）' : '（健康校验通过）'}`);
          this.recordWarmStart(svc.id, cmd, cur.port);
          return { ok: true, cmd, port: cur.port };
        }
        this.invalidateWarmStart(svc.id);
        verifyFailed = true;
        const lastLog = verify.detail;
        this.step(job, 'verify', `${svc.name} 端口已监听，但健康校验未通过（服务实际不可用），判定为本次启动失败`, verify.detail.slice(0, 800));
        if (attempt === job.maxAttempts) break;
        const fix = await this.fixer.fix({
          projectId: project.id,
          rootPath: project.root_path,
          projectName: project.name,
          language: project.language ?? 'unknown',
          isBinary,
          startCommand: cmd,
          port: cur.port,
          logText: lastLog,
          attempt,
          mode: 'repair',
        });
        this.applyFixOutcome(job, svc.id, fix);
        if (!fix.changed) {
          this.step(job, 'repair', `Agent 判断 ${svc.name} 无法自动修复：${fix.analysis || '（无说明）'}`);
          break;
        }
        continue;
      }

      const lastLog = startError ?? this.collectLogs(svc.name, r!.status, attemptStartedAt);
      this.step(job, 'repair', `${svc.name} 第 ${attempt} 次启动失败（${startError ? `异常：${startError}` : r!.status}），交给 Agent 修复`, lastLog.slice(0, 600));
      if (attempt === job.maxAttempts) break;
      const obvious = AutoStartService.diagnoseObviousFailure(lastLog, cmd);
      if (obvious) {
        this.step(job, 'repair', `${svc.name}：${obvious}`);
        break;
      }
      const fix = await this.fixer.fix({
        projectId: project.id,
        rootPath: project.root_path,
        projectName: project.name,
        language: project.language ?? 'unknown',
        isBinary,
        startCommand: cmd,
        port: cur.port,
        logText: lastLog,
        attempt,
        mode: 'repair',
      });
      this.applyFixOutcome(job, svc.id, fix);
      if (!fix.changed) {
        this.step(job, 'repair', `Agent 判断 ${svc.name} 无法自动修复：${fix.analysis || '（无说明）'}`);
        break;
      }
    }
    return { ok: false, cmd: lastCmd, port: this.getService(svc.id)?.port ?? null };
  }

  /** 单服务：保持原有「一键脚本优先 → 启动 → 修复 → 重试」闭环 */
  private async runSingle(
    job: AutoStartJob,
    project: { id: string; name: string; root_path: string; language: string | null; project_type: string },
    svc: { id: string; name: string; start_command: string | null; port: number | null; workdir: string },
    isBinary: boolean,
  ): Promise<void> {
    const root = project.root_path;

    // 1) 一键启动脚本优先
    const hit = detectLaunchScript(root);
    if (hit) {
      this.step(job, 'detect', `识别到一键启动脚本 ${hit.relative}（${hit.kind}，置信度 ${hit.confidence}）`, hit.command);
      const refined = this.refineStartCommand(root, hit.command);
      if (refined.changed) this.step(job, 'detect', refined.note, refined.command);
      this.applyServiceConfig(svc.id, {
        start_command: refined.command,
        port: hit.port ?? svc.port,
      });
      job.command = refined.command;
      job.port = hit.port ?? svc.port;
    } else if (!svc.start_command) {
      this.step(job, 'detect', '项目里没有一键启动脚本，也没有启动命令，交由 Agent 分析启动方式');
    } else {
      const refined = this.refineStartCommand(root, svc.start_command);
      if (refined.changed) {
        this.applyServiceConfig(svc.id, { start_command: refined.command });
        this.step(job, 'detect', refined.note, refined.command);
      } else {
        this.step(job, 'detect', `未发现一键启动脚本，使用已确认的启动命令：${svc.start_command}`);
      }
      job.command = refined.command;
      job.port = svc.port;
    }

    // 2) 无启动命令 → 让 Agent 先给出启动方式
    if (!job.command) {
      const analysis = await this.fixer.fix({
        projectId: project.id,
        rootPath: root,
        projectName: project.name,
        language: project.language ?? 'unknown',
        isBinary,
        startCommand: null,
        port: svc.port,
        logText: '（尚未启动：没有可用的启动命令）',
        attempt: 0,
        mode: 'analyze-start',
      });
      this.applyFixOutcome(job, svc.id, analysis);
      const fresh = this.getService(svc.id);
      if (!fresh?.start_command) {
        job.status = 'Failed';
        job.finishedAt = new Date().toISOString();
        job.report = `无法确定启动方式。${analysis.analysis}`;
        this.step(job, 'failed', job.report);
        this.notify.create({ type: 'project.autostart.failed', title: `项目 ${project.name} 未能启动`, content: job.report, priority: 2 });
        return;
      }
      job.command = fresh.start_command;
      job.port = fresh.port;
    }

    // 3) 启动 → 失败 → 修复 → 重试
    for (let attempt = 1; attempt <= job.maxAttempts; attempt++) {
      if (job.cancelRequested) break;
      job.attempt = attempt;
      const cur = this.getService(svc.id);
      if (!cur?.start_command) break;

      this.step(job, attempt === 1 ? 'start' : 'retry', `第 ${attempt} 次启动：${cur.start_command}`);
      const attemptStartedAt = new Date().toISOString();
      // 先清理上一次的残留进程，避免端口占用导致假失败
      try {
        await this.runtime.stopService(svc.id, true);
      } catch {
        /* 没在跑就忽略 */
      }

      let r: Awaited<ReturnType<RuntimeService['startService']>> | null = null;
      let startError: string | null = null;
      let verifyFailed = false;
      let verifyDetail = '';
      try {
        r = await this.runtime.startService(svc.id);
      } catch (e) {
        startError = String((e as Error)?.message ?? e);
      }
      // 端口占用自愈：确定性终止占用进程并立即重试一次（不消耗修复次数，不进 LLM）
      if (startError && await this.tryKillPortOccupier(startError, job, svc.name)) {
        try { r = await this.runtime.startService(svc.id); startError = null; } catch (e) { startError = String((e as Error)?.message ?? e); r = null; }
      }
      const cliDone = r?.status === 'Stopped' && !cur.port;
      if (cliDone) {
        // CLI 工具型项目：一次性命令 exit 0 = 启动校验通过（依赖装齐 + 入口可用）。
        // 校验通过立即为用户打开可用的命令行窗口。
        let terminalNote = '';
        try {
          await this.runtime.openTerminal(svc.id);
          terminalNote = '已自动打开命令行窗口并启动程序（虚拟环境已激活），窗口保持可用，直接在里面使用本项目。';
        } catch (e) {
          terminalNote = `命令行窗口打开失败（${String((e as Error)?.message ?? e).slice(0, 80)}），可在项目详情里点「打开终端」重试。`;
        }
        job.status = 'Success';
        job.finishedAt = new Date().toISOString();
        job.pid = r!.pid;
        job.startedServiceIds.push(svc.id);
        job.report = `CLI 项目启动校验通过：${cur.start_command} 执行成功（exit 0）。${terminalNote}`;
        this.step(job, 'done', job.report);
        this.notify.create({
          type: 'project.autostart.ok',
          title: `项目 ${project.name} 启动校验通过`,
          content: job.report,
          priority: 4,
          projectId: project.id,
        });
        return;
      }
      if (r?.status === 'Running') {
        // 端口监听 ≠ 启动成功：真实健康校验。vite dev server 端口起来但模块编译
        // 失败（如缺 @tauri-apps/api）时，页面访问是报错页，必须判失败进修复循环。
        const light = this.isWarmStart(svc.id, cur.start_command, cur.port);
        const verify = await this.verifyRunning(svc.name, cur.port, attemptStartedAt, light);
        if (verify.ok) {
          this.recordWarmStart(svc.id, cur.start_command, cur.port);
          job.status = 'Success';
          job.finishedAt = new Date().toISOString();
          job.pid = r.pid;
          job.startedServiceIds.push(svc.id);
          job.report = `启动成功（${light ? '热启动快速校验通过' : '健康校验通过'}）${r.adopted ? '（接管已在运行的实例）' : ''}：${cur.start_command}${cur.port ? `，端口 ${cur.port}` : ''}`;
          this.step(job, 'done', job.report);
          this.notify.create({
            type: 'project.autostart.ok',
            title: `项目 ${project.name} 已成功启动`,
            content: job.report,
            priority: 4,
            projectId: project.id,
          });
          return;
        }
        this.invalidateWarmStart(svc.id);
        verifyFailed = true;
        verifyDetail = verify.detail;
      }

      // 失败：抓日志 → Agent 修复
      const logText = verifyFailed
        ? verifyDetail
        : (startError ?? this.collectLogs(svc.name, r!.status, attemptStartedAt));
      this.step(job, verifyFailed ? 'verify' : 'repair', verifyFailed
        ? `第 ${attempt} 次启动端口已监听，但健康校验未通过（服务实际不可用），判定为失败并进入修复`
        : `第 ${attempt} 次启动失败（${startError ? `异常：${startError}` : r!.status}），抓取日志交给 Agent 修复`, logText.slice(0, 800));
      if (attempt === job.maxAttempts) {
        job.status = 'Failed';
        job.finishedAt = new Date().toISOString();
        job.report = `连续 ${job.maxAttempts} 次启动失败。最后一次状态 ${startError ?? r!.status}。\n\n最近日志：\n${logText.slice(-1200)}`;
        this.step(job, 'failed', job.report);
        this.notify.create({ type: 'project.autostart.failed', title: `项目 ${project.name} 自动修复后仍未启动`, content: job.report.slice(0, 800), priority: 2, projectId: project.id });
        return;
      }

      // 确定性诊断优先：命中已知失败模式就不烧 LLM，也避免「all providers failed」盖住真因
      const obvious = AutoStartService.diagnoseObviousFailure(logText, cur.start_command);
      if (obvious) {
        job.status = 'Failed';
        job.finishedAt = new Date().toISOString();
        job.report = `${obvious}\n\n最近日志：\n${logText.slice(-1200)}`;
        this.step(job, 'failed', obvious);
        this.notify.create({ type: 'project.autostart.failed', title: `项目 ${project.name} 启动失败`, content: job.report.slice(0, 800), priority: 2, projectId: project.id });
        return;
      }

      const fix = await this.fixer.fix({
        projectId: project.id,
        rootPath: root,
        projectName: project.name,
        language: project.language ?? 'unknown',
        isBinary,
        startCommand: cur.start_command,
        port: cur.port,
        logText,
        attempt,
        mode: 'repair',
      });
      this.applyFixOutcome(job, svc.id, fix);

      if (!fix.changed) {
        job.status = 'Failed';
        job.finishedAt = new Date().toISOString();
        job.report = `Agent 判断该项目无法通过自动修复解决：${fix.analysis || '（无说明）'}\n\n最近日志：\n${logText.slice(-1200)}`;
        this.step(job, 'failed', job.report);
        this.notify.create({ type: 'project.autostart.failed', title: `项目 ${project.name} 需要人工介入`, content: job.report.slice(0, 800), priority: 2, projectId: project.id });
        return;
      }
    }

    if (job.status === 'Running') {
      // 取消语义优先：用户手动取消 → 终态 Cancelled（含竞态兜底：统一停全部已启动服务）
      if (job.cancelRequested) {
        // cancel() 已置终态并通知过（表现为 finishedAt 已有值）→ 不重复弹通知
        const alreadyFinal = !!job.finishedAt;
        job.status = 'Cancelled';
        job.finishedAt = job.finishedAt ?? new Date().toISOString();
        const settled = await Promise.allSettled(job.startedServiceIds.map((sid) => this.runtime.stopService(sid, true)));
        const stopped = settled.filter((r) => r.status === 'fulfilled').length;
        job.report = `用户手动取消启动（已停止 ${stopped} 个服务）；可随时重新点「启动」`;
        this.step(job, 'failed', '启动已被用户手动取消');
        if (!alreadyFinal) {
          this.notify.create({ type: 'project.autostart.cancelled', title: `项目 ${project.name} 启动已取消`, content: job.report, priority: 3, projectId: project.id });
        }
        return;
      }
      job.status = 'Failed';
      job.finishedAt = new Date().toISOString();
      job.report = job.report ?? '自动启动未完成（启动命令缺失或全部尝试失败）';
      this.step(job, 'failed', job.report);
    }
  }

  /**
   * 启动后健康校验（核心反"假成功"机制）：
   * 端口监听只说明 dev server 进程起来了，不代表页面真的能用。
   * 校验手段：
   *  1) 采集启动后窗口期内的 [ERROR]/[FATAL] 日志（vite 预转换错误等都会落在这里）；
   *  2) 对有端口的服务：请求根路径，若是 HTML 则解析 <script src> 入口模块并逐个请求，
   *     模块编译失败（依赖缺失 / 语法错误）时 dev server 会返回 5xx——这是客观信号。
   * 任一手段发现真实错误 → 判定启动失败，进入修复循环。
   * 校验只在"发现明确错误"时判失败：应用能正常服务却打了一些无害 error 日志不会被误杀。
   */
  private async verifyRunning(serviceName: string, port: number | null, sinceIso: string, light = false): Promise<{ ok: boolean; detail: string }> {
    // 热启动快速校验：该服务此前用同一命令 + 端口通过过全量健康校验，这次只做一次
    // 轻量 HTTP 探测（2.5s 超时，<400 即通过），跳过观察窗口与逐模块探测。
    // 探测不通过时不判死，自动回落到下方全量校验。
    if (light && port) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2500), headers: { 'User-Agent': 'DevPilot-probe' } });
        if (res.status < 400) {
          void res.body?.cancel();
          this.logs.log({ level: 'info', sourceModule: 'autostart', projectId: '', message: `${serviceName} 热启动快速校验通过（跳过全量探测）` });
          return { ok: true, detail: '' };
        }
        void res.body?.cancel();
      } catch { /* 探测失败 → 回落全量校验 */ }
    }
    if (light && !port) return { ok: true, detail: '' }; // 无端口服务：startService 的常驻窗口已确认存活
    // 自适应窗口期（最多 4s）：HTTP 就绪（能拿到响应）即提前进入校验，
    // 不再无条件睡满 4 秒——正常快速启动的服务这里能省下大半等待。
    const WINDOW_MS = 4000;
    const windowStart = Date.now();
    if (port) {
      let ready = false;
      while (Date.now() - windowStart < WINDOW_MS) {
        try {
          const probe = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1200), headers: { 'User-Agent': 'DevPilot-probe' } });
          // 拿到任何 HTTP 响应（含 4xx/5xx，5xx 也是真实信号）即视为窗口期足够
          ready = true;
          void probe;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      if (!ready) this.logs.log({ level: 'warn', sourceModule: 'autostart', projectId: '', message: `${serviceName} 窗口期 ${WINDOW_MS}ms 内 HTTP 未就绪，按超时进入校验` });
    } else {
      // 无端口服务：只留一小段窗口让应用写出启动期错误日志（审计 P-03：1500ms → 400ms，
      // startService 的常驻判定已经确认过进程没退出，这里再等 1.5s 没有额外信息量）
      await new Promise((r) => setTimeout(r, 400));
    }

    const problems: string[] = [];

    // 1) 窗口期 ERROR 日志（只采集本次启动之后的行，避免旧日志污染）
    try {
      const tail = this.logs.tail(`service.${serviceName}`, 200);
      const errorLines = tail
        .split(/\r?\n/)
        .map((line) => {
          const m = line.match(/^\[([^\]]+)\]\s*\[(ERROR|FATAL)\]\s*(.*)$/i);
          return m && m[1] >= sinceIso ? m[3] : null;
        })
        .filter((x): x is string => !!x);
      if (errorLines.length) problems.push(`启动窗口期捕获 ${errorLines.length} 条错误日志：\n${errorLines.slice(0, 8).join('\n')}`);
    } catch { /* 日志读不到不阻断 */ }

    // 2) 端口服务：探测 HTML 入口模块能否真正编译
    if (port) {
      const probeFail = await this.probeEntryModules(port);
      if (probeFail) problems.push(probeFail);
    }

    return { ok: problems.length === 0, detail: problems.join('\n\n') };
  }

  /** 请求 / 页面，解析其中的 <script src> 模块并逐个请求；任一模块 5xx → 返回失败描述，否则 null */
  private async probeEntryModules(port: number): Promise<string | null> {
    const base = `http://127.0.0.1:${port}`;
    let html: string;
    try {
      const res = await fetch(`${base}/`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'DevPilot-probe', Accept: 'text/html' },
      });
      // 5xx 不等于"启动失败"：SSR 前端（React Router / Next）在后端 API 还没起来时会先返回 5xx，
      // 多服务并行启动时必然出现这个窗口。这里给 25s 容忍窗口，只有持续 5xx 才判失败。
      if (res.status >= 500) {
        let last = res.status;
        for (let i = 0; i < 25; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const retry = await fetch(`${base}/`, {
              signal: AbortSignal.timeout(5000),
              headers: { 'User-Agent': 'DevPilot-probe', Accept: 'text/html' },
            });
            if (retry.status < 500) break;
            last = retry.status;
          } catch { /* 网络抖动继续重试 */ }
          if (i === 24) return `GET / 持续返回 HTTP ${last}（等待 25s 后仍未恢复），服务端异常`;
        }
        this.logs.log({ level: 'info', sourceModule: 'autostart', projectId: '', message: `端口 ${port} 启动初期返回 5xx，等待后端依赖就绪后已恢复` });
        return null;
      }
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('text/html')) return null; // 非 HTML 服务（API 等）不做模块探测
      html = await res.text();
    } catch {
      return null; // 网络抖动不作为失败依据（端口探活已在 runtime 里通过）
    }

    const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 8);
    // 并行探测全部入口模块：串行 8 个最坏 64s，并行最坏 8s
    const results = await Promise.all(srcs.map(async (src) => {
      let u: URL;
      try { u = new URL(src, base); } catch { return null; }
      if (u.origin !== base) return null; // 跳过 CDN / 外部脚本
      try {
        const r2 = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'DevPilot-probe' } });
        if (r2.status >= 500) {
          const body = (await r2.text()).slice(0, 600);
          return `入口模块 ${src} 返回 HTTP ${r2.status}（依赖缺失或编译错误）：\n${body}`;
        }
      } catch { /* 单个模块请求失败不判死 */ }
      return null;
    }));
    return results.find((x) => x !== null) ?? null;
  }

  /**
   * 启动命令的确定性修正（不依赖模型，秒级完成）：
   * - 命中「裸 python」但项目里有 .venv → 换成 .venv 的解释器；
   * - 命中 venv 的 Scripts\xxx.exe（pip 生成的启动器）但该 exe 起不来（常见于 venv 迁移/损坏）
   *   → 换成 "<venv python>" -m xxx，等价但稳定。
   */
  private refineStartCommand(root: string, command: string | null): { command: string; changed: boolean; note: string } {
    const raw = (command ?? '').trim();
    if (!raw) return { command: raw, changed: false, note: '' };

    const venvPython = [
      path.join(root, '.venv', 'Scripts', 'python.exe'),
      path.join(root, 'venv', 'Scripts', 'python.exe'),
      path.join(root, '.venv', 'bin', 'python'),
      path.join(root, 'venv', 'bin', 'python'),
    ].find((p) => fs.existsSync(p));

    // 裸 python 且项目自带 venv
    if (venvPython && /^(python|python3|py)(\.exe)?\s+/i.test(raw)) {
      const rest = raw.replace(/^(python|python3|py)(\.exe)?\s+/i, '');
      // 入口文件如果是 Streamlit 应用（顶层 import streamlit），直接 python x.py 只会跑脚本、
      // 不会起 Web 服务，必须走 streamlit run。
      const entry = rest.match(/^"?([\w./\\-]+\.py)"?/);
      if (entry) {
        const file = path.resolve(root, entry[1]);
        try {
          const head = fs.readFileSync(file, 'utf-8').slice(0, 4000);
          if (/^\s*(import\s+streamlit|from\s+streamlit)/m.test(head)) {
            const next = `"${venvPython}" -m streamlit run ${rest}`;
            return { command: next, changed: true, note: '入口是 Streamlit 应用，已改用「venv python -m streamlit run」启动（否则只会执行脚本、不起服务）' };
          }
        } catch { /* 读不到就按原样 */ }
      }
      const next = `"${venvPython}" ${rest}`;
      return { command: next, changed: true, note: '启动命令用的是系统 python，已改用项目自带虚拟环境的解释器' };
    }

    // venv Scripts 下的启动器 exe
    const m = raw.match(/^"([^"]+\.exe)"\s+(.*)$/i) ?? raw.match(/^(\S+\.exe)\s+(.*)$/i);
    if (m && venvPython) {
      const exe = m[1];
      const rest = m[2];
      // 脚本里的相对路径以项目根为基准，不能按后端进程的 cwd 解析
      const exeAbs = path.isAbsolute(exe) ? exe : path.resolve(root, exe);
      const inVenv = /(^|[\\/])(?:\.venv|venv)[\\/](?:Scripts|bin)[\\/]/i.test(exe);
      const name = path.basename(exeAbs).replace(/\.exe$/i, '');
      if (inVenv && !/^python/i.test(name) && fs.existsSync(exeAbs)) {
        // 该启动器能 import 对应模块吗？不能则换成 -m
        let moduleOk = false;
        try {
          execFileSync(venvPython, ['-c', `import ${name}`], { cwd: root, timeout: 15000, stdio: 'ignore' });
          moduleOk = true;
        } catch {
          moduleOk = false;
        }
        // 模块本身可 import → 统一走 "<venv python> -m <module>"：
        // pip 生成的 Scripts\*.exe 启动器在 venv 被移动/重建后经常静默失败，而 -m 永远有效。
        if (moduleOk) {
          const next = `"${venvPython}" -m ${name} ${rest}`.trim();
          return { command: next, changed: true, note: `已把 ${path.basename(exe)} 启动器换成 python -m ${name}（模块已安装，启动器易失效）` };
        }
      }
    }

    return { command: raw, changed: false, note: '' };
  }

  private applyFixOutcome(job: AutoStartJob, serviceId: string, fix: FixOutcome) {
    // 启动命令合理性把关：宁可不修，也不把「python -m http.server」这种兜底命令写进
    // 数据库/前端服务（实测会把项目"修"成目录列表页）。
    const svcRow = this.ds.db
      .prepare('SELECT name, service_type, start_command, workdir FROM project_services WHERE id = ?')
      .get(serviceId) as { name: string; service_type: string; start_command: string | null; workdir: string } | undefined;
    if (svcRow && fix.startCommand) {
      const verdict = judgeFix({
        serviceName: svcRow.name,
        serviceType: svcRow.service_type,
        projectRoot: this.projectRootOf(job.projectId) ?? svcRow.workdir ?? '',
        workdir: svcRow.workdir || undefined,
        previousCommand: svcRow.start_command,
        proposedCommand: fix.startCommand,
      });
      if (!verdict.ok) {
        this.step(job, 'repair', `拒绝应用 Agent 给出的启动命令：${verdict.reason}${verdict.hint ? `\n建议：${verdict.hint}` : ''}`, fix.startCommand);
        fix.startCommand = null;
        fix.port = null;
        fix.changed = false;
      }
    }
    if (fix.ranCommands.length) {
      const lines = fix.ranCommands.map((c) => `${c.skipped ? '跳过' : `exit=${c.exitCode ?? 'err'}`}  ${c.command}${c.output ? `\n    ${c.output.split('\n').slice(-3).join('\n    ')}` : ''}`);
      this.step(job, 'repair', `执行 ${fix.ranCommands.length} 条修复命令`, lines.join('\n'));
    }
    if (fix.appliedFiles.length) this.step(job, 'repair', `修改文件：${fix.appliedFiles.join(', ')}`);
    if (fix.analysis) this.step(job, 'repair', `Agent 诊断：${fix.analysis.slice(0, 400)}`);

    const patch: { start_command?: string; port?: number | null } = {};
    if (fix.startCommand) patch.start_command = fix.startCommand;
    if (typeof fix.port === 'number' && fix.port > 0) patch.port = fix.port;
    if (Object.keys(patch).length) {
      this.applyServiceConfig(serviceId, patch);
      job.command = patch.start_command ?? job.command;
      job.port = patch.port ?? job.port;
      this.step(job, 'repair', `更新服务配置：${JSON.stringify(patch)}`);
    }
  }

  /** 系统关键进程（自愈终止白名单外一律拒绝） */
  private static readonly PROTECTED_PROCESS_NAMES = /^(system|smss|csrss|wininit|winlogon|services|lsass|svchost|dwm|explorer|registry|memory compression|fontdrvhost|audiodg)$/i;

  /**
   * 端口占用自愈（确定性，不进 LLM 修复，不消耗修复次数）：
   * 启动失败错误形态「端口 X 已被 PID N（name）占用且不响应 HTTP」→ 直接终止占用进程。
   * 护栏：系统关键进程 / DevPilot 自身 / 本机其它受管服务 不杀，转交 Agent 修复或人工处理。
   * 返回 true = 已终止且确认死亡（调用方立即重试启动）。
   */
  private async tryKillPortOccupier(startError: string | null, job: AutoStartJob, svcName: string): Promise<boolean> {
    if (!startError) return false;
    const m = /端口 (\d+) 已被 PID (\d+)（([^）]+)）\s*占用/i.exec(startError);
    if (!m) return false;
    const port = m[1];
    const pid = Number(m[2]);
    const name = m[3];
    if (!Number.isInteger(pid) || pid <= 4) {
      this.step(job, 'repair', `端口 ${port} 占用进程 PID ${pid} 是内核级进程，不自动终止（可改用其它端口）`);
      return false;
    }
    if (pid === process.pid) {
      this.step(job, 'repair', `端口 ${port} 占用进程是 DevPilot 自身，拒绝终止`);
      return false;
    }
    if (AutoStartService.PROTECTED_PROCESS_NAMES.test(name.replace(/\.exe$/i, ''))) {
      this.step(job, 'repair', `端口 ${port} 占用进程 ${name} 是系统关键进程，不自动终止（可改用其它端口）`);
      return false;
    }
    const owner = this.runtime.getTrackedServiceByPid(pid);
    if (owner) {
      this.step(job, 'repair', `端口 ${port} 占用进程 PID ${pid} 属于本机受管服务「${owner}」，不自动终止；请先在运行中心停止该服务，或改用其它端口`);
      return false;
    }
    // 审计 S-03 修复：只终止「本项目自己的遗留进程」，其余一律交还用户决定。
    // 旧实现会把任意占端口的进程直接 taskkill /F —— 实测曾把用户正在跑的 Vite 杀掉。
    const owned = process.env.DEVIPILOT_TRUST_EXTERNAL_PORTS === '1'
      ? true
      : await this.runtime.pidBelongsToProject(pid, job.projectId);
    if (!owned) {
      this.step(
        job,
        'repair',
        `端口 ${port} 被外部进程 PID ${pid}（${name}）占用，且不属于本项目 —— DevPilot 不会自动终止外部进程；` +
        `请先手动结束它，或为该服务改用其它端口后重试`,
      );
      return false;
    }
    const { platform } = await import('@devpilot/platform-adapters');
    try {
      // 2s 上限：taskkill /T /F 正常 100~300ms 返回，旧默认 10s 会让启动/取消在这条路径上长时间空等
      await platform.killTreeWait(pid, 2000);
    } catch (e) {
      this.step(job, 'repair', `终止占用进程 PID ${pid} 失败：${String((e as Error)?.message ?? e).slice(0, 120)}，转 Agent 修复`);
      return false;
    }
    if (platform.pidAlive(pid)) {
      this.step(job, 'repair', `占用进程 PID ${pid} 终止后仍存活（可能有守护重启），转 Agent 修复`);
      return false;
    }
    this.step(job, 'repair', `端口占用自愈：端口 ${port} 被进程 PID ${pid}（${name}）占用，已直接终止该进程，重试启动`);
    this.logs.log({ level: 'warn', sourceModule: 'autostart', message: `端口占用自愈：终止 PID ${pid}（${name}）以释放端口 ${port}（服务 ${svcName}）` });
    return true;
  }

  /**
   * 确定性失败诊断（审计 F-02）：在把日志丢给 LLM 之前，先识别几类「一看就知道」的根因。
   * 命中即直接给结论，不再调用模型——本机没配 Key 时，旧实现会把
   * `all providers failed` 当成结论抛给用户，真实原因（命令不存在）反而看不到。
   */
  static diagnoseObviousFailure(logText: string, startCommand: string | null): string | null {
    const text = String(logText ?? '');
    const lower = text.toLowerCase();
    const firstToken = String(startCommand ?? '').trim().replace(/^["']/, '').split(/\s+/)[0] ?? '';
    if (
      /not recognized as an internal or external command/.test(lower) ||
      /is not recognized as the name of a cmdlet/.test(lower) ||
      /command not found/.test(lower) ||
      /\benoent\b/.test(lower)
    ) {
      return `启动命令无法执行：系统里找不到「${firstToken || '该命令'}」。请确认它已安装并加入 PATH，或在服务配置里改成正确的启动命令。`;
    }
    if (/端口 \d+ 已被外部进程/.test(text)) {
      return '端口冲突：目标端口被不属于本项目的外部进程占用。请先结束该进程，或在服务配置里换一个端口（DevPilot 不会终止外部进程）。';
    }
    if (/eaddrinuse|address already in use/.test(lower)) {
      return '端口已被占用（EADDRINUSE）。请先结束占用该端口的进程，或为该服务换一个端口。';
    }
    if (/cannot find module|module not found/.test(lower)) {
      const m = /cannot find module ['"]([^'"]+)['"]/i.exec(text) ?? /module not found[^\n]*?['"]([^'"]+)['"]/i.exec(text);
      return `缺少依赖模块「${m?.[1] ?? '未知'}」。先安装依赖（npm/pnpm install）后重试。`;
    }
    if (/permission denied|eacces|eperm/.test(lower)) {
      return '权限不足（EACCES/EPERM）。请检查文件/目录权限，或以有权限的账号运行。';
    }
    return null;
  }

  private collectLogs(serviceName: string, status: string, sinceIso?: string): string {    const svcLogRaw = (() => {
      try {
        return this.logs.tail(`service.${serviceName}`, 200);
      } catch {
        return '';
      }
    })();
    // 只保留本轮启动之后的输出：旧的失败日志会把 Agent 引向已经修过的根因
    const svcLog = sinceIso
      ? svcLogRaw
          .split(/\r?\n/)
          .filter((line) => {
            const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]/);
            return !m || m[1] >= sinceIso;
          })
          .join('\n')
          .trim()
      : svcLogRaw;
    const rtLog = (() => {
      try {
        return this.logs.tail('autostart', 40);
      } catch {
        return '';
      }
    })();
    return `服务状态：${status}\n\n--- 本轮服务输出 ---\n${svcLog || '（本轮没有任何输出，进程可能在启动阶段静默退出）'}\n\n--- 自动启动记录 ---\n${rtLog}`;
  }

  /** 项目的全部服务，按依赖顺序排列：基础设施 → backend → app/其他 → frontend */
  private allServices(projectId: string): Array<{ id: string; name: string; service_type: string; start_command: string | null; port: number | null; workdir: string }> {
    const rows = this.ds.db
      .prepare('SELECT id, name, service_type, start_command, port, workdir, created_at FROM project_services WHERE project_id = ? ORDER BY created_at ASC')
      .all(projectId) as Array<{ id: string; name: string; service_type: string; start_command: string | null; port: number | null; workdir: string; created_at: string }>;
    const rank = (t: string) => (t === 'database' || t === 'cache' || t === 'mq' ? 0 : t === 'backend' ? 1 : t === 'frontend' ? 3 : 2);
    return rows.sort((a, b) => rank(a.service_type) - rank(b.service_type));
  }

  /** 项目根目录（供修复守卫判断"项目里是否存在真实应用入口"） */
  private projectRootOf(projectId: string): string | null {
    const row = this.ds.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string } | undefined;
    return row?.root_path ?? null;
  }

  private getService(serviceId: string): { id: string; name: string; service_type: string; start_command: string | null; port: number | null; workdir: string } | null {
    const row = this.ds.db
      .prepare('SELECT id, name, service_type, start_command, port, workdir FROM project_services WHERE id = ?')
      .get(serviceId) as { id: string; name: string; service_type: string; start_command: string | null; port: number | null; workdir: string } | undefined;
    return row ?? null;
  }

  private applyServiceConfig(serviceId: string, patch: { start_command?: string; port?: number | null }) {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (typeof patch.start_command === 'string' && patch.start_command.trim()) {
      sets.push('start_command = ?');
      args.push(patch.start_command.trim());
    }
    if (patch.port != null) {
      sets.push('port = ?');
      args.push(patch.port);
    }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    args.push(new Date().toISOString());
    args.push(serviceId);
    this.ds.db.prepare(`UPDATE project_services SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  /** 供 UI 展示：项目根目录是否存在可直接执行的一键脚本（不执行，只识别） */
  detect(projectId: string) {
    const p = this.ds.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string } | undefined;
    if (!p) throw new Error('项目不存在');
    const hit = detectLaunchScript(p.root_path);
    return {
      rootPath: path.normalize(p.root_path),
      found: !!hit,
      script: hit ? { relative: hit.relative, command: hit.command, kind: hit.kind, port: hit.port, confidence: hit.confidence, reason: hit.reason } : null,
    };
  }
}
