import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { ModelService } from '../agents/model.service';
import { ToolGatewayService } from '../permissions/tool-gateway.service';
import { LogService } from '../logs/log.service';

/**
 * 自动修复 Agent（供 AutoStartService 调用）
 *
 * 与 diagnostics/repair-loop 的区别：
 * - 修复目标是「让这个项目能启动」，不只改代码，更重要的是安装依赖 / 换解释器 / 改启动命令；
 * - 因此计划里允许出现 commands（在项目根目录执行），并允许在必要时改文件；
 * - 所有动作都落在项目根目录内，命令走白名单 + 黑名单双闸，全程落审计与日志。
 */

export interface FixRequest {
  projectId: string;
  rootPath: string;
  projectName: string;
  language: string;
  isBinary: boolean;
  startCommand: string | null;
  port: number | null;
  logText: string;
  attempt: number;
  /** analyze-start：没有启动命令，让模型给出启动方式；repair：修复已有启动失败 */
  mode: 'analyze-start' | 'repair';
}

export interface FixPlan {
  analysis: string;
  commands: string[];
  files: Array<{ path: string; content: string }>;
  startCommand?: string | null;
  port?: number | null;
  explanation?: string;
}

export interface FixOutcome {
  analysis: string;
  explanation?: string;
  appliedFiles: string[];
  ranCommands: Array<{ command: string; exitCode: number | null; output: string; skipped?: string }>;
  changed: boolean;
  startCommand?: string | null;
  port?: number | null;
}

/** 允许自动执行的命令首词：安装依赖 / 构建 / 初始化，都是可恢复操作 */
const CMD_ALLOW = [
  /^(python|python3|py)(\.exe)?\s+-m\s+(pip|venv|ensurepip|pytest|streamlit|uvicorn)\b/i,
  /^(python|python3|py)(\.exe)?\s+-c\s+/i,
  /^(pip|pip3)(\.exe)?\s+(install|uninstall|list|freeze)\b/i,
  /^[.\\/]*(\.venv|venv)[\\/]Scripts[\\/][\w.-]+(\.exe)?\s+/i,
  /^(node|npm|pnpm|yarn|npx|corepack)\b/i,
  /^(go|cargo|rustup)\b/i,
  /^(dotnet|mvn|gradle|gradlew)(\.bat)?\b/i,
  /^(poetry|pipenv|uv|pdm)\b/i,
  /^(bundle|gem|composer|php)\b/i,
  /^(docker|docker-compose)\s+(compose\s+)?(up|build|pull)\b/i,
  /^(chcp|set)\s/i,
];

/** 明确 destructive / 影响系统或其它进程的命令：即使模型给出也拒绝执行 */
const CMD_DENY = [
  /\brm\s+-rf?\b/i,
  /\b(del|erase)\s+\/[sfq]/i,
  /\brd\s+\/s\b/i,
  /\brmdir\s+\/s\b/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\b(shutdown|restart-computer|stop-computer)\b/i,
  /\breg(\.exe)?\s+(add|delete|import)\b/i,
  /\bsc(\.exe)?\s+(delete|stop|config)\b/i,
  /\b(taskkill|tskill|stop-process)\b/i,
  /\bnet\s+(user|localgroup)\b/i,
  /\b(icacls|takeown|cacls)\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+--force)/i,
  /\bpowershell\b.*\b(invoke-expression|iex|downloadstring)\b/i,
  /[>|]{1,2}\s*[a-z]:\\/i,
];

@Injectable()
export class AutoFixerService {
  constructor(
    private readonly model: ModelService,
    private readonly gateway: ToolGatewayService,
    private readonly logs: LogService,
  ) {}

  /** 生成并执行修复计划；返回是否真正产生了变更（无变更 → 上层放弃重试） */
  async fix(req: FixRequest): Promise<FixOutcome> {
    const plan = await this.propose(req);
    const nextStart = (plan.startCommand ?? '').trim();
    const curStart = (req.startCommand ?? '').trim();
    const outcome: FixOutcome = {
      analysis: plan.analysis,
      explanation: plan.explanation,
      appliedFiles: [],
      ranCommands: [],
      changed: false,
      startCommand: nextStart && nextStart !== curStart ? nextStart : null,
      port: plan.port ?? null,
    };
    if (nextStart && nextStart !== curStart) outcome.changed = true;
    if (typeof plan.port === 'number' && plan.port > 0 && plan.port !== req.port) outcome.changed = true;

    // 1) 先跑命令（装依赖 / 初始化），再落文件（改配置），最后交给上层重试启动
    for (const raw of plan.commands ?? []) {
      const command = String(raw ?? '').trim();
      if (!command) continue;
      // 模型常把可执行文件加引号（"".venv\Scripts\python.exe" -m pip ..."），
      // 白名单匹配前先摘掉最外层引号，否则合法命令会被误判成"不在白名单"。
      const normalized = command.replace(/^"([^"]+)"\s*/, '$1 ').replace(/^'([^']+)'\s*/, '$1 ').trim();
      const denied = CMD_DENY.find((re) => re.test(normalized) || re.test(command));
      if (denied) {
        outcome.ranCommands.push({ command, exitCode: null, output: '', skipped: '命中禁止规则，未执行' });
        this.logs.log({ level: 'warn', sourceModule: 'autostart', projectId: req.projectId, message: `拒绝执行命令（危险操作）：${command}` });
        continue;
      }
      if (!CMD_ALLOW.some((re) => re.test(normalized))) {
        outcome.ranCommands.push({ command, exitCode: null, output: '', skipped: '不在允许的命令清单内，未执行' });
        this.logs.log({ level: 'warn', sourceModule: 'autostart', projectId: req.projectId, message: `拒绝执行命令（不在白名单）：${command}` });
        continue;
      }
      const HARD_TIMEOUT_MS = 180_000;
      const call = this.gateway.call(
        { subjectType: 'user', subjectId: 'local-user', tool: 'command.exec', params: { command, cwd: req.rootPath, timeoutMs: HARD_TIMEOUT_MS }, projectId: req.projectId },
        'command_execution',
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hardTimeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), HARD_TIMEOUT_MS + 15_000);
      });
      const r = (await Promise.race([call, hardTimeout])) ?? { ok: false, permission: 'allowed' as const, toolCallId: '', error: `命令超过 ${Math.round(HARD_TIMEOUT_MS / 1000)}s 未结束，已跳过` };
      if (timer) clearTimeout(timer);
      const data = ((r as { data?: unknown }).data ?? {}) as { exitCode?: number | null; stdout?: string; stderr?: string; timedOut?: boolean };
      const output = `${data.stdout ?? ''}${data.stderr ?? ''}`.trim().slice(-4000);
      const exitCode = r.ok ? (data.exitCode ?? null) : null;
      outcome.ranCommands.push({ command, exitCode, output });
      outcome.changed = true;
      this.logs.log({
        level: exitCode === 0 ? 'info' : 'warn',
        sourceModule: 'autostart',
        projectId: req.projectId,
        message: `执行修复命令（exit=${exitCode ?? 'err'}）：${command}${(r as { ok?: boolean }).ok ? '' : ` | ${(r as { error?: string }).error ?? ''}`}`,
      });
    }

    // 2) 文件修复：限定在项目根目录内
    for (const f of plan.files ?? []) {
      const rel = String(f?.path ?? '');
      if (!rel) continue;
      const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(req.rootPath, rel);
      const relative = path.relative(req.rootPath, abs);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        this.logs.log({ level: 'warn', sourceModule: 'autostart', projectId: req.projectId, message: `拒绝越界写入：${rel}（不在 ${req.rootPath} 内）` });
        continue;
      }
      if (req.isBinary) {
        this.logs.log({ level: 'warn', sourceModule: 'autostart', projectId: req.projectId, message: `二进制项目不写源码文件，跳过：${rel}` });
        continue;
      }
      if (typeof f.content !== 'string' || !f.content) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const r = await this.gateway.call(
        { subjectType: 'user', subjectId: 'local-user', tool: 'fs.write', params: { path: abs, content: f.content }, projectId: req.projectId },
        'modify_code',
      );
      if (r.ok) {
        outcome.appliedFiles.push(relative);
        outcome.changed = true;
        this.logs.log({ level: 'info', sourceModule: 'autostart', projectId: req.projectId, message: `已写入修复文件：${relative}` });
      } else {
        this.logs.log({ level: 'error', sourceModule: 'autostart', projectId: req.projectId, message: `写入失败 ${relative}：${r.error ?? ''}` });
      }
    }

    return outcome;
  }

  private async propose(req: FixRequest): Promise<FixPlan> {
    const fileRule = req.isBinary
      ? '该项目是二进制分发（无源码，不能构建）：files 必须为空数组。只能通过 commands（安装依赖/初始化环境）或 startCommand（正确的启动命令）来修。'
      : '如需改代码或配置，files 的 path 必须是相对项目根的路径，content 为完整文件内容；只做最小必要改动。';

    const modeRule = req.mode === 'analyze-start'
      ? '当前没有可用的启动命令：请判断这个项目应当如何启动，给出 startCommand（Windows 语法，相对项目根执行），并给出启动前必须先执行的准备命令（如安装依赖）。'
      : '当前启动命令失败：请根据日志定位根因，给出能真正消除故障的最小动作。';

    const sys = [
      '你是 DevPilot 自动修复 Agent，目标是让用户本地项目**成功启动**，不要让人再手工执行命令。',
      '只输出 JSON：{"analysis":string,"commands":string[],"files":[{"path":string,"content":string}],"startCommand":string|null,"port":number|null,"explanation":string}',
      'commands 会在项目根目录下用 Windows cmd 执行；只允许安装依赖、构建、初始化类命令。',
      '禁止：删除文件、改注册表、结束其它进程、修改系统设置、任何不可恢复操作。',
      '优先使用项目自带运行环境（如 .venv\\Scripts\\python.exe、node_modules、gradlew）。',
      '若判断故障来自项目外部（端口被其它程序占用、缺少系统级依赖），commands 与 files 都给空数组，在 analysis 里说明真实原因。',
      fileRule,
      modeRule,
    ].join('\n');

    const user = [
      `项目：${req.projectName}`,
      `根目录：${req.rootPath}`,
      `语言/类型：${req.language}${req.isBinary ? '（二进制分发）' : ''}`,
      `当前启动命令：${req.startCommand ?? '（无）'}`,
      `期望端口：${req.port ?? '（未配置）'}`,
      `第 ${req.attempt} 次自动修复`,
      '',
      '最近的启动日志：',
      req.logText.slice(0, 6000) || '（没有捕获到输出，进程可能立即退出）',
    ].join('\n');

    let raw = '';
    try {
      raw = await this.model.chat(
        [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        { json: true },
      );
    } catch (e) {
      return { analysis: `修复 Agent 调用失败：${String(e).slice(0, 200)}`, commands: [], files: [] };
    }

    const parsed = this.parseJson(raw);
    if (!parsed) return { analysis: raw.slice(0, 500) || '模型未返回可解析的修复计划', commands: [], files: [] };
    return {
      analysis: String(parsed.analysis ?? ''),
      explanation: parsed.explanation ? String(parsed.explanation) : undefined,
      commands: Array.isArray(parsed.commands) ? parsed.commands.map(String) : [],
      files: Array.isArray(parsed.files) ? parsed.files.filter((f) => f && typeof f.path === 'string') : [],
      startCommand: parsed.startCommand ? String(parsed.startCommand).trim() : null,
      port: Number.isFinite(Number(parsed.port)) && Number(parsed.port) > 0 ? Number(parsed.port) : null,
    };
  }

  /** 模型偶尔会在 JSON 前后带说明文字或 ```json 围栏 */
  private parseJson(raw: string): Record<string, unknown> | null {
    const text = String(raw ?? '').trim();
    const tries = [text];
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) tries.push(fenced[1]);
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) tries.push(text.slice(first, last + 1));
    for (const t of tries) {
      try {
        const v = JSON.parse(t);
        if (v && typeof v === 'object') return v as Record<string, unknown>;
      } catch {
        /* 继续尝试下一种 */
      }
    }
    return null;
  }
}
