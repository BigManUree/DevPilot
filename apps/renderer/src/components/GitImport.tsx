import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Space, Tag, Typography, message } from 'antd';
import { api } from '../api';

/**
 * 从 GitHub 导入：
 *   克隆（异步 job，可看进度）→ 识别建项目。导入完成后不自动启动，由用户在「工作台」点「启动」。
 */

type Phase = 'detect' | 'clone' | 'import' | 'start' | 'retry' | 'repair' | 'done' | 'failed';

interface Step { at: string; phase: Phase; message: string; detail?: string }

interface GitJob {
  id: string;
  status: 'Running' | 'Success' | 'Failed';
  normalizedUrl?: string;
  rootPath?: string;
  projectId?: string;
  projectName?: string;
  report?: string;
  steps: Step[];
}

const LABEL: Record<string, string> = {
  detect: '识别', clone: '克隆', import: '导入',
  start: '启动', retry: '重试', repair: '自动修复',
  done: '完成', failed: '失败',
};
const COLOR: Record<string, string> = {
  detect: 'default', clone: 'geekblue', import: 'cyan',
  start: 'blue', retry: 'orange', repair: 'purple',
  done: 'green', failed: 'red',
};

export function useGitImport() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('从 GitHub 导入');
  const [status, setStatus] = useState<'Running' | 'Success' | 'Failed'>('Running');
  const [steps, setSteps] = useState<Step[]>([]);
  const [meta, setMeta] = useState<{ url?: string; root?: string; command?: string | null; port?: number | null; pid?: number; attempt?: number; max?: number }>({});
  const [report, setReport] = useState<string>('');
  const timers = useRef<Array<ReturnType<typeof setInterval>>>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearInterval);
    timers.current = [];
  }, []);
  useEffect(() => () => clearTimers(), [clearTimers]);

  const push = useCallback((list: Step[]) => {
    if (!list?.length) return;
    setSteps((prev) => [...prev, ...list.filter((s) => !prev.some((p) => p.at === s.at && p.message === s.message))]);
  }, []);

  const run = useCallback(async (repoUrl: string, opts?: { branch?: string; targetDir?: string; name?: string }) => {
    clearTimers();
    setOpen(true);
    setStatus('Running');
    setSteps([]);
    setReport('');
    setMeta({ url: repoUrl });
    setTitle(`从 GitHub 导入 · ${repoUrl}`);

    try {
      const { jobId } = await api<{ jobId: string }>('/projects/import-git', 'POST', {
        repoUrl,
        branch: opts?.branch || undefined,
        targetDir: opts?.targetDir || undefined,
        name: opts?.name || undefined,
      });

      // 阶段一：克隆 + 识别
      const cloneTimer = setInterval(async () => {
        try {
          const j = await api<GitJob>(`/projects/import-git/${jobId}`);
          if ((j as unknown as { error?: string }).error) return;
          push(j.steps as Step[]);
          setMeta((m) => ({ ...m, root: j.rootPath ?? m.root }));

          if (j.status === 'Failed') {
            clearInterval(cloneTimer);
            timers.current = timers.current.filter((t) => t !== cloneTimer);
            setStatus('Failed');
            setReport(j.report ?? '导入失败');
            message.error('GitHub 导入失败，详见弹窗');
            return;
          }
          if (j.status === 'Success' && j.projectId) {
            clearInterval(cloneTimer);
            timers.current = timers.current.filter((t) => t !== cloneTimer);
            setMeta((m) => ({ ...m, root: j.rootPath ?? m.root }));
            setStatus('Success');
            setReport('导入完成，已进入项目列表。到「工作台」点「启动」即可运行（启动时会自动检测并修复问题）。');
            message.success('GitHub 导入完成');
            window.dispatchEvent(new CustomEvent('devpilot:projects-changed'));
          }
        } catch { /* 下一轮再试 */ }
      }, 1200);
      timers.current.push(cloneTimer);
    } catch (e: any) {
      setStatus('Failed');
      setReport(e?.message ?? String(e));
      message.error('发起导入失败：' + (e?.message ?? String(e)));
    }
  }, [clearTimers, push]);

  const node = (
    <Modal
      open={open}
      title={title}
      onCancel={() => { clearTimers(); setOpen(false); }}
      footer={null}
      width={760}
      destroyOnClose
    >
      <Space size={8} wrap style={{ marginBottom: 12 }}>
        <Tag color={status === 'Success' ? 'green' : status === 'Failed' ? 'red' : 'blue'}>
          {status === 'Running' ? '进行中' : status === 'Success' ? '导入完成' : '失败'}
        </Tag>
        {meta.root && <Typography.Text type="secondary" style={{ fontSize: 12 }}>目录：<code>{meta.root}</code></Typography.Text>}
        {meta.port ? <Tag>端口 {meta.port}</Tag> : null}
        {meta.pid ? <Tag>PID {meta.pid}</Tag> : null}
        {meta.attempt ? <Tag>{`第 ${meta.attempt}/${meta.max ?? 3} 次启动`}</Tag> : null}
      </Space>

      <div className="dp-code-block" style={{ maxHeight: 420 }}>
        {steps.length === 0 && <Typography.Text type="secondary">正在校验仓库地址…</Typography.Text>}
        {steps.map((s, i) => (
          <div key={`${s.at}-${i}`} className="dp-job-step">
            <Space size={6} align="start">
              <Tag color={COLOR[s.phase] ?? 'default'} style={{ marginInlineEnd: 0 }}>{LABEL[s.phase] ?? s.phase}</Tag>
              <div>
                <div style={{ fontSize: 12 }}>{s.message}</div>
                {s.detail && (
                  <pre className="dp-mono" style={{ margin: '4px 0 0', color: 'var(--dp-text-2)', whiteSpace: 'pre-wrap' }}>
                    {s.detail.length > 1200 ? s.detail.slice(-1200) : s.detail}
                  </pre>
                )}
              </div>
            </Space>
          </div>
        ))}
      </div>

      {status !== 'Running' && (
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
          {status === 'Success'
            ? '导入完成。可在工作台点击「启动」运行该项目。'
            : (report || '请查看上面的步骤定位失败原因。')}
        </Typography.Paragraph>
      )}
    </Modal>
  );

  return { run, node, open };
}
