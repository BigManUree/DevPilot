import { spawn, exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(exec);

/**
 * 跨平台适配层（需求 3.3 / 设计文档集 §05）：
 * 把 OS 差异（shell、路径、进程树、命令解析、工具发现）收敛到一个接口后面，
 * backend 服务不再散落 process.platform 分支；macOS/Linux 适配只需新增实现。
 */

export interface ShellSpec {
  shell: string;
  args: string[];
}

export interface PlatformAdapter {
  readonly platform: NodeJS.Platform;
  /** 一次性命令执行 shell：win32 → cmd.exe /c；POSIX → /bin/sh -c */
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
    return { shell: 'cmd.exe', args: ['/c', command] };
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

  pidAlive(pid: number): boolean {
    try {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { windowsHide: true }).toString();
      return out.includes(String(pid));
    } catch {
      return false;
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
export const platform = createPlatformAdapter();
