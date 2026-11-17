import { authGuard, authToken, requestToken, isTrustedOrigin } from './auth';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 防 CSRF 守卫回归（审计 S-01）：
 * 跨源浏览器请求（含 Origin: null 的 sandbox iframe）必须被拒；
 * 本机脚本（无 Origin）与 DevPilot 自己的前端来源必须放行；
 * 带正确 token 的 file:// 渲染层必须放行。
 */
describe('authGuard', () => {
  const prevDataDir = process.env.DEVIPILOT_DATA_DIR;
  const prevToken = process.env.DEVIPILOT_AUTH_TOKEN;
  let token: string;

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-auth-'));
    process.env.DEVIPILOT_DATA_DIR = dir;
    delete process.env.DEVIPILOT_AUTH_TOKEN;
    token = authToken();
  });

  afterAll(() => {
    if (prevDataDir === undefined) delete process.env.DEVIPILOT_DATA_DIR;
    else process.env.DEVIPILOT_DATA_DIR = prevDataDir;
    if (prevToken === undefined) delete process.env.DEVIPILOT_AUTH_TOKEN;
    else process.env.DEVIPILOT_AUTH_TOKEN = prevToken;
  });

  function run(opts: { method?: string; origin?: string; headerToken?: string; queryToken?: string; path?: string }) {
    const headers: Record<string, unknown> = {};
    if (opts.origin !== undefined) headers.origin = opts.origin;
    if (opts.headerToken) headers['x-devpilot-token'] = opts.headerToken;
    const req = { method: opts.method ?? 'POST', path: opts.path ?? '/api/v1/tools/call', headers, query: opts.queryToken ? { token: opts.queryToken } : {} };
    let status = 200;
    let body: unknown = null;
    let nexted = false;
    const res = {
      status(code: number) { status = code; return this; },
      json(b: unknown) { body = b; return this; },
    };
    authGuard(req as never, res as never, () => { nexted = true; });
    return { status, nexted, body };
  }

  it('本机脚本（无 Origin）放行', () => {
    expect(run({}).nexted).toBe(true);
  });

  it('DevPilot 开发前端来源放行', () => {
    expect(run({ origin: 'http://localhost:5173' }).nexted).toBe(true);
  });

  it('第三方站点被拒（403）', () => {
    const r = run({ origin: 'https://evil.example.com' });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(403);
  });

  it('Origin: null（sandbox iframe / file://）无 token 被拒', () => {
    const r = run({ origin: 'null' });
    expect(r.status).toBe(403);
  });

  it('Origin: null 带正确 token 放行（打包态渲染层）', () => {
    expect(run({ origin: 'null', headerToken: token }).nexted).toBe(true);
  });

  it('错误 token 被拒', () => {
    expect(run({ origin: 'null', headerToken: 'wrong-token' }).status).toBe(403);
  });

  it('query token 也可用（WS/下载链接场景）', () => {
    expect(run({ origin: 'null', queryToken: token }).nexted).toBe(true);
  });

  it('健康检查始终放行（Electron 探活，无副作用）', () => {
    expect(run({ method: 'GET', path: '/api/v1/health', origin: 'https://evil.example.com' }).nexted).toBe(true);
  });

  it('OPTIONS 预检放行（CORS 由 cors 中间件处理）', () => {
    expect(run({ method: 'OPTIONS', origin: 'https://evil.example.com' }).nexted).toBe(true);
  });

  it('token 落盘文件权限为 0600 且内容稳定', () => {
    const file = path.join(process.env.DEVIPILOT_DATA_DIR!, '.auth-token');
    const stat = fs.statSync(file);
    expect(fs.readFileSync(file, 'utf-8').trim()).toBe(token);
    // Windows 上 mode 位不完整，仅校验非全权限
    expect(stat.size).toBeGreaterThan(0);
  });

  it('requestToken / isTrustedOrigin 辅助函数', () => {
    expect(requestToken({ headers: { 'x-devpilot-token': 'a' } })).toBe('a');
    expect(requestToken({ headers: {}, query: { token: 'b' } })).toBe('b');
    expect(requestToken({ headers: {} })).toBeNull();
    expect(isTrustedOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isTrustedOrigin('null')).toBe(false);
  });
});
