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

export async function api<T = unknown>(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<T> {
  const base = await baseUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`连不上后端 ${base}，请确认后端进程已启动`);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) throw new Error(pickMessage(data, res.status, res.statusText));
  return data as T;
}

export async function wsUrl(): Promise<string> {
  const base = await baseUrl();
  return base.replace(/^http/, 'ws') + '/ws';
}
