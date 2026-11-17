import React from 'react';
import ReactDOM from 'react-dom/client';
import { message } from 'antd';
import App from './App';

/** 启动计时桥（主进程 startup-trace）；非 Electron 环境（浏览器 dev）下不生效 */
const startupMark = (mark: string): void => {
  try {
    const dp = (window as unknown as { devpilot?: { startupMark?: (m: string) => Promise<void> } }).devpilot;
    void dp?.startupMark?.(mark);
  } catch { /* 计时失败不影响启动 */ }
};

startupMark('bundleEvaluated');

/** 全局兜底：未捕获的异步错误（多为旧页面未 try/catch 的 API 失败）以 toast 呈现，不静默吞掉 */
window.addEventListener('unhandledrejection', (e) => {
  const reason = (e as PromiseRejectionEvent).reason;
  const text = reason instanceof Error ? reason.message : String(reason ?? '未知错误');
  message.error(text);
  (e as PromiseRejectionEvent).preventDefault();
});

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);

// 首帧：连续两个 rAF 之后的那一帧才是「用户真正看到内容」的帧（单个 rAF 只保证样式已计算）
requestAnimationFrame(() => {
  requestAnimationFrame(() => startupMark('firstPaint'));
});
