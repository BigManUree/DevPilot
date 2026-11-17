import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * 本机防 CSRF 守卫（审计 S-01 / S-02 修复）。
 *
 * 威胁模型：DevPilot 后端只监听 127.0.0.1，但**任意网页**都能向本机发起请求。
 * 浏览器对跨站请求一定带 Origin 头，且无法由 JS 伪造——据此建立三档策略：
 *
 * 1. 无 Origin：非浏览器客户端（curl / 脚本 / MCP / 验收），放行（本机进程已是可信边界）。
 * 2. Origin 在开发白名单（vite 5173 / preview 4173）：放行（这是 DevPilot 自己的前端）。
 * 3. 其它任何 Origin（含 `null`，即 sandbox iframe / data: / file:）：
 *    - 必须携带有效 token（`X-DevPilot-Token` 头或 `?token=`），否则 403。
 *
 * 打包态渲染层是 file://，Origin 为 `null`，靠 preload 注入的 token 通过校验；
 * 恶意页面即使把请求发到本机，也拿不到 token（跨源拿不到 preload，也无法读取响应）。
 */

/** 允许免 token 的来源（DevPilot 自己的前端） */
export const DEV_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);

let cachedToken: string | null = null;

/** 数据目录：与 DatabaseService 保持一致（DEVIPILOT_DATA_DIR 优先） */
export function authDataDir(): string {
  return process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data');
}

/**
 * 本机 token：环境变量优先（Electron 可显式传入），否则读/写 `<dataDir>/.auth-token`。
 * 文件权限 0600；写入用临时文件 + rename 避免半截文件。
 */
export function authToken(): string {
  if (cachedToken) return cachedToken;
  const fromEnv = (process.env.DEVIPILOT_AUTH_TOKEN ?? '').trim();
  if (fromEnv) {
    cachedToken = fromEnv;
    return cachedToken;
  }
  const dir = authDataDir();
  const file = path.join(dir, '.auth-token');
  try {
    const existing = fs.readFileSync(file, 'utf-8').trim();
    if (existing) {
      cachedToken = existing;
      return cachedToken;
    }
  } catch { /* 不存在则创建 */ }
  const token = randomUUID().replace(/-/g, '');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, token, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* 文件不可写时退回进程内 token（此时仅同进程客户端可用） */
  }
  cachedToken = token;
  return token;
}

/** 取请求携带的 token（头优先，其次 query——WS/下载链接只能用 query） */
export function requestToken(req: { headers: Record<string, unknown>; query?: unknown }): string | null {
  const header = req.headers['x-devpilot-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const q = req.query as Record<string, unknown> | undefined;
  const fromQuery = q?.token;
  if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery.trim();
  return null;
}

/** 校验某个 Origin 是否可以免 token */
export function isTrustedOrigin(origin: string | undefined): boolean {
  return origin !== undefined && DEV_ORIGINS.has(origin);
}

/** Express 中间件：本机防 CSRF */
export function authGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS') return next();
  // 健康检查始终放行（Electron 启动探活用，且无副作用）
  if (req.path === '/api/v1/health') return next();

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  // 1) 非浏览器客户端（无 Origin）：本机脚本/CLI/MCP/验收
  if (origin === undefined) return next();
  // 2) DevPilot 自己的开发前端
  if (isTrustedOrigin(origin)) return next();
  // 3) 其它来源（含 'null' / file:// / 任意站点）：必须带 token
  const token = requestToken(req as unknown as { headers: Record<string, unknown>; query?: unknown });
  if (token && token === authToken()) return next();

  res.status(403).json({
    statusCode: 403,
    error: 'Forbidden',
    message: `跨来源请求被拒绝（Origin: ${origin}）。DevPilot 只接受本机前端或携带本机 token 的请求。`,
  });
}
