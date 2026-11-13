import { api } from './api';

/**
 * 环境与依赖检测结果缓存（需求 7）：
 * - App 启动时调用 primeEnvironments() 预热，之后进入页面直接读缓存，不再重复检测
 * - 页面上的「刷新」按钮走 refreshEnvironments() 强制重新检测
 */
let cache: any[] | null = null;
let inflight: Promise<any[]> | null = null;

function detect(): Promise<any[]> {
  inflight = api<any[]>('/environments')
    .then((r) => { cache = Array.isArray(r) ? r : []; return cache; })
    .catch((e) => { inflight = null; throw e; });
  return inflight;
}

/** App 启动时预热：后台静默执行，失败不影响启动流程 */
export function primeEnvironments(): void {
  if (cache || inflight) return;
  void detect().catch(() => { /* 静默，进入页面时可见错误并可手动刷新 */ });
}

/** 页面读取：命中缓存直接返回，未命中才发起检测 */
export function getCachedEnvironments(): Promise<any[]> {
  if (cache) return Promise.resolve(cache);
  return detect();
}

/** 强制重新检测（刷新按钮） */
export function refreshEnvironments(): Promise<any[]> {
  cache = null;
  return detect();
}
