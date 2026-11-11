import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';
import net from 'node:net';

/**
 * 本地后端生命周期管理（部署形态：Electron 启动后拉起或连接本地 NestJS 服务）。
 * - 开发态：直接 node 跑 apps/backend/dist/main.js
 * - 打包态：process.execPath（electron.exe）+ ELECTRON_RUN_AS_NODE=1 跑 resources/backend/dist/main.js，
 *   免单独携带 node.exe；原生模块 better-sqlite3 位于 asarUnpack 目录，Node require 正常解析
 * - 健康检查：TCP 探测 127.0.0.1:port
 * - 退出清理：app quit 时终止后端进程
 */
export class BackendManager {
  private proc: ChildProcess | null = null;

  constructor(
    private readonly port = Number(process.env.DEVIPILOT_BACKEND_PORT ?? 37100),
  ) {}

  /** 打包态 resources 目录下的后端入口；开发态仓库内相对路径 */
  private backendEntry(): string {
    if (app.isPackaged) {
      return path.join(process.resourcesPath, 'backend', 'dist', 'main.js');
    }
    return path.join(__dirname, '../../../backend/dist/main.js');
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private probe(timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.port, timeout: timeoutMs });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
      sock.once('error', () => resolve(false));
    });
  }

  /** 确保后端可用：已监听则复用，否则拉起新进程并等待就绪 */
  async ensure(maxWaitMs = 20000): Promise<string> {
    if (await this.probe()) return this.url;

    const entry = this.backendEntry();
    // 打包态用 electron.exe 自身当 node（ELECTRON_RUN_AS_NODE）；开发态 execPath 即 node.exe
    this.proc = spawn(process.execPath, [entry], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DEVIPILOT_BACKEND_PORT: String(this.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc.stdout?.on('data', (d) => console.log('[backend]', String(d).trim()));
    this.proc.stderr?.on('data', (d) => console.error('[backend:err]', String(d).trim()));
    this.proc.on('exit', (code) => console.log('[backend] exited code =', code));

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (await this.probe()) return this.url;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`backend failed to become ready within ${maxWaitMs}ms`);
  }

  /** 退出清理：终止本管理器创建的后端进程 */
  shutdown() {
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
