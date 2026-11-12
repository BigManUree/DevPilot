import React, { useCallback, useEffect, useState } from 'react';
import { Button, message, Modal, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { api } from '../api';
import { Mono, PageHeader, SectionCard, StateBlock, StatusTag } from '../components/ui';
import { formatTime } from '../utils';
import { useAutoStart } from '../components/AutoStart';

/** 运行中心：项目为上下文，服务按行呈现，启停有进度与防重复。 */
export default function Runtime({ go }: { go: (k: string) => void }) {
  const [projects, setProjects] = useState<any[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [services, setServices] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [tracked, setTracked] = useState<Record<string, { adopted?: boolean; pid?: number }>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const auto = useAutoStart();

  const busy = (k: string) => !!pending[k];
  const mark = (k: string, v: boolean) => setPending((p) => ({ ...p, [k]: v }));

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, s, t] = await Promise.all([
        api<any[]>('/projects'),
        api<any[]>('/runtime/sessions'),
        api<any[]>('/runtime/tracked').catch(() => [] as any[]),
      ]);
      setProjects(Array.isArray(p) ? p : []);
      setSessions(Array.isArray(s) ? s : []);
      setTracked(Object.fromEntries((Array.isArray(t) ? t : []).map((x: any) => [x.serviceId, x])));

      return Array.isArray(p) ? p : [];
    } catch (e: any) {
      setError(e?.message ?? String(e));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const loadServices = useCallback(async (id: string) => {
    try {
      const d = await api<any>(`/projects/${id}`);
      setServices(d.services ?? []);
    } catch (e: any) {
      message.error('加载服务失败：' + (e?.message ?? String(e)));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const ps = await load();
      if (ps.length && !projectId) {
        setProjectId(ps[0].id);
        await loadServices(ps[0].id);
      }
    })();
    const t = setInterval(() => { void load(); if (projectId) void loadServices(projectId); }, 5000);
    return () => clearInterval(t);
  }, [load, loadServices, projectId]);

  const chooseProject = async (id: string) => {
    setProjectId(id);
    await loadServices(id);
  };

  const act = async (key: string, fn: () => Promise<void>) => {
    if (busy(key)) return;
    mark(key, true);
    try { await fn(); } catch (e: any) { message.error(e?.message ?? String(e)); } finally { mark(key, false); }
  };

  const startProject = () => projectId && act('proj-start', async () => {
    const r = await api<{ plan: Array<{ status: string }> }>(`/projects/${projectId}/start`, 'POST');
    message.success(`启动完成：${r.plan.filter((s) => s.status === 'Running').length} 个服务运行中`);
    await loadServices(projectId);
    await load();
  });

  const stopProject = () => projectId && act('proj-stop', async () => {
    await api(`/projects/${projectId}/stop`, 'POST');
    message.success('已全部停止');
    await loadServices(projectId);
    await load();
  });

  const startService = (s: any) => act(`svc-${s.id}`, async () => {
    await api(`/services/${s.id}/start`, 'POST');
    message.success(`${s.name} 已启动`);
    if (projectId) await loadServices(projectId);
  });

  const stopService = (s: any) => act(`svc-${s.id}`, async () => {
    const r = await api<{ stopped: boolean; reason?: string }>(`/services/${s.id}/stop`, 'POST');
    if (r.stopped) {
      message.success(`${s.name} 已停止`);
    } else if (/referenced by/.test(r.reason ?? '')) {
      Modal.confirm({
        title: '共享服务被其他项目引用',
        content: `${r.reason}。强制停止将解除引用保护并记入审计，确定继续？`,
        okText: '强制停止',
        okButtonProps: { danger: true },
        onOk: async () => {
          const r2 = await api<{ stopped: boolean }>(`/services/${s.id}/stop`, 'POST', { force: true });
          r2.stopped ? message.success('已强制停止（审计已记录）') : message.error('停止失败');
          if (projectId) await loadServices(projectId);
        },
      });
    } else {
      message.warning(r.reason ?? '停止失败');
    }
    if (projectId) await loadServices(projectId);
  });

  const currentProject = projects.find((p) => p.id === projectId);
  const failedCount = services.filter((s) => s.status === 'Failed' || s.status === 'Unhealthy').length;

  return (
    <div>
      <PageHeader
        title="运行中心"
        description={currentProject ? `项目：${currentProject.name}` : '选择项目后管理其服务'}
        extra={
          <Space>
            <Select
              style={{ width: 220 }}
              placeholder="选择项目"
              value={projectId}
              onChange={(v) => void chooseProject(v)}
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
            />
            <Button type="primary" disabled={!projectId} onClick={() => projectId && void auto.run(projectId, currentProject?.name ?? '项目')}>自动启动（含修复）</Button>
            <Button disabled={!projectId} loading={busy('proj-start')} onClick={() => void startProject()}>启动全部</Button>
            <Button disabled={!projectId} loading={busy('proj-stop')} onClick={() => void stopProject()}>停止全部</Button>
          </Space>
        }
      />

      <SectionCard
        title={`服务（${services.length}）`}
        extra={failedCount > 0 && (
          <Button size="small" danger type="link" onClick={() => go('6')}>{failedCount} 个异常，查看日志与诊断</Button>
        )}
        style={{ marginBottom: 16 }}
      >
        <StateBlock loading={loading} error={error} onRetry={() => void load()} empty={services.length === 0}
          emptyText={projectId ? '该项目还没有识别出服务，请先在项目详情中确认配置' : '请选择项目'}>
          <Table
            rowKey="id"
            size="small"
            dataSource={services}
            pagination={false}
            scroll={{ x: 820 }}
            columns={[
              { title: '服务', dataIndex: 'name', render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
              { title: '类型', dataIndex: 'service_type', width: 100 },
              { title: '端口', dataIndex: 'port', width: 80, render: (v) => v ?? '-' },
              {
                title: '状态', dataIndex: 'status', width: 150,
                render: (s: string, r: any) => {
                  const t = tracked[r.id];
                  return (
                    <Space size={4}>
                      <StatusTag status={s} />
                      {t?.adopted && (
                        <Tooltip title={`端口上已有实例在运行（PID ${t.pid ?? '未知'}），由 DevPilot 接管而未重复启动；点「停止」会终止该进程`}>
                          <Tag color="blue" style={{ marginInlineEnd: 0 }}>外部实例</Tag>
                        </Tooltip>
                      )}
                    </Space>
                  );
                },
              },
              { title: '启动命令', dataIndex: 'start_command', ellipsis: true, render: (v: string) => <Mono title={v}>{v}</Mono> },
              {
                title: '操作', width: 150, render: (_, s) => (
                  <Space size={4}>
                    <Button size="small" type="primary" loading={busy(`svc-${s.id}`)} disabled={s.status === 'Running' || s.status === 'Starting'} onClick={() => void startService(s)}>启动</Button>
                    <Button size="small" loading={busy(`svc-${s.id}`)} disabled={s.status === 'Stopped'} onClick={() => void stopService(s)}>停止</Button>
                  </Space>
                ),
              },
            ]}
          />
        </StateBlock>
      </SectionCard>

      <SectionCard title={`启动会话（${sessions.length}）`}>
        <StateBlock loading={loading} error={null} empty={sessions.length === 0} emptyText="暂无启动记录">
          <Table
            rowKey="id"
            size="small"
            dataSource={sessions}
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            columns={[
              { title: '项目', dataIndex: 'project_id', ellipsis: true, render: (v: string) => projects.find((p) => p.id === v)?.name ?? v },
              { title: 'PID', dataIndex: 'pids_json', render: (v: string) => <Mono>{v}</Mono> },
              { title: '启动时间', dataIndex: 'started_at', width: 150, render: (v: string) => <Mono title={v}>{formatTime(v)}</Mono> },
              { title: '停止时间', dataIndex: 'stopped_at', width: 150, render: (v: string) => v ? <Mono title={v}>{formatTime(v)}</Mono> : <StatusTag status="Running" /> },
            ]}
          />
        </StateBlock>
      </SectionCard>
      {auto.node}
    </div>
  );
}
