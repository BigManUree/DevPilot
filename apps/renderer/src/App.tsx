import React, { useEffect, useRef, useState } from 'react';
import {
  ConfigProvider, Layout, Menu, Typography, Table, Button, Input, Space, Tag, Card,
  Modal, message, List, Tabs, Descriptions, Select, Badge,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { api, wsUrl } from './api';
import '@xterm/xterm/css/xterm.css';
import MonacoEditor from '@monaco-editor/react';

/* ---------- 状态色映射 ---------- */
const statusColor: Record<string, string> = {
  Running: 'green', Starting: 'blue', Stopping: 'orange',
  Failed: 'red', Unhealthy: 'volcano', Stopped: 'default', Unknown: 'default',
  Completed: 'green', Pending: 'default', Preparing: 'blue', WaitingApproval: 'orange',
  Failed_: 'red', Cancelled: 'default', PASSED: 'green', PARTIAL: 'orange',
};

/* ---------- 首页工作台 ---------- */
function Dashboard({ go }: { go: (k: string) => void }) {
  const [projects, setProjects] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [goal, setGoal] = useState('');

  const load = React.useCallback(async () => {
    setProjects(await api('/projects'));
    setTasks(await api('/tasks'));
    setApprovals(await api('/approvals'));
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  const submitTask = async () => {
    if (!goal.trim()) return;
    const r = await api<{ taskId: string }>('/tasks', 'POST', { goal });
    message.info(`任务已创建 ${r.taskId.slice(0, 8)}`);
    setGoal('');
    await api(`/tasks/${r.taskId}/run`, 'POST').catch(() => {});
    void load();
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Card title="Supervisor 快捷任务">
        <Space.Compact style={{ width: '100%' }}>
          <Input placeholder="描述任务，例如：读取项目 package.json 并报告依赖" value={goal} onChange={(e) => setGoal(e.target.value)} onPressEnter={submitTask} />
          <Button type="primary" onClick={submitTask}>执行</Button>
        </Space.Compact>
        {approvals.length > 0 && (
          <Typography.Text type="warning" style={{ marginTop: 8, display: 'block' }}>
            有 {approvals.length} 项待审批授权 → 前往「审批中心」处理
          </Typography.Text>
        )}
      </Card>
      <Card title={`项目（${projects.length}）`} extra={<Button onClick={() => go('2')}>管理</Button>}>
        <List size="small" dataSource={projects} renderItem={(p: any) => (
          <List.Item>
            <Space>
              <Typography.Text strong>{p.name}</Typography.Text>
              <Tag>{p.language ?? '未识别'}</Tag>
              <Tag color={statusColor[p.analysis_status === 'confirmed' ? 'Completed' : 'Pending']}>{p.analysis_status}</Tag>
            </Space>
          </List.Item>
        )} />
      </Card>
      <Card title={`最近任务（${tasks.length}）`} extra={<Button onClick={() => go('3')}>任务中心</Button>}>
        <List size="small" dataSource={tasks.slice(0, 5)} renderItem={(t: any) => (
          <List.Item>
            <Space>
              <Tag color={statusColor[t.status] ?? 'default'}>{t.status}</Tag>
              <Typography.Text>{t.input_summary}</Typography.Text>
            </Space>
          </List.Item>
        )} />
      </Card>
    </Space>
  );
}

/* ---------- 项目管理 ---------- */
function Projects() {
  const [projects, setProjects] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [importPath, setImportPath] = useState('');

  const load = React.useCallback(async () => setProjects(await api('/projects')), []);
  useEffect(() => { void load(); }, [load]);

  const doImport = async () => {
    if (!importPath.trim()) return;
    const r = await api<{ projectId: string; analysis: any }>('/projects/import', 'POST', { source: 'folder', rootPath: importPath });
    message.success(`导入成功：识别 ${r.analysis.services.length} 个服务，${r.analysis.unknowns.length} 项待确认`);
    setImportPath('');
    void load();
  };

  const openDetail = async (id: string) => setDetail(await api(`/projects/${id}`));

  const confirmProject = async (id: string) => {
    await api(`/projects/${id}/confirm`, 'POST');
    message.success('配置已确认');
    void load();
  };

  const removeProject = async (id: string) => {
    await api(`/projects/${id}`, 'DELETE');
    message.success('已删除记录（未动磁盘文件）');
    setDetail(null);
    void load();
  };

  const startProject = async (id: string) => {
    const r = await api<{ plan: Array<{ status: string }> }>(`/projects/${id}/start`, 'POST');
    message.success(`启动完成：${r.plan.filter((s) => s.status === 'Running').length} 个服务运行中`);
    void load();
  };

  const stopProject = async (id: string) => {
    await api(`/projects/${id}/stop`, 'POST');
    message.success('已停止');
    void load();
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card title="导入项目">
        <Space.Compact style={{ width: '100%' }}>
          <Input placeholder="项目根目录绝对路径（folder 导入）" value={importPath} onChange={(e) => setImportPath(e.target.value)} onPressEnter={doImport} />
          <Button type="primary" onClick={doImport}>导入并识别</Button>
        </Space.Compact>
      </Card>
      <Table
        rowKey="id" dataSource={projects} size="small"
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '语言', dataIndex: 'language', render: (v) => v ?? '-' },
          { title: '框架', dataIndex: 'framework', render: (v) => v ?? '-' },
          { title: '状态', dataIndex: 'analysis_status' },
          { title: '路径', dataIndex: 'root_path', ellipsis: true },
          {
            title: '操作', render: (_, r) => (
              <Space>
                <Button size="small" onClick={() => void openDetail(r.id)}>详情</Button>
                <Button size="small" type="primary" onClick={() => void startProject(r.id)}>启动</Button>
                <Button size="small" danger onClick={() => void stopProject(r.id)}>停止</Button>
                <Button size="small" onClick={() => void confirmProject(r.id)}>确认配置</Button>
                <Button size="small" danger onClick={() => void removeProject(r.id)}>删除记录</Button>
              </Space>
            ),
          },
        ]}
      />
      <Modal open={!!detail} onCancel={() => setDetail(null)} footer={null} title={detail?.project?.name} width={720}>
        {detail && (
          <Tabs items={[
            {
              key: 'services', label: '服务', children: (
                <Table rowKey="id" size="small" dataSource={detail.services} pagination={false}
                  columns={[
                    { title: '名称', dataIndex: 'name' },
                    { title: '类型', dataIndex: 'service_type' },
                    { title: '启动命令', dataIndex: 'start_command' },
                    { title: '端口', dataIndex: 'port' },
                    { title: '状态', dataIndex: 'status', render: (s) => <Tag color={statusColor[s]}>{s}</Tag> },
                  ]} />
              ),
            },
            {
              key: 'configs', label: '配置草案', children: (
                <Table rowKey="id" size="small" dataSource={detail.configs} pagination={false}
                  columns={[
                    { title: '类型', dataIndex: 'config_type' },
                    { title: '来源', dataIndex: 'source' },
                    { title: '内容', dataIndex: 'content_ref', ellipsis: true },
                  ]} />
              ),
            },
            {
              key: 'info', label: '项目信息', children: (
                <Descriptions column={1} size="small">
                  <Descriptions.Item label="路径">{detail.project.root_path}</Descriptions.Item>
                  <Descriptions.Item label="识别状态">{detail.project.analysis_status}</Descriptions.Item>
                  <Descriptions.Item label="导入来源">{detail.project.import_source}</Descriptions.Item>
                  <Descriptions.Item label="配置版本">{detail.project.config_version}</Descriptions.Item>
                </Descriptions>
              ),
            },
          ]} />
        )}
      </Modal>
    </Space>
  );
}

/* ---------- 任务中心 ---------- */
function Tasks() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const load = React.useCallback(async () => setTasks(await api('/tasks')), []);
  useEffect(() => { void load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Table rowKey="id" size="small" dataSource={tasks}
        columns={[
          { title: '目标', dataIndex: 'input_summary', ellipsis: true },
          { title: '状态', dataIndex: 'status', render: (s) => <Tag color={statusColor[s] ?? 'default'}>{s}</Tag> },
          { title: '结果', dataIndex: 'result_summary', ellipsis: true },
          { title: '创建时间', dataIndex: 'created_at' },
          {
            title: '操作', render: (_, r) => (
              <Space>
                <Button size="small" onClick={async () => setDetail(await api(`/tasks/${r.id}`))}>详情</Button>
                <Button size="small" onClick={async () => { await api(`/tasks/${r.id}/run`, 'POST'); void load(); }}>执行</Button>
                <Button size="small" danger onClick={async () => { await api(`/tasks/${r.id}/cancel`, 'POST'); void load(); }}>取消</Button>
              </Space>
            ),
          },
        ]} />
      <Modal open={!!detail} onCancel={() => setDetail(null)} footer={null} title="任务详情" width={760}>
        {detail && (
          <Tabs items={[
            { key: 'subs', label: '子任务', children: (
              <Table rowKey="id" size="small" pagination={false} dataSource={detail.subtasks}
                columns={[
                  { title: 'Agent', dataIndex: 'assigned_agent' },
                  { title: '状态', dataIndex: 'status', render: (s) => <Tag color={statusColor[s] ?? 'default'}>{s}</Tag> },
                  { title: '输入', dataIndex: 'input_json', ellipsis: true },
                ]} />
            ) },
            { key: 'ck', label: '检查点', children: <List size="small" dataSource={detail.checkpoints} renderItem={(c: any) => <List.Item>{c.created_at} — {c.state_snapshot}</List.Item>} /> },
            { key: 'task', label: '任务', children: <pre style={{ maxHeight: 300, overflow: 'auto' }}>{JSON.stringify(detail.task, null, 2)}</pre> },
          ]} />
        )}
      </Modal>
    </Space>
  );
}

/* ---------- 运行中心 ---------- */
function Runtime() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const load = React.useCallback(async () => {
    setSessions(await api('/runtime/sessions'));
    setProjects(await api('/projects'));
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card title="项目运行控制">
        {projects.map((p) => (
          <Space key={p.id} style={{ marginBottom: 8 }}>
            <Typography.Text strong>{p.name}</Typography.Text>
            <Button size="small" type="primary" onClick={async () => { await api(`/projects/${p.id}/start`, 'POST'); message.info('已启动'); }}>一键启动</Button>
            <Button size="small" danger onClick={async () => { await api(`/projects/${p.id}/stop`, 'POST'); message.info('已停止'); }}>全部停止</Button>
            <Button size="small" onClick={async () => setDetail(await api(`/projects/${p.id}`))}>查看服务</Button>
          </Space>
        ))}
      </Card>
      <Card title={`启动会话（${sessions.length}）`}>
        <Table rowKey="id" size="small" dataSource={sessions} pagination={false}
          columns={[
            { title: '项目', dataIndex: 'project_id', ellipsis: true },
            { title: 'PID', dataIndex: 'pids_json' },
            { title: '启动时间', dataIndex: 'started_at' },
            { title: '停止时间', dataIndex: 'stopped_at', render: (v) => v ?? '运行中' },
          ]} />
      </Card>
      <Modal open={!!detail} onCancel={() => setDetail(null)} footer={null} title="服务状态" width={720}>
        {detail && <Table rowKey="id" size="small" pagination={false} dataSource={detail.services}
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: '状态', dataIndex: 'status', render: (s) => <Tag color={statusColor[s]}>{s}</Tag> },
            { title: '端口', dataIndex: 'port' },
            { title: '命令', dataIndex: 'start_command', ellipsis: true },
            {
              title: '操作', render: (_, s: any) => (
                <Space>
                  <Button size="small" onClick={async () => { await api(`/services/${s.id}/start`, 'POST'); message.info('已启动'); }}>启动</Button>
                  <Button size="small" danger onClick={async () => { await api(`/services/${s.id}/stop`, 'POST'); message.info('已停止'); }}>停止</Button>
                </Space>
              ),
            },
          ]} />}
      </Modal>
    </Space>
  );
}

/* ---------- 终端中心（xterm.js） ---------- */
function Terminal() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<{ term: any; fit: any } | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<string | null>(null);
  // 每会话独立输出缓冲（切会话时回放）
  const buffersRef = useRef<Map<string, string>>(new Map());
  const [logLines, setLogLines] = useState<string[]>([]);

  const load = React.useCallback(async () => setSessions(await api('/terminal/sessions')), []);
  useEffect(() => { void load(); }, [load]);

  // 全局 WS：按 payload.sessionId 路由到对应缓冲
  useEffect(() => {
    let alive = true;
    void (async () => {
      const ws = new WebSocket(await wsUrl());
      wsRef.current = ws;
      ws.onmessage = (ev) => {
        if (!alive) return;
        try {
          const evt = JSON.parse(String(ev.data));
          if (evt.event_type === 'terminal.data') {
            const sid = evt.payload.sessionId as string;
            const chunk = evt.payload.data as string;
            buffersRef.current.set(sid, (buffersRef.current.get(sid) ?? '') + chunk);
            if (sid === activeRef.current && termRef.current) termRef.current.term.write(chunk);
          }
          if (evt.event_type === 'runtime.log') setLogLines((l) => [...l.slice(-500), `[${evt.severity}] ${evt.source_module}: ${evt.payload.message}`]);
        } catch { /* 忽略非 JSON 帧 */ }
      };
    })();
    return () => { alive = false; wsRef.current?.close(); };
  }, []);

  // 挂载 xterm 实例（active 变化时重建并回放缓冲）
  useEffect(() => {
    activeRef.current = active;
    if (!active || !hostRef.current) return;
    Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([{ Terminal }, { FitAddon }]) => {
      const fit = new FitAddon();
      const term = new Terminal({ fontSize: 13, theme: { background: '#0d1117' }, convertEol: true });
      term.loadAddon(fit);
      term.open(hostRef.current!);
      try { fit.fit(); } catch { /* 容器未就绪 */ }
      term.write(buffersRef.current.get(active) ?? '');
      term.onData((d: string) => {
        if (activeRef.current) wsRef.current?.send(JSON.stringify({ event: 'terminal.input', data: { sessionId: activeRef.current, data: d } }));
      });
      termRef.current = { term, fit };
    });
    return () => { termRef.current?.term.dispose(); termRef.current = null; };
  }, [active]);

  const createSession = async () => {
    const r = await api<{ sessionId: string }>('/terminal/sessions', 'POST', {});
    setActive(r.sessionId);
    void load();
  };

  const killSession = async (sid: string) => {
    await api(`/terminal/sessions/${sid}`, 'DELETE');
    buffersRef.current.delete(sid);
    if (active === sid) setActive(null);
    void load();
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card title="终端会话（xterm.js）" extra={<Button onClick={createSession}>新建终端</Button>} size="small">
        <Space wrap>
          {sessions.map((s) => (
            <Tag key={s.sessionId} color={active === s.sessionId ? 'blue' : 'default'} style={{ cursor: 'pointer' }}
              onClick={() => setActive(s.sessionId)}
              closable onClose={(e) => { e.preventDefault(); void killSession(s.sessionId); }}>
              {s.cwd?.split(/[\\/]/).pop() || s.sessionId.slice(0, 8)}
            </Tag>
          ))}
        </Space>
      </Card>
      <Card size="small" title={active ? `终端 ${active.slice(0, 8)}（直接键入，Ctrl+C 支持）` : '未选中会话'}>
        <div ref={hostRef} style={{ height: 380, background: '#0d1117' }} />
      </Card>
      <Card size="small" title={`实时日志流（${logLines.length}）`}>
        <pre style={{ maxHeight: 200, overflow: 'auto', fontSize: 12 }}>
          {logLines.slice(-30).join('\n') || '（等待事件）'}
        </pre>
      </Card>
    </Space>
  );
}

/* ---------- 日志与诊断 ---------- */
function Logs() {
  const [rows, setRows] = useState<any[]>([]);
  const [level, setLevel] = useState<string | undefined>();
  const [source, setSource] = useState<string | undefined>();
  const [logExcerpt, setLogExcerpt] = useState('');
  const [verifyCmd, setVerifyCmd] = useState('node --version');
  const [diag, setDiag] = useState<any>(null);

  const load = React.useCallback(async () => {
    const qs = new URLSearchParams();
    if (level) qs.set('level', level);
    if (source) qs.set('sourceModule', source);
    const r = await api<{ rows: any[] }>(`/logs?${qs}`);
    setRows(r.rows);
  }, [level, source]);
  useEffect(() => { void load(); }, [load]);

  const runDiagnose = async () => {
    const r = await api('/diagnostics', 'POST', { logExcerpt, verifyCommand: verifyCmd });
    setDiag(r);
    message.info(`诊断状态：${(r as any).status}`);
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title="AI 诊断修复">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input.TextArea rows={4} placeholder="粘贴错误日志" value={logExcerpt} onChange={(e) => setLogExcerpt(e.target.value)} />
          <Input value={verifyCmd} onChange={(e) => setVerifyCmd(e.target.value)} placeholder="验证命令" />
          <Button type="primary" onClick={runDiagnose}>诊断并修复</Button>
          {diag && <pre style={{ maxHeight: 240, overflow: 'auto', fontSize: 12 }}>{JSON.stringify(diag, null, 2)}</pre>}
        </Space>
      </Card>
      <Card size="small" title="日志检索">
        <Space style={{ marginBottom: 8 }}>
          <Select allowClear placeholder="级别" style={{ width: 140 }} value={level} onChange={setLevel}
            options={['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((v) => ({ value: v, label: v }))} />
          <Input placeholder="来源模块" style={{ width: 220 }} value={source} onChange={(e) => setSource(e.target.value || undefined)} />
          <Button onClick={() => void load()}>查询</Button>
        </Space>
        <Table rowKey="id" size="small" dataSource={rows} pagination={{ pageSize: 10 }}
          columns={[
            { title: '时间', dataIndex: 'created_at', width: 200 },
            { title: '级别', dataIndex: 'level', render: (l) => <Tag color={l === 'error' ? 'red' : l === 'warn' ? 'orange' : 'default'}>{l}</Tag> },
            { title: '来源', dataIndex: 'source_module' },
            { title: '文件', dataIndex: 'body_ref', ellipsis: true },
          ]} />
      </Card>
    </Space>
  );
}

/* ---------- 审批中心 ---------- */
function Approvals() {
  const [rows, setRows] = useState<any[]>([]);
  const load = React.useCallback(async () => setRows(await api('/approvals')), []);
  useEffect(() => { void load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);

  const act = async (id: string, approve: boolean) => {
    await api(`/approvals/${id}/${approve ? 'approve' : 'reject'}`, 'POST');
    message.success(approve ? '已授权' : '已拒绝');
    void load();
  };

  return (
    <Table rowKey="id" size="small" dataSource={rows}
      columns={[
        { title: '请求方', dataIndex: 'requester' },
        { title: '操作摘要', dataIndex: 'action_summary' },
        { title: '风险', dataIndex: 'risk_level', render: (r) => <Tag color={r === 'high' ? 'red' : r === 'medium' ? 'orange' : 'default'}>{r}</Tag> },
        { title: '时间', dataIndex: 'created_at' },
        {
          title: '操作', render: (_, r) => (
            <Space>
              <Button size="small" type="primary" onClick={() => void act(r.id, true)}>批准</Button>
              <Button size="small" danger onClick={() => void act(r.id, false)}>拒绝</Button>
            </Space>
          ),
        },
      ]} />
  );
}

/* ---------- 环境检测 ---------- */
function Environments() {
  const [tools, setTools] = useState<any[]>([]);
  useEffect(() => { void api<any[]>('/environments').then(setTools); }, []);
  return (
    <Table rowKey="id" size="small" dataSource={tools}
      columns={[
        { title: '工具', dataIndex: 'name' },
        { title: '状态', dataIndex: 'status', render: (s) => <Tag color={s === 'ok' ? 'green' : 'red'}>{s}</Tag> },
        { title: '版本', dataIndex: 'version' },
        { title: '安装指引', dataIndex: 'installHint' },
      ]} />
  );
}

/* ---------- 系统设置 ---------- */
function Settings() {
  const [st, setSt] = useState<any>(null);
  const [key, setKey] = useState('');
  useEffect(() => { void api('/models/status').then(setSt); }, []);
  const save = async () => {
    if (!key.trim()) return;
    await api('/models/config', 'POST', { apiKey: key });
    message.success('API Key 已保存');
    setKey('');
    setSt(await api('/models/status'));
  };
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title="模型配置（DeepSeek）">
        <Descriptions size="small" column={1}>
          <Descriptions.Item label="供应商">{st?.provider}</Descriptions.Item>
          <Descriptions.Item label="模型">{st?.model}</Descriptions.Item>
          <Descriptions.Item label="Key 状态">{st?.keyConfigured ? '已配置' : '未配置'}</Descriptions.Item>
        </Descriptions>
        <Space.Compact style={{ width: '100%', marginTop: 8 }}>
          <Input.Password placeholder="sk-..." value={key} onChange={(e) => setKey(e.target.value)} onPressEnter={save} />
          <Button type="primary" onClick={save}>保存</Button>
        </Space.Compact>
      </Card>
    </Space>
  );
}

/* ---------- Git 中心 ---------- */
function GitCenter() {
  const [repoPath, setRepoPath] = useState('');
  const [st, setSt] = useState<any>(null);
  const [logRows, setLogRows] = useState<any[]>([]);
  const [diffTxt, setDiffTxt] = useState('');
  const [msg, setMsg] = useState('');
  const enc = (s: string) => encodeURIComponent(s);

  const loadStatus = async (p: string) => {
    const s = await api<any>(`/git/status?repoPath=${enc(p)}`);
    setSt(s);
    setLogRows(await api<any[]>(`/git/log?repoPath=${enc(p)}`));
  };

  const open = async () => {
    if (!repoPath.trim()) return;
    try {
      await loadStatus(repoPath);
      message.success('仓库已加载');
    } catch { message.error('仓库加载失败（是否为 git 仓库？）'); }
  };

  const commit = async () => {
    const r = await api<any>('/git/commit', 'POST', { repoPath, message: msg });
    if (r.pendingApproval) message.warning('agent 身份需审批，已生成审批单');
    else if (r.ok) message.success('已提交');
    else message.info(r.output || '无变更可提交');
    setMsg('');
    await loadStatus(repoPath);
  };

  const showDiff = async (f?: string) => {
    const d = await api<any>(`/git/diff?repoPath=${enc(repoPath)}${f ? '&file=' + enc(f) : ''}`);
    setDiffTxt(d.diff || '（无未暂存修改）');
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title="打开仓库">
        <Space.Compact style={{ width: '100%' }}>
          <Input placeholder="仓库绝对路径" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} onPressEnter={open} />
          <Button type="primary" onClick={open}>打开</Button>
        </Space.Compact>
      </Card>
      {st && (
        <>
          <Card size="small" title={`工作区 — ${st.branch} ${st.clean ? '（干净）' : `（${st.files.length} 个变更）`}`} extra={<Button size="small" onClick={() => void loadStatus(repoPath)}>刷新</Button>}>
            <List size="small" dataSource={st.files} renderItem={(f: any) => (
              <List.Item actions={[<Button key="d" size="small" onClick={() => void showDiff(f.path)}>Diff</Button>]}>
                <Space><Tag color={f.status === 'M' ? 'orange' : f.status === '??' ? 'default' : 'blue'}>{f.status || 'M'}</Tag>{f.path}</Space>
              </List.Item>
            )} />
            <Space style={{ marginTop: 8 }}>
              <Input placeholder="提交说明" value={msg} onChange={(e) => setMsg(e.target.value)} style={{ width: 360 }} onPressEnter={commit} />
              <Button type="primary" onClick={commit}>提交全部</Button>
              <Button onClick={() => void showDiff()}>整体 Diff</Button>
            </Space>
          </Card>
          {diffTxt && <Card size="small" title="Diff"><pre style={{ maxHeight: 280, overflow: 'auto', fontSize: 12 }}>{diffTxt}</pre></Card>}
          <Card size="small" title="提交历史">
            <Table rowKey="hash" size="small" pagination={false} dataSource={logRows}
              columns={[
                { title: 'Hash', dataIndex: 'hash', width: 100 },
                { title: '作者', dataIndex: 'author', width: 120 },
                { title: '时间', dataIndex: 'date', width: 200 },
                { title: '说明', dataIndex: 'subject' },
              ]} />
          </Card>
        </>
      )}
    </Space>
  );
}

/* ---------- 代码工作区（Monaco） ---------- */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json',
  py: 'python', java: 'java', go: 'go', rs: 'rust', php: 'php', md: 'markdown',
  html: 'html', css: 'css', xml: 'xml', yaml: 'yaml', yml: 'yaml', bat: 'bat', ps1: 'powershell',
};

function CodeWorkspace() {
  const [root, setRoot] = useState('C:/Users/administer/WorkBuddy/DevPilot');
  const [entries, setEntries] = useState<any[]>([]);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadDir = React.useCallback(async (dir: string) => {
    const r = await api<{ entries: any[] }>('/workspace/dir?dirPath=' + encodeURIComponent(dir));
    setEntries(r.entries);
    setRoot(dir);
  }, []);
  useEffect(() => { void loadDir(root); }, [loadDir]); // eslint-disable-line react-hooks/exhaustive-deps

  const openFile = async (p: string) => {
    const r = await api<{ content: string }>('/workspace/file?filePath=' + encodeURIComponent(p));
    setOpenPath(p);
    setContent(r.content);
    setDirty(false);
  };

  const save = async () => {
    if (!openPath) return;
    setSaving(true);
    const r = await api<{ ok: boolean; error?: string }>('/workspace/file', 'POST', { filePath: openPath, content });
    setSaving(false);
    if (r.ok) { setDirty(false); message.success('已保存（含自动备份）'); }
    else message.error('保存失败：' + r.error);
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title="目录浏览">
        <Space.Compact style={{ width: '70%' }}>
          <Input value={root} onChange={(e) => setRoot(e.target.value)} onPressEnter={() => void loadDir(root)} />
          <Button onClick={() => void loadDir(root)}>打开</Button>
        </Space.Compact>
        <List size="small" style={{ maxHeight: 260, overflow: 'auto' }} dataSource={entries}
          renderItem={(e) => (
            <List.Item
              style={{ cursor: 'pointer', padding: '2px 8px' }}
              onClick={() => (e.isDir ? void loadDir(e.path) : void openFile(e.path))}
            >
              <Typography.Text type={e.isDir ? 'warning' : undefined}>
                {e.isDir ? '📁' : '📄'} {e.name}
              </Typography.Text>
            </List.Item>
          )} />
      </Card>
      {openPath && (
        <Card size="small" title={openPath + (dirty ? ' ●' : '')} extra={<Button type="primary" onClick={save} loading={saving} disabled={!dirty}>保存</Button>}>
          <div style={{ border: '1px solid #eee' }}>
            <MonacoEditor
              height="420px"
              language={LANG_BY_EXT[openPath.split('.').pop() || ''] ?? 'plaintext'}
              value={content}
              onChange={(v) => { setContent(v ?? ''); setDirty(true); }}
              theme="vs"
              options={{ minimap: { enabled: false }, fontSize: 13, automaticLayout: true }}
            />
          </div>
        </Card>
      )}
    </Space>
  );
}

/* ---------- 数据库与本地服务管理 ---------- */
function DatabasesCenter() {
  const [conns, setConns] = useState<any[]>([]);
  const [detected, setDetected] = useState<any[]>([]);
  const [services, setServices] = useState<any[]>([]);
  const [form, setForm] = useState({ name: '', dbType: 'sqlite', host: '127.0.0.1', port: '3306', databaseName: '' });
  const [svcForm, setSvcForm] = useState({ name: '', serviceKind: 'custom', exePath: '', args: '', port: '' });

  const load = React.useCallback(async () => {
    setConns(await api('/databases/connections'));
    setServices(await api('/local-services'));
    setDetected(await api('/databases/detect'));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const addConn = async () => {
    if (!form.name.trim() || !form.databaseName.trim()) return message.warning('名称与 database 为必填');
    await api('/databases/connections', 'POST', { name: form.name, dbType: form.dbType, host: form.dbType === 'sqlite' ? undefined : form.host, port: form.dbType === 'sqlite' ? undefined : Number(form.port), databaseName: form.databaseName });
    message.success('连接已登记');
    void load();
  };

  const testConn = async (id: string) => {
    const r = await api<{ ok: boolean; detail: string }>(`/databases/connections/${id}/test`, 'POST');
    r.ok ? message.success(r.detail) : message.error(r.detail);
    void load();
  };

  const addSvc = async () => {
    if (!svcForm.name.trim() || !svcForm.exePath.trim()) return message.warning('名称与可执行文件为必填');
    await api('/local-services', 'POST', {
      name: svcForm.name, serviceKind: svcForm.serviceKind, exePath: svcForm.exePath,
      args: svcForm.args.trim() ? svcForm.args.split(/\s+/) : undefined,
      port: svcForm.port ? Number(svcForm.port) : undefined,
    });
    message.success('服务已登记');
    setSvcForm({ name: '', serviceKind: 'custom', exePath: '', args: '', port: '' });
    void load();
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title="本地数据服务探测（端口 + Windows 服务）" extra={<Button size="small" onClick={() => void load()}>刷新</Button>}>
        <Table rowKey="kind" size="small" pagination={false} dataSource={detected}
          columns={[
            { title: '服务', dataIndex: 'name' },
            { title: '端口', dataIndex: 'port' },
            { title: '端口', dataIndex: 'portOpen', render: (v) => <Tag color={v ? 'green' : 'default'}>{v ? '开放' : '关闭'}</Tag> },
            { title: 'Windows 服务', dataIndex: 'winService', render: (v, r) => v ? <Tag color={r.winServiceRunning ? 'green' : 'default'}>{v} {r.winServiceRunning ? '运行中' : '已安装'}</Tag> : '-' },
          ]} />
      </Card>
      <Card size="small" title="数据库连接">
        <Space style={{ marginBottom: 8 }} wrap>
          <Input placeholder="名称" style={{ width: 140 }} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Select style={{ width: 110 }} value={form.dbType} onChange={(v) => setForm({ ...form, dbType: v })}
            options={['sqlite', 'mysql', 'postgres', 'mongo', 'redis', 'mssql'].map((v) => ({ value: v, label: v }))} />
          {form.dbType !== 'sqlite' && <>
            <Input placeholder="主机" style={{ width: 140 }} value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
            <Input placeholder="端口" style={{ width: 80 }} value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
          </>}
          <Input placeholder={form.dbType === 'sqlite' ? '数据库文件路径' : '数据库名'} style={{ width: 280 }} value={form.databaseName} onChange={(e) => setForm({ ...form, databaseName: e.target.value })} />
          <Button type="primary" onClick={addConn}>登记</Button>
        </Space>
        <Table rowKey="id" size="small" dataSource={conns} pagination={false}
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: '类型', dataIndex: 'db_type' },
            { title: '目标', render: (_, r) => r.db_type === 'sqlite' ? r.database_name : `${r.host}:${r.port}/${r.database_name ?? '-'}`, ellipsis: true },
            { title: '状态', dataIndex: 'status', render: (s) => <Tag color={s === 'connected' ? 'green' : s === 'unknown' ? 'default' : 'red'}>{s}</Tag> },
            {
              title: '操作', render: (_, r) => (
                <Space>
                  <Button size="small" onClick={() => void testConn(r.id)}>测试</Button>
                  <Button size="small" danger onClick={async () => { await api(`/databases/connections/${r.id}`, 'DELETE'); void load(); }}>删除</Button>
                </Space>
              ),
            },
          ]} />
      </Card>
      <Card size="small" title="本地服务管理">
        <Space style={{ marginBottom: 8 }} wrap>
          <Input placeholder="名称" style={{ width: 120 }} value={svcForm.name} onChange={(e) => setSvcForm({ ...svcForm, name: e.target.value })} />
          <Input placeholder="可执行文件（如 node / mysql/bin/mysqld.exe）" style={{ width: 280 }} value={svcForm.exePath} onChange={(e) => setSvcForm({ ...svcForm, exePath: e.target.value })} />
          <Input placeholder="参数（空格分隔）" style={{ width: 200 }} value={svcForm.args} onChange={(e) => setSvcForm({ ...svcForm, args: e.target.value })} />
          <Input placeholder="健康检查端口" style={{ width: 110 }} value={svcForm.port} onChange={(e) => setSvcForm({ ...svcForm, port: e.target.value })} />
          <Button type="primary" onClick={addSvc}>登记</Button>
        </Space>
        <Table rowKey="id" size="small" dataSource={services} pagination={false}
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: '类型', dataIndex: 'service_kind' },
            { title: '状态', dataIndex: 'status', render: (s) => <Tag color={statusColor[s] ?? 'default'}>{s}</Tag> },
            { title: 'PID', dataIndex: 'pid', render: (v) => v ?? '-' },
            { title: '端口', dataIndex: 'port', render: (v) => v ?? '-' },
            {
              title: '操作', render: (_, r) => (
                <Space>
                  <Button size="small" type="primary" onClick={async () => { const x = await api<any>(`/local-services/${r.id}/start`, 'POST'); x.ok ? message.success(`已启动 pid=${x.pid}`) : message.error(x.error); void load(); }}>启动</Button>
                  <Button size="small" onClick={async () => { await api(`/local-services/${r.id}/check`, 'POST'); void load(); }}>检查</Button>
                  <Button size="small" danger onClick={async () => { await api(`/local-services/${r.id}/stop`, 'POST'); void load(); }}>停止</Button>
                  <Button size="small" danger onClick={async () => { await api(`/local-services/${r.id}`, 'DELETE'); void load(); }}>删除</Button>
                </Space>
              ),
            },
          ]} />
      </Card>
    </Space>
  );
}

/* ---------- 外部工具联动 ---------- */
function ExternalToolsPage() {
  const [tools, setTools] = useState<any[]>([]);
  const [projectPath, setProjectPath] = useState('');
  const [url, setUrl] = useState('');
  const [avds, setAvds] = useState<string[]>([]);

  const load = React.useCallback(async () => setTools(await api('/external-tools')), []);
  useEffect(() => { void load(); }, [load]);

  const openIde = async (toolId: string) => {
    if (!projectPath.trim()) return message.warning('先填写项目路径');
    const r = await api<any>('/external-tools/open-ide', 'POST', { toolId, projectPath });
    r.ok ? message.success(`已在 ${r.tool ?? toolId} 中打开`) : message.error(r.error);
  };
  const openUrl = async (toolId?: string) => {
    if (!url.trim()) return message.warning('先填写 URL');
    const r = await api<any>('/external-tools/open-url', 'POST', { toolId, url });
    r.ok ? message.success('已在浏览器打开') : message.error(r.error);
  };
  const loadAvds = async () => {
    const r = await api<{ ok: boolean; avds: string[]; error?: string }>('/external-tools/avds');
    if (r.ok) { setAvds(r.avds); message.success(`找到 ${r.avds.length} 个 AVD`); }
    else message.error(r.error ?? '未找到模拟器');
  };
  const launch = async (avd: string) => {
    const r = await api<any>('/external-tools/launch-emulator', 'POST', { avd });
    r.ok ? message.success(`模拟器 ${avd} 启动中`) : message.error(r.error);
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title="工具探测" extra={<Button size="small" onClick={() => void load()}>刷新</Button>}>
        <Table rowKey="id" size="small" pagination={false} dataSource={tools}
          columns={[
            { title: '工具', dataIndex: 'name' },
            { title: '类别', dataIndex: 'kind', render: (k) => <Tag>{k}</Tag> },
            { title: '状态', dataIndex: 'status', render: (s) => <Tag color={s === 'ok' ? 'green' : 'red'}>{s === 'ok' ? '可用' : '未找到'}</Tag> },
            { title: '路径', dataIndex: 'exePath', ellipsis: true },
          ]} />
      </Card>
      <Card size="small" title="IDE 打开项目">
        <Space.Compact style={{ width: '70%' }}>
          <Input placeholder="项目绝对路径" value={projectPath} onChange={(e) => setProjectPath(e.target.value)} />
        </Space.Compact>
        <Space style={{ marginTop: 8 }}>
          {tools.filter((t) => t.kind === 'ide' && t.status === 'ok').map((t) => (
            <Button key={t.id} onClick={() => void openIde(t.id)}>用 {t.name} 打开</Button>
          ))}
        </Space>
      </Card>
      <Card size="small" title="浏览器打开 URL">
        <Input placeholder="https://..." value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: '50%' }} onPressEnter={() => void openUrl()} />
        <Space style={{ marginTop: 8 }}>
          <Button type="primary" onClick={() => void openUrl()}>默认浏览器</Button>
          {tools.filter((t) => t.kind === 'browser' && t.status === 'ok').map((t) => (
            <Button key={t.id} onClick={() => void openUrl(t.id)}>{t.name}</Button>
          ))}
        </Space>
      </Card>
      <Card size="small" title="Android 模拟器">
        <Space style={{ marginBottom: 8 }}>
          <Button onClick={() => void loadAvds()}>列出 AVD</Button>
        </Space>
        <Space wrap>
          {avds.map((a) => (
            <Tag key={a} color="blue" style={{ cursor: 'pointer' }} onClick={() => void launch(a)}>{a} ▶ 启动</Tag>
          ))}
        </Space>
      </Card>
    </Space>
  );
}

/* ---------- 多环境配置中心 ---------- */
function ConfigCenterPage() {
  const [projects, setProjects] = useState<any[]>([]);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [profiles, setProfiles] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [vars, setVars] = useState('{}');
  const [diffResult, setDiffResult] = useState<any>(null);

  useEffect(() => { void api<any[]>('/projects').then((p) => { setProjects(p); if (p.length) setProjectId(p[0].id); }); }, []);
  const load = React.useCallback(async () => {
    if (projectId) setProfiles(await api(`/config-center/profiles?projectId=${projectId}`));
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const addProfile = async () => {
    if (!projectId || !name.trim()) return message.warning('选项目并填写环境名');
    let parsed: Record<string, string>;
    try { parsed = JSON.parse(vars); } catch { return message.error('变量需为合法 JSON'); }
    await api('/config-center/profiles', 'POST', { projectId, name, variables: parsed });
    message.success('环境档案已保存');
    setName(''); setVars('{}');
    void load();
  };
  const activate = async (id: string) => {
    const r = await api<any>(`/config-center/profiles/${id}/activate`, 'POST', { projectId });
    message.success(`已激活并写入 ${r.servicesUpdated} 个服务 env`);
    void load();
  };
  const doDiff = async () => {
    if (profiles.length < 2) return message.warning('需要至少两个档案');
    const r = await api('/config-center/diff', 'POST', { projectId, profileA: profiles[0].id, profileB: profiles[1].id });
    setDiffResult(r);
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title="选择项目">
        <Select style={{ width: 360 }} value={projectId} onChange={setProjectId}
          options={projects.map((p) => ({ value: p.id, label: p.name }))} />
      </Card>
      <Card size="small" title={`环境档案（${profiles.length}）`}>
        <Space style={{ marginBottom: 8 }} wrap>
          <Input placeholder="环境名（dev/test/prod）" style={{ width: 160 }} value={name} onChange={(e) => setName(e.target.value)} />
          <Input.TextArea placeholder='变量 JSON：{"API_URL":"..."}' rows={1} style={{ width: 320 }} value={vars} onChange={(e) => setVars(e.target.value)} />
          <Button type="primary" onClick={addProfile}>保存</Button>
          <Button onClick={() => void doDiff()}>对比前两个档案</Button>
        </Space>
        <Table rowKey="id" size="small" dataSource={profiles} pagination={false}
          columns={[
            { title: '环境', dataIndex: 'name' },
            { title: '状态', dataIndex: 'active', render: (v) => v ? <Tag color="green">激活中</Tag> : <Tag>未激活</Tag> },
            { title: '变量', dataIndex: 'variables', render: (v) => <pre style={{ margin: 0, fontSize: 12, maxHeight: 80, overflow: 'auto' }}>{JSON.stringify(v, null, 1)}</pre> },
            {
              title: '操作', render: (_, r) => (
                <Space>
                  <Button size="small" type="primary" disabled={r.active} onClick={() => void activate(r.id)}>激活（写入服务 env）</Button>
                  <Button size="small" danger onClick={async () => { await api(`/config-center/profiles/${r.id}`, 'DELETE'); void load(); }}>删除</Button>
                </Space>
              ),
            },
          ]} />
      </Card>
      {diffResult && (
        <Card size="small" title={`对比：${diffResult.a} vs ${diffResult.b}`}>
          <pre style={{ fontSize: 12, maxHeight: 240, overflow: 'auto' }}>{JSON.stringify(diffResult, null, 2)}</pre>
        </Card>
      )}
    </Space>
  );
}

/* ---------- 统一备份迁移 ---------- */
function BackupCenterPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [bundlePath, setBundlePath] = useState('');

  const load = React.useCallback(async () => {
    setRows(await api('/backups'));
    setProjects(await api('/projects'));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    const r = await api<any>('/backups', 'POST', {});
    message.success(`备份完成 ${(r.size / 1024).toFixed(0)} KB`);
    void load();
  };
  const verify = async (id: string) => {
    const r = await api<{ ok: boolean; error?: string }>(`/backups/${id}/verify`, 'POST');
    r.ok ? message.success('校验通过') : message.error(r.error ?? '校验失败');
    void load();
  };
  const restore = async (id: string) => {
    const r = await api<any>(`/backups/${id}/restore`, 'POST');
    r.ok ? message.warning(r.message) : message.error(r.error);
  };
  const exportProject = async (projectId: string) => {
    const r = await api<any>('/backups/export-project', 'POST', { projectId });
    message.success(`导出完成（${r.counts.services} 服务 / ${r.counts.profiles} 档案）→ ${r.file}`);
    setBundlePath(r.file);
  };
  const importProject = async () => {
    if (!bundlePath.trim()) return message.warning('填写导出包路径');
    const r = await api<any>('/backups/import-project', 'POST', { bundlePath });
    r.ok ? message.success(`导入完成${r.skipped ? '（项目已存在，增量恢复）' : ''}：+${r.created.services} 服务 +${r.created.profiles} 档案`) : message.error(r.error);
    void load();
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title="全量备份（SQLite 快照 + SHA256）">
        <Button type="primary" onClick={create}>立即备份</Button>
        <Table rowKey="id" size="small" style={{ marginTop: 8 }} dataSource={rows} pagination={false}
          columns={[
            { title: '时间', dataIndex: 'created_at', width: 200 },
            { title: '类型', dataIndex: 'backup_type' },
            { title: '数据版本', dataIndex: 'data_version' },
            { title: '大小', dataIndex: 'size_bytes', render: (v) => `${(v / 1024).toFixed(0)} KB` },
            { title: '校验', dataIndex: 'verify_status', render: (s) => <Tag color={s === 'verified' ? 'green' : s === 'unverified' ? 'default' : 'red'}>{s}</Tag> },
            {
              title: '操作', render: (_, r) => (
                <Space>
                  <Button size="small" onClick={() => void verify(r.id)}>校验</Button>
                  <Button size="small" danger onClick={() => void restore(r.id)}>恢复（重启生效）</Button>
                </Space>
              ),
            },
          ]} />
      </Card>
      <Card size="small" title="项目导出 / 导入（跨机器迁移）">
        <Space wrap style={{ marginBottom: 8 }}>
          <Select placeholder="选择项目" style={{ width: 280 }} onChange={(v) => void exportProject(v)}
            options={projects.map((p) => ({ value: p.id, label: p.name }))} />
        </Space>
        <Space.Compact style={{ width: '80%' }}>
          <Input placeholder="导出包 JSON 路径" value={bundlePath} onChange={(e) => setBundlePath(e.target.value)} />
          <Button type="primary" onClick={importProject}>导入</Button>
        </Space.Compact>
      </Card>
    </Space>
  );
}

/* ---------- 通知中心 ---------- */
function NotificationCenterPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [unread, setUnread] = useState(0);

  const load = React.useCallback(async () => {
    setRows(await api('/notifications'));
    setUnread(await api('/notifications/unread-count'));
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title={`通知中心（未读 ${unread}）`}
        extra={<Space>
          <Button size="small" onClick={async () => { await api('/notifications/read-all', 'POST'); void load(); }}>全部已读</Button>
          <Button size="small" onClick={() => void load()}>刷新</Button>
        </Space>}>
        <List dataSource={rows} renderItem={(n: any) => (
          <List.Item actions={[
            !n.read && <Button key="r" size="small" onClick={async () => { await api(`/notifications/${n.id}/read`, 'POST'); void load(); }}>已读</Button>,
            <Button key="d" size="small" danger onClick={async () => { await api(`/notifications/${n.id}`, 'DELETE'); void load(); }}>删除</Button>,
          ].filter(Boolean) as any}>
            <List.Item.Meta
              title={<Space>
                <Tag color={n.priority <= 2 ? 'red' : n.priority <= 3 ? 'orange' : 'default'}>{n.type}</Tag>
                <Typography.Text strong={!n.read}>{n.title}</Typography.Text>
                {n.read ? null : <Badge status="processing" text="未读" />}
              </Space>}
              description={`${n.content_summary ?? ''} — ${n.created_at}`}
            />
          </List.Item>
        )} />
      </Card>
    </Space>
  );
}

/* ---------- 主布局 ---------- */
const NAV = [
  { key: '1', label: '首页工作台' },
  { key: '2', label: '项目管理' },
  { key: '3', label: '任务中心' },
  { key: '4', label: '运行中心' },
  { key: '5', label: '终端中心' },
  { key: '6', label: '日志与诊断' },
  { key: '7', label: '审批中心' },
  { key: '8', label: '环境与依赖' },
  { key: '9', label: '系统设置' },
  { key: '10', label: 'Git 中心' },
  { key: '11', label: '代码工作区' },
  { key: '12', label: '数据库与服务' },
  { key: '13', label: '外部工具' },
  { key: '14', label: '配置中心' },
  { key: '15', label: '备份迁移' },
  { key: '16', label: '通知中心' },
];

export default function App() {
  const [page, setPage] = useState('1');
  const render = () => {
    switch (page) {
      case '1': return <Dashboard go={setPage} />;
      case '2': return <Projects />;
      case '3': return <Tasks />;
      case '4': return <Runtime />;
      case '5': return <Terminal />;
      case '6': return <Logs />;
      case '7': return <Approvals />;
      case '8': return <Environments />;
      case '9': return <Settings />;
      case '10': return <GitCenter />;
      case '11': return <CodeWorkspace />;
      case '12': return <DatabasesCenter />;
      case '13': return <ExternalToolsPage />;
      case '14': return <ConfigCenterPage />;
      case '15': return <BackupCenterPage />;
      case '16': return <NotificationCenterPage />;
      default: return null;
    }
  };
  return (
    <ConfigProvider locale={zhCN}>
      <Layout style={{ height: '100vh' }}>
        <Layout.Sider theme="dark" width={180}>
          <div style={{ padding: 16 }}>
            <Typography.Title level={5} style={{ color: '#fff', margin: 0 }}>DevPilot</Typography.Title>
          </div>
          <Menu theme="dark" mode="inline" items={NAV} selectedKeys={[page]} onClick={(e) => setPage(e.key)} />
        </Layout.Sider>
        <Layout>
          <Layout.Content style={{ padding: 20, overflow: 'auto', background: '#f5f5f5' }}>{render()}</Layout.Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}
