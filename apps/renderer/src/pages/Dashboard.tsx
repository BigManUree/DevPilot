import React, { useCallback, useEffect, useState } from 'react';
import { Button, Card, Col, Input, List, message, Row, Space, Typography } from 'antd';
import { api } from '../api';
import { Mono, PageHeader, SectionCard, StateBlock, StatusTag } from '../components/ui';
import { colors } from '../theme';

/** 工作台：主任务 = 导入/选择项目 → 启动 → 看状态。右侧仅放轻量信号。 */
export default function Dashboard({ go, onOpenProject }: {
  go: (k: string) => void; onOpenProject: (id: string) => void;
}) {
  const [projects, setProjects] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [services, setServices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importPath, setImportPath] = useState('');
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, t, a, s] = await Promise.all([
        api<any[]>('/projects'),
        api<any[]>('/tasks'),
        api<any[]>('/approvals'),
        api<any[]>('/services/status').catch(() => []),
      ]);
      setProjects(Array.isArray(p) ? p : []);
      setTasks(Array.isArray(t) ? t : []);
      setApprovals(Array.isArray(a) ? a : []);
      setServices(Array.isArray(s) ? s : []);
    } catch (e: any) {
      setError(e?.message ?? '无法连接后端，请确认后端进程已启动');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [load]);

  const doImport = async () => {
    if (!importPath.trim() || importing) return;
    setImporting(true);
    try {
      const r = await api<{ projectId: string; analysis: any }>('/projects/import', 'POST', { source: 'folder', rootPath: importPath.trim() });
      message.success(`导入成功：识别 ${r.analysis.services.length} 个服务，${r.analysis.unknowns.length} 项待确认`);
      setImportPath('');
      await load();
      onOpenProject(r.projectId);
    } catch (e: any) {
      message.error('导入失败：' + (e?.message ?? String(e)));
    } finally {
      setImporting(false);
    }
  };

  const running = services.filter((s) => s.status === 'Running').length;
  const failed = services.filter((s) => s.status === 'Failed' || s.status === 'Unhealthy').length;
  const recentTasks = tasks.slice(0, 4);

  return (
    <div>
      <PageHeader title="工作台" description="选择或导入项目，启动服务，查看运行状态" />

      <SectionCard style={{ marginBottom: 16 }}>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            placeholder="项目根目录绝对路径，例如 D:\work\my-app"
            value={importPath}
            onChange={(e) => setImportPath(e.target.value)}
            onPressEnter={doImport}
            disabled={importing}
          />
          <Button type="primary" onClick={doImport} loading={importing} disabled={!importPath.trim()}>
            导入并识别
          </Button>
        </Space.Compact>
        <p className="dp-desc" style={{ marginTop: 8 }}>导入后先审阅识别出的服务与配置，确认后再启动。</p>
      </SectionCard>

      <Row gutter={16}>
        <Col xs={24} lg={16}>
          <SectionCard title={`项目（${projects.length}）`} extra={<Button size="small" onClick={() => go('2')}>全部项目</Button>}>
            <StateBlock
              loading={loading} error={error} onRetry={() => void load()}
              empty={projects.length === 0}
              emptyText="还没有项目。在上方输入根目录路径导入第一个项目。"
            >
              <List
                dataSource={projects.slice(0, 8)}
                renderItem={(p: any) => (
                  <List.Item
                    style={{ cursor: 'pointer', padding: '10px 4px' }}
                    onClick={() => onOpenProject(p.id)}
                    actions={[<Button key="open" size="small" type="link" onClick={(e) => { e.stopPropagation(); onOpenProject(p.id); }}>打开</Button>]}
                  >
                    <List.Item.Meta
                      title={
                        <Space size={8}>
                          <Typography.Text strong>{p.name}</Typography.Text>
                          <span style={{ color: colors.textTertiary, fontSize: 12 }}>{[p.language, p.framework].filter(Boolean).join(' / ') || '未识别'}</span>
                        </Space>
                      }
                      description={
                        <Space size={8} style={{ marginTop: 4 }} wrap>
                          <StatusTag status={p.analysis_status === 'confirmed' ? 'Completed' : 'Pending'} text={p.analysis_status === 'confirmed' ? '配置已确认' : '待确认配置'} />
                          <span style={{ fontSize: 12, color: colors.textSecondary }}>
                            {p.service_count ?? 0} 个服务
                            {(p.running_count ?? 0) > 0 && <span style={{ color: colors.success }}> · {p.running_count} 运行中</span>}
                          </span>
                          <Mono title={p.root_path}>{p.root_path}</Mono>
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            </StateBlock>
          </SectionCard>
        </Col>

        <Col xs={24} lg={8}>
          <SectionCard title="运行状态" style={{ marginBottom: 16 }}>
            <StateBlock loading={loading} error={null} empty={false}>
              <Space size={24}>
                <span><Typography.Text strong style={{ fontSize: 20 }}>{running}</Typography.Text> <span className="dp-desc">运行中</span></span>
                <span>
                  <Typography.Text strong style={{ fontSize: 20, color: failed ? colors.danger : undefined }}>{failed}</Typography.Text>
                  <span className="dp-desc"> 异常</span>
                </span>
              </Space>
              <div style={{ marginTop: 8 }}>
                <Button size="small" onClick={() => go('4')}>进入运行中心</Button>
              </div>
            </StateBlock>
          </SectionCard>

          {approvals.length > 0 && (
            <SectionCard title="待审批" style={{ marginBottom: 16 }}>
              <Typography.Text type="warning">{approvals.length} 项命令或写操作等待授权</Typography.Text>
              <div style={{ marginTop: 8 }}><Button size="small" onClick={() => go('7')}>去审批</Button></div>
            </SectionCard>
          )}

          <SectionCard title="最近任务" extra={<Button size="small" type="link" onClick={() => go('3')}>全部</Button>}>
            <StateBlock loading={loading} error={null} empty={recentTasks.length === 0} emptyText="暂无任务">
              <List
                size="small"
                dataSource={recentTasks}
                renderItem={(t: any) => (
                  <List.Item style={{ padding: '6px 0' }}>
                    <Space size={8} style={{ width: '100%' }}>
                      <StatusTag status={t.status} />
                      <Typography.Text ellipsis style={{ fontSize: 12 }}>{t.input_summary}</Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </StateBlock>
          </SectionCard>
        </Col>
      </Row>
    </div>
  );
}
