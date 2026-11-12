import React, { useCallback, useEffect, useState } from 'react';
import { Button, Descriptions, Drawer, Dropdown, Input, message, Modal, Space, Table, Tabs, Typography } from 'antd';
import { api } from '../api';
import { Mono, PageHeader, StateBlock, StatusTag } from '../components/ui';

/** 项目：搜索/筛选、识别与配置确认、详情抽屉。危险操作明确区分「删记录」与「动磁盘」。 */
export default function Projects({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string | null) => void }) {
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importPath, setImportPath] = useState('');
  const [importing, setImporting] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api<any[]>('/projects');
      setProjects(Array.isArray(r) ? r : []);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const openDetail = useCallback(async (id: string) => {
    try {
      setDetail(await api(`/projects/${id}`));
      onSelect(id);
    } catch (e: any) {
      message.error('打开项目详情失败：' + (e?.message ?? String(e)));
    }
  }, [onSelect]);

  useEffect(() => { if (selectedId) void openDetail(selectedId); }, [selectedId, openDetail]);

  const mark = (k: string, v: boolean) => setPending((p) => ({ ...p, [k]: v }));
  const busy = (k: string) => !!pending[k];

  const doImport = async () => {
    if (!importPath.trim() || importing) return;
    setImporting(true);
    try {
      const r = await api<{ projectId: string; analysis: any }>('/projects/import', 'POST', { source: 'folder', rootPath: importPath.trim() });
      message.success(`导入成功：识别 ${r.analysis.services.length} 个服务，${r.analysis.unknowns.length} 项待确认`);
      setImportPath('');
      await load();
      await openDetail(r.projectId);
    } catch (e: any) {
      message.error('导入失败：' + (e?.message ?? String(e)));
    } finally {
      setImporting(false);
    }
  };

  const act = async (key: string, fn: () => Promise<void>) => {
    if (busy(key)) return;
    mark(key, true);
    try { await fn(); } catch (e: any) { message.error(e?.message ?? String(e)); } finally { mark(key, false); }
  };

  const startProject = (id: string) => act(`start-${id}`, async () => {
    const r = await api<{ plan: Array<{ status: string }> }>(`/projects/${id}/start`, 'POST');
    message.success(`启动完成：${r.plan.filter((s) => s.status === 'Running').length} 个服务运行中`);
    await load();
    if (detail) await openDetail(id);
  });

  const stopProject = (id: string) => act(`stop-${id}`, async () => {
    await api(`/projects/${id}/stop`, 'POST');
    message.success('已停止');
    await load();
    if (detail) await openDetail(id);
  });

  const confirmProject = (id: string) => act(`confirm-${id}`, async () => {
    await api(`/projects/${id}/confirm`, 'POST');
    message.success('配置已确认，识别草案转为生效配置');
    await load();
    if (detail) await openDetail(id);
  });

  const removeProject = (p: any) => {
    Modal.confirm({
      title: `删除项目记录「${p.name}」？`,
      content: (
        <div>
          <p>仅从 DevPilot 移除该项目记录与配置，<strong>不会删除磁盘上的任何文件</strong>。</p>
          <p className="dp-mono" style={{ fontSize: 12 }}>{p.root_path}</p>
        </div>
      ),
      okText: '删除记录',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => act(`del-${p.id}`, async () => {
        await api(`/projects/${p.id}`, 'DELETE');
        message.success('已删除记录（磁盘文件未改动）');
        setDetail(null);
        onSelect(null);
        await load();
      }),
    });
  };

  const filtered = projects.filter((p) => {
    const k = keyword.trim().toLowerCase();
    if (!k) return true;
    return `${p.name} ${p.root_path} ${p.language ?? ''} ${p.framework ?? ''}`.toLowerCase().includes(k);
  });

  return (
    <div>
      <PageHeader
        title="项目"
        description="导入 → 审阅识别结果 → 确认配置 → 启动。删除仅移除记录，不动磁盘文件。"
        extra={<Input.Search placeholder="搜索名称 / 路径 / 技术栈" allowClear style={{ width: 260 }} value={keyword} onChange={(e) => setKeyword(e.target.value)} />}
      />

      <Space.Compact style={{ width: '100%', marginBottom: 16 }}>
        <Input
          placeholder="项目根目录绝对路径"
          value={importPath}
          onChange={(e) => setImportPath(e.target.value)}
          onPressEnter={doImport}
          disabled={importing}
        />
        <Button type="primary" onClick={doImport} loading={importing} disabled={!importPath.trim()}>导入并识别</Button>
      </Space.Compact>

      <StateBlock loading={loading} error={error} onRetry={() => void load()} empty={filtered.length === 0}
        emptyText={keyword ? '没有匹配的项目，换个关键词试试' : '还没有项目，先在上方导入'}>
        <Table
          rowKey="id"
          size="small"
          dataSource={filtered}
          pagination={{ pageSize: 12, hideOnSinglePage: true }}
          scroll={{ x: 900 }}
          onRow={(r) => ({ onClick: () => void openDetail(r.id), style: { cursor: 'pointer' } })}
          columns={[
            { title: '名称', dataIndex: 'name', render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
            { title: '技术栈', render: (_, r) => [r.language, r.framework].filter(Boolean).join(' / ') || <span style={{ color: '#98A2B3' }}>未识别</span> },
            { title: '配置状态', dataIndex: 'analysis_status', width: 120, render: (s: string) => <StatusTag status={s === 'confirmed' ? 'Completed' : 'Pending'} text={s === 'confirmed' ? '已确认' : '待确认'} /> },
            { title: '根目录', dataIndex: 'root_path', ellipsis: true, render: (v: string) => <Mono title={v}>{v}</Mono> },
            {
              title: '操作', width: 260, render: (_, r) => (
                <Space size={4} onClick={(e) => e.stopPropagation()}>
                  <Button size="small" type="primary" loading={busy(`start-${r.id}`)} onClick={() => void startProject(r.id)}>启动</Button>
                  <Button size="small" loading={busy(`stop-${r.id}`)} onClick={() => void stopProject(r.id)}>停止</Button>
                  <Dropdown
                    menu={{
                      items: [
                        { key: 'detail', label: '查看详情' },
                        { key: 'confirm', label: '确认配置', disabled: r.analysis_status === 'confirmed' },
                        { type: 'divider' },
                        { key: 'delete', label: '删除记录（不动磁盘）', danger: true },
                      ],
                      onClick: ({ key, domEvent }) => {
                        domEvent.stopPropagation();
                        if (key === 'detail') void openDetail(r.id);
                        if (key === 'confirm') void confirmProject(r.id);
                        if (key === 'delete') removeProject(r);
                      },
                    }}
                  >
                    <Button size="small">更多</Button>
                  </Dropdown>
                </Space>
              ),
            },
          ]}
        />
      </StateBlock>

      <Drawer
        open={!!detail}
        onClose={() => { setDetail(null); onSelect(null); }}
        title={detail?.project?.name ?? '项目详情'}
        width={720}
        extra={
          detail && (
            <Space>
              <Button size="small" type="primary" loading={busy(`start-${detail.project.id}`)} onClick={() => void startProject(detail.project.id)}>启动</Button>
              <Button size="small" loading={busy(`stop-${detail.project.id}`)} onClick={() => void stopProject(detail.project.id)}>停止</Button>
            </Space>
          )
        }
      >
        {detail && (
          <>
            <Descriptions column={1} size="small" style={{ marginBottom: 16 }}>
              <Descriptions.Item label="根目录"><Mono>{detail.project.root_path}</Mono></Descriptions.Item>
              <Descriptions.Item label="识别状态">
                <StatusTag status={detail.project.analysis_status === 'confirmed' ? 'Completed' : 'Pending'} text={detail.project.analysis_status === 'confirmed' ? '配置已确认' : '识别草案待确认'} />
              </Descriptions.Item>
              <Descriptions.Item label="导入来源">{detail.project.import_source}</Descriptions.Item>
              <Descriptions.Item label="配置版本">{detail.project.config_version}</Descriptions.Item>
            </Descriptions>
            <Tabs
              items={[
                {
                  key: 'services', label: `服务（${detail.services?.length ?? 0}）`, children: (
                    <Table rowKey="id" size="small" dataSource={detail.services} pagination={false}
                      columns={[
                        { title: '名称', dataIndex: 'name' },
                        { title: '类型', dataIndex: 'service_type' },
                        { title: '启动命令', dataIndex: 'start_command', ellipsis: true, render: (v: string) => <Mono title={v}>{v}</Mono> },
                        { title: '端口', dataIndex: 'port', width: 70 },
                        { title: '状态', dataIndex: 'status', width: 90, render: (s: string) => <StatusTag status={s} /> },
                      ]} />
                  ),
                },
                {
                  key: 'configs', label: `配置草案（${detail.configs?.length ?? 0}）`, children: (
                    <>
                      <p className="dp-desc" style={{ marginBottom: 8 }}>草案来自项目结构识别，确认后才作为启动依据。</p>
                      <Table rowKey="id" size="small" dataSource={detail.configs} pagination={false}
                        columns={[
                          { title: '类型', dataIndex: 'config_type' },
                          { title: '来源', dataIndex: 'source' },
                          { title: '内容', dataIndex: 'content_ref', ellipsis: true },
                        ]} />
                    </>
                  ),
                },
              ]}
            />
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              {detail.project.analysis_status !== 'confirmed' && (
                <Button type="primary" loading={busy(`confirm-${detail.project.id}`)} onClick={() => void confirmProject(detail.project.id)}>
                  审阅无误，确认配置
                </Button>
              )}
              <Button danger onClick={() => removeProject(detail.project)}>删除项目记录</Button>
            </div>
          </>
        )}
      </Drawer>
    </div>
  );
}
