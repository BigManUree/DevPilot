import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Drawer, Dropdown, Input, message, Modal, Select, Space, Table, Tabs, Tag, Typography } from 'antd';
import { api, pickDirectory } from '../api';
import { useAutoStart } from '../components/AutoStart';
import { useGitImport } from '../components/GitImport';
import { MetricCard, Mono, PageHeader, SectionCard, StateBlock, StatusTag } from '../components/ui';
import { formatTime } from '../utils';

function LogViewer({ services, refreshKey }: { services: any[]; refreshKey: number }) {
  const [lines, setLines] = useState<string[]>([]);
  const [svcFilter, setSvcFilter] = useState<string | undefined>();
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
        <Select allowClear size="small" placeholder="按服务过滤" style={{ width: 200 }} value={svcFilter} onChange={setSvcFilter} options={(services ?? []).map((s) => ({ value: s.name, label: s.name }))}/>
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

  const act = async (key: string, fn: () => Promise<void>) => {
    if (busy(key)) return;
    mark(key, true);
    try { await fn(); } catch (e: any) { message.error(e?.message ?? String(e)); }
    finally { mark(key, false); }
  };
  const startProject = (id: string, name: string) => void auto.run(id, name);
  const stopProject = (id: string) => act(`stop-${id}`, async () => {
    await api(`/projects/${id}/stop`, 'POST');
    message.success('项目已停止');
    await load();
    if (detail) await openDetail(id);
  });
  const startService = (service: any) => act(`svc-${service.id}`, async () => {
    await api(`/services/${service.id}/start`, 'POST');
    message.success(`${service.name} 已启动`);
    setLogRefreshKey((key) => key + 1);
    if (detail?.project?.id) await openDetail(detail.project.id);
  });
  const stopService = (service: any) => act(`svc-${service.id}`, async () => {
    const result = await api<{ stopped: boolean; reason?: string }>(`/services/${service.id}/stop`, 'POST');
    if (result.stopped) message.success(`${service.name} 已停止`);
    else if (/referenced by/.test(result.reason ?? '')) {
      Modal.confirm({
        title: '共享服务被其他项目引用', content: `${result.reason}。强制停止将解除引用保护并记入审计，确定继续？`,
        okText: '强制停止', okButtonProps: { danger: true },
        onOk: async () => {
          const forced = await api<{ stopped: boolean }>(`/services/${service.id}/stop`, 'POST', { force: true });
          forced.stopped ? message.success('已强制停止（审计已记录）') : message.error('停止失败');
          if (detail?.project?.id) await openDetail(detail.project.id);
        },
      });
    } else message.warning(result.reason ?? '停止失败');
    if (detail?.project?.id) await openDetail(detail.project.id);
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
  const toggleFavorite = (id: string) => setFavorites((current) => {
    const next = current.includes(id) ? current.filter((item) => item !== id) : [id, ...current];
    try { localStorage.setItem('devpilot.projectFavorites', JSON.stringify(next)); } catch { /* noop */ }
    return next;
  });

  const filtered = useMemo(() => projects.filter((project) => {
    const query = keyword.trim().toLowerCase();
    const matchesKeyword = !query || `${project.name} ${project.root_path} ${project.language ?? ''} ${project.framework ?? ''}`.toLowerCase().includes(query);
    const running = (project.running_count ?? 0) > 0;
    return matchesKeyword && (statusFilter === 'all' || statusFilter === 'running' && running || statusFilter === 'stopped' && !running || statusFilter === 'draft' && project.analysis_status !== 'confirmed');
  }), [projects, keyword, statusFilter]);
  const runningProjects = projects.filter((project) => (project.running_count ?? 0) > 0).length;
  const activeAgents = tasks.filter((task) => ['Running', 'Preparing'].includes(task.status)).length;
  const pendingTasks = tasks.filter((task) => ['Pending', 'WaitingInput', 'WaitingApproval'].includes(task.status)).length;
  const gitChanges = Object.values(gitInfo).reduce((sum, item) => sum + (item.changes ?? 0), 0);
  const favoriteProjects = favorites.map((id) => projects.find((project) => project.id === id)).filter(Boolean);
  const recentProjects = recents.map((id) => projects.find((project) => project.id === id)).filter(Boolean);
  const showcase = favoriteProjects.length ? favoriteProjects.slice(0, 4) : recentProjects.length ? recentProjects.slice(0, 4) : projects.slice(0, 4);
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
          <div className="dp-project-meta">
            <StatusTag status={anyRunning(project) ? 'Running' : 'Stopped'} text={anyRunning(project) ? `运行中 · ${project.running_count} 服务` : '未运行'}/>
            {gitInfo[project.id]?.branch && <Tag>{gitInfo[project.id].branch}</Tag>}
            {project.analysis_status !== 'confirmed' && <StatusTag status="Pending" text="待确认配置"/>}
          </div>
          <div className="dp-project-path dp-mono" title={project.root_path}>{project.root_path}</div>
          <div className="dp-project-footer">
            <time>{project.service_count ?? 0} 个服务{project.updated_at ? ` · ${formatTime(project.updated_at)}` : ''}</time>
            <div className="dp-project-actions" onClick={(event) => event.stopPropagation()}>
              {anyRunning(project)
                ? <Button size="small" loading={busy(`stop-${project.id}`)} onClick={() => void stopProject(project.id)}>停止</Button>
                : <Button size="small" type="primary" icon={<SmallIcon name="play"/>} onClick={() => startProject(project.id, project.name)}>启动</Button>}
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
        { title: '状态', width: 110, render: (_, record) => <StatusTag status={anyRunning(record) ? 'Running' : 'Stopped'} text={anyRunning(record) ? `运行中 ${record.running_count}` : '已停止'}/> },
        { title: 'Git 分支', width: 120, render: (_, record) => gitInfo[record.id]?.branch ? <Tag>{gitInfo[record.id].branch}</Tag> : <span className="dp-muted">—</span> },
        { title: '服务', dataIndex: 'service_count', width: 65, render: (value) => value ?? 0 },
        ...(!dashboard ? [
          { title: '配置', dataIndex: 'analysis_status', width: 90, render: (value: string) => <StatusTag status={value === 'confirmed' ? 'Completed' : 'Pending'} text={value === 'confirmed' ? '已确认' : '待确认'}/> },
          { title: '根目录', dataIndex: 'root_path', ellipsis: true, render: (value: string) => <Mono title={value}>{value}</Mono> },
        ] : []),
        { title: '操作', width: dashboard ? 160 : 220, render: (_, record) => (
          <Space size={4} onClick={(event) => event.stopPropagation()}>
            {anyRunning(record)
              ? <Button size="small" loading={busy(`stop-${record.id}`)} onClick={() => void stopProject(record.id)}>停止</Button>
              : <Button size="small" type="primary" onClick={() => startProject(record.id, record.name)}>启动</Button>}
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
        { key: 'github', label: 'GitHub 仓库', children: <div style={{ maxWidth: 760 }}><Space.Compact style={{ width: '100%' }}><Input placeholder="owner/repo 或 https://github.com/owner/repo" value={gitUrl} onChange={(event) => setGitUrl(event.target.value)} onPressEnter={doGitImport}/><Button type="primary" onClick={doGitImport} disabled={!gitUrl.trim()}>克隆并导入</Button></Space.Compact><Space style={{ marginTop: 10 }} wrap><Input style={{ width: 170 }} placeholder="分支（可选）" value={gitBranch} onChange={(event) => setGitBranch(event.target.value)}/><Space.Compact><Input style={{ width: 320 }} placeholder="克隆位置（留空使用默认目录）" value={gitDir} onChange={(event) => setGitDir(event.target.value)}/><Button onClick={async () => { const dir = await pickDirectory(); if (dir) setGitDir(dir); }}>浏览</Button></Space.Compact></Space></div> },
      ]}/>
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
            <SectionCard title={favoriteProjects.length ? '收藏项目' : recentProjects.length ? '最近访问' : '项目快速入口'} extra={<Button type="link" size="small" onClick={() => { window.location.hash = '#/2'; }}>全部项目</Button>}>
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
            { value: 'all', label: '全部状态' }, { value: 'running', label: '正在运行' }, { value: 'stopped', label: '未运行' }, { value: 'draft', label: '待确认配置' },
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
      <Drawer open={!!detail} onClose={() => { setDetail(null); onSelect(null); }} title={detail?.project?.name ?? '项目详情'} width={780} extra={detail && <Space>{anyRunning(detail.project) ? <StatusTag status="Running"/> : <Button size="small" type="primary" onClick={() => startProject(detail.project.id, detail.project.name)}>启动项目</Button>}<Button size="small" loading={busy(`stop-${detail.project.id}`)} disabled={!anyRunning(detail.project)} onClick={() => void stopProject(detail.project.id)}>停止</Button></Space>}>
        {detail && <>
          <div className="dp-project-meta"><Tag>{[detail.project.language, detail.project.framework].filter(Boolean).join(' / ') || '技术栈待识别'}</Tag>{gitInfo[detail.project.id]?.branch && <Tag>{gitInfo[detail.project.id].branch}</Tag>}<StatusTag status={detail.project.analysis_status === 'confirmed' ? 'Completed' : 'Pending'} text={detail.project.analysis_status === 'confirmed' ? '配置已确认' : '配置待确认'}/></div>
          <p className="dp-mono dp-desc">{detail.project.root_path}</p>
          {runningServices.length > 0 && <div style={{ marginBottom: 18 }}><Typography.Text strong style={{ display: 'block', marginBottom: 8 }}>访问地址</Typography.Text><Space direction="vertical" size={6} style={{ width: '100%' }}>{runningServices.map((service) => {
            const path = service.access_path && service.access_path !== '/' ? service.access_path : '';
            const url = `http://127.0.0.1:${service.port}${path}`;
            return <Space key={service.id} size={8} style={{ background: 'var(--dp-code-bg)', border: '1px solid var(--dp-border)', borderRadius: 7, padding: '7px 10px', width: '100%' }}><Typography.Text strong>{service.name}</Typography.Text><a className="dp-mono" href={url} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openInBrowser(url); }}>{url}</a><Button size="small" type="link" onClick={() => copyText(url)}>复制</Button></Space>;
          })}</Space></div>}
          <Table rowKey="id" size="small" dataSource={detailServices} pagination={false} style={{ marginBottom: 18 }} columns={[
            { title: '服务', dataIndex: 'name', render: (value: string) => <Typography.Text strong>{value}</Typography.Text> },
            { title: '类型', dataIndex: 'service_type', width: 90 }, { title: '端口', dataIndex: 'port', width: 70, render: (value) => value ?? '—' },
            { title: '状态', dataIndex: 'status', width: 90, render: (value: string) => <StatusTag status={value}/> },
            { title: '启动命令', dataIndex: 'start_command', ellipsis: true, render: (value: string) => <Mono title={value}>{value}</Mono> },
            { title: '操作', width: 135, render: (_, service) => <Space size={4}>{service.status === 'Running' || service.status === 'Starting' ? <StatusTag status={service.status}/> : <Button size="small" loading={busy(`svc-${service.id}`)} onClick={() => void startService(service)}>启动</Button>}<Button size="small" loading={busy(`svc-${service.id}`)} disabled={service.status === 'Stopped'} onClick={() => void stopService(service)}>停止</Button></Space> },
          ]}/>
          <Tabs items={[
            { key: 'logs', label: '运行日志', children: <LogViewer services={detailServices} refreshKey={logRefreshKey}/> },
            { key: 'configs', label: `配置草案（${detail.configs?.length ?? 0}）`, children: <><p className="dp-desc">草案来自项目结构识别，确认后才作为启动依据。</p><Table rowKey="id" size="small" dataSource={detail.configs} pagination={false} columns={[{ title: '类型', dataIndex: 'config_type' }, { title: '来源', dataIndex: 'source' }, { title: '内容', dataIndex: 'content_ref', ellipsis: true }]}/></> },
          ]}/>
          <div style={{ marginTop: 18, display: 'flex', gap: 8 }}>{detail.project.analysis_status !== 'confirmed' && <Button type="primary" loading={busy(`confirm-${detail.project.id}`)} onClick={() => void confirmProject(detail.project.id)}>审阅无误，确认配置</Button>}<Button danger onClick={() => removeProject(detail.project)}>删除项目记录</Button></div>
        </>}
      </Drawer>
    </div>
  );
}
