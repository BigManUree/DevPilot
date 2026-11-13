import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Drawer, Dropdown, Input, message, Modal, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { api, pickDirectory } from '../api';
import { useDevPilotEvents } from '../useEvents';
import { useAutoStart } from '../components/AutoStart';
import { useGitImport } from '../components/GitImport';
import { MetricCard, Mono, PageHeader, SectionCard, StateBlock, StatusTag } from '../components/ui';
import { formatTime } from '../utils';

function LogViewer({ services, refreshKey }: { services: any[]; refreshKey: number }) {
  const [lines, setLines] = useState<string[]>([]);
  // 默认只看本项目的日志（优先前端服务，其次第一个服务）；想看全部由用户手动清除筛选
  const [svcFilter, setSvcFilter] = useState<string | undefined>(() => {
    const list = services ?? [];
    return (list.find((s) => s.service_type === 'frontend') ?? list[0])?.name;
  });
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const targets = svcFilter ? [`service.${svcFilter}`] : [...(services ?? []).map((s) => `service.${s.name}`), 'autostart'];
      const parts = await Promise.all(targets.map(async (mod) => {
        try {
          const r = await api<{ tail: string }>(`/logs/tail?sourceModule=${encodeURIComponent(mod)}&lines=200`);
          if (!r.tail) return [] as Array<{ t: string; line: string }>;
          const short = svcFilter ? '' : `[${mod.replace(/^service\./, '')}] `;
          return r.tail.split('\n').filter(Boolean).map((line) => {
            const match = line.match(/^\[([^\]]+)\]/);
            return { t: match ? match[1] : '', line: match ? `${short}${line.slice(match[0].length).trimStart()}` : `${short}${line}` };
          });
        } catch { return [] as Array<{ t: string; line: string }>; }
      }));
      setLines(parts.flat().sort((a, b) => a.t.localeCompare(b.t)).map((x) => x.line));
      setError(null);
    } catch (e: any) { setError(e?.message ?? String(e)); }
  }, [svcFilter, services]);

  useEffect(() => { void load(); const timer = setInterval(() => void load(), 3000); return () => clearInterval(timer); }, [load, refreshKey]);
  useEffect(() => { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; }, [lines]);

  return (
    <div>
      <Space className="dp-toolbar" wrap>
        <Select
          allowClear
          size="small"
          placeholder="全部日志"
          style={{ width: 200 }}
          value={svcFilter}
          onChange={setSvcFilter}
          options={(services ?? []).map((s) => ({ value: s.name, label: s.name }))}
        />
        <span className="dp-desc">默认显示本项目服务日志 · 清空筛选可查看全部</span>
        <Button size="small" onClick={() => void load()}>刷新</Button>
        <span className="dp-desc">每 3 秒自动刷新 · 新日志自动滚动到底部</span>
      </Space>
      <div ref={boxRef} className="dp-log-console" role="log" aria-live="polite">
        {error && <div className="dp-log-line error">加载日志失败：{error}</div>}
        {!error && lines.length === 0 && <div className="dp-log-line">暂无运行日志。启动项目后这里会实时输出服务日志。</div>}
        {lines.map((line, index) => {
          const className = /\[ERROR\]|\[FATAL\]/.test(line) ? 'error' : /\[WARN\]/.test(line) ? 'warn' : /\[DEBUG\]/.test(line) ? 'debug' : '';
          return <div key={`${index}-${line.slice(0, 20)}`} className={`dp-log-line ${className}`}>{line}</div>;
        })}
      </div>
    </div>
  );
}

function SmallIcon({ name }: { name: 'folder' | 'play' | 'agent' | 'task' | 'git' | 'grid' | 'list' | 'star' | 'arrow' }) {
  const paths: Record<string, React.ReactNode> = {
    folder: <path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>,
    play: <path d="m8 5 11 7-11 7Z"/>,
    agent: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/></>,
    task: <><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></>,
    git: <><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-12 2-12 8"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    list: <><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3" cy="6" r=".5"/><circle cx="3" cy="12" r=".5"/><circle cx="3" cy="18" r=".5"/></>,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>,
    arrow: <path d="m9 5 7 7-7 7"/>,
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill={name === 'star' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function readList(key: string): string[] {
  try { const value = JSON.parse(localStorage.getItem(key) ?? '[]'); return Array.isArray(value) ? value.filter((x) => typeof x === 'string') : []; }
  catch { return []; }
}

/** Git 分支标签：超长分支名截断省略并悬浮显示全名，避免挤压重叠相邻列 */
function BranchTag({ branch }: { branch?: string }) {
  if (!branch) return <span className="dp-muted">—</span>;
  return (
    <Tag style={{ maxWidth: 118, display: 'inline-block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle', marginInlineEnd: 0 }} title={branch}>
      {branch}
    </Tag>
  );
}

export default function Dashboard({ selectedId, onSelect, variant = 'dashboard' }: {
  selectedId: string | null; onSelect: (id: string | null) => void; variant?: 'dashboard' | 'projects';
}) {
  const [projects, setProjects] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importPath, setImportPath] = useState('');
  const [importing, setImporting] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [view, setView] = useState<'card' | 'list'>('card');
  const [detail, setDetail] = useState<any>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [logRefreshKey, setLogRefreshKey] = useState(0);
  const [favorites, setFavorites] = useState<string[]>(() => readList('devpilot.projectFavorites'));
  const [recents, setRecents] = useState<string[]>(() => readList('devpilot.projectRecents'));
  const [gitInfo, setGitInfo] = useState<Record<string, { branch?: string; changes?: number }>>({});
  const auto = useAutoStart();
  const git = useGitImport();
  const [importTab, setImportTab] = useState('local');
  const [gitUrl, setGitUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('');
  const [gitDir, setGitDir] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api<any[]>('/projects');
      setProjects(Array.isArray(result) ? result : []);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setLoading(false); }
  }, []);

  const loadActivity = useCallback(async () => {
    const [taskResult, agentResult, approvalResult] = await Promise.allSettled([
      api<any[]>('/tasks'), api<any[]>('/agents'), api<any[]>('/approvals'),
    ]);
    if (taskResult.status === 'fulfilled') setTasks(Array.isArray(taskResult.value) ? taskResult.value : []);
    if (agentResult.status === 'fulfilled') setAgents(Array.isArray(agentResult.value) ? agentResult.value : []);
    if (approvalResult.status === 'fulfilled') setApprovals(Array.isArray(approvalResult.value) ? approvalResult.value : []);
  }, []);

  useEffect(() => { void load(); const timer = setInterval(load, 8000); return () => clearInterval(timer); }, [load]);
  useEffect(() => {
    if (variant !== 'dashboard') return;
    void loadActivity();
    const timer = setInterval(loadActivity, 8000);
    return () => clearInterval(timer);
  }, [loadActivity, variant]);

  useEffect(() => {
    let alive = true;
    const targets = projects.slice(0, 12);
    void Promise.all(targets.map(async (project) => {
      try {
        const status = await api<any>(`/git/status?repoPath=${encodeURIComponent(project.root_path)}`);
        return { id: project.id, branch: status.branch, changes: status.files?.length ?? 0 };
      } catch { return { id: project.id }; }
    })).then((rows) => {
      if (!alive) return;
      setGitInfo(Object.fromEntries(rows.map((row) => [row.id, { branch: row.branch, changes: row.changes }])));
    });
    return () => { alive = false; };
  }, [projects]);

  const openDetail = useCallback(async (id: string) => {
    try {
      const data = await api<any>(`/projects/${id}`);
      setDetail(data);
      onSelect(id);
      setLogRefreshKey((key) => key + 1);
      setRecents((current) => {
        const next = [id, ...current.filter((item) => item !== id)].slice(0, 8);
        try { localStorage.setItem('devpilot.projectRecents', JSON.stringify(next)); } catch { /* noop */ }
        return next;
      });
      const need = (data.services ?? []).filter((service: any) => service.status === 'Running' && service.port && !service.access_path);
      if (need.length > 0) {
        let changed = false;
        await Promise.all(need.map(async (service: any) => {
          try { await api(`/services/${service.id}/detect-url`, 'POST'); changed = true; } catch { /* optional probe */ }
        }));
        if (changed) {
          const fresh = await api(`/projects/${id}`);
          setDetail((current: any) => current?.project?.id === id ? fresh : current);
        }
      }
    } catch (e: any) { message.error('打开项目详情失败：' + (e?.message ?? String(e))); }
  }, [onSelect]);

  useEffect(() => { if (selectedId && !detail) void openDetail(selectedId); }, [selectedId, detail, openDetail]);
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener('devpilot:projects-changed', onChanged);
    return () => window.removeEventListener('devpilot:projects-changed', onChanged);
  }, [load]);

  const doGitImport = () => {
    if (!gitUrl.trim()) return;
    void git.run(gitUrl.trim(), { branch: gitBranch.trim() || undefined, targetDir: gitDir.trim() || undefined });
  };
  const chooseImportDir = async () => { const dir = await pickDirectory(); if (dir) setImportPath(dir); };
  const mark = (key: string, value: boolean) => setPending((current) => ({ ...current, [key]: value }));
  const busy = (key: string) => !!pending[key];

  const doImport = async () => {
    if (!importPath.trim() || importing) return;
    setImporting(true);
    try {
      const result = await api<{ projectId: string; analysis: any }>('/projects/import', 'POST', { source: 'folder', rootPath: importPath.trim() });
      message.success(`导入成功：识别 ${result.analysis.services.length} 个服务，${result.analysis.unknowns.length} 项待确认`);
      setImportPath('');
      await load();
      await openDetail(result.projectId);
    } catch (e: any) { message.error('导入失败：' + (e?.message ?? String(e))); }
    finally { setImporting(false); }
  };

  // ---- 统一导入（压缩包 / HTTP 下载 / Docker）：异步 job + 真实进度 + WS 推送 ----
  const [unifiedRef, setUnifiedRef] = useState('');
  const [unifiedJob, setUnifiedJob] = useState<{ jobId: string; phase: string; percent: number; message: string } | null>(null);
  const unifiedJobRef = useRef<string | null>(null);

  useDevPilotEvents(['import.progress'], (event) => {
    const payload = event.payload as { jobId?: string; phase?: string; percent?: number; message?: string };
    if (payload.jobId && payload.jobId === unifiedJobRef.current) {
      setUnifiedJob({ jobId: payload.jobId, phase: String(payload.phase ?? ''), percent: Number(payload.percent ?? 0), message: String(payload.message ?? '') });
    }
  });

  const pollUnified = async (jobId: string) => {
    for (let i = 0; i < 600; i++) {
      const job = await api<{ status: string; phase: string; percent: number; message: string; error?: string; project_id?: string }>(`/projects/import/unified/${jobId}`);
      setUnifiedJob({ jobId, phase: job.phase, percent: job.percent, message: job.message });
      if (job.status === 'done') {
        message.success('导入完成：统一分析已生成项目档案');
        setUnifiedJob(null); unifiedJobRef.current = null; setUnifiedRef('');
        await load();
        if (job.project_id) await openDetail(job.project_id);
        return;
      }
      if (job.status === 'failed') { message.error(`导入失败：${job.error ?? '未知原因'}`); setUnifiedJob(null); unifiedJobRef.current = null; return; }
      if (job.status === 'cancelled') { setUnifiedJob(null); unifiedJobRef.current = null; return; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    message.warning('导入超时未完成，请稍后在任务列表查看');
  };

  const doUnifiedImport = async (source: 'archive' | 'http' | 'docker') => {
    if (!unifiedRef.trim() || unifiedJobRef.current) return;
    const hints: Record<string, string> = { archive: '本机压缩包路径', http: 'http(s) 下载直链', docker: '含 docker-compose.yml 或 Dockerfile 的目录' };
    if (source === 'http' && !/^https?:\/\//i.test(unifiedRef.trim())) { message.warning('请输入 http/https 下载链接'); return; }
    unifiedJobRef.current = 'pending';
    try {
      const { jobId } = await api<{ jobId: string }>('/projects/import/unified', 'POST', { source, ref: unifiedRef.trim() });
      unifiedJobRef.current = jobId;
      setUnifiedJob({ jobId, phase: 'queued', percent: 0, message: '任务已排队' });
      void pollUnified(jobId);
    } catch (e: any) {
      message.error(`导入发起失败：${e?.message ?? String(e)}`);
      unifiedJobRef.current = null;
    }
    void hints;
  };

  const act = async (key: string, fn: () => Promise<void>) => {
    if (busy(key)) return;
    mark(key, true);
    try { await fn(); } catch (e: any) { message.error(e?.message ?? String(e)); }
    finally { mark(key, false); }
  };
  const startProject = (id: string, name: string) => void auto.run(id, name);
  const startingProject = (id: string) => auto.isStarting(id);
  /** CLI 型项目没有常驻服务：启动 = 打开命令行窗口并自动运行程序 */
  const openTerminal = (serviceId: string, name?: string) => act(`term-${serviceId}`, async () => {
    await api(`/services/${serviceId}/terminal`, 'POST');
    message.success(`已打开命令行窗口${name ? `（${name}）` : ''}并自动启动程序，窗口保持可用`);
  });
  const restartProject = (project: any) => act(`restart-${project.id}`, async () => {
    await api(`/projects/${project.id}/stop`, 'POST');
    message.success('项目已停止，正在重新启动…');
    await load();
    if (detail) await openDetail(project.id);
    void auto.run(project.id, project.name);
  });
  const stopProject = (id: string) => act(`stop-${id}`, async () => {
    await api(`/projects/${id}/stop`, 'POST');
    message.success('项目已停止');
    await load();
    if (detail) await openDetail(id);
  });
  const confirmProject = (id: string) => act(`confirm-${id}`, async () => {
    await api(`/projects/${id}/confirm`, 'POST');
    message.success('配置已确认，识别草案转为生效配置');
    await load();
    if (detail) await openDetail(id);
  });
  const removeProject = (project: any) => {
    Modal.confirm({
      title: `删除项目记录「${project.name}」？`,
      content: <div><p>仅从 DevPilot 移除该项目记录与配置，<strong>不会删除磁盘上的任何文件</strong>。</p><p className="dp-mono">{project.root_path}</p></div>,
      okText: '删除记录', okButtonProps: { danger: true }, cancelText: '取消',
      onOk: () => act(`del-${project.id}`, async () => {
        await api(`/projects/${project.id}`, 'DELETE');
        message.success('已删除记录（磁盘文件未改动）');
        setDetail(null); onSelect(null); await load();
      }),
    });
  };
  const openInBrowser = async (url: string) => { try { await api('/external-tools/open-url', 'POST', { url }); } catch { window.open(url, '_blank'); } };
  const copyText = (text: string) => { void navigator.clipboard?.writeText(text); message.success('访问地址已复制'); };
  const toggleFavorite = (id: string) => {
    const project = projects.find((p) => p.id === id);
    setFavorites((current) => {
      const isFav = current.includes(id);
      const next = isFav ? current.filter((item) => item !== id) : [id, ...current];
      try { localStorage.setItem('devpilot.projectFavorites', JSON.stringify(next)); } catch { /* noop */ }
      message.success(isFav ? `已取消收藏「${project?.name ?? id}」` : `已收藏「${project?.name ?? id}」`);
      return next;
    });
  };

  const filtered = useMemo(() => projects.filter((project) => {
    const query = keyword.trim().toLowerCase();
    const matchesKeyword = !query || `${project.name} ${project.root_path} ${project.language ?? ''} ${project.framework ?? ''}`.toLowerCase().includes(query);
    const running = (project.running_count ?? 0) > 0;
    const matchesStatus = statusFilter === 'all'
      || (statusFilter === 'running' && running)
      || (statusFilter === 'stopped' && !running)
      || (statusFilter === 'draft' && project.analysis_status !== 'confirmed')
      || (statusFilter === 'favorites' && favorites.includes(project.id));
    return matchesKeyword && matchesStatus;
  }), [projects, keyword, statusFilter, favorites]);
  const runningProjects = projects.filter((project) => (project.running_count ?? 0) > 0).length;
  const activeAgents = tasks.filter((task) => ['Running', 'Preparing'].includes(task.status)).length;
  const pendingTasks = tasks.filter((task) => ['Pending', 'WaitingInput', 'WaitingApproval'].includes(task.status)).length;
  const gitChanges = Object.values(gitInfo).reduce((sum, item) => sum + (item.changes ?? 0), 0);
  const recentProjects = recents.map((id) => projects.find((project) => project.id === id)).filter(Boolean);
  const showcase = recentProjects.length ? recentProjects.slice(0, 4) : projects.slice(0, 4);
  const anyRunning = (project: any) => (project.running_count ?? 0) > 0;

  const projectCards = (rows: any[], compact = false) => (
    <div className={`dp-project-grid${compact ? ' compact' : ''}`}>
      {rows.map((project) => (
        <article className="dp-project-card" key={project.id} onClick={() => void openDetail(project.id)}>
          <div className="dp-project-card-top">
            <div className="dp-project-glyph">{String(project.name ?? '?').slice(0, 1)}</div>
            <div className="dp-project-title"><strong>{project.name}</strong><small>{[project.language, project.framework].filter(Boolean).join(' · ') || '技术栈待识别'}</small></div>
            <button className={`dp-project-star${favorites.includes(project.id) ? ' active' : ''}`} title={favorites.includes(project.id) ? '取消收藏' : '收藏项目'} onClick={(event) => { event.stopPropagation(); toggleFavorite(project.id); }}><SmallIcon name="star"/></button>
          </div>
          {project.description && <div className="dp-project-desc" title={project.description}>{project.description}</div>}
          <div className="dp-project-meta">
            <StatusTag status={anyRunning(project) ? 'Running' : startingProject(project.id) ? 'Starting' : 'Stopped'} text={anyRunning(project) ? `运行中 · ${project.running_count} 服务` : startingProject(project.id) ? '启动中…' : '未运行'}/>
            <BranchTag branch={gitInfo[project.id]?.branch}/>
            {project.analysis_status !== 'confirmed' && <StatusTag status="Pending" text="待确认配置"/>}
          </div>
          <div className="dp-project-path dp-mono" title={project.root_path}>{project.root_path}</div>
          <div className="dp-project-footer">
            <time>{project.service_count ?? 0} 个服务{project.updated_at ? ` · ${formatTime(project.updated_at)}` : ''}</time>
            <div className="dp-project-actions" onClick={(event) => event.stopPropagation()}>
              {anyRunning(project)
                ? <Button size="small" loading={busy(`stop-${project.id}`)} onClick={() => void stopProject(project.id)}>停止</Button>
                : project.cli_service_id
                  ? <Button size="small" type="primary" loading={busy(`term-${project.cli_service_id}`)} onClick={() => openTerminal(project.cli_service_id, project.name)}>{busy(`term-${project.cli_service_id}`) ? '打开中' : '打开终端'}</Button>
                  : <Button size="small" type="primary" icon={<SmallIcon name="play"/>} loading={startingProject(project.id)} onClick={() => startProject(project.id, project.name)}>{startingProject(project.id) ? '启动中' : '启动'}</Button>}
              <Button size="small" onClick={() => void openDetail(project.id)}>详情</Button>
            </div>
          </div>
        </article>
      ))}
    </div>
  );

  const projectTable = (rows: any[], dashboard = false) => (
    <Table rowKey="id" size="small" dataSource={rows} pagination={dashboard ? false : { pageSize: 12, hideOnSinglePage: true }} scroll={{ x: dashboard ? 680 : 980 }}
      onRow={(record) => ({ onClick: () => void openDetail(record.id), style: { cursor: 'pointer' } })}
      columns={[
        { title: '项目', dataIndex: 'name', render: (value: string, record: any) => <Space size={9}><span className="dp-project-glyph" style={{ width: 28, height: 28, borderRadius: 7, fontSize: 11 }}>{String(value).slice(0, 1)}</span><span><Typography.Text strong>{value}</Typography.Text><div className="dp-desc">{[record.language, record.framework].filter(Boolean).join(' / ') || '待识别'}</div></span></Space> },
        { title: '状态', width: 110, render: (_, record) => <StatusTag status={anyRunning(record) ? 'Running' : startingProject(record.id) ? 'Starting' : 'Stopped'} text={anyRunning(record) ? `运行中 ${record.running_count}` : startingProject(record.id) ? '启动中…' : '已停止'}/> },
        { title: 'Git 分支', width: 130, render: (_, record) => <BranchTag branch={gitInfo[record.id]?.branch}/> },
        { title: '服务', dataIndex: 'service_count', width: 65, render: (value) => value ?? 0 },
        ...(!dashboard ? [
          { title: '配置', dataIndex: 'analysis_status', width: 90, render: (value: string) => <StatusTag status={value === 'confirmed' ? 'Completed' : 'Pending'} text={value === 'confirmed' ? '已确认' : '待确认'}/> },
          { title: '根目录', dataIndex: 'root_path', ellipsis: true, render: (value: string) => <Mono title={value}>{value}</Mono> },
        ] : []),
        { title: '操作', width: dashboard ? 160 : 220, render: (_, record) => (
          <Space size={4} onClick={(event) => event.stopPropagation()}>
            {anyRunning(record)
              ? <Button size="small" loading={busy(`stop-${record.id}`)} onClick={() => void stopProject(record.id)}>停止</Button>
              : record.cli_service_id
                ? <Button size="small" type="primary" loading={busy(`term-${record.cli_service_id}`)} onClick={() => openTerminal(record.cli_service_id, record.name)}>{busy(`term-${record.cli_service_id}`) ? '打开中' : '打开终端'}</Button>
                : <Button size="small" type="primary" loading={startingProject(record.id)} onClick={() => startProject(record.id, record.name)}>{startingProject(record.id) ? '启动中' : '启动'}</Button>}
            <Button size="small" onClick={() => void openDetail(record.id)}>详情</Button>
            {!dashboard && <Dropdown menu={{ items: [
                { key: 'favorite', label: favorites.includes(record.id) ? '取消收藏' : '收藏项目' },
                { key: 'confirm', label: '确认配置', disabled: record.analysis_status === 'confirmed' },
                { type: 'divider' }, { key: 'delete', label: '删除记录（不动磁盘）', danger: true },
              ], onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === 'favorite') toggleFavorite(record.id);
                if (key === 'confirm') void confirmProject(record.id);
                if (key === 'delete') removeProject(record);
              } }}><Button size="small">更多</Button></Dropdown>}
          </Space>
        ) },
      ]}/>
  );

  const detailServices: any[] = detail?.services ?? [];
  const runningServices = detailServices.filter((service) => service.status === 'Running' && service.port);
  const importPanel = (
    <SectionCard title="导入项目" className="dp-import-card">
      <Tabs size="small" activeKey={importTab} onChange={setImportTab} items={[
        { key: 'local', label: '本地目录', children: <Space.Compact style={{ width: '100%', maxWidth: 760 }}><Button onClick={chooseImportDir}>选择项目目录</Button><Input readOnly placeholder="从资源管理器选择项目根目录" value={importPath}/><Button type="primary" onClick={doImport} loading={importing} disabled={!importPath.trim()}>导入并识别</Button></Space.Compact> },
        { key: 'github', label: 'Git 仓库', children: <div style={{ maxWidth: 760 }}><Space.Compact style={{ width: '100%' }}><Input placeholder="GitHub / GitLab / Gitee / 自建 Git 的 https 或 ssh 地址" value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} onPressEnter={doGitImport}/><Button type="primary" onClick={doGitImport} disabled={!gitUrl.trim()}>克隆并导入</Button></Space.Compact><Space style={{ marginTop: 10 }} wrap><Input style={{ width: 170 }} placeholder="分支（可选）" value={gitBranch} onChange={(event) => setGitBranch(event.target.value)}/><Space.Compact><Input style={{ width: 320 }} placeholder="克隆位置（留空使用默认目录）" value={gitDir} onChange={(event) => setGitDir(event.target.value)}/><Button onClick={async () => { const dir = await pickDirectory(); if (dir) setGitDir(dir); }}>浏览</Button></Space.Compact></Space></div> },
        { key: 'archive', label: '压缩包', children: <div style={{ maxWidth: 760 }}><Space.Compact style={{ width: '100%' }}><Input placeholder="ZIP / 7Z / RAR 压缩包路径（安全解压：路径穿越/压缩炸弹防护）" value={unifiedRef} onChange={(event) => setUnifiedRef(event.target.value)} onPressEnter={() => void doUnifiedImport('archive')}/><Button type="primary" onClick={() => void doUnifiedImport('archive')} disabled={!unifiedRef.trim() || !!unifiedJobRef.current}>导入并解压</Button></Space.Compact></div> },
        { key: 'http', label: 'HTTP 下载', children: <div style={{ maxWidth: 760 }}><Space.Compact style={{ width: '100%' }}><Input placeholder="https://... 项目归档下载直链（SSRF 防护已启用）" value={unifiedRef} onChange={(event) => setUnifiedRef(event.target.value)} onPressEnter={() => void doUnifiedImport('http')}/><Button type="primary" onClick={() => void doUnifiedImport('http')} disabled={!unifiedRef.trim() || !!unifiedJobRef.current}>下载并导入</Button></Space.Compact></div> },
        { key: 'docker', label: 'Docker/Compose', children: <div style={{ maxWidth: 760 }}><Space.Compact style={{ width: '100%' }}><Input placeholder="含 docker-compose.yml / compose.yaml / Dockerfile 的本地目录" value={unifiedRef} onChange={(event) => setUnifiedRef(event.target.value)} onPressEnter={() => void doUnifiedImport('docker')}/><Button type="primary" onClick={() => void doUnifiedImport('docker')} disabled={!unifiedRef.trim() || !!unifiedJobRef.current}>识别并导入</Button></Space.Compact></div> },
      ]}/>
      {unifiedJob && (
        <div style={{ marginTop: 12, maxWidth: 760 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
            <span>{unifiedJob.message || unifiedJob.phase}</span><span>{unifiedJob.percent}%</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--dp-border, #eee)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${unifiedJob.percent}%`, background: 'var(--dp-primary, #1677ff)', transition: 'width .3s' }}/>
          </div>
          <Button size="small" style={{ marginTop: 8 }} onClick={async () => { await api(`/projects/import/unified/${unifiedJob.jobId}/cancel`, 'POST'); message.info('已请求取消'); }}>取消导入</Button>
        </div>
      )}
    </SectionCard>
  );

  return (
    <div>
      <PageHeader
        eyebrow={variant === 'dashboard' ? 'Developer workspace' : 'Project portfolio'}
        title={variant === 'dashboard' ? '工作台' : '项目管理'}
        description={variant === 'dashboard' ? '掌握项目运行状态，继续最近的开发工作。' : '在一个视图中导入、筛选并管理全部本地项目。'}
        extra={<>
          <Input.Search placeholder="搜索名称、路径或技术栈" allowClear style={{ width: 250 }} value={keyword} onChange={(event) => setKeyword(event.target.value)}/>
          {variant === 'dashboard' && <Button type="primary" onClick={() => { window.location.hash = '#/2'; }}>导入项目</Button>}
        </>}
      />

      {variant === 'dashboard' && <>
        <div className="dp-metrics">
          <MetricCard label="项目总数" value={projects.length} hint={`${projects.filter((p) => p.analysis_status === 'confirmed').length} 个配置已确认`} icon={<SmallIcon name="folder"/>}/>
          <MetricCard label="正在运行" value={runningProjects} hint={`${projects.reduce((sum, p) => sum + (p.running_count ?? 0), 0)} 个运行中服务`} icon={<SmallIcon name="play"/>} tone="green"/>
          <MetricCard label="Agent 执行中" value={activeAgents} hint={`${agents.length} 个已注册 Agent`} icon={<SmallIcon name="agent"/>}/>
          <MetricCard label="待处理任务" value={pendingTasks} hint={`${approvals.length} 项待审批`} icon={<SmallIcon name="task"/>} tone="amber"/>
          <MetricCard label="Git 工作区变更" value={gitChanges} hint={`已检查 ${Math.min(projects.length, 12)} 个项目仓库`} icon={<SmallIcon name="git"/>}/>
        </div>
        <div className="dp-dashboard-grid">
          <div className="dp-dashboard-stack">
            <SectionCard title={recentProjects.length ? '最近访问' : '项目快速入口'} extra={<Button type="link" size="small" onClick={() => { window.location.hash = '#/2'; }}>全部项目</Button>}>
              <StateBlock loading={loading} error={error} onRetry={() => void load()} empty={showcase.length === 0} emptyText="导入项目后即可从这里快速启动">{projectCards(showcase, true)}</StateBlock>
            </SectionCard>
            <SectionCard title="项目运行状态" extra={<span className="dp-desc">{runningProjects} 个项目运行中</span>}>
              <StateBlock loading={loading} error={error} empty={projects.length === 0} emptyText="暂无项目">{projectTable(projects.slice(0, 6), true)}</StateBlock>
            </SectionCard>
          </div>
          <div className="dp-dashboard-stack">
            <SectionCard title="最近活动" extra={<Button type="link" size="small" onClick={() => { window.location.hash = '#/3'; }}>任务中心</Button>}>
              <div className="dp-activity-list">
                {tasks.slice(0, 5).map((task) => <div className="dp-activity-item" key={task.id}><span className="dp-activity-dot"/><div className="dp-activity-copy"><div className="dp-activity-title">{task.input_summary ?? 'Agent 任务'}</div><div className="dp-activity-meta"><StatusTag status={task.status}/> {formatTime(task.created_at)}</div></div></div>)}
                {tasks.length === 0 && <StateBlock empty emptyText="暂无 Agent 活动记录">{null}</StateBlock>}
              </div>
            </SectionCard>
            <SectionCard title="待处理事项" extra={<Button type="link" size="small" onClick={() => { window.location.hash = '#/7'; }}>前往审批</Button>}>
              <div className="dp-activity-list">
                {approvals.slice(0, 4).map((approval) => <div className="dp-activity-item" key={approval.id}><span className="dp-activity-dot" style={{ background: 'var(--dp-warning)' }}/><div className="dp-activity-copy"><div className="dp-activity-title">{approval.action_summary}</div><div className="dp-activity-meta">{approval.requester} · {approval.risk_level} 风险</div></div></div>)}
                {approvals.length === 0 && <StateBlock empty emptyText="没有待审批操作">{null}</StateBlock>}
              </div>
            </SectionCard>
            <SectionCard title="系统运行状态">
              <div className="dp-activity-item"><span className="dp-activity-dot" style={{ background: 'var(--dp-success)' }}/><div className="dp-activity-copy"><div className="dp-activity-title">Agent 注册表</div><div className="dp-activity-meta">{agents.filter((a) => a.status === 'registered').length} / {agents.length} 可用</div></div></div>
              <div className="dp-activity-item"><span className="dp-activity-dot"/><div className="dp-activity-copy"><div className="dp-activity-title">协作任务队列</div><div className="dp-activity-meta">{activeAgents} 执行中 · {pendingTasks} 待处理</div></div></div>
            </SectionCard>
          </div>
        </div>
      </>}

      {variant === 'projects' && <>
        {importPanel}
        <div style={{ height: 16 }}/>
        <div className="dp-toolbar">
          <Select value={statusFilter} onChange={setStatusFilter} style={{ width: 140 }} options={[
            { value: 'all', label: '全部状态' }, { value: 'running', label: '正在运行' }, { value: 'stopped', label: '未运行' }, { value: 'draft', label: '待确认配置' }, { value: 'favorites', label: '我的收藏' },
          ]}/>
          <span className="dp-desc">{filtered.length} / {projects.length} 个项目</span>
          <div className="dp-toolbar-spacer"/>
          <div className="dp-view-switch" aria-label="项目视图"><button className={view === 'card' ? 'active' : ''} onClick={() => setView('card')} title="卡片视图"><SmallIcon name="grid"/></button><button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')} title="列表视图"><SmallIcon name="list"/></button></div>
          <Button onClick={() => void load()}>刷新</Button>
        </div>
        <StateBlock loading={loading} error={error} onRetry={() => void load()} empty={filtered.length === 0} emptyText={keyword || statusFilter !== 'all' ? '没有符合当前筛选条件的项目' : '还没有项目，先在上方导入'}>
          {view === 'card' ? projectCards(filtered) : projectTable(filtered)}
        </StateBlock>
      </>}

      {auto.node}{git.node}
      <Drawer
        open={!!detail}
        onClose={() => { setDetail(null); onSelect(null); }}
        title={detail?.project?.name ?? '项目详情'}
        width={780}
        extra={detail && (
          <Space>
            {startingProject(detail.project.id)
              ? <Button size="small" loading>启动中</Button>
              : anyRunning(detail.project)
                ? <Button size="small" loading={busy(`restart-${detail.project.id}`)} onClick={() => void restartProject(detail.project)}>重启项目</Button>
                : detailServices.length > 0 && detailServices.every((s) => s.service_type === 'cli')
                  ? <Button size="small" type="primary" loading={busy(`term-${detailServices[0].id}`)} onClick={() => openTerminal(detailServices[0].id, detail.project.name)}>打开终端</Button>
                  : <Button size="small" type="primary" onClick={() => startProject(detail.project.id, detail.project.name)}>启动项目</Button>}
            {!(detailServices.length > 0 && detailServices.every((s) => s.service_type === 'cli')) && (
              <Button size="small" loading={busy(`stop-${detail.project.id}`)} disabled={!anyRunning(detail.project)} onClick={() => void stopProject(detail.project.id)}>停止</Button>
            )}
          </Space>
        )}
      >
        {detail && <>
          <div className="dp-project-meta">
            <Tag>{[detail.project.language, detail.project.framework].filter(Boolean).join(' / ') || '技术栈待识别'}</Tag>
            <BranchTag branch={gitInfo[detail.project.id]?.branch}/>
            <StatusTag status={detail.project.analysis_status === 'confirmed' ? 'Completed' : 'Pending'} text={detail.project.analysis_status === 'confirmed' ? '配置已确认' : '配置待确认'}/>
          </div>
          <div className="dp-detail-head">
            <div className="dp-detail-path">
              <SmallIcon name="folder"/>
              <span className="dp-mono dp-detail-path-text" title={detail.project.root_path}>{detail.project.root_path}</span>
              <Button size="small" type="text" className="dp-detail-copy" onClick={() => copyText(detail.project.root_path)}>复制</Button>
            </div>
            {detail.project.description && (
              <div className="dp-detail-intro">
                <span className="dp-detail-intro-label">简介</span>
                <span className="dp-detail-intro-text" title={detail.project.description}>{detail.project.description}</span>
              </div>
            )}
          </div>
          {runningServices.length > 0 && (
            <div className="dp-access-row">
              <Typography.Text strong className="dp-access-label">访问地址</Typography.Text>
              {runningServices.map((service) => {
                const path = service.access_path && service.access_path !== '/' ? service.access_path : '';
                const url = `http://127.0.0.1:${service.port}${path}`;
                return (
                  <span key={service.id} className="dp-access-chip">
                    <span className="dp-access-name">{service.name}</span>
                    <a className="dp-mono dp-access-url" href={url} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openInBrowser(url); }} title={url}>{url}</a>
                    <Button size="small" type="link" onClick={() => copyText(url)}>复制</Button>
                  </span>
                );
              })}
            </div>
          )}
          <Table rowKey="id" size="small" dataSource={detailServices} pagination={false} style={{ marginBottom: 18 }} columns={[
            { title: '服务', dataIndex: 'name', render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
            { title: '类型', dataIndex: 'service_type', width: 90 }, { title: '端口', dataIndex: 'port', width: 70, render: (value) => value ?? '—' },
            { title: '状态', dataIndex: 'status', width: 100, render: (value: string, record: any) => record.service_type === 'cli' && value === 'Stopped' ? <StatusTag status="Completed" text="CLI 就绪"/> : <StatusTag status={value}/> },
            { title: '启动命令', dataIndex: 'start_command', ellipsis: true, render: (value: string) => <Mono title={value}>{value}</Mono> },
          ]}/>
          {detailServices.length > 0 && detailServices.every((s) => s.service_type === 'cli') && (() => {
            const cli = detailServices[0];
            let hint: { example?: string; note?: string } = {};
            try { hint = cli.usage_hint ? JSON.parse(cli.usage_hint) : {}; } catch { /* 忽略损坏的 JSON */ }
            const usageCmd = hint.example || (cli.start_command ?? '').replace(/\s+--help\s*$/i, '');
            return (
              <>
                {usageCmd && (
                  <div className="dp-access-row">
                    <Typography.Text strong className="dp-access-label">使用命令</Typography.Text>
                    <span className="dp-access-chip">
                      <code className="dp-mono dp-access-url" style={{ maxWidth: 420, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={usageCmd}>{usageCmd}</code>
                      <Button size="small" type="link" onClick={() => copyText(usageCmd)}>复制</Button>
                    </span>
                  </div>
                )}
                <div className="dp-cli-hint">
                  <Typography.Text strong>命令行项目</Typography.Text>
                  <Typography.Text type="secondary">{hint.note || '这类项目不是网页服务，启动 = 为你打开一个命令行窗口并自动运行程序；程序退出后窗口保持可用，可直接输入命令传参继续使用。'}</Typography.Text>
                  <Button size="small" type="primary" loading={busy(`term-${cli.id}`)} onClick={() => openTerminal(cli.id, detail.project.name)}>打开终端</Button>
                </div>
              </>
            );
          })()}
          <Tabs items={[
            { key: 'logs', label: '运行日志', children: <LogViewer key={detail.project.id} services={detailServices} refreshKey={logRefreshKey}/> },
            { key: 'configs', label: `配置草案（${detail.configs?.length ?? 0}）`, children: <><p className="dp-desc">草案来自项目结构识别，确认后才作为启动依据。</p><Table rowKey="id" size="small" dataSource={detail.configs} pagination={false} columns={[{ title: '类型', dataIndex: 'config_type' }, { title: '来源', dataIndex: 'source' }, { title: '内容', dataIndex: 'content_ref', ellipsis: true }]}/></> },
            { key: 'profile', label: '组件树', children: <ProfilePanel projectId={detail.project.id}/> },
            { key: 'health', label: '环境体检', children: <EnvPanel projectId={detail.project.id}/> },
            { key: 'archives', label: '运行档案', children: <ArchivesPanel projectId={detail.project.id}/> },
          ]}/>
          <div style={{ marginTop: 18, display: 'flex', gap: 8 }}>{detail.project.analysis_status !== 'confirmed' && <Button type="primary" loading={busy(`confirm-${detail.project.id}`)} onClick={() => void confirmProject(detail.project.id)}>审阅无误，确认配置</Button>}<Button danger onClick={() => removeProject(detail.project)}>删除项目记录</Button></div>
        </>}
      </Drawer>
    </div>
  );
}

/* ---------- 智能化升级面板：组件树 / 环境体检 / 运行档案 ---------- */

interface ProfileComponent {
  id: string; name: string; path: string; kind: string; language: string | null; framework: string | null;
  packageManager: string | null; confidence: number;
  evidence: Array<{ file: string; reason: string }>;
  runtime: { languageVersion: string | null; languageVersionSource: string | null; devStartCommand: string | null; buildCommand: string | null; port: number | null; envVars: Array<{ key: string; required: boolean; sensitive: boolean }>; externalServices: Array<{ type: string; port: number | null }> } | null;
}

function ProfilePanel({ projectId }: { projectId: string }) {
  const [profile, setProfile] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try { setProfile(await api(`/projects/${projectId}/profile`)); } catch (e: any) { setError(e?.message ?? String(e)); }
    })();
  }, [projectId]);
  if (error) return <p className="dp-desc">档案读取失败：{error}</p>;
  if (!profile) return <p className="dp-desc">加载中…</p>;
  const components = (profile.components ?? []) as ProfileComponent[];
  return (
    <div>
      <p className="dp-desc">指纹 <Mono>{String(profile.fingerprint ?? '—').slice(0, 16)}</Mono> · 分析于 {profile.analyzedAt ? formatTime(profile.analyzedAt) : '—'} · 证据与置信度由规则引擎计算</p>
      {components.map((component) => (
        <div key={component.id} style={{ border: '1px solid var(--dp-border, #eee)', borderRadius: 8, padding: 12, marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <strong>{component.name}</strong>
            <span><Tag>{component.kind}</Tag>{component.language && <Tag>{component.language}</Tag>}{component.framework && <Tag>{component.framework}</Tag>}{component.packageManager && <Tag>{component.packageManager}</Tag>}<Tag>置信 {Math.round(component.confidence * 100)}%</Tag></span>
          </div>
          {component.runtime && (
            <div className="dp-agent-kv" style={{ fontSize: 12 }}>
              <span>版本要求</span><strong>{component.runtime.languageVersion ?? '未声明'}{component.runtime.languageVersionSource ? `（${component.runtime.languageVersionSource}）` : ''}</strong>
            </div>
          )}
          {component.runtime?.devStartCommand && <div className="dp-agent-kv" style={{ fontSize: 12 }}><span>启动命令</span><strong><Mono>{component.runtime.devStartCommand}</Mono></strong></div>}
          {component.runtime?.port != null && <div className="dp-agent-kv" style={{ fontSize: 12 }}><span>端口</span><strong>{component.runtime.port}</strong></div>}
          {!!component.runtime?.envVars?.length && <div className="dp-agent-kv" style={{ fontSize: 12 }}><span>环境变量</span><strong>{component.runtime.envVars.map((v) => v.key).join('，')}</strong></div>}
          {!!component.runtime?.externalServices?.length && <div className="dp-agent-kv" style={{ fontSize: 12 }}><span>外部服务</span><strong>{component.runtime.externalServices.map((s) => `${s.type}:${s.port ?? '?'}`).join('，')}</strong></div>}
          <details style={{ fontSize: 12, marginTop: 6 }}>
            <summary style={{ cursor: 'pointer' }}>识别证据（{component.evidence?.length ?? 0}）</summary>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {(component.evidence ?? []).map((e, i) => <li key={i}><Mono>{e.file}</Mono> — {e.reason}</li>)}
            </ul>
          </details>
        </div>
      ))}
      {components.length === 0 && <p className="dp-desc">未识别出组件（可能是空目录或二进制分发）。{(profile.needsConfirmation ?? []).map((s: string) => <div key={s}>{s}</div>)}</p>}
    </div>
  );
}

function EnvPanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<{ match?: any; vars?: any; services?: any } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [match, vars, services] = await Promise.all([
        api<any>(`/environments/match/${projectId}`),
        api<any>(`/environments/env-vars/${projectId}`),
        api<any>(`/environments/services/${projectId}`),
      ]);
      setData({ match, vars, services });
      setError(null);
    } catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setLoading(false); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  if (loading) return <p className="dp-desc">体检中…（真实执行 --version 验证，首次约需 10-30 秒）</p>;
  if (error) return <p className="dp-desc">体检失败：{error} <Button size="small" onClick={() => void load()}>重试</Button></p>;
  if (!data) return null;
  return (
    <div>
      <div style={{ marginBottom: 10 }}><Button size="small" onClick={() => void load()}>重新体检</Button></div>
      {/* 版本匹配 */}
      <h4>版本匹配（项目要求 vs 本机多版本）</h4>
      {(data.match?.matches ?? []).length === 0 && <p className="dp-desc">项目组件未声明版本约束。</p>}
      {(data.match?.matches ?? []).map((m: any, i: number) => (
        <div key={i} style={{ borderBottom: '1px solid var(--dp-border, #eee)', padding: '8px 0', fontSize: 12 }}>
          <strong>{m.component?.name ?? m.toolId}</strong>：<Tag color={m.status === 'satisfied' ? 'green' : m.status === 'mismatch' ? 'orange' : m.status === 'missing' ? 'red' : 'default'}>
            {m.status === 'satisfied' ? '满足' : m.status === 'mismatch' ? '版本不匹配' : m.status === 'missing' ? '缺失' : '未声明约束'}
          </Tag>
          <div className="dp-desc">要求 {m.requirement ?? '未声明'}{m.requirementSource ? `（${m.requirementSource}）` : ''}；本机 {m.installed?.map((v: any) => v.version).join('、') || '无'}</div>
          <div className="dp-desc">{m.advice}</div>
        </div>
      ))}
      {/* 环境变量 */}
      <h4 style={{ marginTop: 14 }}>环境变量（.env.example / application.yml）</h4>
      <p className="dp-desc">{data.vars?.note ?? `共 ${data.vars?.vars?.length ?? 0} 项需求，缺失 ${data.vars?.missing?.length ?? 0} 项（敏感值不回显，不自动生成密钥）`}</p>
      {(data.vars?.vars ?? []).map((v: any) => (
        <div key={v.key} className="dp-agent-kv" style={{ fontSize: 12 }}>
          <span><Mono>{v.key}</Mono>{v.sensitive ? ' 🔒' : ''}</span>
          <strong>{v.status === 'provided' ? `已提供（${v.where}）` : v.status === 'default-available' ? '有默认值' : '缺失'}</strong>
        </div>
      ))}
      {/* 外部服务 */}
      <h4 style={{ marginTop: 14 }}>外部服务探活</h4>
      {(data.services?.services ?? []).length === 0 && <p className="dp-desc">项目未依赖 MySQL/Redis 等外部服务。</p>}
      {(data.services?.services ?? []).map((s: any, i: number) => (
        <div key={i} style={{ borderBottom: '1px solid var(--dp-border, #eee)', padding: '8px 0', fontSize: 12 }}>
          <strong>{s.type}</strong>：<Tag color={s.listening ? 'green' : 'red'}>{s.listening ? `运行中（端口 ${s.port}${s.processName ? `，进程 ${s.processName}` : ''}）` : `未监听（端口 ${s.port}）`}</Tag>
          <div className="dp-desc">{s.advice}</div>
        </div>
      ))}
    </div>
  );
}

function ArchivesPanel({ projectId }: { projectId: string }) {
  const [data, setData] = useState<{ runs: any[]; repairs: any[] } | null>(null);
  useEffect(() => {
    void (async () => {
      try { setData(await api(`/projects/${projectId}/archives`)); } catch { setData({ runs: [], repairs: [] }); }
    })();
  }, [projectId]);
  if (!data) return <p className="dp-desc">加载中…</p>;
  return (
    <div>
      <h4>运行记录（{data.runs.length}）</h4>
      {data.runs.length === 0 && <p className="dp-desc">暂无运行记录。</p>}
      {data.runs.map((run, i) => (
        <div key={i} className="dp-agent-kv" style={{ fontSize: 12, borderBottom: '1px solid var(--dp-border, #eee)', padding: '6px 0' }}>
          <span>{formatTime(run.created_at)}</span>
          <strong>{run.status} · {run.command?.slice(0, 60) ?? '—'}{run.port ? ` · 端口 ${run.port}` : ''}{run.pid ? ` · PID ${run.pid}` : ''}</strong>
        </div>
      ))}
      <h4 style={{ marginTop: 14 }}>修复记录（{data.repairs.length}）</h4>
      {data.repairs.length === 0 && <p className="dp-desc">暂无修复记录。</p>}
      {data.repairs.map((r, i) => (
        <div key={i} className="dp-agent-kv" style={{ fontSize: 12, borderBottom: '1px solid var(--dp-border, #eee)', padding: '6px 0' }}>
          <span>{formatTime(r.created_at)} · {r.category ?? 'unknown'}</span>
          <strong>{r.outcome}{r.verify_result ? ` · 验证：${String(r.verify_result).slice(0, 60)}` : ''}</strong>
        </div>
      ))}
    </div>
  );
}
