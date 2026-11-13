import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, notification, Space, Tag, Typography } from 'antd';
import { api } from '../api';

/**
 * 启动闭环的 UI 侧封装（点击「启动」按钮触发）。
 *
 * 后台执行契约（关键）：
 * - 弹窗只是"观察窗口"，关闭弹窗（点遮罩 / 点 X / 按 Esc）绝不终止启动任务；
 * - 轮询在后台持续进行，直到任务成功或失败；
 * - 任务结束时无论弹窗是否开着，都会弹出成功 / 失败通知；
 * - 弹窗关闭且任务仍在进行时，右下角显示悬浮状态条，点击可重新打开弹窗查看实时日志。
 *
 * 流程：检测启动方式 → 启动 → 启动后健康校验 → 失败则抓日志让 Agent 自动修复（如安装依赖）→ 重试。
 */

export interface AutoStartStep {
  at: string;
  phase: 'detect' | 'start' | 'verify' | 'repair' | 'retry' | 'done' | 'failed';
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
  verify: '校验',
  retry: '重试',
  repair: '自动修复',
  done: '完成',
  failed: '失败',
};

const PHASE_COLOR: Record<string, string> = {
  detect: 'default',
  start: 'blue',
  verify: 'cyan',
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
  // 任务是否已经通知过结果（防止重复弹通知）
  const resultNotified = useRef(false);

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
        if (j.status !== 'Running' && !resultNotified.current) {
          resultNotified.current = true;
          stop();
          // 无论弹窗是否开着，任务结束必须弹出明确的结果通知
          if (j.status === 'Success') {
            notification.success({
              message: `项目 ${j.projectName} 启动成功`,
              description: `${j.command ?? ''}${j.port ? ` · 端口 ${j.port}` : ''}。可在项目详情里打开访问地址。`,
              placement: 'bottomRight',
              duration: 6,
            });
          } else {
            notification.error({
              message: `项目 ${j.projectName} 启动失败`,
              description: `${(j.report ?? '').slice(0, 300) || '详见启动弹窗里的修复过程与最后一次日志'}（点击右下角悬浮条可查看完整过程）`,
              placement: 'bottomRight',
              duration: 8,
            });
          }
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
    resultNotified.current = false;
    setJob({
      id: '', projectId, projectName, status: 'Running',
      startedAt: new Date().toISOString(), attempt: 0, maxAttempts: 6, steps: [],
    });
    try {
      const r = await api<{ jobId: string }>(`/projects/${projectId}/autostart`, 'POST');
      poll(r.jobId);
    } catch (e: any) {
      setJob((j) => (j ? { ...j, status: 'Failed', report: e?.message ?? String(e) } : j));
      resultNotified.current = true;
      notification.error({
        message: `发起「${projectName}」启动失败`,
        description: e?.message ?? String(e),
        placement: 'bottomRight',
        duration: 8,
      });
    }
  }, [poll]);

  /** 项目是否正处于启动任务执行中（用于把「启动」按钮切换成禁用/重启态） */
  const isStarting = useCallback((projectId: string) => {
    return !!job && job.projectId === projectId && job.status === 'Running';
  }, [job]);

  const node = (
    <>
      <Modal
        open={open}
        title={job ? `启动项目 · ${job.projectName}${job.status === 'Running' ? '（后台执行中，关闭窗口不会终止任务）' : ''}` : '启动项目'}
        onCancel={() => { setOpen(false); }}
        footer={
          job?.status === 'Running'
            ? [<Typography.Text key="hint" type="secondary" style={{ fontSize: 12 }}>任务在后台持续执行，成功或失败时会弹出通知；关闭此窗口不影响启动。</Typography.Text>]
            : null
        }
        width={720}
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
                启动后 DevPilot 会对服务做真实健康校验（页面模块能否正常编译、有无报错日志），校验失败会自动修复并重试，不会把"假启动"报成成功。
              </Typography.Paragraph>
            )}
          </div>
        )}
      </Modal>
      {!open && job?.status === 'Running' && (
        <div className="dp-start-pill" onClick={() => setOpen(true)} role="button" title="点击查看启动进度与实时日志">
          <span className="dp-start-pill-dot" />
          <span>「{job.projectName}」启动中… 第 {Math.max(job.attempt, 1)}/{job.maxAttempts} 次 · 点击查看进度</span>
        </div>
      )}
    </>
  );

  return { run, node, job, open, isStarting };
}
