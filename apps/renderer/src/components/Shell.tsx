import React, { useEffect, useState } from 'react';
import { Breadcrumb, Layout, Menu } from 'antd';
import { api } from '../api';

export interface NavPage { key: string; label: string; group: string; desc: string }

/** 20 个功能页的分组导航（key 与原页面路由一致，保证全部可达） */
export const PAGES: NavPage[] = [
  { key: '1', label: '工作台', group: '工作区', desc: '最近项目、运行状态与主任务入口' },
  { key: '2', label: '项目', group: '工作区', desc: '导入、识别、确认配置与项目详情' },
  { key: '4', label: '运行中心', group: '工作区', desc: '服务启动停止、健康状态与启动会话' },
  { key: '5', label: '终端', group: '开发', desc: '交互式终端会话与输出回放' },
  { key: '6', label: '日志与诊断', group: '开发', desc: '按级别/来源检索日志，AI 诊断修复' },
  { key: '10', label: 'Git', group: '开发', desc: '提交、分支与受控推送' },
  { key: '11', label: '代码工作区', group: '开发', desc: '文件浏览与编辑' },
  { key: '3', label: '任务', group: '自动化', desc: 'Agent 任务目标、状态与结果' },
  { key: '7', label: '审批', group: '自动化', desc: '待审批的命令与写操作' },
  { key: '17', label: 'Agent', group: '自动化', desc: 'Agent 注册与运行状态' },
  { key: '18', label: '记忆', group: '自动化', desc: '跨会话事实与决策记录' },
  { key: '20', label: '工作流', group: '自动化', desc: 'DSL 工作流、触发器与运行历史' },
  { key: '8', label: '环境与依赖', group: '资源与工具', desc: '运行时检测与缺失项' },
  { key: '12', label: '数据库与服务', group: '资源与工具', desc: '本地数据库连接与状态' },
  { key: '13', label: '外部工具', group: '资源与工具', desc: 'IDE / 终端 / 浏览器联动' },
  { key: '14', label: '配置中心', group: '资源与工具', desc: '键值配置与环境覆盖' },
  { key: '15', label: '备份迁移', group: '资源与工具', desc: '备份、恢复与跨设备迁移' },
  { key: '16', label: '通知', group: '资源与工具', desc: '事件通知与订阅规则' },
  { key: '19', label: '插件', group: '资源与工具', desc: '本地声明式插件与权限' },
  { key: '9', label: '设置', group: '设置', desc: '模型供应商、凭据与偏好' },
];

const GROUPS = ['工作区', '开发', '自动化', '资源与工具'];

function backendStatus(): { ok: boolean | null; text: string } {
  return { ok: null, text: '检测中' };
}

export default function Shell({ page, onNavigate, children }: {
  page: string; onNavigate: (k: string) => void; children: React.ReactNode;
}) {
  const current = PAGES.find((p) => p.key === page) ?? PAGES[0];
  const [health, setHealth] = useState<{ ok: boolean | null }>({ ok: null });

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        await api('/health');
        if (alive) setHealth({ ok: true });
      } catch {
        if (alive) setHealth({ ok: false });
      }
    };
    void check();
    const t = setInterval(check, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const menuItems = [
    ...GROUPS.map((g) => ({
      type: 'group' as const,
      key: g,
      label: g,
      children: PAGES.filter((p) => p.group === g).map((p) => ({ key: p.key, label: p.label })),
    })),
  ];

  return (
    <Layout style={{ height: '100vh' }}>
      <Layout.Sider width={216} className="dp-sider" theme="light">
        <div className="dp-brand"><span className="dp-brand-badge">D</span>DevPilot</div>
        <Menu
          mode="inline"
          items={menuItems}
          selectedKeys={[page]}
          onClick={(e) => onNavigate(e.key)}
          style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
        />
        <div className="dp-sider-footer">
          <Menu
            mode="inline"
            items={[{ key: '9', label: '设置' }]}
            selectedKeys={page === '9' ? ['9'] : []}
            onClick={(e) => onNavigate(e.key)}
          />
          <div className="dp-backend" title={health.ok ? '后端连接正常' : '后端不可达，请检查进程'}>
            <span className={`dp-dot ${health.ok === null ? '' : health.ok ? 'ok' : 'bad'}`} />
            127.0.0.1:37100 · {health.ok === null ? backendStatus().text : health.ok ? '已连接' : '未连接'}
          </div>
        </div>
      </Layout.Sider>
      <Layout>
        <div className="dp-header">
          <Breadcrumb items={current.group === current.label ? [{ title: current.label }] : [{ title: current.group }, { title: current.label }]} />
          <span style={{ fontSize: 12, color: '#98A2B3' }}>
            {health.ok === false ? '后端未连接，操作可能失败' : ''}
          </span>
        </div>
        <Layout.Content className="dp-content">
          <div className="dp-page">{children}</div>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
