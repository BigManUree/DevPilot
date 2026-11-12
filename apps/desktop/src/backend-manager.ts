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
    // __dirname = apps/desktop/dist → ../.. = apps → apps/backend/dist/main.js
    // （旧版多算一级到仓库根，导致 DevPilot\backend\... MODULE_NOT_FOUND）
    return path.join(__dirname, '../../backend/dist/main.js');
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
    // 打包态：electron.exe 自身当 node（ELECTRON_RUN_AS_NODE=1），better-sqlite3 已按 Electron ABI
    //   重编译并放在 asarUnpack，直接可用。
    // 开发态：必须用系统 node——electron 内置 Node 的 ABI 与仓库里 better-sqlite3 产物不匹配
    //   （实测 NODE_MODULE_VERSION 130 vs 127），重编译会让 CLI 侧又加载不了，两态用不同运行时。
    const isPackaged = app.isPackaged;
    const cmd = isPackaged ? process.execPath : 'node';
    const env: NodeJS.ProcessEnv = { ...process.env, DEVIPILOT_BACKEND_PORT: String(this.port) };
    if (isPackaged) env.ELECTRON_RUN_AS_NODE = '1';
    else delete env.ELECTRON_RUN_AS_NODE;
    // 外部注入的 NODE_OPTIONS（如宿主 CLI 的 --require shim）在打包态会被 Electron 拒绝，
    // 导致后端进程直接退出；后端不需要这些注入，统一剔除。
    delete env.NODE_OPTIONS;
    this.proc = spawn(cmd, [entry], {
      env,
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
