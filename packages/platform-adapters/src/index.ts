import { spawn, exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(exec);

/**
 * 跨平台适配层（需求 3.3 / 设计文档集 §05）：
 * 把 OS 差异（shell、路径、进程树、命令解析、工具发现）收敛到一个接口后面，
 * backend 服务不再散落 process.platform 分支；macOS/Linux 适配只需新增实现。
 */

/** spawn 选项扩展：win32 verbatim 透传引号 */
export interface SpawnOptionsExt {
  windowsVerbatimArguments?: boolean;
}

export interface ShellSpec {
  shell: string;
  args: string[];
  /** win32 下 shellFor 返回 verbatim，调用方 spawn 时透传（防 cmd /c 拆坏命令内引号） */
  options?: SpawnOptionsExt;
}

export interface PlatformAdapter {
  readonly platform: NodeJS.Platform;
  /** 一次性命令执行 shell：win32 → cmd.exe /d /s /c（verbatim 保引号）；POSIX → /bin/sh -c */
  shellFor(command: string): ShellSpec;
  /** 交互式终端 shell：win32 → powershell.exe -NoLogo；POSIX → /bin/bash */
  interactiveShell(): ShellSpec;
  /** 进程树终止（fire-and-forget）：win32 → taskkill /T /F 按 PID（不按名称，防误杀外部进程）；POSIX → pkill 子树 + SIGKILL 本体 */
  killTree(pid: number): void;
  /** 进程树终止（可等待）：调用方需要确认退出后再清理状态时使用 */
  killTreeWait(pid: number, timeoutMs?: number): Promise<void>;
  /** 命令解析：win32 给无扩展名命令补 .cmd/.exe/.bat（npm 等脚本实为 .cmd）；POSIX 原样返回 */
  resolveCommand(command: string): string;
  /** 压缩包解压：win32 → PowerShell Expand-Archive（.zip）；POSIX → unzip -o（.zip）；不支持类型抛错 */
  extractArchive(archivePath: string, dest: string): void;

  /** 进程存活探测：win32 → tasklist 过滤 PID；POSIX → kill(pid, 0) 信号探测 */
  pidAlive(pid: number): boolean;

  /** 工具发现程序名：win32 → where；POSIX → which */
  whichProgram(): string;
}

class Win32Adapter implements PlatformAdapter {
  readonly platform = 'win32' as const;

  shellFor(command: string): ShellSpec {
    // /s 修改引号剥离规则 + verbatim：命令内的双引号（如 node -e "..."）原样传给 cmd，不再被拆坏
    return { shell: 'cmd.exe', args: ['/d', '/s', '/c', command], options: { windowsVerbatimArguments: true } };
  }

  interactiveShell(): ShellSpec {
    return { shell: 'powershell.exe', args: ['-NoLogo'] };
  }

  killTree(pid: number): void {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  }

  async killTreeWait(pid: number, timeoutMs = 10_000): Promise<void> {
    await execP(`taskkill /T /F /PID ${pid}`, { timeout: timeoutMs, windowsHide: true });
  }

  resolveCommand(command: string): string {
    if (/\.(exe|cmd|bat)$/i.test(command)) return command;
    return `${command}.cmd`;
  }

  whichProgram(): string {
    return 'where';
  }

  /**
   * 进程存活探测：libuv 的 uv_kill(pid, 0) → OpenProcess + CloseHandle，单次 ~0.05ms 且不阻塞事件循环。
   * 旧实现每次 execSync('tasklist') 实测 ~150ms 同步阻塞（停服务轮询里每 80~100ms 调一次，
   * 会把整个 Nest 事件循环卡死，导致停止请求与随后刷新请求排队 —— 「点停止反应慢」的主因之一）。
   */
  pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM：进程存在但当前用户无权 signal；ESRCH / 其他：进程已不存在
      return (e as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  }

  extractArchive(archivePath: string, dest: string): void {
    if (!/\.zip$/i.test(archivePath)) {
      throw new Error(`unsupported archive type: ${archivePath}（首版支持 .zip）`);
    }
    execSync(
      `powershell -NoProfile -Command Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(dest)} -Force`,
      { stdio: 'pipe' },
    );
  }
}

class PosixAdapter implements PlatformAdapter {
  readonly platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform) {
    this.platform = platform;
  }

  shellFor(command: string): ShellSpec {
    return { shell: '/bin/sh', args: ['-c', command] };
  }

  interactiveShell(): ShellSpec {
    return { shell: '/bin/bash', args: [] };
  }

  killTree(pid: number): void {
    // 先杀子树（pkill -P 只处理直接子进程），再终止本体
    spawn('pkill', ['-TERM', '-P', String(pid)], { windowsHide: true });
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 进程已退出视为成功
    }
  }

  async killTreeWait(pid: number, timeoutMs = 10_000): Promise<void> {
    spawn('pkill', ['-TERM', '-P', String(pid)], { windowsHide: true });
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已退出
    }
    void timeoutMs;
  }

  resolveCommand(command: string): string {
    return command;
  }

  whichProgram(): string {
    return 'which';
  }

  pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  extractArchive(archivePath: string, dest: string): void {
    if (!/\.zip$/i.test(archivePath)) {
      throw new Error(`unsupported archive type: ${archivePath}（首版支持 .zip）`);
    }
    execSync(`unzip -o ${JSON.stringify(archivePath)} -d ${JSON.stringify(dest)}`, { stdio: 'pipe' });
  }
}

/** 按平台构造适配器；未知平台归入 POSIX 家族（darwin/linux） */
export function createPlatformAdapter(platform: NodeJS.Platform = process.platform): PlatformAdapter {
  return platform === 'win32' ? new Win32Adapter() : new PosixAdapter(platform);
}

/** 后端单例：进程平台固定，导出共享实例避免重复构造 */
/**
 * 为被托管的子进程清理「宿主注入」的环境变量。
 *
 * 真实故障（AIHOT-main 前端起不来）：DevPilot 后端本身是被编辑器/Agent 宿主拉起的，
 * 宿主的 NODE_OPTIONS 里挂了 safe-delete shim；spawn 项目服务时 `{...process.env}` 原样继承，
 * 于是 react-router 的 typegen 删 `.react-router/types`（83 项）时被 shim 拦下抛错，
 * 开发服务器直接 exit 1 —— 用户看到的是「项目启动失败」，实际是宿主注入污染。
 *
 * 规则：默认剔除宿主注入（NODE_OPTIONS / ELECTRON_RUN_AS_NODE 等），除非调用方在服务 env 里
 * 显式给出，或设 DEVIPILOT_KEEP_NODE_OPTIONS=1 保留。
 */
export function cleanServiceEnv(
  base: NodeJS.ProcessEnv,
  extra?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...(extra ?? {}) };
  const keepNodeOptions = process.env.DEVIPILOT_KEEP_NODE_OPTIONS === '1';
  const injected = Object.keys(env).filter((k) => {
    if (extra && Object.prototype.hasOwnProperty.call(extra, k)) return false; // 服务显式配置的保留
    if (k === 'ELECTRON_RUN_AS_NODE') return true;
    if (k === 'NODE_OPTIONS') return !keepNodeOptions;
    // 宿主的 shim/诊断注入（如 NODE_REPL_EXTERNAL_MODULE / 各类 *_SHIM）
    if (k.endsWith('_SHIM') || k === 'NODE_REPL_EXTERNAL_MODULE') return true;
    return false;
  });
  for (const k of injected) delete env[k];
  return env;
}

export const platform = createPlatformAdapter();

export { credentials, createCredentialStore } from './credential-store';
export type { CredentialStore } from './credential-store';
