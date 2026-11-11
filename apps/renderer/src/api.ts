/** API 客户端：Electron 下经 preload 获取后端地址；浏览器开发走 localhost:37100 */
async function baseUrl(): Promise<string> {
  const dp = (window as unknown as { devpilot?: { getBackendUrl?: () => Promise<string> } }).devpilot;
  if (dp?.getBackendUrl) return dp.getBackendUrl();
  return 'http://127.0.0.1:37100';
}

export async function api<T = unknown>(
  path: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<T> {
  const base = await baseUrl();
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as T;
}

export async function wsUrl(): Promise<string> {
  const base = await baseUrl();
  return base.replace(/^http/, 'ws') + '/ws';
}
