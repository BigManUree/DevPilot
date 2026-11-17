/** API 客户端：Electron 下经 preload 获取后端地址；浏览器开发走 localhost:37100
 *
 * 错误语义：非 2xx 与网络失败一律 throw Error(可读 message)。
 * 旧页面里「读 r.message 判断失败」的分支不再依赖——失败会抛错，
 * 未捕获的 reject 由 main.tsx 的全局兜底提示，不会静默吞掉。
 */
async function baseUrl(): Promise<string> {
  const dp = (window as unknown as { devpilot?: { getBackendUrl?: () => Promise<string> } }).devpilot;
  if (dp?.getBackendUrl) return dp.getBackendUrl();
  return 'http://127.0.0.1:37100';
}

/** 打开目录选择器：Electron 用系统对话框；浏览器经后端目录浏览兜底（dirPicker.tsx）。取消返回 null */
export async function pickDirectory(): Promise<string | null> {
  const dp = (window as unknown as { devpilot?: { pickDirectory?: () => Promise<string | null> } }).devpilot;
  if (dp?.pickDirectory) return dp.pickDirectory();
  const m = await import('./dirPicker');
  return m.pickDirectoryInBrowser();
}

/** 本机 API token：Electron 下由 preload 提供（后端写入 data 目录），浏览器开发模式可能为 null */
let tokenPromise: Promise<string | null> | null = null;

export function authToken(): Promise<string | null> {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      const dp = (window as unknown as { devpilot?: { getAuthToken?: () => Promise<string | null> } }).devpilot;
      try {
        if (dp?.getAuthToken) return (await dp.getAuthToken()) ?? null;
      } catch { /* 取不到就按匿名处理（开发前端有 Origin 白名单兜底） */ }
      return null;
    })();
  }
  return tokenPromise;
}

function pickMessage(data: unknown, status: number, statusText: string): string {
  if (data && typeof data === 'object') {
    const d = data as { message?: unknown; error?: unknown };
    const raw = d.message ?? d.error;
    if (Array.isArray(raw)) return raw.join('；');
    if (typeof raw === 'string' && raw.trim()) return raw;
  }
  if (typeof data === 'string' && data.trim()) return data.trim().slice(0, 200);
  return `请求失败（HTTP ${status}${statusText ? ' ' + statusText : ''}）`;
}

/** 网络层失败（连接拒绝/超时等）——与业务 HTTP 错误区分：只有这类才值得重试 */
class NetworkError extends Error {}

/**
 * 后端就绪门：窗口先于后端打开（冷启动优化），此时发请求只会拿到 ECONNREFUSED。
 * 所有请求先等这里放行，避免「启动瞬间一堆连接失败 toast」，也让首屏骨架能正常显示。
 */
let readyGate: Promise<void> | null = null;

export function whenBackendReady(): Promise<void> {
  if (!readyGate) {
    const dp = (window as unknown as { devpilot?: { backendReady?: () => Promise<{ ready: boolean }> } }).devpilot;
    if (!dp?.backendReady) return Promise.resolve();
    readyGate = dp.backendReady().then(() => undefined).catch(() => undefined);
  }
  return readyGate;
}

/** 首个成功响应的时刻：用于衡量「界面真正有数据」而不只是「画出了骨架」 */
let firstResponseMarked = false;

async function fetchOnce<T = unknown>(
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
): Promise<T> {
  await whenBackendReady();
  const base = await baseUrl();
  const token = await authToken();
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'X-DevPilot-Token': token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new NetworkError(`连不上后端 ${base}，请确认后端进程已启动`);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) throw new Error(pickMessage(data, res.status, res.statusText));
  if (!firstResponseMarked) {
    firstResponseMarked = true;
    try {
      const dp = (window as unknown as { devpilot?: { startupMark?: (m: string) => Promise<void> } }).devpilot;
      void dp?.startupMark?.('firstApiResponse');
    } catch { /* 计时失败忽略 */ }
  }
  return data as T;
}

export async function api<T = unknown>(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<T> {
  // GET 幂等 → 网络失败自动重试（400ms/1.2s 退避）：项目启动重负载期
  // （npm install / go build 抢 CPU）后端可能瞬时响应不过来，重试把这类
  // 瞬时故障对 UI 完全透明化；只有真正宕机才把错误暴露给页面。
  if (method === 'GET') {
    let lastErr: unknown = null;
    for (const delay of [0, 400, 1200]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        return await fetchOnce<T>(path, method, body);
      } catch (e) {
        if (!(e instanceof NetworkError)) throw e; // 业务错误不重试
        lastErr = e;
      }
    }
    throw lastErr;
  }
  return fetchOnce<T>(path, method, body);
}

export async function wsUrl(): Promise<string> {
  const base = await baseUrl();
  const token = await authToken();
  const url = base.replace(/^http/, 'ws') + '/ws';
  // file:// 渲染层的 Origin 是 null，必须带 token 才被后端 WS 守卫放行
  return token ? `${url}?token=${encodeURIComponent(token)}` : url;
}
