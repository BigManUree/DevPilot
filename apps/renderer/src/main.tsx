import React from 'react';
import ReactDOM from 'react-dom/client';
import { message } from 'antd';
import App from './App';

/** 全局兜底：未捕获的异步错误（多为旧页面未 try/catch 的 API 失败）以 toast 呈现，不静默吞掉 */
window.addEventListener('unhandledrejection', (e) => {
  const reason = (e as PromiseRejectionEvent).reason;
  const text = reason instanceof Error ? reason.message : String(reason ?? '未知错误');
  message.error(text);
  (e as PromiseRejectionEvent).preventDefault();
});

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
