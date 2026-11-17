import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';
import net from 'node:net';
import fs from 'node:fs';
import { markStartup } from './startup-trace';

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

  /** 随包 Node 运行时路径（打包态存在才返回） */
  private bundledNodePath(): string | null {
    if (!app.isPackaged) return null;
    const name = process.platform === 'win32' ? 'node.exe' : 'node';
    const p = path.join(process.resourcesPath, 'backend', 'node', name);
    return fs.existsSync(p) ? p : null;
  }

  /** Node 22 模块编译缓存目录（与数据目录同级，默认 %APPDATA%/devpilot/compile-cache） */
  private compileCacheDir(): string {
    const dataDir = process.env.DEVIPILOT_DATA_DIR
      ?? path.join(process.env.APPDATA ?? app.getPath('userData'), 'devpilot', 'data');
    const dir = path.join(path.dirname(dataDir), 'compile-cache');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 建不出来就让 Node 自己处理 */ }
    return dir;
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
    if (await this.probe()) { markStartup('backend.reused'); return this.url; }

    const entry = this.backendEntry();
    // 打包态：electron.exe 自身当 node（ELECTRON_RUN_AS_NODE=1），better-sqlite3 已按 Electron ABI
    //   重编译并放在 asarUnpack，直接可用。
    // 开发态：必须用系统 node——electron 内置 Node 的 ABI 与仓库里 better-sqlite3 产物不匹配
    //   （实测 NODE_MODULE_VERSION 130 vs 127），重编译会让 CLI 侧又加载不了，两态用不同运行时。
    const isPackaged = app.isPackaged;
    // 打包态优先用随包携带的 Node 运行时（resources/backend/node/node.exe）：
    // Electron 33 内置 Node 20 跑不动 backend（undici@8 需要 Node 22 的 zstd）。
    // 找不到才回退「electron.exe + ELECTRON_RUN_AS_NODE」。
    const bundledNode = this.bundledNodePath();
    const cmd = isPackaged ? (bundledNode ?? process.execPath) : 'node';
    const env: NodeJS.ProcessEnv = { ...process.env, DEVIPILOT_BACKEND_PORT: String(this.port) };
    // 后端进程的启动计时与主进程同源：把主进程的 0 点（进程创建）绝对时间传过去，
    // 后端 phase 就能直接换算成「从用户双击到后端可服务」的毫秒数，落在同一份 trace 里。
    env.DEVIPILOT_STARTUP_T0 = String(Date.now() - Math.round(process.uptime() * 1000));
    // Node 22 模块编译缓存：后端 require 图（Nest/undici/better-sqlite3）编译约占冷启动 1.3s 中的
    // 大头，二次启动起命中 V8 code cache 可省 200~300ms（首次启动会把缓存写出来）。
    env.NODE_COMPILE_CACHE = this.compileCacheDir();
    if (isPackaged && !bundledNode) env.ELECTRON_RUN_AS_NODE = '1';
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
    markStartup('backend.spawned', { cmd: path.basename(cmd) });

    // 就绪轮询间隔 50ms：旧实现 300ms 会在「后端已 listen」和「探测到」之间白等最多 300ms，
    // 这段时间正好卡在建窗之前，属于纯浪费。
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      if (await this.probe(300)) { markStartup('backend.probed'); return this.url; }
      await new Promise((r) => setTimeout(r, 50));
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
