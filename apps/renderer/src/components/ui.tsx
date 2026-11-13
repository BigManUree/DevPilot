import React from 'react';
import { Button, Card, Spin, Tag, Typography } from 'antd';
import { monoFont } from '../theme';

export const statusColor: Record<string, string> = {
  Running: 'green', Starting: 'blue', Stopping: 'orange', registered: 'green',
  Failed: 'red', Unhealthy: 'volcano', Stopped: 'default', Unknown: 'default',
  Completed: 'green', Pending: 'default', Preparing: 'blue', WaitingApproval: 'orange',
  Paused: 'orange', WaitingInput: 'purple', Cancelled: 'default', PASSED: 'green', PARTIAL: 'orange',
};

const statusText: Record<string, string> = {
  Running: '运行中', Starting: '启动中', Stopping: '停止中', Failed: '失败', Unhealthy: '异常',
  Stopped: '已停止', Unknown: '未知', Completed: '已完成', Pending: '待执行', Preparing: '准备中',
  WaitingApproval: '待审批', Paused: '已暂停', WaitingInput: '等待输入', Cancelled: '已取消',
  PASSED: '通过', PARTIAL: '部分通过', registered: '已注册',
};

export function StatusTag({ status, text }: { status: string; text?: string }) {
  return <Tag className="dp-status-tag" color={statusColor[status] ?? 'default'} title={status}>{text ?? statusText[status] ?? status}</Tag>;
}

export function PageHeader({ title, description, extra, eyebrow }: {
  title: string; description?: string; extra?: React.ReactNode; eyebrow?: string;
}) {
  return (
    <header className="dp-page-header">
      <div className="dp-page-heading">
        {eyebrow && <div className="dp-eyebrow">{eyebrow}</div>}
        <Typography.Title level={2}>{title}</Typography.Title>
        {description && <p className="dp-desc">{description}</p>}
      </div>
      {extra && <div className="dp-page-actions">{extra}</div>}
    </header>
  );
}

export function SectionCard({ title, extra, children, style, className = '' }: {
  title?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode;
  style?: React.CSSProperties; className?: string;
}) {
  return <Card size="small" title={title} extra={extra} style={style} className={`dp-section-card ${className}`}>{children}</Card>;
}

export function StateBlock({ loading, error, empty, emptyText, onRetry, children }: {
  loading?: boolean; error?: string | null; empty?: boolean;
  emptyText?: string; onRetry?: () => void; children: React.ReactNode;
}) {
  if (loading) return <div className="dp-loading"><Spin size="small" /><span>正在加载工作区数据</span></div>;
  if (error) return (
    <div className="dp-state dp-state-error" role="alert">
      <div className="dp-state-title">暂时无法加载</div>
      <div className="dp-state-copy">{error}</div>
      {onRetry && <Button size="small" onClick={onRetry}>重新加载</Button>}
    </div>
  );
  if (empty) return (
    <div className="dp-state dp-state-empty">
      <div className="dp-empty-mark" aria-hidden="true">—</div>
      <div className="dp-state-title">{emptyText ?? '暂无数据'}</div>
    </div>
  );
  return <>{children}</>;
}

export function Mono({ children, title }: { children: React.ReactNode; title?: string }) {
  return <span className="dp-mono" title={title} style={{ fontFamily: monoFont }}>{children}</span>;
}

export function MetricCard({ label, value, hint, icon, tone = 'blue' }: {
  label: string; value: React.ReactNode; hint?: string; icon?: React.ReactNode; tone?: string;
}) {
  return (
    <div className={`dp-metric dp-metric-${tone}`}>
      <div className="dp-metric-top"><span>{label}</span>{icon && <span className="dp-metric-icon">{icon}</span>}</div>
      <div className="dp-metric-value">{value}</div>
      {hint && <div className="dp-metric-hint">{hint}</div>}
    </div>
  );
}
