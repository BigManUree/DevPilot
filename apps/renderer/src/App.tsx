import React, { useEffect, useRef, useState } from 'react';
import {
  ConfigProvider, Typography, Table, Button, Input, Space, Tag, Card,
  Modal, message, List, Tabs, Descriptions, Select, Badge, Steps, Result, Checkbox,
} from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { api, pickDirectory } from './api';
import { buildAntdTheme, type ThemeMode } from './theme';
import { useThemeMode } from './components/useTheme';
import Shell, { PAGES } from './components/Shell';
import { MetricCard, Mono, PageHeader, SectionCard, StateBlock, StatusTag, statusColor } from './components/ui';
import { formatTime } from './utils';
import Dashboard from './pages/Dashboard';
import Projects from './pages/Projects';
import { getCachedEnvironments, primeEnvironments, refreshEnvironments } from './envCache';
import { PROVIDER_LOGOS } from './providerLogos';
import './styles.css';

/** 删除类操作统一确认：说明删除范围，避免误点 */
function confirmDelete(title: string, content: string, onOk: () => Promise<void>) {
  Modal.confirm({
    title, content,
    okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
    onOk: async () => { try { await onOk(); } catch (e: any) { message.error('删除失败：' + (e?.message ?? String(e))); } },
  });
}

/* ---------- 任务中心 ---------- */
function Tasks() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [askTask, setAskTask] = useState<any>(null);
  const [answer, setAnswer] = useState('');
  const load = React.useCallback(async () => setTasks(await api('/tasks')), []);
  useEffect(() => { void load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);

  const submitAnswer = async () => {
    if (!askTask || !answer.trim()) return;
    try {
      const r = await api<any>(`/tasks/${askTask.id}/respond-input`, 'POST', { answer, run: false });
      message.success(`补充已提交（状态 → ${r.status}），可在操作列点击「执行」继续`);
    } catch (e: any) {
      message.error('提交失败：' + (e?.message ?? String(e)));
    }
    setAskTask(null); setAnswer(''); void load();
  };

  const [statusFilter, setStatusFilter] = useState<string>('all');
  const filteredTasks = tasks.filter((task) => statusFilter === 'all' || task.status === statusFilter);
  const counts = {
    running: tasks.filter((task) => ['Running', 'Preparing'].includes(task.status)).length,
    waiting: tasks.filter((task) => ['WaitingApproval', 'WaitingInput'].includes(task.status)).length,
    pending: tasks.filter((task) => task.status === 'Pending').length,
    done: tasks.filter((task) => ['Completed', 'Failed', 'Cancelled'].includes(task.status)).length,
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <div className="dp-metrics">
        <MetricCard label="执行中" value={counts.running} hint="含准备与运行状态" />
        <MetricCard label="等待确认" value={counts.waiting} hint="审批或补充输入" tone="amber" />
        <MetricCard label="待执行" value={counts.pending} hint="可在操作列启动" />
        <MetricCard label="已结束" value={counts.done} hint="完成、失败或取消" tone="green" />
      </div>
      <SectionCard title={`任务列表（${filteredTasks.length}）`} extra={(
        <Select value={statusFilter} onChange={setStatusFilter} style={{ width: 140 }} size="small" options={[
          { value: 'all', label: '全部状态' }, { value: 'Running', label: '运行中' }, { value: 'Preparing', label: '准备中' },
          { value: 'Pending', label: '待执行' }, { value: 'WaitingApproval', label: '待审批' }, { value: 'WaitingInput', label: '待输入' },
          { value: 'Paused', label: '已暂停' }, { value: 'Completed', label: '已完成' }, { value: 'Failed', label: '失败' },
        ]} />
      )}>
        <StateBlock loading={false} empty={filteredTasks.length === 0} emptyText="没有符合当前筛选条件的任务">
          <Table rowKey="id" size="small" dataSource={filteredTasks} pagination={{ pageSize: 10, hideOnSinglePage: true }}
            columns={[
              { title: '任务目标', dataIndex: 'input_summary', ellipsis: true, render: (value: string, row) => <span><Typography.Text strong>{value || '未命名任务'}</Typography.Text><div className="dp-desc">{String(row.id).slice(0, 8)} · {formatTime(row.created_at)}</div></span> },
              { title: '状态', dataIndex: 'status', width: 105, render: (s) => <StatusTag status={s} /> },
              { title: '结果', dataIndex: 'result_summary', ellipsis: true },
              {
                title: '操作', width: 265, render: (_, r) => (
                  <Space size={4} wrap>
                    <Button size="small" onClick={async () => setDetail(await api(`/tasks/${r.id}`))}>详情</Button>
                    {['Pending', 'WaitingInput'].includes(r.status) && <Button size="small" type="primary" onClick={async () => { await api(`/tasks/${r.id}/run`, 'POST'); void load(); }}>执行</Button>}
                    {['Running', 'Preparing'].includes(r.status) && <Button size="small" onClick={async () => { await api(`/tasks/${r.id}/pause`, 'POST'); void load(); }}>暂停</Button>}
                    {r.status === 'Paused' && <Button size="small" type="primary" onClick={async () => { await api(`/tasks/${r.id}/resume`, 'POST'); void load(); }}>恢复</Button>}
                    {r.status === 'WaitingInput' && <Button size="small" type="primary" onClick={() => { setAskTask(r); setAnswer(''); }}>补充信息</Button>}
                    {['Pending', 'Preparing', 'Running', 'Paused', 'WaitingApproval', 'WaitingInput'].includes(r.status) && <Button size="small" danger onClick={async () => { await api(`/tasks/${r.id}/cancel`, 'POST'); void load(); }}>取消</Button>}
                  </Space>
                ),
              },
            ]} />
        </StateBlock>
      </SectionCard>
      <Modal open={!!detail} onCancel={() => setDetail(null)} footer={null} title="任务详情" width={780}>
        {detail && (
          <Tabs items={[
            { key: 'subs', label: '子任务', children: (
              <Table rowKey="id" size="small" pagination={false} dataSource={detail.subtasks}
                columns={[
                  { title: 'Agent', dataIndex: 'assigned_agent' },
                  { title: '状态', dataIndex: 'status', render: (s) => <StatusTag status={s} /> },
                  { title: '输入', dataIndex: 'input_json', ellipsis: true },
                ]} />
            ) },
            { key: 'ck', label: '检查点', children: <List size="small" dataSource={detail.checkpoints} renderItem={(c: any) => <List.Item>{c.created_at} — {c.state_snapshot}</List.Item>} /> },
            { key: 'task', label: '任务', children: <pre className="dp-code-block">{JSON.stringify(detail.task, null, 2)}</pre> },
          ]} />
        )}
      </Modal>
      <Modal open={!!askTask} onCancel={() => setAskTask(null)} onOk={submitAnswer} okText="提交并转待执行"
        title={`补充信息 — ${askTask?.input_summary?.slice(0, 40) ?? ''}`}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>{askTask?.result_summary}</Typography.Paragraph>
        <Input.TextArea rows={4} placeholder="补充任务目标、涉及路径、前置条件等" value={answer} onChange={(e) => setAnswer(e.target.value)} />
      </Modal>
    </Space>
  );
}

/* ---------- 日志与诊断 ---------- */
function Logs() {
  const [rows, setRows] = useState<any[]>([]);
  const [level, setLevel] = useState<string | undefined>();
  const [source, setSource] = useState<string | undefined>();
  const [logExcerpt, setLogExcerpt] = useState('');
  const [diag, setDiag] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 「查看内容」弹窗：读取该行来源模块对应的日志文件尾部正文
  const [viewSource, setViewSource] = useState<string | null>(null);
  const [viewText, setViewText] = useState('');
  const [viewLoading, setViewLoading] = useState(false);

  const openLogContent = async (row: any) => {
    setViewSource(row.source_module ?? row.body_ref ?? 'log');
    setViewLoading(true);
    setViewText('');
    try {
      const r = await api<{ tail: string }>(`/logs/tail?sourceModule=${encodeURIComponent(row.source_module ?? '')}&lines=400`);
      setViewText(r.tail || '（该日志文件为空）');
    } catch (e: any) {
      setViewText('读取失败：' + (e?.message ?? String(e)));
    } finally {
      setViewLoading(false);
    }
  };

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (level) qs.set('level', level);
      if (source) qs.set('sourceModule', source);
      const r = await api<{ rows: any[] }>(`/logs?${qs}`);
      setRows(r.rows ?? []);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [level, source]);
  useEffect(() => { void load(); }, [load]);

  const runDiagnose = () => {
    if (!logExcerpt.trim()) { message.warning('先粘贴需要诊断的错误日志'); return; }
    Modal.confirm({
      title: '开始 AI 诊断修复？',
      content: (
        <div>
          <p>诊断会把日志摘录（{logExcerpt.length} 字符）发给当前模型。</p>
          <p>模型给出的文件修改会先备份再写入，写入与命令执行都经过审批门。</p>
        </div>
      ),
      okText: '开始诊断',
      onOk: async () => {
        setRunning(true);
        setDiag(null);
        try {
          const r = await api<any>('/diagnostics', 'POST', { logExcerpt });
          setDiag(r);
          message.info(`诊断状态：${r?.status ?? '未知'}`);
        } catch (e: any) {
          message.error('诊断失败：' + (e?.message ?? String(e)));
        } finally {
          setRunning(false);
        }
      },
    });
  };

  const diffLineStyle = (line: string): React.CSSProperties => {
    if (line.startsWith('+')) return { background: 'var(--dp-success-bg)', color: 'var(--dp-success-fg)' };
    if (line.startsWith('-')) return { background: 'var(--dp-danger-bg)', color: 'var(--dp-danger-fg)' };
    if (line.startsWith('@@')) return { color: 'var(--dp-text-2)' };
    return {};
  };

  return (
    <div>
      <SectionCard title="AI 诊断修复" style={{ marginBottom: 16 }}>
        <p className="dp-desc" style={{ marginTop: 0, marginBottom: 10 }}>
          流程：读日志 → 模型定位根因 → 生成文件级修复 → 备份 → 写入（审批门）。
        </p>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input.TextArea rows={4} placeholder="粘贴错误日志或堆栈" value={logExcerpt} onChange={(e) => setLogExcerpt(e.target.value)} />
          <div>
            <Button type="primary" loading={running} onClick={runDiagnose}>诊断并修复</Button>
          </div>

          {diag && (
            <div style={{ borderTop: '1px solid var(--dp-border)', paddingTop: 12 }}>
              <Space size={8} style={{ marginBottom: 8 }}>
                <StatusTag status={diag.status ?? 'Unknown'} />
                {diag.diagnosisId && <Mono>诊断 {String(diag.diagnosisId).slice(0, 8)}</Mono>}
              </Space>
              {diag.analysis && (
                <div style={{ background: 'var(--dp-code-bg)', border: '1px solid var(--dp-border)', borderRadius: 6, padding: 10, whiteSpace: 'pre-wrap', fontSize: 13, marginBottom: 10 }}>
                  {diag.analysis}
                </div>
              )}
              {(diag.diffs ?? []).length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  {(diag.diffs ?? []).map((d: any, i: number) => (
                    <div key={i} style={{ marginBottom: 8 }}>
                      <Space size={8}>
                        <Mono>{d.path}</Mono>
                        <Tag color={d.rolledBack ? 'orange' : d.applied ? 'green' : 'default'}>
                          {d.rolledBack ? '已回滚' : d.applied ? '已写入' : '未写入'}
                        </Tag>
                      </Space>
                      <pre className="dp-diff dp-mono">
                        {String(d.diff ?? '').split('\n').map((line: string, li: number) => (
                          <div key={li} style={diffLineStyle(line)}>{line || ' '}</div>
                        ))}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
              {(diag.verifyAttempts ?? []).length > 0 && (
                <Space direction="vertical" size={2} style={{ marginBottom: 8 }}>
                  {(diag.verifyAttempts ?? []).map((v: any, i: number) => (
                    <span key={i} style={{ fontSize: 12 }}>
                      验证 <Mono>{v.command}</Mono> → {v.timedOut ? <span style={{ color: 'var(--dp-warning)' }}>超时</span> : v.exitCode === 0 ? <span style={{ color: 'var(--dp-success)' }}>通过（exit 0）</span> : <span style={{ color: 'var(--dp-danger-fg)' }}>失败（exit {v.exitCode}）</span>}
                    </span>
                  ))}
                </Space>
              )}
              {diag.report && <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, marginBottom: 8 }}>{diag.report}</div>}
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }} copyable={{ text: JSON.stringify(diag, null, 2) }}>
                复制原始响应
              </Typography.Paragraph>
            </div>
          )}
        </Space>
      </SectionCard>

      <SectionCard title={`日志检索${rows.length ? `（${rows.length}）` : ''}`}>
        <Space wrap style={{ marginBottom: 8 }}>
          <Select allowClear placeholder="级别" style={{ width: 140 }} value={level} onChange={setLevel}
            options={['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map((v) => ({ value: v, label: v }))} />
          <Input placeholder="来源模块，例如 workflow" style={{ width: 220 }} value={source} onChange={(e) => setSource(e.target.value || undefined)} />
          <Button onClick={() => void load()}>查询</Button>
        </Space>
        <StateBlock loading={loading} error={error} onRetry={() => void load()} empty={rows.length === 0} emptyText="当前筛选条件下没有日志">
          <Table rowKey="id" size="small" dataSource={rows} pagination={{ pageSize: 12 }} scroll={{ x: 820 }}
            columns={[
              { title: '时间', dataIndex: 'created_at', width: 120, render: (v: string) => <Mono title={v}>{formatTime(v)}</Mono> },
              { title: '级别', dataIndex: 'level', width: 80, render: (l) => <Tag color={l === 'error' || l === 'fatal' ? 'red' : l === 'warn' ? 'orange' : 'default'}>{l}</Tag> },
              { title: '来源', dataIndex: 'source_module', width: 180, ellipsis: true },
              { title: '日志文件', dataIndex: 'body_ref', ellipsis: true, render: (v: string) => <Mono title={v}>{v}</Mono> },
              {
                title: '操作', width: 100, render: (_, r: any) => (
                  <Button size="small" onClick={() => void openLogContent(r)}>查看内容</Button>
                ),
              },
            ]} />
        </StateBlock>
      </SectionCard>

      <Modal
        open={!!viewSource}
        onCancel={() => setViewSource(null)}
        footer={null}
        width={860}
        title={viewSource ? `日志内容 — ${viewSource}` : '日志内容'}
      >
        <pre
          className="dp-mono"
          style={{
            margin: 0, maxHeight: 520, overflow: 'auto', fontSize: 12, lineHeight: '18px',
            background: 'var(--dp-code-bg)', border: '1px solid var(--dp-border)', borderRadius: 6, padding: 10,
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}
        >
          {viewLoading ? '加载中…' : viewText}
        </pre>
      </Modal>
    </div>
  );
}

/* ---------- 审批中心 ---------- */
function Approvals() {
  const [rows, setRows] = useState<any[]>([]);
  const load = React.useCallback(async () => setRows(await api('/approvals')), []);
  useEffect(() => { void load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);

  const [acting, setActing] = useState<string | null>(null);
  const highRisk = rows.filter((row) => row.risk_level === 'high').length;
  const mediumRisk = rows.filter((row) => row.risk_level === 'medium').length;

  const act = async (id: string, approve: boolean) => {
    if (acting) return;
    setActing(id);
    try {
      await api(`/approvals/${id}/${approve ? 'approve' : 'reject'}`, 'POST');
      message.success(approve ? '已授权' : '已拒绝');
      void load();
    } catch (e: any) { message.error(e?.message ?? String(e)); }
    finally { setActing(null); }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <div className="dp-metrics" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
        <MetricCard label="待处理" value={rows.length} hint="每 3 秒自动刷新" />
        <MetricCard label="高风险" value={highRisk} hint="建议逐条确认" tone="amber" />
        <MetricCard label="中风险" value={mediumRisk} hint="涉及状态或文件写入" />
      </div>
      <SectionCard title="审批队列">
        <StateBlock loading={false} empty={rows.length === 0} emptyText="没有等待授权的操作">
          <Table rowKey="id" size="small" dataSource={rows}
            columns={[
              { title: '请求方', dataIndex: 'requester', width: 150 },
              { title: '操作摘要', dataIndex: 'action_summary', ellipsis: true },
              { title: '风险', dataIndex: 'risk_level', width: 95, render: (r) => <Tag color={r === 'high' ? 'red' : r === 'medium' ? 'orange' : 'default'}>{r}</Tag> },
              { title: '时间', dataIndex: 'created_at', width: 180, render: (value: string) => <Mono title={value}>{formatTime(value)}</Mono> },
              {
                title: '操作', width: 140, render: (_, r) => (
                  <Space size={4}>
                    <Button size="small" type="primary" loading={acting === r.id} onClick={() => void act(r.id, true)}>批准</Button>
                    <Button size="small" danger loading={acting === r.id} onClick={() => void act(r.id, false)}>拒绝</Button>
                  </Space>
                ),
              },
            ]} />
        </StateBlock>
      </SectionCard>
    </Space>
  );
}

/* ---------- 环境检测 ---------- */
function Environments() {
  const [tools, setTools] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // 打开页面优先读启动时缓存的检测结果，不再每次进入都重新检测
  const load = React.useCallback(async () => {
    setError(null);
    try {
      setTools(await getCachedEnvironments());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // 手动刷新：强制重新检测一遍
  const refresh = async () => {
    setRefreshing(true);
    try {
      setTools(await refreshEnvironments());
      message.success('环境检测完成');
    } catch (e: any) {
      message.error('检测失败：' + (e?.message ?? String(e)));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <SectionCard
      title="运行时与工具检测"
      extra={<Button size="small" loading={refreshing} onClick={() => void refresh()}>刷新检测</Button>}
    >
      <p className="dp-desc" style={{ marginTop: 0 }}>应用启动时自动检测一次；如安装了新工具，点右上角「刷新检测」重新扫描。</p>
      <StateBlock loading={loading} error={error} onRetry={() => void load()} empty={tools.length === 0} emptyText="暂无检测结果，点「刷新检测」开始扫描">
        <Table rowKey="id" size="small" dataSource={tools}
          columns={[
            { title: '工具', dataIndex: 'name' },
            { title: '状态', dataIndex: 'status', render: (s) => <Tag color={s === 'ok' ? 'green' : 'red'}>{s}</Tag> },
            { title: '版本', dataIndex: 'version' },
            { title: '安装指引', dataIndex: 'installHint' },
          ]} />
      </StateBlock>
    </SectionCard>
  );
}

/* ---------- 系统设置（模型供应商：ccswitch 式卡片切换，官方品牌图标） ---------- */

function Settings({ rerunOnboarding, themeMode, onThemeChange }: { rerunOnboarding: () => void; themeMode: ThemeMode; onThemeChange: (mode: ThemeMode) => void }) {
  const [st, setSt] = useState<any>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  // 配置弹窗：编辑某个供应商的 Key / 模型 / Base URL
  const [editing, setEditing] = useState<any>(null);
  const [keyVal, setKeyVal] = useState('');
  const [modelVal, setModelVal] = useState('');
  const [urlVal, setUrlVal] = useState('');
  const [saving, setSaving] = useState(false);

  const load = React.useCallback(async () => setSt(await api('/models/status')), []);
  useEffect(() => { void load(); }, [load]);

  const switchTo = async (p: string) => {
    if (switching) return;
    setSwitching(p);
    try {
      const r = await api<{ provider: string; keyConfigured: boolean }>('/models/switch', 'POST', { provider: p });
      r.keyConfigured ? message.success(`已切换到 ${p}`) : message.warning(`已切换到 ${p}，但该供应商尚未配置 Key，点「配置」补上即可`);
      await load();
    } catch (e: any) {
      message.error('切换失败：' + (e?.message ?? String(e)));
    } finally {
      setSwitching(null);
    }
  };

  const openConfig = (p: any) => {
    setEditing(p);
    setKeyVal('');
    setModelVal(p.defaultModel ?? '');
    setUrlVal(p.baseUrl ?? '');
  };

  const saveConfig = async () => {
    if (!editing || saving) return;
    if (!keyVal.trim()) { message.warning('API Key 必填（已配置的 Key 重新保存即可覆盖）'); return; }
    setSaving(true);
    try {
      await api('/models/config', 'POST', {
        provider: editing.id,
        apiKey: keyVal.trim(),
        model: modelVal.trim() || undefined,
        baseUrl: urlVal.trim() || undefined,
      });
      message.success(`${editing.label} 配置已保存`);
      setEditing(null);
      await load();
    } catch (e: any) {
      message.error('保存失败：' + (e?.message ?? String(e)));
    } finally {
      setSaving(false);
    }
  };

  const current = st?.providers?.find((p: any) => p.active);
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title="外观与主题">
        <p className="dp-desc" style={{ marginTop: 0, marginBottom: 14 }}>选择浅色、深色，或随操作系统自动切换。设置会保存在本机，并在下次启动时恢复。</p>
        <div className="dp-theme-options">
          {([
            { key: 'light' as ThemeMode, label: '浅色模式', className: '' },
            { key: 'dark' as ThemeMode, label: '深色模式', className: 'dark' },
            { key: 'system' as ThemeMode, label: '跟随系统', className: 'system' },
          ]).map((option) => (
            <button key={option.key} type="button" className={`dp-theme-option${themeMode === option.key ? ' active' : ''}`} onClick={() => onThemeChange(option.key)} aria-pressed={themeMode === option.key}>
              <div className={`dp-theme-preview ${option.className}`} />
              <strong>{option.label}{themeMode === option.key ? ' · 当前' : ''}</strong>
            </button>
          ))}
        </div>
      </Card>
      <Card size="small" title="模型供应商">
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          全部走 OpenAI 兼容协议，点击卡片上的「切换」自由更换当前模型，点「配置」填写 Key / 模型 / Base URL。
          Key 保存在 Windows 凭据管理器（不可用时降级为本地加密文件），界面与日志只显示「已配置 / 未配置」，不回显明文。
          当前激活：<Tag color="blue">{current?.label ?? st?.provider ?? '-'}</Tag>
          {current && <Typography.Text type="secondary">{current.defaultModel}{current.keyConfigured ? '' : ' · 未配置 Key'}</Typography.Text>}
        </Typography.Paragraph>

        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          {(st?.providers ?? []).map((p: any) => (
            <div
              key={p.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 10,
                border: p.active ? '1.5px solid var(--dp-primary)' : '1px solid var(--dp-border)',
                background: p.active ? 'var(--dp-primary-soft)' : 'transparent',
                transition: 'border-color .15s',
              }}
            >
              <div style={{
                width: 38, height: 38, borderRadius: 8, flexShrink: 0,
                background: 'var(--dp-card)', border: '1px solid var(--dp-border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
              }}>
                {PROVIDER_LOGOS[p.id]
                  ? <img src={PROVIDER_LOGOS[p.id]} alt={p.label} draggable={false} style={{ width: 22, height: 22, display: 'block' }} />
                  : <span style={{ color: 'var(--dp-text-3)', fontWeight: 700, fontSize: 16 }}>{String(p.label).slice(0, 1)}</span>}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Space size={6} wrap>
                  <Typography.Text strong>{p.label}</Typography.Text>
                  {p.active && <Tag color="blue" style={{ marginInlineEnd: 0 }}>使用中</Tag>}
                </Space>
                <div className="dp-mono" style={{ fontSize: 12, color: 'var(--dp-text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.baseUrl || '（未设置 Base URL）'}
                </div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div>{p.keyConfigured ? <Tag color="green" style={{ marginInlineEnd: 0 }}>Key 已配置</Tag> : <Tag style={{ marginInlineEnd: 0 }}>未配置 Key</Tag>}</div>
                <div style={{ fontSize: 12, color: 'var(--dp-text-2)', marginTop: 2 }}>模型 {p.defaultModel || '-'}</div>
              </div>
              <Space size={6} style={{ flexShrink: 0 }}>
                <Button size="small" onClick={() => openConfig(p)}>配置</Button>
                {!p.active && (
                  <Button size="small" type="primary" loading={switching === p.id} onClick={() => void switchTo(p.id)}>切换</Button>
                )}
              </Space>
            </div>
          ))}
        </Space>
      </Card>

      <Card size="small" title="首次启动引导">
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>重跑初始化检查 → 模型配置 → 环境/工具检测 → 项目导入的五步引导。</Typography.Paragraph>
        <Button onClick={rerunOnboarding}>重新运行引导</Button>
      </Card>

      <Modal
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={() => void saveConfig()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        title={`配置模型供应商 — ${editing?.label ?? ''}`}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={10}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            API Key 为必填（出于凭据安全设计，后端不接受空 Key 更新；已配置的 Key 重新保存即可覆盖）。
          </Typography.Text>
          <Input.Password placeholder="API Key（sk-...）" value={keyVal} onChange={(e) => setKeyVal(e.target.value)} />
          <Input
            placeholder="模型名（留空使用默认）"
            addonBefore="模型"
            value={modelVal}
            onChange={(e) => setModelVal(e.target.value)}
          />
          <Input
            placeholder="Base URL（custom 供应商必填）"
            addonBefore="地址"
            value={urlVal}
            onChange={(e) => setUrlVal(e.target.value)}
          />
        </Space>
      </Modal>
    </Space>
  );
}

/* ---------- Git 中心 ---------- */
function GitCenter() {
  const [projects, setProjects] = useState<any[]>([]);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [repoPath, setRepoPath] = useState('');
  const [st, setSt] = useState<any>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [logRows, setLogRows] = useState<any[]>([]);
  const [diffTxt, setDiffTxt] = useState('');
  const [msg, setMsg] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const enc = (s: string) => encodeURIComponent(s);

  React.useEffect(() => { void api<any[]>('/projects').then(setProjects).catch(() => {}); }, []);

  /** 打开仓库成功后：若来自已导入项目则自动登记（供 push 白名单使用），并拉取分支列表 */
  const afterOpen = async (p: string, pid?: string) => {
    await loadStatus(p);
    setBranches(await api<any[]>(`/git/branches?repoPath=${enc(p)}`));
    if (pid) {
      try { await api('/git/register', 'POST', { projectId: pid, repoPath: p }); } catch { /* 已登记过则忽略 */ }
    }
  };

  const loadStatus = async (p: string) => {
    const s = await api<any>(`/git/status?repoPath=${enc(p)}`);
    setSt(s);
    setLogRows(await api<any[]>(`/git/log?repoPath=${enc(p)}`));
    setSelected(new Set());
    setDiffTxt('');
  };

  const open = async (p?: string, pid?: string) => {
    const path = p ?? repoPath;
    if (!path.trim()) return;
    setBusy(true);
    try {
      await afterOpen(path, pid);
      message.success('仓库已加载');
    } catch { message.error('仓库加载失败（是否为 git 仓库？）'); }
    finally { setBusy(false); }
  };

  const pickRepo = async () => {
    const d = await pickDirectory();
    if (!d) return;
    setRepoPath(d);
    setProjectId(undefined);
    await open(d, undefined);
  };

  const switchBranch = async (branch: string) => {
    const r = await api<any>('/git/checkout', 'POST', { repoPath, branch });
    if (r.ok) {
      message.success(`已切换到 ${branch}`);
      await afterOpen(repoPath, projectId);
    } else {
      message.error(r.error ?? r.output ?? '切换失败');
      await loadStatus(repoPath); // 拉回实际分支
      setBranches(await api<any[]>(`/git/branches?repoPath=${enc(repoPath)}`));
    }
  };

  const commit = async () => {
    if (!msg.trim()) return message.warning('先填写提交说明');
    const files = selected.size ? [...selected] : null;
    const r = await api<any>('/git/commit', 'POST', { repoPath, message: msg, files });
    if (r.pendingApproval) message.warning('agent 身份需审批，已生成审批单');
    else if (r.ok) message.success(files ? `已提交 ${files.length} 个文件` : '已提交全部变更');
    else message.info(r.output || '无变更可提交');
    setMsg('');
    await afterOpen(repoPath, projectId);
  };

  const discardFile = (f: string) => confirmDelete(
    `丢弃「${f}」的修改？`,
    '已跟踪文件会恢复到最后一次提交的版本；未跟踪的新文件会被删除。此操作不可撤销。',
    async () => {
      const r = await api<any>('/git/discard', 'POST', { repoPath, files: [f] });
      r.ok ? message.success('已丢弃') : message.error(r.errors?.[0] ?? '丢弃失败');
      await afterOpen(repoPath, projectId);
    },
  );

  const revertCommitRow = (hash: string) => confirmDelete(
    `回滚提交 ${hash}？`,
    '会生成一条反向提交撤销该次改动（不改写历史），工作区需先保持干净。',
    async () => {
      const r = await api<any>('/git/revert', 'POST', { repoPath, hash });
      r.ok ? message.success(`已回滚 ${hash}`) : message.error(r.error ?? r.output ?? '回滚失败');
      await afterOpen(repoPath, projectId);
    },
  );

  const push = () => confirmDelete(
    '推送到远程仓库？',
    '推送走安全策略：远程需已登记（打开项目仓库时自动登记）、保护分支（main/master）工作区必须干净、提交内容含疑似密钥会被拦截。',
    async () => {
      const r = await api<any>('/git/push', 'POST', { repoPath, allowPush: true });
      r.ok ? message.success('推送成功') : message.error(r.error ?? r.output ?? '推送失败');
    },
  );

  const showDiff = async (f?: string) => {
    const d = await api<any>(`/git/diff?repoPath=${enc(repoPath)}${f ? '&file=' + enc(f) : ''}`);
    setDiffTxt(d.diff || '（无未暂存修改）');
  };

  const currentBranch = branches.find((b) => !b.startsWith('remotes/') && !b.startsWith('* ')) && branches.find((b) => b.replace('* ', '') === st?.branch)
    ? st?.branch
    : st?.branch;

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title="仓库入口" extra={<span className="dp-desc">支持项目仓库、目录选择或手动路径</span>}>
        <Space wrap>
          <Select
            showSearch
            allowClear
            placeholder="从已导入项目选择"
            style={{ width: 320 }}
            value={projectId}
            onChange={(v, opt: any) => {
              setProjectId(v);
              if (v) {
                const p = projects.find((x) => x.id === v);
                if (p?.root_path) { setRepoPath(p.root_path); void open(p.root_path, v); }
              }
            }}
            options={projects.map((p) => ({ value: p.id, label: `${p.name}（${p.root_path}）` }))}
            optionFilterProp="label"
          />
          <Button onClick={() => void pickRepo()}>选择目录…</Button>
          <Input placeholder="或手输仓库绝对路径" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} onPressEnter={() => void open()} style={{ width: 320 }} />
          <Button type="primary" loading={busy} onClick={() => void open()}>打开</Button>
        </Space>
      </Card>
      {st && (
        <>
          <Card
            size="small"
            title={<Space size={8} wrap><span>工作区</span><Tag color="blue">{st.branch}</Tag><StatusTag status={st.clean ? 'Completed' : 'Pending'} text={st.clean ? '工作区干净' : `${st.files.length} 个变更`}/></Space>}
            extra={(
              <Space>
                <Select
                  size="small"
                  showSearch
                  value={currentBranch}
                  style={{ width: 200 }}
                  placeholder="切换分支"
                  onChange={(b) => void switchBranch(b)}
                  options={branches.filter((b) => !b.startsWith('remotes/')).map((b) => ({ value: b.replace('* ', ''), label: b.replace('* ', '') }))}
                  optionFilterProp="label"
                />
                <Button size="small" danger disabled={!st.clean} onClick={push} title={st.clean ? '推送到远程' : '推送前需保持工作区干净'}>推送到远程</Button>
                <Button size="small" onClick={() => void afterOpen(repoPath, projectId)}>刷新</Button>
              </Space>
            )}
          >
            <List size="small" dataSource={st.files} renderItem={(f: any) => (
              <List.Item actions={[
                <Button key="d" size="small" onClick={() => void showDiff(f.path)}>Diff</Button>,
                <Button key="x" size="small" danger onClick={() => discardFile(f.path)}>丢弃</Button>,
                <Checkbox
                  key="c"
                  checked={selected.has(f.path)}
                  onChange={(e) => {
                    const n = new Set(selected);
                    e.target.checked ? n.add(f.path) : n.delete(f.path);
                    setSelected(n);
                  }}
                >
                  提交
                </Checkbox>,
              ]}>
                <Space><Tag color={f.status === 'M' ? 'orange' : f.status === '??' ? 'default' : 'blue'}>{f.status || 'M'}</Tag>{f.path}</Space>
              </List.Item>
            )} />
            <Space style={{ marginTop: 8 }}>
              <Input placeholder="提交说明" value={msg} onChange={(e) => setMsg(e.target.value)} style={{ width: 360 }} onPressEnter={commit} />
              <Button type="primary" onClick={commit}>{selected.size ? `提交选中（${selected.size}）` : '提交全部'}</Button>
              <Button onClick={() => void showDiff()}>整体 Diff</Button>
            </Space>
          </Card>
          {diffTxt && <Card size="small" title="Diff"><pre className="dp-code-block" style={{ maxHeight: 280 }}>{diffTxt}</pre></Card>}
          <Card size="small" title="提交历史">
            <Table rowKey="hash" size="small" pagination={false} dataSource={logRows}
              columns={[
                { title: 'Hash', dataIndex: 'hash', width: 100 },
                { title: '作者', dataIndex: 'author', width: 120 },
                { title: '时间', dataIndex: 'date', width: 200 },
                { title: '说明', dataIndex: 'subject' },
                { title: '操作', width: 110, render: (_, r: any) => (
                  <Button size="small" danger onClick={() => revertCommitRow(r.hash)}>回滚此提交</Button>
                ) },
              ]} />
          </Card>
        </>
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
            { title: '端口状态', dataIndex: 'portOpen', render: (v) => <Tag color={v ? 'green' : 'default'}>{v ? '开放' : '关闭'}</Tag> },
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
                  <Button size="small" danger onClick={() => confirmDelete('删除这条数据库连接？', '只移除 DevPilot 中的连接配置，不会删除远端数据库或其中的数据。', async () => { await api(`/databases/connections/${r.id}`, 'DELETE'); await load(); })}>删除</Button>
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
                  <Button size="small" danger onClick={() => confirmDelete('删除这个本地服务？', '会移除服务定义与启动配置。若进程仍在运行，请先停止再删除。', async () => { await api(`/local-services/${r.id}`, 'DELETE'); await load(); })}>删除</Button>
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
    if (!projectPath.trim()) return message.warning('先选择项目目录');
    const r = await api<any>('/external-tools/open-ide', 'POST', { toolId, projectPath });
    r.ok ? message.success(`已在 ${r.tool ?? toolId} 中打开`) : message.error(r.error);
  };
  const chooseProjectDir = async () => {
    const dir = await pickDirectory();
    if (dir) setProjectPath(dir);
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
          <Button onClick={() => void chooseProjectDir()}>选择项目目录…</Button>
          <Input readOnly placeholder="点击左侧按钮从资源管理器选择" value={projectPath} style={{ flex: 1 }} />
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
            <Tag key={a} color="blue" style={{ cursor: 'pointer' }} onClick={() => void launch(a)}>{a} · 启动</Tag>
          ))}
        </Space>
      </Card>
      <CommandActionsCard tools={tools} />
    </Space>
  );
}

/* ---------- 外部工具命令级联动（需求 7.2 分级 2 级） ---------- */
function CommandActionsCard({ tools }: { tools: any[] }) {
  const [toolId, setToolId] = useState<string | undefined>(undefined);
  const [actions, setActions] = useState<any[]>([]);
  const [actionName, setActionName] = useState('');
  const [cmdTpl, setCmdTpl] = useState('');
  const [runResult, setRunResult] = useState<any>(null);

  const load = React.useCallback(async () => {
    if (!toolId) { setActions([]); return; }
    setActions(await api(`/external-tools/${toolId}/actions`));
  }, [toolId]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!toolId || !actionName.trim() || !cmdTpl.trim()) return message.warning('选择工具并填写动作名与命令模板');
    try {
      await api(`/external-tools/${toolId}/actions`, 'POST', { actionName, commandTemplate: cmdTpl });
      setActionName(''); setCmdTpl('');
      message.success('动作已保存');
      void load();
    } catch { message.error('保存失败（同名？）'); }
  };
  const run = async (actionId: string) => {
    setRunResult({ running: true });
    const r = await api<any>(`/external-tools/${toolId}/actions/${actionId}/run`, 'POST', {});
    setRunResult(r);
    r.ok ? message.success('执行完成') : message.warning(`退出码 ${r.exitCode ?? '?'}${r.error ? '：' + r.error : ''}`);
  };

  return (
    <Card size="small" title="命令级联动（构建 / 运行 / 状态查询）">
      <Space wrap style={{ marginBottom: 12 }}>
        <Select placeholder="选择工具" style={{ width: 180 }} value={toolId}
          onChange={(v) => setToolId(v)}
          options={tools.filter((t) => t.status === 'ok').map((t) => ({ value: t.id, label: t.name }))} />
        <Input placeholder="动作名，如 build / status" style={{ width: 160 }} value={actionName} onChange={(e) => setActionName(e.target.value)} />
        <Input placeholder="命令模板（{install_path} = 工具安装目录）" style={{ width: 380 }} value={cmdTpl} onChange={(e) => setCmdTpl(e.target.value)} onPressEnter={create} />
        <Button type="primary" onClick={create}>保存动作</Button>
      </Space>
      {actions.length > 0 && (
        <Table rowKey="id" size="small" pagination={false} dataSource={actions} style={{ marginBottom: 12 }}
          columns={[
            { title: '动作', dataIndex: 'action_name', width: 120 },
            { title: '命令', dataIndex: 'command_template', ellipsis: true },
            { title: '超时', dataIndex: 'timeout_ms', width: 80, render: (v) => `${v}ms` },
            { title: '操作', width: 130, render: (_, r) => (
              <Space>
                <Button size="small" type="primary" onClick={() => void run(r.id)}>执行</Button>
                <Button size="small" danger onClick={() => confirmDelete('删除这条工具动作？', '只移除这条快捷动作配置，不影响外部工具本身。', async () => { await api(`/external-tools/${toolId}/actions/${r.id}`, 'DELETE'); await load(); })}>删除</Button>
              </Space>
            ) },
          ]} />
      )}
      {runResult && !runResult.running && (
        <pre className="dp-code-block" style={{ maxHeight: 220 }}>
          {runResult.error ? `错误：${runResult.error}` : `exit=${runResult.exitCode}\n${runResult.stdout || ''}${runResult.stderr ? '\n[stderr] ' + runResult.stderr : ''}`}
        </pre>
      )}
    </Card>
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
                  <Button size="small" danger onClick={() => confirmDelete('删除这个配置档案？', '该档案下的覆盖值会一并删除，相关项目将回落到默认配置。', async () => { await api(`/config-center/profiles/${r.id}`, 'DELETE'); await load(); })}>删除</Button>
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
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const busy = (k: string) => !!pending[k];
  const mark = (k: string, v: boolean) => setPending((p) => ({ ...p, [k]: v }));

  const load = React.useCallback(async () => {
    try {
      setRows(await api('/backups'));
      setProjects(await api('/projects'));
    } catch (e: any) { message.error(e?.message ?? String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (busy('create')) return;
    mark('create', true);
    try {
      const r = await api<any>('/backups', 'POST', {});
      message.success(`备份完成 ${(r.size / 1024).toFixed(0)} KB，已通过 SHA256 记录`);
      await load();
    } catch (e: any) { message.error('备份失败：' + (e?.message ?? String(e))); } finally { mark('create', false); }
  };

  const verify = async (id: string) => {
    if (busy(`verify-${id}`)) return;
    mark(`verify-${id}`, true);
    try {
      const r = await api<{ ok: boolean; error?: string }>(`/backups/${id}/verify`, 'POST');
      r.ok ? message.success('校验通过，备份文件未被篡改') : message.error(r.error ?? '校验失败');
      await load();
    } catch (e: any) { message.error('校验失败：' + (e?.message ?? String(e))); } finally { mark(`verify-${id}`, false); }
  };

  const restore = (id: string, createdAt: string) => {
    Modal.confirm({
      title: '用这个备份覆盖当前数据？',
      content: (
        <div>
          <p>当前数据库会被 <strong>{createdAt}</strong> 的快照整体替换，替换后需要重启应用生效。</p>
          <p style={{ color: 'var(--dp-warning)' }}>这份备份之后产生的项目、任务与配置改动都会丢失。建议先点「立即备份」留存当前状态。</p>
        </div>
      ),
      okText: '覆盖并恢复',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const r = await api<any>(`/backups/${id}/restore`, 'POST');
        r.ok ? message.warning(r.message ?? '恢复完成，重启应用后生效') : message.error(r.error ?? '恢复失败');
        await load();
      },
    });
  };

  const exportProject = async (projectId: string) => {
    try {
      const r = await api<any>('/backups/export-project', 'POST', { projectId });
      message.success(`导出完成：${r.counts.services} 个服务 / ${r.counts.profiles} 份档案`);
      setBundlePath(r.file);
    } catch (e: any) { message.error('导出失败：' + (e?.message ?? String(e))); }
  };

  const importProject = async () => {
    if (!bundlePath.trim()) { message.warning('先填写或选择导出包路径'); return; }
    if (busy('import')) return;
    mark('import', true);
    try {
      const r = await api<any>('/backups/import-project', 'POST', { bundlePath });
      r.ok
        ? message.success(`导入完成${r.skipped ? '（项目已存在，按增量恢复）' : ''}：+${r.created.services} 服务 / +${r.created.profiles} 档案`)
        : message.error(r.error ?? '导入失败');
      await load();
    } catch (e: any) { message.error('导入失败：' + (e?.message ?? String(e))); } finally { mark('import', false); }
  };

  return (
    <div>
      <SectionCard
        title="全量备份"
        extra={<Button size="small" type="primary" loading={busy('create')} onClick={() => void create()}>立即备份</Button>}
        style={{ marginBottom: 16 }}
      >
        <p className="dp-desc" style={{ marginTop: 0, marginBottom: 8 }}>备份包含 SQLite 快照与 SHA256 校验值，恢复会整体覆盖当前数据。</p>
        <Table rowKey="id" size="small" dataSource={rows} pagination={false}
          columns={[
            { title: '时间', dataIndex: 'created_at', width: 180, render: (v: string) => <Mono>{formatTime(v)}</Mono> },
            { title: '类型', dataIndex: 'backup_type', width: 100 },
            { title: '数据版本', dataIndex: 'data_version', width: 100 },
            { title: '大小', dataIndex: 'size_bytes', width: 100, render: (v) => `${(v / 1024).toFixed(0)} KB` },
            { title: '校验', dataIndex: 'verify_status', width: 100, render: (s) => <Tag color={s === 'verified' ? 'green' : s === 'unverified' ? 'default' : 'red'}>{s === 'verified' ? '已校验' : s === 'unverified' ? '未校验' : '校验失败'}</Tag> },
            {
              title: '操作', width: 190, render: (_, r) => (
                <Space size={4}>
                  <Button size="small" loading={busy(`verify-${r.id}`)} onClick={() => void verify(r.id)}>校验</Button>
                  <Button size="small" danger onClick={() => restore(r.id, r.created_at)}>从此备份恢复</Button>
                </Space>
              ),
            },
          ]} />
      </SectionCard>

      <SectionCard title="项目导出与导入（跨机器迁移）">
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space wrap>
            <Select placeholder="选择要导出的项目" style={{ width: 280 }}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
              onChange={(v) => void exportProject(v)} />
            <span className="dp-desc">导出后下方会自动填入文件路径，可直接拷到另一台机器导入。</span>
          </Space>
          <Space.Compact style={{ width: '100%' }}>
            <Input placeholder="导出包 JSON 路径" value={bundlePath} onChange={(e) => setBundlePath(e.target.value)} />
            <Button type="primary" loading={busy('import')} onClick={() => void importProject()}>导入</Button>
          </Space.Compact>
          <span className="dp-desc">项目已存在时按增量恢复，不会覆盖已有服务与档案。</span>
        </Space>
      </SectionCard>
    </div>
  );
}

/* ---------- 通知中心 ---------- */
function NotificationCenterPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [unread, setUnread] = useState(0);
  const [rules, setRules] = useState<any[]>([]);
  const [ruleName, setRuleName] = useState('');
  const [ruleType, setRuleType] = useState('*');
  const [rulePri, setRulePri] = useState<number>(5);

  const load = React.useCallback(async () => {
    setRows(await api('/notifications'));
    setUnread(await api('/notifications/unread-count'));
    setRules(await api('/notifications/rules'));
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);

  const createRule = async () => {
    if (!ruleName.trim()) return message.warning('请填写规则名称');
    try {
      await api('/notifications/rules', 'POST', { name: ruleName, typePattern: ruleType, minPriority: rulePri });
      setRuleName('');
      message.success('规则已创建');
      void load();
    } catch { message.error('创建失败（名称重复？）'); }
  };

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
      <Card size="small" title="通知规则订阅">
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
          存在启用规则时，仅命中规则的通知会送达（类型支持 * 与前缀通配如 task.*；紧急阈值：优先级 ≤ 阈值才收）。无规则时全量接收。
        </Typography.Paragraph>
        <Space wrap style={{ marginBottom: 12 }}>
          <Input placeholder="规则名" style={{ width: 160 }} value={ruleName} onChange={(e) => setRuleName(e.target.value)} onPressEnter={createRule} />
          <Input placeholder="类型模式，如 task.* 或 *" style={{ width: 200 }} value={ruleType} onChange={(e) => setRuleType(e.target.value)} />
          <Select style={{ width: 130 }} value={rulePri} onChange={setRulePri}
            options={[1, 2, 3, 4, 5].map((v) => ({ value: v, label: `紧急阈值 ≤${v}` }))} />
          <Button type="primary" onClick={createRule}>创建规则</Button>
        </Space>
        <Table rowKey="id" size="small" pagination={false} dataSource={rules}
          locale={{ emptyText: '暂无规则（全量接收）' }}
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: '类型模式', dataIndex: 'type_pattern' },
            { title: '紧急阈值', dataIndex: 'min_priority', render: (v) => `≤${v}` },
            { title: '状态', dataIndex: 'enabled', render: (v) => <Tag color={v ? 'green' : 'default'}>{v ? '启用' : '停用'}</Tag> },
            { title: '操作', render: (_, r) => (
              <Space>
                <Button size="small" onClick={async () => { await api(`/notifications/rules/${r.id}/update`, 'POST', { enabled: !r.enabled }); void load(); }}>{r.enabled ? '停用' : '启用'}</Button>
                <Button size="small" danger onClick={() => confirmDelete('删除这条订阅规则？', '删除后该类事件不再按此规则推送。', async () => { await api(`/notifications/rules/${r.id}`, 'DELETE'); await load(); })}>删除</Button>
              </Space>
            ) },
          ]} />
      </Card>
    </Space>
  );
}

/* ---------- 首次启动引导（WF-01，P0 #17） ---------- */
function FirstRunWizard({ onFinish }: { onFinish: () => void }) {
  const [step, setStep] = useState(0);
  const [health, setHealth] = useState<any>(null);
  const [modelSt, setModelSt] = useState<any>(null);
  const [apiKey, setApiKey] = useState('');
  const [envTools, setEnvTools] = useState<any[]>([]);
  const [extTools, setExtTools] = useState<any[]>([]);
  const [importPath, setImportPath] = useState('');
  const [importing, setImporting] = useState(false);

  const steps = [
    { title: '初始化检查' }, { title: '模型配置' }, { title: '环境检测' }, { title: '工具检测' }, { title: '导入项目' },
  ];

  // 进入每步时拉取对应数据
  useEffect(() => {
    if (step === 0) void api('/health').then(setHealth).catch(() => setHealth({ error: true }));
    if (step === 1) void api('/models/status').then(setModelSt);
    if (step === 2) void api<any[]>('/environments').then(setEnvTools);
    if (step === 3) void api<any[]>('/external-tools').then(setExtTools);
  }, [step]);

  const saveKey = async () => {
    if (!apiKey.trim()) return message.warning('请输入 API Key');
    await api('/models/config', 'POST', { apiKey });
    setApiKey('');
    setModelSt(await api('/models/status'));
    message.success('Key 已保存');
  };

  const doImport = async () => {
    if (!importPath.trim()) return message.warning('请先选择项目根目录');
    setImporting(true);
    try {
      const r = await api<{ projectId: string; analysis: any }>('/projects/import', 'POST', { source: 'folder', rootPath: importPath });
      message.success(`导入成功：识别 ${r.analysis.services.length} 个服务`);
    } catch {
      message.error('导入失败（检查路径是否有效）');
    }
    setImporting(false);
  };

  const finish = () => {
    localStorage.setItem('devpilot.onboarded', '1');
    onFinish();
  };

  const nextText = step === steps.length - 1 ? '完成引导' : '下一步';
  const canNext = step !== 1 || !!modelSt?.keyConfigured;

  return (
    <div className="dp-wizard-scroll">
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <Card className="dp-wizard-card">
        <Typography.Title level={3} style={{ marginTop: 0 }}>欢迎使用 DevPilot</Typography.Title>
        <Typography.Paragraph type="secondary">首次启动引导将带你完成 5 步初始化配置。</Typography.Paragraph>
        <Steps current={step} items={steps.map((s) => ({ key: s.title, title: s.title }))} style={{ margin: '16px 0 24px' }} />
        {step === 0 && (health ? (
          health.error ? <Result status="error" title="后端服务不可达" subTitle="请确认后端已启动（scripts/start-backend.cmd）后点击「下一步」重试" />
            : <Result status="success" title={`后端就绪（v${health.version ?? '?'}）`} subTitle={`状态 ${health.status ?? 'ok'} · 数据库与运行时初始化完成`} />
        ) : <Typography.Text type="secondary">正在检查后端…</Typography.Text>)}
        {step === 1 && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Descriptions size="small" column={2}>
              <Descriptions.Item label="供应商">{modelSt?.provider ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="模型">{modelSt?.model ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="Key 状态">{modelSt?.keyConfigured ? '已配置' : '未配置'}</Descriptions.Item>
            </Descriptions>
            {!modelSt?.keyConfigured && (
              <>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>配置 DeepSeek API Key 后 Supervisor 才能规划执行任务。也可在「系统设置」中随时补配。</Typography.Paragraph>
                <Space.Compact style={{ width: '100%' }}>
                  <Input.Password placeholder="sk-..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} onPressEnter={saveKey} />
                  <Button type="primary" onClick={saveKey}>保存</Button>
                </Space.Compact>
              </>
            )}
          </Space>
        )}
        {step === 2 && (
          <>
            <Typography.Paragraph type="secondary">开发环境探针结果（未安装的工具不影响使用，按需安装即可）：</Typography.Paragraph>
            <Table rowKey="id" size="small" pagination={false} dataSource={envTools}
              columns={[
                { title: '工具', dataIndex: 'name' },
                { title: '状态', dataIndex: 'status', render: (s) => <Tag color={s === 'ok' ? 'green' : s === 'missing' ? 'default' : 'red'}>{s === 'ok' ? '可用' : s === 'missing' ? '未安装' : '异常'}</Tag> },
                { title: '版本', dataIndex: 'version', render: (v) => v ?? '-' },
              ]} />
          </>
        )}
        {step === 3 && (
          <>
            <Typography.Paragraph type="secondary">外部工具联动探测（IDE / 浏览器 / 模拟器等，可在「外部工具」页深度配置）：</Typography.Paragraph>
            <Table rowKey="id" size="small" pagination={false} dataSource={extTools}
              columns={[
                { title: '工具', dataIndex: 'name' },
                { title: '类别', dataIndex: 'kind' },
                { title: '状态', dataIndex: 'status', render: (s) => <Tag color={s === 'ok' ? 'green' : 'default'}>{s === 'ok' ? '可用' : '未找到'}</Tag> },
              ]} />
          </>
        )}
        {step === 4 && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Paragraph type="secondary">导入第一个项目（可跳过，之后在「工作台」随时导入）：</Typography.Paragraph>
            <Space.Compact style={{ width: '100%' }}>
              <Button onClick={async () => { const d = await pickDirectory(); if (d) setImportPath(d); }}>选择项目目录…</Button>
              <Input readOnly placeholder="点击左侧按钮从资源管理器选择" value={importPath} style={{ flex: 1 }} />
              <Button type="primary" loading={importing} disabled={!importPath.trim()} onClick={doImport}>导入并识别</Button>
            </Space.Compact>
          </Space>
        )}
        <div style={{ marginTop: 24, textAlign: 'right' }}>
          <Space>
            {step > 0 && <Button onClick={() => setStep(step - 1)}>上一步</Button>}
            {step < steps.length - 1 && <Button onClick={finish}>跳过引导</Button>}
            <Button type="primary" disabled={!canNext} onClick={() => (step === steps.length - 1 ? finish() : setStep(step + 1))}>{nextText}</Button>
          </Space>
        </div>
      </Card>
    </div>
      </div>
  );
}

/* ---------- Agent 管理中心（二阶段 #1） ---------- */
function AgentsCenterPage() {
  const [agents, setAgents] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [goal, setGoal] = useState('');
  const [projectId, setProjectId] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = React.useCallback(async () => {
    const [agentRows, taskRows, projectRows, approvalRows] = await Promise.all([
      api<any[]>('/agents'), api<any[]>('/tasks'), api<any[]>('/projects'), api<any[]>('/approvals'),
    ]);
    setAgents(agentRows); setProjects(projectRows); setApprovals(approvalRows);
    setTasks(taskRows);
    if (!selectedId && taskRows.length) setSelectedId(taskRows[0].id);
  }, [selectedId]);

  const loadDetail = React.useCallback(async () => {
    if (!selectedId) { setDetail(null); return; }
    try { setDetail(await api(`/tasks/${selectedId}`)); } catch { setDetail(null); }
  }, [selectedId]);

  useEffect(() => { void load(); const timer = setInterval(load, 4000); return () => clearInterval(timer); }, [load]);
  useEffect(() => { void loadDetail(); const timer = setInterval(loadDetail, 4000); return () => clearInterval(timer); }, [loadDetail]);

  const createTask = async () => {
    if (!goal.trim()) { message.warning('请先描述本次 Agent 任务目标'); return; }
    setCreating(true);
    try {
      const created = await api<any>('/tasks', 'POST', { goal: goal.trim(), projectId });
      const id = created.id ?? created.taskId ?? created.task?.id;
      if (!id) throw new Error('后端未返回任务 ID');
      setGoal(''); setSelectedId(id);
      message.success('Agent 任务已创建，可在执行区启动');
      await load();
    } catch (e: any) { message.error('创建失败：' + (e?.message ?? String(e))); }
    finally { setCreating(false); }
  };

  const taskAction = async (action: 'run' | 'pause' | 'resume' | 'cancel') => {
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      await api(`/tasks/${selectedId}/${action}`, 'POST');
      message.success({ run: '任务已开始执行', pause: '任务已暂停', resume: '任务已恢复', cancel: '任务已取消' }[action]);
      await Promise.all([load(), loadDetail()]);
    } catch (e: any) { message.error(e?.message ?? String(e)); }
    finally { setBusy(false); }
  };

  const actApproval = async (id: string, approve: boolean) => {
    await api(`/approvals/${id}/${approve ? 'approve' : 'reject'}`, 'POST');
    message.success(approve ? '已批准操作' : '已拒绝操作');
    await Promise.all([load(), loadDetail()]);
  };

  const selected = tasks.find((task) => task.id === selectedId) ?? detail?.task;
  const subtasks: any[] = detail?.subtasks ?? [];
  const checkpoints: any[] = detail?.checkpoints ?? [];
  const parseJson = (value: any) => {
    if (value == null) return null;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
  };
  const capabilities = (agent: any): string[] => {
    const value = parseJson(agent.capabilities_json);
    return Array.isArray(value) ? value : [];
  };

  return (
    <div>
      <PageHeader eyebrow="AI orchestration" title="Agent 工作区" description="创建任务、追踪规划与工具执行，并在同一工作区完成审批。" extra={<><StatusTag status={agents.length ? 'Running' : 'Unknown'} text={`${agents.length} 个 Agent`}/><Button onClick={() => void Promise.all([load(), loadDetail()])}>刷新</Button></>}/>
      <div className="dp-agent-workspace">
        <aside className="dp-agent-sidebar">
          <div className="dp-agent-pane-title"><span>任务会话</span><span>{tasks.length}</span></div>
          {tasks.map((task) => (
            <button key={task.id} className={`dp-agent-session${selectedId === task.id ? ' active' : ''}`} onClick={() => setSelectedId(task.id)}>
              <span className="dp-agent-session-title">{task.input_summary || '未命名任务'}</span>
              <span className="dp-agent-session-meta"><span>{task.status}</span><span>{formatTime(task.created_at)}</span></span>
            </button>
          ))}
          {tasks.length === 0 && <div className="dp-state-empty"><div className="dp-state-title">暂无会话</div><p className="dp-desc">在右侧输入目标开始</p></div>}
          <div className="dp-agent-pane-title"><span>常用 Agent</span><span>{agents.length}</span></div>
          {agents.map((agent) => <div className="dp-agent-session" key={agent.id}><span className="dp-agent-session-title">{agent.name}</span><span className="dp-agent-session-meta"><span>{agent.type}</span><span>{agent.status}</span></span></div>)}
        </aside>

        <main className="dp-agent-main">
          {selected ? <div className="dp-agent-conversation">
            <div className="dp-agent-task-head">
              <StatusTag status={selected.status}/>
              <h3>{selected.input_summary}</h3>
              <p>任务 {String(selected.id).slice(0, 8)} · 创建于 {formatTime(selected.created_at)}</p>
              <Space size={6} style={{ marginTop: 14 }} wrap>
                {['Pending', 'WaitingInput'].includes(selected.status) && <Button type="primary" size="small" loading={busy} onClick={() => void taskAction('run')}>开始执行</Button>}
                {['Running', 'Preparing'].includes(selected.status) && <Button size="small" loading={busy} onClick={() => void taskAction('pause')}>暂停</Button>}
                {selected.status === 'Paused' && <Button type="primary" size="small" loading={busy} onClick={() => void taskAction('resume')}>恢复执行</Button>}
                {['Pending', 'Preparing', 'Running', 'Paused', 'WaitingApproval', 'WaitingInput'].includes(selected.status) && <Button danger size="small" loading={busy} onClick={() => void taskAction('cancel')}>取消任务</Button>}
              </Space>
            </div>
            <div className="dp-agent-timeline">
              <div className="dp-agent-pane-title" style={{ padding: '0 0 10px' }}><span>规划与执行进度</span><span>{subtasks.length} 个子任务</span></div>
              {subtasks.map((subtask, index) => (
                <div className="dp-agent-step" key={subtask.id ?? index}>
                  <div className="dp-agent-step-head"><span className="dp-agent-step-title">{String(index + 1).padStart(2, '0')} · {subtask.assigned_agent ?? 'Agent'}</span><StatusTag status={subtask.status}/></div>
                  <pre>{typeof parseJson(subtask.input_json) === 'string' ? parseJson(subtask.input_json) : JSON.stringify(parseJson(subtask.input_json), null, 2)}</pre>
                  {(subtask.result_summary || subtask.result_json) && <pre>{subtask.result_summary ?? JSON.stringify(parseJson(subtask.result_json), null, 2)}</pre>}
                </div>
              ))}
              {subtasks.length === 0 && <StateBlock empty emptyText={selected.status === 'Pending' ? '任务已就绪，点击开始执行生成规划' : '当前任务尚无子任务记录'}>{null}</StateBlock>}
              {selected.result_summary && <div className="dp-agent-step"><div className="dp-agent-step-head"><span className="dp-agent-step-title">任务结果</span><StatusTag status={selected.status}/></div><pre>{selected.result_summary}</pre></div>}
            </div>
          </div> : <div className="dp-agent-empty"><div><div className="dp-agent-empty-mark">AI</div><Typography.Title level={4}>从一个明确目标开始</Typography.Title><p className="dp-desc">选择项目并描述任务。Supervisor 会规划步骤，执行记录将在这里呈现。</p></div></div>}
          <div className="dp-agent-composer">
            <Space.Compact style={{ width: '100%', marginBottom: 8 }}>
              <Select allowClear placeholder="关联项目（可选）" style={{ width: '100%' }} value={projectId} onChange={setProjectId} options={projects.map((project) => ({ value: project.id, label: project.name }))}/>
            </Space.Compact>
            <Input.TextArea rows={3} value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="描述希望 Agent 完成的任务，例如：分析当前项目的启动失败原因并给出修复方案…"/>
            <div className="dp-agent-composer-note"><span>创建后由你确认开始执行</span><Button type="primary" size="small" loading={creating} disabled={!goal.trim()} onClick={() => void createTask()}>新建任务会话</Button></div>
          </div>
        </main>

        <aside className="dp-agent-inspector">
          <div className="dp-agent-pane-title"><span>当前状态</span>{selected && <StatusTag status={selected.status}/>}</div>
          <div className="dp-agent-detail-block">
            <h4>执行上下文</h4>
            <div className="dp-agent-kv"><span>任务 ID</span><strong>{selected?.id ?? '—'}</strong></div>
            <div className="dp-agent-kv"><span>关联项目</span><strong>{projects.find((project) => project.id === (selected?.project_id ?? selected?.projectId))?.name ?? '未关联'}</strong></div>
            <div className="dp-agent-kv"><span>开始时间</span><strong>{selected?.started_at ?? '尚未开始'}</strong></div>
            <div className="dp-agent-kv"><span>检查点</span><strong>{checkpoints.length} 个</strong></div>
          </div>
          <div className="dp-agent-pane-title"><span>审批操作</span><span>{approvals.length}</span></div>
          <div style={{ padding: '0 12px' }}>
            {approvals.map((approval) => <div className="dp-agent-approval" key={approval.id} style={{ marginBottom: 8 }}><strong style={{ fontSize: 11 }}>{approval.action_summary}</strong><p className="dp-desc">{approval.requester} · {approval.risk_level}</p><Space size={6}><Button size="small" type="primary" onClick={() => void actApproval(approval.id, true)}>批准</Button><Button size="small" danger onClick={() => void actApproval(approval.id, false)}>拒绝</Button></Space></div>)}
            {approvals.length === 0 && <p className="dp-desc">当前没有等待审批的操作。</p>}
          </div>
          <div className="dp-agent-pane-title"><span>工具与文件记录</span><span>{subtasks.length}</span></div>
          <div style={{ padding: '0 12px' }}>
            {subtasks.map((subtask, index) => <div className="dp-agent-detail-block" style={{ margin: '0 0 8px' }} key={subtask.id ?? index}><h4>{subtask.assigned_agent ?? `子任务 ${index + 1}`}</h4><div className="dp-agent-kv"><span>状态</span><strong>{subtask.status}</strong></div><div className="dp-agent-kv"><span>工具 / 输入</span><strong title={String(subtask.input_json ?? '')}>{subtask.input_json ?? '—'}</strong></div><div className="dp-agent-kv"><span>结果</span><strong title={String(subtask.result_summary ?? '')}>{subtask.result_summary ?? '尚无结果'}</strong></div></div>)}
            {subtasks.length === 0 && <p className="dp-desc">工具调用和文件变更将在执行后记录在这里。</p>}
          </div>
          <div className="dp-agent-pane-title"><span>Agent 能力</span></div>
          <div style={{ padding: '0 12px 16px' }}>{agents.map((agent) => <div className="dp-agent-detail-block" style={{ margin: '0 0 8px' }} key={agent.id}><h4>{agent.name} <Tag>{agent.version}</Tag></h4><div>{capabilities(agent).map((capability) => <Tag key={capability}>{capability}</Tag>)}</div></div>)}</div>
        </aside>
      </div>
    </div>
  );
}

/* ---------- 记忆系统（二阶段 #2） ---------- */
function MemoryPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [scope, setScope] = useState<string | undefined>();
  const [kw, setKw] = useState('');
  const [newContent, setNewContent] = useState('');
  const load = React.useCallback(async () => {
    if (kw.trim()) {
      const q = scope ? `q=${encodeURIComponent(kw)}&scope=${scope}` : `q=${encodeURIComponent(kw)}`;
      setRows((await api<{ rows: any[] }>(`/memories/search?${q}`)).rows);
    } else {
      setRows(await api(scope ? `/memories?scope=${scope}` : '/memories'));
    }
  }, [scope, kw]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!newContent.trim()) return;
    await api('/memories', 'POST', { scope: scope ?? 'global', content: newContent, source: 'manual' });
    setNewContent('');
    message.success('记忆已保存');
    void load();
  };
  const remove = async (id: string) => {
    await api(`/memories/${id}/delete`, 'POST');
    void load();
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <SectionCard title="检索记忆" extra={<span className="dp-desc">{rows.length} 条记录</span>}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Select allowClear placeholder="全部 scope" style={{ width: 140 }} value={scope}
            onChange={(v) => setScope(v)}
            options={['global', 'project', 'task'].map((v) => ({ value: v, label: v }))} />
          <Input.Search placeholder="关键词检索（空格分词 AND 匹配）" style={{ width: 320 }} value={kw}
            onChange={(e) => setKw(e.target.value)} onSearch={() => void load()} allowClear />
          <Button onClick={() => { setKw(''); setScope(undefined); }}>重置</Button>
        </Space>
        <Table rowKey="id" size="small" dataSource={rows}
          columns={[
            { title: 'Scope', dataIndex: 'scope', width: 80, render: (s) => <Tag color={s === 'global' ? 'purple' : s === 'project' ? 'blue' : 'green'}>{s}</Tag> },
            { title: '内容', dataIndex: 'content_ref', ellipsis: true },
            { title: '来源', dataIndex: 'source', width: 100 },
            { title: '置信度', dataIndex: 'confidence', width: 80, render: (v) => Number(v).toFixed(2) },
            { title: '关联', width: 160, render: (_, r) => r.project_id ? `项目 ${String(r.project_id).slice(0, 8)}` : r.task_id ? `任务 ${String(r.task_id).slice(0, 8)}` : '-' },
            { title: '创建时间', dataIndex: 'created_at', width: 180 },
            { title: '操作', width: 70, render: (_, r) => <Button size="small" danger onClick={() => remove(r.id)}>删除</Button> },
          ]} />
      </SectionCard>
      <SectionCard title="手动沉淀">
        <Space.Compact style={{ width: '100%' }}>
          <Input placeholder="记录一条跨会话有用的事实、偏好或决策（保存到 global scope）" value={newContent} onChange={(e) => setNewContent(e.target.value)} onPressEnter={create} />
          <Button type="primary" onClick={create}>保存</Button>
        </Space.Compact>
      </SectionCard>
    </Space>
  );
}

/* ---------- 插件中心 ---------- */
function PluginsCenterPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [reloadInfo, setReloadInfo] = useState<string>('');

  const load = React.useCallback(async () => setRows(await api('/plugins')), []);
  useEffect(() => { void load(); }, [load]);

  const reload = async () => {
    const r = await api<{ installed: number; rejected: Array<{ dir: string; error: string }> }>('/plugins/reload', 'POST');
    const rej = r.rejected.length ? `，${r.rejected.length} 个被拒绝：${r.rejected.map((x) => `${x.dir}(${x.error})`).join('；')}` : '';
    setReloadInfo(`已安装 ${r.installed} 个${rej}`);
    void load();
  };
  const toggle = async (row: any) => {
    await api(`/plugins/${row.id}/${row.enabled ? 'disable' : 'enable'}`, 'POST');
    void load();
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title="插件中心（本地声明式插件）"
        extra={<Space>
          <Button size="small" onClick={reload}>扫描安装（reload）</Button>
          <Button size="small" onClick={() => void load()}>刷新</Button>
        </Space>}>
        {reloadInfo && <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>{reloadInfo}</Typography.Paragraph>}
        <Table rowKey="id" size="small" pagination={false} dataSource={rows}
          columns={[
            { title: 'ID', dataIndex: 'id' },
            { title: '名称', dataIndex: 'name' },
            { title: '版本', dataIndex: 'version', width: 90 },
            { title: '权限', dataIndex: 'permissions', render: (p: string[]) => (p ?? []).map((x) => <Tag key={x}>{x}</Tag>) },
            { title: '事件钩子', dataIndex: 'hooks', render: (hooks: any[]) => (hooks ?? []).map((h, i) => (
              <Tag key={i} color="blue">{h.event} → {h.action}</Tag>
            )) },
            { title: '状态', dataIndex: 'enabled', width: 90, render: (e: boolean) => e ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
            { title: '操作', width: 90, render: (_, r) => (
              <Button size="small" type={r.enabled ? 'default' : 'primary'} onClick={() => void toggle(r)}>{r.enabled ? '停用' : '启用'}</Button>
            ) },
          ]} />
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          插件目录：%APPDATA%\devpilot\data\plugins\&lt;id&gt;\plugin.json（事件钩子为声明式：log / notify / command，command 走审批双门）
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}

/* ---------- 工作流拓扑图（9.8 完整形态：DAG + 条件分支 + 回边） ---------- */
const TOPO_W = 176, TOPO_H = 52, TOPO_GAP_X = 210, TOPO_GAP_Y = 78;

function WorkflowTopology({ steps }: { steps: any[] }) {
  type Edge = { from: string; to: string; label?: string; back: boolean };
  const edges: Edge[] = [];
  const pushEdge = (from: string, to: string, label?: string) => {
    if (edges.some((e) => e.from === from && e.to === to)) return;
    edges.push({ from, to, label, back: false });
  };
  steps.forEach((s, i) => {
    const next = steps[i + 1]?.id;
    const resolve = (g?: string) => (g === 'end' ? '__end__' : g || next);
    if (s.type === 'condition') {
      const t = resolve(s.gotoOnTrue);
      const f = resolve(s.gotoOnFalse);
      if (t && t !== f) pushEdge(s.id, t, 'T');
      if (f) pushEdge(s.id, f, t === f ? undefined : 'F');
    } else if (next) {
      pushEdge(s.id, next);
    } else {
      pushEdge(s.id, '__end__');
    }
  });
  // 分层：BFS（前向边定层，回边不参与层计算）
  const idx = new Map(steps.map((s, i) => [s.id, i]));
  const layer = new Map<string, number>([[steps[0]?.id ?? '', 0]]);
  const queue = steps.length ? [steps[0].id] : [];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.from !== cur || e.to === '__end__') continue;
      if ((idx.get(e.to) ?? 0) <= (idx.get(e.from) ?? 0)) continue; // 回边不定层
      if (!layer.has(e.to)) { layer.set(e.to, layer.get(cur)! + 1); queue.push(e.to); }
    }
  }
  steps.forEach((s, i) => { if (!layer.has(s.id)) layer.set(s.id, i); }); // 兜底
  const maxLayer = Math.max(...steps.map((s) => layer.get(s.id)!), 0);
  const lanesByLayer = new Map<number, number>();
  const pos = new Map<string, { x: number; y: number }>();
  for (const s of steps) {
    const l = layer.get(s.id)!;
    const lane = lanesByLayer.get(l) ?? 0;
    lanesByLayer.set(l, lane + 1);
    pos.set(s.id, { x: 24 + l * TOPO_GAP_X, y: 24 + lane * TOPO_GAP_Y });
  }
  const endLayer = maxLayer + 1;
  const endCount = lanesByLayer.get(endLayer) ?? 0;
  pos.set('__end__', { x: 24 + endLayer * TOPO_GAP_X, y: 24 + endCount * TOPO_GAP_Y });
  const endY = 24 + endCount * TOPO_GAP_Y;
  const width = 24 + (endLayer + 1) * TOPO_GAP_X;
  const height = Math.max(...[...pos.values()].map((p) => p.y), 0) + TOPO_H + 56;

  const nodeColor = (t: string): { fill: string; stroke: string } =>
    t === 'condition' ? { fill: 'var(--dp-primary-soft)', stroke: 'var(--dp-primary)' }
    : t === 'notify' ? { fill: 'var(--dp-success-bg)', stroke: 'var(--dp-success)' }
    : t === 'task' ? { fill: 'var(--dp-warning-bg)', stroke: 'var(--dp-warning)' }
    : { fill: 'var(--dp-card)', stroke: 'var(--dp-border-strong)' };

  return (
    <div className="dp-workflow-canvas"><svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="工作流拓扑图">
      <defs>
        <marker id="topo-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
          <path d="M0,0 L7,3 L0,6 Z" className="dp-workflow-arrow" />
        </marker>
      </defs>
      {edges.map((e, i) => {
        const p1 = pos.get(e.from)!;
        const p2 = pos.get(e.to)!;
        const isBack = (idx.get(e.to) ?? Infinity) <= (idx.get(e.from) ?? -1);
        let path: string;
        if (isBack) { // 回边：源底部绕到目标底部
          const x1 = p1.x + TOPO_W / 2, y1 = p1.y + TOPO_H, x2 = p2.x + TOPO_W / 2, y2 = p2.y + TOPO_H;
          const dip = Math.max(y1, y2) + 34;
          path = `M ${x1} ${y1} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2}`;
        } else { // 前向边：源右侧 → 目标左侧
          const x1 = p1.x + TOPO_W, y1 = p1.y + TOPO_H / 2, x2 = p2.x, y2 = p2.y + TOPO_H / 2;
          path = x2 - x1 > 24 ? `M ${x1} ${y1} C ${x1 + 40} ${y1}, ${x2 - 40} ${y2}, ${x2} ${y2}` : `M ${x1} ${y1} C ${x1 + 40} ${y1}, ${x2 - 40} ${y2}, ${x2} ${y2}`;
        }
        const color = e.label === 'T' ? 'var(--dp-success)' : e.label === 'F' ? 'var(--dp-danger)' : 'var(--dp-text-3)';
        const lx = (p1.x + TOPO_W + p2.x) / 2, ly = (p1.y + p2.y) / 2 + (isBack ? 26 : -6);
        return (
          <g key={i}>
            <path d={path} fill="none" stroke={color} strokeWidth={e.label ? 1.6 : 1.2} strokeDasharray={isBack ? '5 4' : undefined} markerEnd="url(#topo-arrow)" />
            {e.label && <text x={lx} y={ly} fontSize={12} fontWeight={600} fill={color} textAnchor="middle">{e.label}</text>}
          </g>
        );
      })}
      {steps.map((s) => {
        const p = pos.get(s.id)!;
        const c = nodeColor(s.type);
        return (
          <g key={s.id}>
            <rect x={p.x} y={p.y} width={TOPO_W} height={TOPO_H} rx={8} fill={c.fill} stroke={c.stroke} />
            <text x={p.x + 12} y={p.y + 21} fontSize={13} fontWeight={600} className="dp-workflow-node-text">{s.id}</text>
            <text x={p.x + 12} y={p.y + 39} fontSize={11} className="dp-workflow-node-type">{s.type}</text>
          </g>
        );
      })}
      <g>
        <rect x={pos.get('__end__')!.x} y={endY} width={TOPO_W} height={TOPO_H} rx={24} fill="var(--dp-danger-bg)" stroke="var(--dp-danger)" strokeDasharray="4 3" />
        <text x={pos.get('__end__')!.x + 12} y={endY + 31} fontSize={13} fill="var(--dp-danger)">结束 end</text>
      </g>
    </svg></div>
  );
}

/* ---------- 工作流 ---------- */
function WorkflowsPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [detail, setDetail] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [runDetail, setRunDetail] = useState<any>(null);
  const [newName, setNewName] = useState('');
  const [newJson, setNewJson] = useState('');

  const load = React.useCallback(async () => setRows(await api('/workflows')), []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    if (!newName.trim() || !newJson.trim()) { message.warning('名称与定义 JSON 均必填'); return; }
    let definition: any;
    try { definition = JSON.parse(newJson); } catch { message.error('定义不是合法 JSON'); return; }
    const r = await api<{ id?: string; message?: string }>('/workflows', 'POST', { name: newName.trim(), definition });
    if (r.id) { message.success('工作流已创建'); setNewName(''); setNewJson(''); void load(); }
    else message.error(r.message ?? '创建失败');
  };

  const run = async (w: any) => {
    message.loading({ content: `运行 ${w.name} 中…`, key: w.id, duration: 0 });
    const r = await api<{ runId: string; status: string; context: any }>(`/workflows/${w.id}/run`, 'POST');
    message.destroy(w.id);
    r.status === 'Completed' ? message.success(`运行完成（runId ${r.runId.slice(0, 8)}）`) : message.error(`运行 ${r.status}：${(r.context?.__error ?? '').slice(0, 80)}`);
    void load();
  };

  const showRuns = async (w: any) => {
    setRuns(await api(`/workflows/${w.id}/runs`));
    setDetail(w);
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Card size="small" title="新建工作流（JSON 定义）"
        extra={<Button size="small" type="primary" onClick={create}>创建</Button>}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input placeholder="工作流名称（唯一）" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Input.TextArea rows={6} placeholder={'步骤定义 JSON，例：\n{\n  "trigger": { "type": "schedule", "cron": "0 9 * * 1-5" },\n  "steps": [\n    { "id": "ver", "type": "command", "command": "node --version" },\n    { "id": "check", "type": "condition", "left": "${ver.exitCode}", "op": "eq", "right": "0", "gotoOnTrue": "good", "gotoOnFalse": "bad" },\n    { "id": "good", "type": "notify", "title": "健康 ${ver.output}" },\n    { "id": "finish", "type": "condition", "left": "1", "op": "eq", "right": "1", "gotoOnTrue": "end" },\n    { "id": "bad", "type": "notify", "title": "异常分支" }\n  ]\n}\n步骤类型：task（goal）/ command（command,cwd）/ notify（title,content）/ condition（left,op,right,gotoOnTrue,gotoOnFalse，"end" 终止）\n触发器：schedule（intervalMinutes 或 cron，cron 5 字段 分 时 日 月 周，如 "0 9 * * 1-5"）/ event（eventType）'} value={newJson} onChange={(e) => setNewJson(e.target.value)} />
        </Space>
      </Card>
      <Card size="small" title="工作流列表">
        <Table rowKey="id" size="small" pagination={false} dataSource={rows}
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: '触发器', dataIndex: 'trigger', width: 170, render: (t: string) => <Tag color={t === '手动' ? 'default' : t.startsWith('cron') ? 'purple' : t.startsWith('每') ? 'blue' : 'orange'}>{t}</Tag> },
            { title: '步骤数', dataIndex: 'steps', width: 80 },
            { title: '状态', dataIndex: 'enabled', width: 80, render: (e: boolean) => e ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
            { title: '更新时间', dataIndex: 'updated_at', ellipsis: true },
            { title: '操作', width: 260, render: (_, w) => (
              <Space>
                <Button size="small" type="primary" disabled={!w.enabled} onClick={() => void run(w)}>运行</Button>
                <Button size="small" onClick={async () => { const full = await api<any>(`/workflows/${w.id}`); setDetail({ ...w, definition: (full as any).definition }); }}>定义</Button>
                <Button size="small" onClick={() => void showRuns(w)}>历史</Button>
                <Button size="small" onClick={async () => { await api(`/workflows/${w.id}/${w.enabled ? 'disable' : 'enable'}`, 'POST'); void load(); }}>{w.enabled ? '停用' : '启用'}</Button>
                <Button size="small" danger onClick={() => confirmDelete(`删除工作流「${w.name}」？`, '会删除工作流定义与触发器，正在运行的实例不受影响，但此后不再从这里启动或查看。', async () => { await api(`/workflows/${w.id}`, 'DELETE'); await load(); })}>删除</Button>
              </Space>
            ) },
          ]} />
      </Card>
      <Modal open={!!detail} onCancel={() => { setDetail(null); setRuns([]); }} footer={null} title={`工作流：${detail?.name ?? ''}`} width={960}>
        {detail && (
          <Tabs items={[
            { key: 'topo', label: '拓扑视图', children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                {detail.definition?.trigger && (
                  <div>
                    <Tag color={detail.definition.trigger.type === 'schedule' ? 'blue' : 'orange'}>
                      触发器：{detail.definition.trigger.type === 'schedule'
                        ? (detail.definition.trigger.cron ? `cron ${detail.definition.trigger.cron}` : `每 ${detail.definition.trigger.intervalMinutes} 分钟`)
                        : `事件 ${detail.definition.trigger.eventType}`}
                    </Tag>
                  </div>
                )}
                <WorkflowTopology steps={detail.definition?.steps ?? []} />
              </Space>
            ) },
            { key: 'def', label: '步骤视图', children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                {(detail.definition?.steps ?? []).map((s: any) => (
                  <Card key={s.id} size="small" type="inner" title={`${s.id} · ${s.type}`}
                    extra={s.gotoOnTrue ? <Tag color="purple">T→{s.gotoOnTrue}{s.gotoOnFalse ? ` / F→${s.gotoOnFalse}` : ''}</Tag> : null}>
                    <pre className="dp-code-block" style={{ maxHeight: 160, margin: 0 }}>{JSON.stringify(s, null, 2)}</pre>
                  </Card>
                ))}
                <Steps size="small" items={(detail.definition?.steps ?? []).map((s: any) => ({ title: s.id }))} />
              </Space>
            ) },
            { key: 'json', label: '定义 JSON', children: <pre className="dp-code-block">{JSON.stringify(detail.definition, null, 2)}</pre> },
            { key: 'runs', label: `运行历史（${runs.length}）`, children: (
              <Table rowKey="id" size="small" pagination={false} dataSource={runs}
                expandable={{ expandedRowRender: (r) => <pre className="dp-code-block" style={{ margin: 0 }}>{JSON.stringify(r.context, null, 2)}</pre> }}
                columns={[
                  { title: '运行 ID', dataIndex: 'id', render: (v: string) => v.slice(0, 8), width: 100 },
                  { title: '状态', dataIndex: 'status', render: (s: string) => <Tag color={s === 'Completed' ? 'green' : s === 'Running' ? 'blue' : 'red'}>{s}</Tag> },
                  { title: '当前步骤', dataIndex: 'current_step' },
                  { title: '开始时间', dataIndex: 'started_at', ellipsis: true },
                  { title: '操作', width: 80, render: (_, r) => <Button size="small" onClick={async () => setRunDetail(await api(`/workflow-runs/${r.id}`))}>详情</Button> },
                ]} />
            ) },
          ]} />
        )}
      </Modal>
      <Modal open={!!runDetail} onCancel={() => setRunDetail(null)} footer={null} title={`运行详情 ${runDetail?.id?.slice(0, 8) ?? ''}`} width={720}>
        {runDetail && <pre className="dp-code-block">{JSON.stringify(runDetail, null, 2)}</pre>}
      </Modal>
    </Space>
  );
}

/* ---------- 主布局 ---------- */
function LegacyFrame({ pageKey, children }: { pageKey: string; children: React.ReactNode }) {
  const meta = PAGES.find((p) => p.key === pageKey);
  return (
    <div>
      <PageHeader eyebrow={meta?.group} title={meta?.label ?? ''} description={meta?.desc} />
      {children}
    </div>
  );
}

const PAGE_KEYS = ['1','2','3','6','7','8','9','10','12','13','14','15','16','17','18','19','20'];
function readHashPage(): string {
  try {
    const k = window.location.hash.replace(/^#\/?/, '');
    return PAGE_KEYS.includes(k) ? k : '1';
  } catch { return '1'; }
}

export default function App() {
  const [page, setPage] = useState<string>(readHashPage);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const { mode: themeMode, resolved, setMode } = useThemeMode();
  const [onboarded, setOnboarded] = useState(() => {
    try { return localStorage.getItem('devpilot.onboarded') === '1'; } catch { return false; }
  });
  const navigate = (k: string) => {
    setPage(k);
    try { if (window.location.hash !== `#/${k}`) window.location.hash = `#/${k}`; } catch { /* 忽略 */ }
  };
  useEffect(() => {
    const onHash = () => setPage(readHashPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // 原生菜单栏动作（文件/编辑/视图/导航/帮助）
  useEffect(() => {
    type MenuPayload =
      | { action: 'navigate'; page: string }
      | { action: 'theme'; mode: ThemeMode }
      | { action: 'toggle-sider' }
      | { action: 'import-project' }
      | { action: 'run-project' };
    const bridge = (window as unknown as {
      devpilot?: { onMenu?: (cb: (p: unknown) => void) => () => void };
    }).devpilot;
    if (!bridge?.onMenu) return;
    return bridge.onMenu((raw) => {
      const p = raw as MenuPayload;
      switch (p?.action) {
        case 'navigate': navigate(p.page); break;
        case 'theme': setMode(p.mode); break;
        case 'toggle-sider': window.dispatchEvent(new Event('devpilot:toggle-sider')); break;
        case 'import-project': navigate('2'); break;
        case 'run-project': navigate('2'); break;
        default: break;
      }
    });
  }, [setMode]);

  // 环境检测只在应用启动时做一次（页面上的「刷新检测」按钮可手动重扫）
  useEffect(() => { primeEnvironments(); }, []);

  const finishOnboarding = () => setOnboarded(true);
  const rerunOnboarding = () => {
    try { localStorage.removeItem('devpilot.onboarded'); } catch { /* 忽略 */ }
    setOnboarded(false);
  };
  const openProject = (id: string) => { setSelectedProjectId(id); navigate('1'); };
  const render = () => {
    switch (page) {
      case '1': return <Dashboard selectedId={selectedProjectId} onSelect={setSelectedProjectId} />;
      case '2': return <Projects selectedId={selectedProjectId} onSelect={setSelectedProjectId} />;
      case '3': return <LegacyFrame pageKey='3'><Tasks /></LegacyFrame>;
      case '6': return <LegacyFrame pageKey='6'><Logs /></LegacyFrame>;
      case '7': return <LegacyFrame pageKey='7'><Approvals /></LegacyFrame>;
      case '8': return <LegacyFrame pageKey='8'><Environments /></LegacyFrame>;
      case '9': return <LegacyFrame pageKey='9'><Settings rerunOnboarding={rerunOnboarding} themeMode={themeMode} onThemeChange={setMode} /></LegacyFrame>;
      case '10': return <LegacyFrame pageKey='10'><GitCenter /></LegacyFrame>;
      case '12': return <LegacyFrame pageKey='12'><DatabasesCenter /></LegacyFrame>;
      case '13': return <LegacyFrame pageKey='13'><ExternalToolsPage /></LegacyFrame>;
      case '14': return <LegacyFrame pageKey='14'><ConfigCenterPage /></LegacyFrame>;
      case '15': return <LegacyFrame pageKey='15'><BackupCenterPage /></LegacyFrame>;
      case '16': return <LegacyFrame pageKey='16'><NotificationCenterPage /></LegacyFrame>;
      case '17': return <AgentsCenterPage />;
      case '18': return <LegacyFrame pageKey='18'><MemoryPage /></LegacyFrame>;
      case '19': return <LegacyFrame pageKey='19'><PluginsCenterPage /></LegacyFrame>;
      case '20': return <LegacyFrame pageKey='20'><WorkflowsPage /></LegacyFrame>;
      default: return null;
    }
  };
  const theme = buildAntdTheme(resolved === 'dark');
  if (!onboarded) {
    return <ConfigProvider locale={zhCN} theme={theme}><FirstRunWizard onFinish={finishOnboarding} /></ConfigProvider>;
  }
  return (
    <ConfigProvider locale={zhCN} theme={theme}>
      <Shell page={page} onNavigate={navigate} themeMode={themeMode} onThemeChange={setMode}>{render()}</Shell>
    </ConfigProvider>
  );
}
