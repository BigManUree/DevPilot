import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Modal, notification, Space, Tag, Typography, Button, message } from 'antd';
import { api } from '../api';

/**
 * 启动闭环的 UI 侧封装（点击「启动」按钮触发）。支持多个项目同时启动。
 *
 * 后台执行契约（关键）：
 * - 每个项目一条独立的启动任务，互不干扰：A 项目启动中也可以启动 B 项目；
 * - 弹窗只是"观察窗口"，关闭弹窗（点遮罩 / 点 X / 按 Esc）绝不终止启动任务；
 * - 每条任务各自轮询，直到成功 / 失败 / 取消；
 * - 任务结束时无论弹窗是否开着，都会弹出成功 / 失败通知；
 * - 弹窗关闭且任务仍在进行时，右下角为每条进行中的任务各显示一条悬浮状态条，
 *   点击可重新打开对应弹窗查看实时日志；
 * - 项目卡片/表格的「启动中…」状态持续到任务完全成功（Success）才消失。
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
  status: 'Running' | 'Success' | 'Failed' | 'Cancelled';
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

const POLL_INTERVAL_MS = 1500;

export function useAutoStart() {
  /** 所有任务，按 projectId 索引（同一项目同时只允许一条启动任务） */
  const [jobs, setJobs] = useState<Record<string, AutoStartJob>>({});
  /** 当前打开弹窗的项目 id；null = 弹窗关闭（任务继续后台跑） */
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);

  // jobs 的实时镜像：轮询定时器里读，避免闭包拿到旧值
  const jobsRef = useRef<Record<string, AutoStartJob>>({});
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);

  // 统一轮询定时器：存在 Running 任务时启动，全部终态后停止
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 每条任务各自的辅助状态（keyed by jobId）
  const seenStepCount = useRef<Map<string, number>>(new Map());
  const slowFixNotified = useRef<Set<string>>(new Set());
  const resultNotified = useRef<Set<string>>(new Set());
  // 已自动关闭过弹窗的任务 id：取消终态弹窗自动收起，且重开查看时不重复触发
  const autoClosedJobId = useRef<Set<string>>(new Set());

  const ensurePolling = useCallback(() => {
    if (timer.current) return;
    timer.current = setInterval(() => {
      const running = Object.values(jobsRef.current).filter((j) => j.status === 'Running' && j.id);
      if (!running.length) {
        if (timer.current) { clearInterval(timer.current); timer.current = null; }
        return;
      }
      for (const j of running) void tickJob(j.id);
    }, POLL_INTERVAL_MS);
  }, []);

  const stopPolling = useCallback(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  /** 单条任务的进度更新（含通知与终态收敛）。定义在 ensurePolling 之前会被引用，用函数声明提升 */
  async function tickJob(jobId: string) {
    const cur = Object.values(jobsRef.current).find((j) => j.id === jobId);
    if (!cur || cur.status !== 'Running') return;
    try {
      const j = await api<AutoStartJob & { error?: string }>(`/autostart/${jobId}`);
      if (!j || j.error) {
        // 任务已被后端回收（取消后保留 60s 到期 / 后端重启 / 记录过期）：
        // 停止轮询该任务并把本地状态收敛为终态，避免 UI 永远停在「进行中」
        resultNotified.current.add(jobId);
        setJobs((m) => {
          const old = m[cur.projectId];
          if (!old || old.id !== jobId || old.status !== 'Running') return m;
          return { ...m, [cur.projectId]: { ...old, status: 'Cancelled', finishedAt: new Date().toISOString(), report: old.report ?? '任务已结束' } };
        });
        return;
      }
      // 新步骤里出现修复 / 安装依赖类操作时，弹通知提醒「耗时可能较长」
      const seen = seenStepCount.current.get(jobId) ?? 0;
      if (j.steps.length > seen) {
        const fresh = j.steps.slice(seen);
        seenStepCount.current.set(jobId, j.steps.length);
        // 只有真实进入修复阶段且动作明确（安装/下载依赖）才提醒「可能耗时较长」；
        // 旧正则 /安装|依赖|下载|install/ 曾把 detect 阶段「按依赖顺序启动」误判成修复。
        const slow = fresh.find(
          (s) => s.phase === 'repair' && /(安装|下载|install|npm ci|pip install|go mod|获取依赖)/i.test(s.message),
        );
        if (slow && !slowFixNotified.current.has(jobId)) {
          slowFixNotified.current.add(jobId);
          notification.warning({
            message: `${j.projectName}：正在自动修复启动问题`,
            description: `${slow.message}\n这类修复（如安装依赖、下载组件）可能耗时较长，可先处理其他事情；完成后会自动重试启动并在状态栏提示结果。`,
            placement: 'bottomRight',
            duration: 10,
          });
        }
      }
      setJobs((m) => (m[cur.projectId] && m[cur.projectId].id === jobId ? { ...m, [cur.projectId]: j } : m));
      if (j.status !== 'Running' && !resultNotified.current.has(jobId)) {
        resultNotified.current.add(jobId);
        // 无论弹窗是否开着，任务结束必须弹出明确的结果通知
        if (j.status === 'Success') {
          notification.success({
            message: `项目 ${j.projectName} 启动成功`,
            description: `${j.command ?? ''}${j.port ? ` · 端口 ${j.port}` : ''}。可在项目详情里打开访问地址。`,
            placement: 'bottomRight',
            duration: 6,
          });
        } else if (j.status === 'Cancelled') {
          notification.info({
            message: `已取消「${j.projectName}」的启动`,
            description: '启动流程已中止，已拉起的服务已停止；可随时重新点「启动」。',
            placement: 'bottomRight',
            duration: 5,
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
  }

  const run = useCallback(async (projectId: string, projectName: string) => {
    // 同一项目已在启动中：只把观察窗口切过去，不重复发起
    const existing = jobsRef.current[projectId];
    if (existing && existing.status === 'Running') {
      setOpenProjectId(projectId);
      return;
    }
    setOpenProjectId(projectId);
    seenStepCount.current.delete(projectId);
    slowFixNotified.current.delete(projectId);
    resultNotified.current.delete(projectId);
    setJobs((m) => ({
      ...m,
      [projectId]: {
        id: '', projectId, projectName, status: 'Running',
        startedAt: new Date().toISOString(), attempt: 0, maxAttempts: 6, steps: [],
      },
    }));
    try {
      const r = await api<{ jobId: string }>(`/projects/${projectId}/autostart`, 'POST');
      // 立刻把真实 jobId 落到本地状态：避免用户在首个轮询周期内点「停止启动」时 id 还是空串
      setJobs((m) => (m[projectId] ? { ...m, [projectId]: { ...m[projectId], id: r.jobId } } : m));
      ensurePolling();
      void tickJob(r.jobId);
    } catch (e: any) {
      resultNotified.current.add(projectId);
      setJobs((m) => (m[projectId] ? { ...m, [projectId]: { ...m[projectId], status: 'Failed', report: e?.message ?? String(e) } } : m));
      notification.error({
        message: `发起「${projectName}」启动失败`,
        description: e?.message ?? String(e),
        placement: 'bottomRight',
        duration: 8,
      });
    }
  }, [ensurePolling]);

  /** 项目是否正处于启动任务执行中（持续到完全启动成功为止，用于「启动中…」转圈态） */
  const isStarting = useCallback((projectId: string) => {
    const j = jobs[projectId];
    return !!j && j.status === 'Running';
  }, [jobs]);

  /**
   * 手动取消启动（点「停止启动」）：本地立即置终态（按钮与悬浮条秒消失，不等轮询），
   * 后端并行停止已拉起的服务。请求失败时回滚为进行中并可重试。
   */
  const cancelForProject = useCallback(async (projectId: string) => {
    const job = jobsRef.current[projectId];
    if (!job || job.status !== 'Running') return false;
    const jobId = job.id;
    if (!jobId) return false; // 极端窗口：启动请求刚发出、jobId 尚未回填
    resultNotified.current.add(jobId); // 取消通知由本次点击负责，轮询不再重复弹
    setJobs((m) => (m[projectId] && m[projectId].id === jobId
      ? { ...m, [projectId]: { ...m[projectId], status: 'Cancelled', finishedAt: new Date().toISOString(), report: '用户手动取消启动（正在停止已拉起的服务）' } }
      : m));
    try {
      const r = await api<{ ok: boolean; message: string }>(`/autostart/${jobId}/cancel`, 'POST');
      r.ok ? message.success(r.message) : message.warning(r.message);
      return r.ok;
    } catch (e: any) {
      // 接口失败：回滚为进行中并恢复轮询，保留再次点击取消的能力
      resultNotified.current.delete(jobId);
      setJobs((m) => (m[projectId] && m[projectId].id === jobId
        ? { ...m, [projectId]: { ...m[projectId], status: 'Running', finishedAt: undefined, report: undefined } }
        : m));
      ensurePolling();
      message.error('取消失败：' + (e?.message ?? String(e)));
      return false;
    }
  }, [ensurePolling]);

  // 取消后弹窗自动关闭：当前打开的任务变「已取消」时稍作停留即收起；每个任务只触发一次
  const openedJob = openProjectId ? jobs[openProjectId] : null;

  // ---- 启动日志自动跟随最新内容 ----
  // 规则：默认贴底；用户手动往上滚（离底部 > 48px）就停止跟随，滚回底部附近自动恢复。
  // 以「步骤数 + 任务状态 + 切换项目」为触发点，DOM 更新后一帧再滚，避免读到旧高度。
  const logRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  const [followLatest, setFollowLatest] = useState(true);

  // 直接赋值 scrollTop：不用 rAF / smooth —— 窗口被遮挡或最小化时 rAF 会被浏览器暂停，
  // 依赖它的跟随就会失效（实测：弹窗日志不再跟手）。同步赋值在任何可见性下都生效。
  const scrollLogToBottom = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const onLogScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const stick = distance <= 48;
    stickToBottom.current = stick;
    setFollowLatest(stick);
  }, []);

  const stepCount = openedJob?.steps.length ?? 0;
  const jobStatus = openedJob?.status;
  // 布局提交后立刻贴底（DOM 已经长高），避免读到上一帧的 scrollHeight
  useLayoutEffect(() => {
    if (!openProjectId || !stickToBottom.current) return;
    scrollLogToBottom();
  }, [openProjectId, stepCount, jobStatus, scrollLogToBottom]);

  // 打开弹窗时无条件贴底：上一次滚到上面，不该影响这次启动的观察位置
  useEffect(() => {
    if (!openProjectId) return;
    stickToBottom.current = true;
    setFollowLatest(true);
    const t = setTimeout(scrollLogToBottom, 0);
    return () => clearTimeout(t);
  }, [openProjectId, scrollLogToBottom]);

  useEffect(() => {
    if (openProjectId && openedJob?.status === 'Cancelled' && openedJob.id && !autoClosedJobId.current.has(openedJob.id)) {
      autoClosedJobId.current.add(openedJob.id);
      const t = setTimeout(() => setOpenProjectId(null), 1200);
      return () => clearTimeout(t);
    }
  }, [openProjectId, openedJob]);

  const node = (
    <>
      <Modal
        open={!!openProjectId && !!openedJob}
        title={openedJob ? `启动项目 · ${openedJob.projectName}${openedJob.status === 'Running' ? '（后台执行中，关闭窗口不会终止任务）' : ''}` : '启动项目'}
        onCancel={() => { setOpenProjectId(null); }}
        footer={
          openedJob?.status === 'Running' ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                后台执行中 · 成功或失败会弹通知 · 关闭此窗口不影响启动
              </Typography.Text>
              <Button size="small" type="text" danger onClick={() => void cancelForProject(openedJob.projectId)}>停止启动</Button>
            </div>
          ) : null
        }
        width={720}
      >
        {openedJob && (
          <div>
            <Space size={8} wrap style={{ marginBottom: 12 }}>
              <Tag color={openedJob.status === 'Success' ? 'green' : openedJob.status === 'Failed' ? 'red' : openedJob.status === 'Cancelled' ? 'default' : 'blue'}>
                {openedJob.status === 'Running' ? `进行中（第 ${Math.max(openedJob.attempt, 1)}/${openedJob.maxAttempts} 次）` : openedJob.status === 'Success' ? '已启动' : openedJob.status === 'Cancelled' ? '已取消' : '失败'}
              </Tag>
              {openedJob.command && <Typography.Text type="secondary" style={{ fontSize: 12 }}>命令：<code>{openedJob.command}</code></Typography.Text>}
              {openedJob.port ? <Tag>端口 {openedJob.port}</Tag> : null}
              {openedJob.pid ? <Tag>PID {openedJob.pid}</Tag> : null}
            </Space>

            <div style={{ position: 'relative' }}>
            <div
              ref={logRef}
              className="dp-code-block"
              style={{ maxHeight: 400 }}
              onScroll={onLogScroll}
            >
              {openedJob.steps.length === 0 && <Typography.Text type="secondary">正在检测启动方式…</Typography.Text>}
              {openedJob.steps.map((s, i) => (
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
            {!followLatest && (
              <Button
                size="small"
                type="primary"
                onClick={() => { stickToBottom.current = true; setFollowLatest(true); scrollLogToBottom(); }}
                style={{ position: 'absolute', right: 16, bottom: 12, boxShadow: '0 2px 8px rgba(0,0,0,.18)', zIndex: 2 }}
              >
                回到最新 ↓
              </Button>
            )}
            </div>

            {openedJob.status !== 'Running' && (
              <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
                启动后 DevPilot 会对服务做真实健康校验（页面模块能否正常编译、有无报错日志），校验失败会自动修复并重试，不会把"假启动"报成成功。
              </Typography.Paragraph>
            )}
          </div>
        )}
      </Modal>
      {/* 每条进行中的任务各一条悬浮状态条（弹窗正开着的那条不显示），纵向依次错开 */}
      {Object.values(jobs)
        .filter((j) => j.status === 'Running' && j.id && j.projectId !== openProjectId)
        .map((j, i) => (
          <div
            key={j.id}
            className="dp-start-pill"
            style={{ bottom: 24 + i * 48 }}
            onClick={() => setOpenProjectId(j.projectId)}
            role="button"
            title="点击查看启动进度与实时日志"
          >
            <span className="dp-start-pill-dot" />
            <span>「{j.projectName}」启动中… 第 {Math.max(j.attempt, 1)}/{j.maxAttempts} 次 · 点击查看进度</span>
          </div>
        ))}
    </>
  );

  return { run, node, job: openedJob, jobs, open: !!openProjectId, isStarting, cancelForProject };
}
