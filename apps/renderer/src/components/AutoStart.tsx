import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Space, Tag, Typography, message } from 'antd';
import { api } from '../api';

/**
 * 一键自动启动（导入后闭环）的 UI 侧封装。
 *
 * 流程：导入项目 → 后端识别自带启动脚本（没有则让 Agent 分析启动方式）→ 启动
 * → 失败则抓日志让 Agent 自动修复 → 重试（最多 3 次）→ 成功通知。
 * 这里只负责发起任务、轮询进度并把每一步显示出来。
 */

export interface AutoStartStep {
  at: string;
  phase: 'detect' | 'start' | 'repair' | 'retry' | 'done' | 'failed';
  message: string;
  detail?: string;
}

export interface AutoStartJob {
  id: string;
  projectId: string;
  projectName: string;
  status: 'Running' | 'Success' | 'Failed';
  startedAt: string;
  finishedAt?: string;
  attempt: number;
  maxAttempts: number;
  command?: string | null;
  port?: number | null;
  pid?: number;
  report?: string;
  steps: AutoStartStep[];
}

const PHASE_LABEL: Record<string, string> = {
  detect: '识别',
  start: '启动',
  retry: '重试',
  repair: '自动修复',
  done: '完成',
  failed: '失败',
};

const PHASE_COLOR: Record<string, string> = {
  detect: 'default',
  start: 'blue',
  retry: 'orange',
  repair: 'purple',
  done: 'green',
  failed: 'red',
};

export function useAutoStart() {
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<AutoStartJob | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => () => stop(), [stop]);

  const poll = useCallback((jobId: string) => {
    stop();
    const tick = async () => {
      try {
        const j = await api<AutoStartJob>(`/autostart/${jobId}`);
        if (!j || (j as unknown as { error?: string }).error) return;
        setJob(j);
        if (j.status !== 'Running') {
          stop();
          if (j.status === 'Success') message.success(`项目 ${j.projectName} 已成功启动${j.port ? `（端口 ${j.port}）` : ''}`);
          else message.error(`项目 ${j.projectName} 自动启动失败，详见弹窗里的最后一次日志`);
        }
      } catch {
        /* 轮询失败不打断，下一轮再试 */
      }
    };
    void tick();
    timer.current = setInterval(tick, 1500);
  }, [stop]);

  const run = useCallback(async (projectId: string, projectName: string) => {
    setOpen(true);
    setJob({
      id: '', projectId, projectName, status: 'Running',
      startedAt: new Date().toISOString(), attempt: 0, maxAttempts: 3, steps: [],
    });
    try {
      const r = await api<{ jobId: string }>(`/projects/${projectId}/autostart`, 'POST');
      poll(r.jobId);
    } catch (e: any) {
      setJob((j) => (j ? { ...j, status: 'Failed', report: e?.message ?? String(e) } : j));
      message.error('发起自动启动失败：' + (e?.message ?? String(e)));
    }
  }, [poll]);

  const node = (
    <Modal
      open={open}
      title={job ? `自动启动 · ${job.projectName}` : '自动启动'}
      onCancel={() => { stop(); setOpen(false); }}
      footer={null}
      width={720}
      destroyOnClose
    >
      {job && (
        <div>
          <Space size={8} wrap style={{ marginBottom: 12 }}>
            <Tag color={job.status === 'Success' ? 'green' : job.status === 'Failed' ? 'red' : 'blue'}>
              {job.status === 'Running' ? `进行中（第 ${Math.max(job.attempt, 1)}/${job.maxAttempts} 次）` : job.status === 'Success' ? '已启动' : '失败'}
            </Tag>
            {job.command && <Typography.Text type="secondary" style={{ fontSize: 12 }}>命令：<code>{job.command}</code></Typography.Text>}
            {job.port ? <Tag>端口 {job.port}</Tag> : null}
            {job.pid ? <Tag>PID {job.pid}</Tag> : null}
          </Space>

          <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid var(--dp-border)', borderRadius: 8, padding: 12, background: 'var(--dp-code-bg)' }}>
            {job.steps.length === 0 && <Typography.Text type="secondary">正在识别项目…</Typography.Text>}
            {job.steps.map((s, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <Space size={6} align="start">
                  <Tag color={PHASE_COLOR[s.phase] ?? 'default'} style={{ marginInlineEnd: 0 }}>{PHASE_LABEL[s.phase] ?? s.phase}</Tag>
                  <div>
                    <div style={{ fontSize: 13 }}>{s.message}</div>
                    {s.detail && (
                      <pre className="dp-mono" style={{ margin: '4px 0 0', fontSize: 12, whiteSpace: 'pre-wrap', color: 'var(--dp-text-2)' }}>{s.detail}</pre>
                    )}
                  </div>
                </Space>
              </div>
            ))}
          </div>

          {job.status !== 'Running' && (
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
              自动启动会优先使用项目自带的一键脚本；失败时由 Agent 自动修复（安装依赖 / 换解释器 / 改启动命令）后重试，最多 3 次。
            </Typography.Paragraph>
          )}
        </div>
      )}
    </Modal>
  );

  return { run, node, job, open };
}
