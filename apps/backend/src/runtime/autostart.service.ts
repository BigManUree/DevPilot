import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../database/database.module';
import { LogService } from '../logs/log.service';
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
  status: 'Running' | 'Success' | 'Failed';
  startedAt: string;
  finishedAt?: string;
  attempt: number;
  maxAttempts: number;
  command?: string | null;
  port?: number | null;
  pid?: number;
  report?: string;
  steps: AutoStartStep[];
}

@Injectable()
export class AutoStartService {
  private jobs = new Map<string, AutoStartJob>();
  private byProject = new Map<string, string>();

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
    };
    this.jobs.set(job.id, job);
    this.byProject.set(projectId, job.id);
    void this.run(job, project).catch((e) => {
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

    for (const svc of services) {
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
          results.push(`✗ ${svc.name}：无法确定启动方式`);
          allOk = false;
          continue;
        }
      }

      // 2) 启动 → 失败修复 → 重试
      let ok = false;
      let lastLog = '';
      for (let attempt = 1; attempt <= job.maxAttempts; attempt++) {
        job.attempt = attempt;
        const cur = this.getService(svc.id)!;
        const refined = this.refineStartCommand(project.root_path, cur.start_command);
        if (refined.changed) {
          this.applyServiceConfig(svc.id, { start_command: refined.command });
          this.step(job, 'detect', `[${svc.name}] ${refined.note}`, refined.command);
        }
        const cmd = refined.command;
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
          // startService 抛异常（如端口被系统保留）不应中止整个任务，进入修复流程
          startError = String((e as Error)?.message ?? e);
        }

        if (r?.status === 'Stopped' && !cur.port) {
          // CLI 工具型服务：一次性命令 exit 0 = 启动校验通过（依赖齐、入口可用）。
          // 校验通过立即为用户打开可用的命令行窗口——CLI 项目的"启动成功"就是能直接用。
          let terminalNote = '';
          try {
            await this.runtime.openTerminal(svc.id);
            terminalNote = '，已自动打开命令行窗口';
          } catch (e) {
            terminalNote = `，命令行窗口打开失败（${String((e as Error)?.message ?? e).slice(0, 80)}），可在详情里点「打开终端」重试`;
          }
          ok = true;
          results.push(`✓ ${svc.name}：CLI 启动校验通过（${cmd}，exit 0）${terminalNote}`);
          this.step(job, 'done', `${svc.name} CLI 启动校验通过${terminalNote}，直接在弹出的窗口里使用本项目`);
          break;
        }

        if (r?.status === 'Running') {
          // 端口监听 ≠ 启动成功：做真实健康校验（页面模块能否编译、有无报错日志）。
          // vite「Failed to resolve import」这类错误曾经被误报成启动成功。
          const verify = await this.verifyRunning(svc.name, cur.port, attemptStartedAt);
          if (verify.ok) {
            ok = true;
            results.push(`✓ ${svc.name}：${cmd}${cur.port ? `（端口 ${cur.port}）` : ''}${r.adopted ? '，接管已有实例' : ''}`);
            this.step(job, 'done', `${svc.name} 启动成功${cur.port ? `，端口 ${cur.port}（健康校验通过）` : '（健康校验通过）'}`);
            break;
          }
          verifyFailed = true;
          lastLog = verify.detail;
          this.step(job, 'verify', `${svc.name} 端口已监听，但健康校验未通过（服务实际不可用），判定为本次启动失败`, verify.detail.slice(0, 800));
        }

        if (!verifyFailed) {
          lastLog = startError ?? this.collectLogs(svc.name, r!.status, attemptStartedAt);
          this.step(job, 'repair', `${svc.name} 第 ${attempt} 次启动失败（${startError ? `异常：${startError}` : r!.status}），交给 Agent 修复`, lastLog.slice(0, 600));
        } else {
          this.step(job, 'repair', `${svc.name} 第 ${attempt} 次启动失败（健康校验未通过），交给 Agent 修复`, lastLog.slice(0, 600));
        }
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
      }
      if (!ok) {
        results.push(`✗ ${svc.name}：启动失败（详见上方日志）`);
        allOk = false;
      }
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
        const verify = await this.verifyRunning(svc.name, cur.port, attemptStartedAt);
        if (verify.ok) {
          job.status = 'Success';
          job.finishedAt = new Date().toISOString();
          job.pid = r.pid;
          job.report = `启动成功（健康校验通过）${r.adopted ? '（接管已在运行的实例）' : ''}：${cur.start_command}${cur.port ? `，端口 ${cur.port}` : ''}`;
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
  private async verifyRunning(serviceName: string, port: number | null, sinceIso: string): Promise<{ ok: boolean; detail: string }> {
    // 留出窗口期：让 dev server 完成 warmup / 让应用写出启动期错误日志
    await new Promise((r) => setTimeout(r, 4000));

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
      if (res.status >= 500) return `GET / 返回 HTTP ${res.status}，服务端异常`;
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('text/html')) return null; // 非 HTML 服务（API 等）不做模块探测
      html = await res.text();
    } catch {
      return null; // 网络抖动不作为失败依据（端口探活已在 runtime 里通过）
    }

    const srcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]).slice(0, 8);
    for (const src of srcs) {
      let u: URL;
      try { u = new URL(src, base); } catch { continue; }
      if (u.origin !== base) continue; // 跳过 CDN / 外部脚本
      try {
        const r2 = await fetch(u, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'DevPilot-probe' } });
        if (r2.status >= 500) {
          const body = (await r2.text()).slice(0, 600);
          return `入口模块 ${src} 返回 HTTP ${r2.status}（依赖缺失或编译错误）：\n${body}`;
        }
      } catch { /* 单个模块请求失败不判死，以下一个为准 */ }
    }
    return null;
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

  private collectLogs(serviceName: string, status: string, sinceIso?: string): string {
    const svcLogRaw = (() => {
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
