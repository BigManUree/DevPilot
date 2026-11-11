import { Injectable } from '@nestjs/common';
import { exec, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { AuditService } from '../permissions/audit.service';
import { LogService } from '../logs/log.service';

const run = promisify(execFile);
const shellExec = promisify(exec);

export interface ExternalTool {
  id: string;
  name: string;
  kind: 'ide' | 'browser' | 'emulator';
  exePath: string | null;
  status: 'ok' | 'missing';
}

/**
 * 外部工具联动：
 * - IDE（VS Code / IntelliJ IDEA）打开项目目录
 * - 浏览器（Chrome / Edge）打开 URL
 * - Android 模拟器（emulator + AVD 列表/启动）
 * 全部通过本机可执行文件直接启动，不弹系统 open。
 */
@Injectable()
export class ExternalToolsService {
  constructor(
    private readonly audit: AuditService,
    private readonly logs: LogService,
  ) {}

  /** 探测本机常用工具：PATH `where` + 常见安装目录 */
  async detectTools(): Promise<ExternalTool[]> {
    const out: ExternalTool[] = [];

    const add = (id: string, name: string, kind: ExternalTool['kind'], exePath: string | null) =>
      out.push({ id, name, kind, exePath, status: exePath ? 'ok' : 'missing' });

    // PATH 探测
    const whereCmd = async (cmd: string): Promise<string | null> => {
      try {
        const { stdout } = await shellExec(`where ${cmd}`, { timeout: 8_000, windowsHide: true });
        const first = stdout.split('\n').map((l) => l.trim()).filter(Boolean)[0];
        return first ?? null;
      } catch { return null; }
    };
    // 常见安装目录探测
    const existsOne = (candidates: string[]): string | null =>
      candidates.find((p) => fs.existsSync(p)) ?? null;

    const code = (await whereCmd('code.cmd')) ?? (await whereCmd('code'));
    add('vscode', 'VS Code', 'ide', code ?? existsOne([
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code/bin/Code.exe'),
      'C:/Program Files/Microsoft VS Code/bin/Code.exe',
    ]));

    const idea = existsOne([
      'C:/Program Files/JetBrains/IntelliJ IDEA Community Edition/bin/idea64.exe',
      'C:/Program Files/JetBrains/IntelliJ IDEA Ultimate/bin/idea64.exe',
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs/IntelliJ IDEA Community Edition/bin/idea64.exe'),
    ]);
    add('idea', 'IntelliJ IDEA', 'ide', idea ?? (await whereCmd('idea64.exe')));

    const chrome = existsOne([
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    ]);
    add('chrome', 'Chrome', 'browser', chrome ?? (await whereCmd('chrome.exe')));

    const edge = existsOne([
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ]);
    add('edge', 'Edge', 'browser', edge ?? (await whereCmd('msedge.exe')));

    const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? '';
    const emulator = androidHome ? existsOne([path.join(androidHome, 'emulator/emulator.exe')]) : null;
    add('emulator', 'Android Emulator', 'emulator', emulator);

    return out;
  }

  /** IDE 打开项目目录 */
  async openInIde(toolId: string, projectPath: string) {
    if (!fs.existsSync(projectPath)) return { ok: false, error: `路径不存在：${projectPath}` };
    const tools = await this.detectTools();
    const tool = tools.find((t) => t.id === toolId && t.status === 'ok');
    if (!tool?.exePath) return { ok: false, error: `IDE 未安装或未找到：${toolId}` };
    const args = toolId === 'idea' ? [projectPath] : ['-n', projectPath];
    const child = spawn(tool.exePath, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    this.audit.record({ subject: 'user:local-user', action: 'external-tool.open', target: `${tool.name} ${projectPath}`, result: 'ok' });
    this.logs.log({ level: 'info', sourceModule: 'external-tools', message: `${tool.name} opened ${projectPath}` });
    return { ok: true, tool: tool.name };
  }

  /** 浏览器打开 URL */
  async openUrl(toolId: string | null, url: string) {
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '仅支持 http/https URL' };
    const tools = await this.detectTools();
    let exePath: string | null = null;
    if (toolId) {
      const tool = tools.find((t) => t.id === toolId && t.status === 'ok');
      exePath = tool?.exePath ?? null;
    } else {
      // 未指定：优先 Chrome，再 Edge
      exePath = (tools.find((t) => t.id === 'chrome' && t.status === 'ok') ?? tools.find((t) => t.id === 'edge' && t.status === 'ok'))?.exePath ?? null;
    }
    if (!exePath) {
      // 兜底：系统默认浏览器（cmd start）
      const c = spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
      c.unref();
      this.audit.record({ subject: 'user:local-user', action: 'external-tool.open-url', target: url, result: 'ok', detail: { via: 'default browser' } });
      return { ok: true, tool: 'default' };
    }
    const child = spawn(exePath, [url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    this.audit.record({ subject: 'user:local-user', action: 'external-tool.open-url', target: url, result: 'ok' });
    return { ok: true };
  }

  /** Android 模拟器 AVD 列表 */
  async listAvds(): Promise<{ ok: boolean; avds: string[]; error?: string }> {
    const tools = await this.detectTools();
    const emu = tools.find((t) => t.id === 'emulator');
    if (!emu?.exePath) return { ok: false, avds: [], error: '未找到 emulator.exe（检查 ANDROID_HOME）' };
    try {
      const { stdout } = await run(emu.exePath, ['-list-avds'], { timeout: 15_000, windowsHide: true });
      return { ok: true, avds: stdout.split('\n').map((l) => l.trim()).filter(Boolean) };
    } catch (err) {
      return { ok: false, avds: [], error: String(err).slice(0, 300) };
    }
  }

  /** 启动指定 AVD */
  async launchEmulator(avd: string) {
    const tools = await this.detectTools();
    const emu = tools.find((t) => t.id === 'emulator');
    if (!emu?.exePath) return { ok: false, error: '未找到 emulator.exe' };
    const child = spawn(emu.exePath, ['-avd', avd], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    this.audit.record({ subject: 'user:local-user', action: 'external-tool.launch-emulator', target: avd, result: 'ok' });
    this.logs.log({ level: 'info', sourceModule: 'external-tools', message: `emulator launched: ${avd}` });
    return { ok: true, avd };
  }
}
