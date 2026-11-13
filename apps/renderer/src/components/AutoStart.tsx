import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, notification, Space, Tag, Typography, message } from 'antd';
import { api } from '../api';

/**
 * 启动闭环的 UI 侧封装（点击「启动」按钮触发）。
 *
 * 流程：检测启动方式 → 启动 → 失败则抓日志让 Agent 自动修复（如安装依赖）→ 重试。
 * 修复类操作（装依赖、下载等）耗时可能较长，这里会在出现该类步骤时弹通知提醒用户。
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
  detect: '检测',
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
  // 耗时修复提醒：一次启动只提醒一次，避免刷屏
  const slowFixNotified = useRef(false);
  // 已提醒过的步骤下标，防止轮询重复计数
  const seenStepCount = useRef(0);
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
        // 新步骤里出现修复 / 安装依赖类操作时，弹通知提醒「耗时可能较长」
        if (j.steps.length > seenStepCount.current) {
          const fresh = j.steps.slice(seenStepCount.current);
          seenStepCount.current = j.steps.length;
          const slow = fresh.find(
            (s) => s.phase === 'repair' || /安装|依赖|下载|install|下载/i.test(s.message),
          );
          if (slow && !slowFixNotified.current) {
            slowFixNotified.current = true;
            notification.warning({
              message: `${j.projectName}：正在自动修复启动问题`,
              description: `${slow.message}\n这类修复（如安装依赖、下载组件）可能耗时较长，可先处理其他事情；完成后会自动重试启动并在状态栏提示结果。`,
              placement: 'bottomRight',
              duration: 10,
            });
          }
        }
        setJob(j);
        if (j.status !== 'Running') {
          stop();
          if (j.status === 'Success') message.success(`项目 ${j.projectName} 已成功启动${j.port ? `（端口 ${j.port}）` : ''}`);
          else message.error(`项目 ${j.projectName} 启动失败，详见弹窗里的修复过程与最后一次日志`);
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
    slowFixNotified.current = false;
    seenStepCount.current = 0;
    setJob({
      id: '', projectId, projectName, status: 'Running',
      startedAt: new Date().toISOString(), attempt: 0, maxAttempts: 3, steps: [],
    });
    try {
      const r = await api<{ jobId: string }>(`/projects/${projectId}/autostart`, 'POST');
      poll(r.jobId);
    } catch (e: any) {
      setJob((j) => (j ? { ...j, status: 'Failed', report: e?.message ?? String(e) } : j));
      message.error('发起启动失败：' + (e?.message ?? String(e)));
    }
  }, [poll]);

  const node = (
    <Modal
      open={open}
      title={job ? `启动项目 · ${job.projectName}` : '启动项目'}
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

          <div className="dp-code-block" style={{ maxHeight: 400 }}>
            {job.steps.length === 0 && <Typography.Text type="secondary">正在检测启动方式…</Typography.Text>}
            {job.steps.map((s, i) => (
              <div key={i} className="dp-job-step">
                <Space size={6} align="start">
                  <Tag color={PHASE_COLOR[s.phase] ?? 'default'} style={{ marginInlineEnd: 0 }}>{PHASE_LABEL[s.phase] ?? s.phase}</Tag>
                  <div>
                    <div style={{ fontSize: 12 }}>{s.message}</div>
                    {s.detail && <pre className="dp-mono" style={{ margin: '4px 0 0', color: 'var(--dp-text-2)', whiteSpace: 'pre-wrap' }}>{s.detail}</pre>}
                  </div>
                </Space>
              </div>
            ))}
          </div>

          {job.status !== 'Running' && (
            <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
              启动时优先使用项目自带的启动脚本；遇到问题会由 Agent 自动检测并修复（安装依赖 / 换解释器 / 改启动命令）后重试。
            </Typography.Paragraph>
          )}
        </div>
      )}
    </Modal>
  );

  return { run, node, job, open };
}
