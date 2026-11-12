import React from 'react';
import { Card, Tag, Typography, Spin, Button } from 'antd';
import { colors, monoFont } from '../theme';

/** 状态色统一映射（服务 / 任务 / 工作流共用） */
export const statusColor: Record<string, string> = {
  Running: 'green', Starting: 'blue', Stopping: 'orange',
  Failed: 'red', Unhealthy: 'volcano', Stopped: 'default', Unknown: 'default',
  Completed: 'green', Pending: 'default', Preparing: 'blue', WaitingApproval: 'orange',
  Paused: 'orange', WaitingInput: 'purple',
  Failed_: 'red', Cancelled: 'default', PASSED: 'green', PARTIAL: 'orange',
};

/** 状态中文名（Tag 悬停保留英文原值，便于对照日志与接口） */
const statusText: Record<string, string> = {
  Running: '运行中', Starting: '启动中', Stopping: '停止中', Failed: '失败', Unhealthy: '异常',
  Stopped: '已停止', Unknown: '未知', Completed: '已完成', Pending: '待执行', Preparing: '准备中',
  WaitingApproval: '待审批', Paused: '已暂停', WaitingInput: '等待输入', Cancelled: '已取消',
  PASSED: '通过', PARTIAL: '部分通过',
};

export function StatusTag({ status, text }: { status: string; text?: string }) {
  return (
    <Tag color={statusColor[status] ?? 'default'} style={{ marginInlineEnd: 0 }} title={status}>
      {text ?? statusText[status] ?? status}
    </Tag>
  );
}

/** 页面标题区：标题 + 说明 + 右侧操作，所有页面统一入口 */
export function PageHeader({ title, description, extra }: {
  title: string; description?: string; extra?: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{title}</Typography.Title>
        {description && <p className="dp-desc">{description}</p>}
      </div>
      {extra && <div style={{ flex: 'none' }}>{extra}</div>}
    </div>
  );
}

/** 白底细边分区卡 */
export function SectionCard({ title, extra, children, style }: {
  title?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties;
}) {
  return <Card size="small" title={title} extra={extra} style={style}>{children}</Card>;
}

/** 加载 / 错误 / 空三态占位（成功时渲染 children） */
export function StateBlock({ loading, error, empty, emptyText, onRetry, children }: {
  loading?: boolean; error?: string | null; empty?: boolean;
  emptyText?: string; onRetry?: () => void; children: React.ReactNode;
}) {
  if (loading) return <div style={{ padding: '32px 0', textAlign: 'center' }}><Spin size="small" /></div>;
  if (error) {
    return (
      <div style={{ padding: '16px 14px', background: '#FEF3F2', border: '1px solid #FECDCA', borderRadius: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: colors.danger }}>加载失败</div>
        <div style={{ fontSize: 12, color: colors.textSecondary, marginTop: 4 }}>{error}</div>
        {onRetry && <Button size="small" style={{ marginTop: 10 }} onClick={onRetry}>重试</Button>}
      </div>
    );
  }
  if (empty) {
    return (
      <div style={{ padding: '24px 0', textAlign: 'center', color: colors.textTertiary, fontSize: 13 }}>
        {emptyText ?? '暂无数据'}
      </div>
    );
  }
  return <>{children}</>;
}

/** 等宽路径/命令文本 */
export function Mono({ children, title }: { children: React.ReactNode; title?: string }) {
  return <span className="dp-mono" title={title} style={{ fontFamily: monoFont }}>{children}</span>;
}
