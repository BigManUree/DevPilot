import React, { useEffect, useState } from 'react';
import { Breadcrumb, Dropdown, Layout, Menu, Tooltip } from 'antd';
import { api } from '../api';
import type { ThemeMode } from '../theme';

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
const COLLAPSE_KEY = 'devpilot.siderCollapsed';

/** 折叠态紧凑导航：两字缩写 + tooltip，键盘可聚焦 */
function CompactNav({ page, onNavigate }: { page: string; onNavigate: (k: string) => void }) {
  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
      {PAGES.map((p) => {
        const active = p.key === page;
        return (
          <Tooltip key={p.key} title={`${p.group} / ${p.label}`} placement="right">
            <button
              type="button"
              aria-label={p.label}
              aria-current={active ? 'page' : undefined}
              onClick={() => onNavigate(p.key)}
              style={{
                width: '100%', height: 34, marginBottom: 2, border: 'none', cursor: 'pointer',
                borderRadius: 6, background: active ? 'var(--dp-primary-soft)' : 'transparent',
                color: active ? 'var(--dp-primary)' : 'var(--dp-text-2)',
                fontWeight: active ? 600 : 400, fontSize: 12,
                boxShadow: active ? 'inset 2px 0 0 var(--dp-primary)' : undefined,
              }}
            >
              {p.label.slice(0, 2)}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

const THEME_ITEMS: Array<{ key: ThemeMode; label: string }> = [
  { key: 'system', label: '跟随系统' },
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
];

function ThemeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 1.2v1.8M8 13v1.8M1.2 8h1.8M13 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"
        stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export default function Shell({ page, onNavigate, children, themeMode, onThemeChange }: {
  page: string;
  onNavigate: (k: string) => void;
  children: React.ReactNode;
  themeMode: ThemeMode;
  onThemeChange: (m: ThemeMode) => void;
}) {
  const current = PAGES.find((p) => p.key === page) ?? PAGES[0];
  const [health, setHealth] = useState<{ ok: boolean | null }>({ ok: null });
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });

  const toggle = () => setCollapsed((c) => {
    const next = !c;
    try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* 忽略 */ }
    return next;
  });

  // 菜单栏（视图 → 侧栏）与快捷键共用同一入口
  useEffect(() => {
    const onToggle = () => toggle();
    window.addEventListener('devpilot:toggle-sider', onToggle);
    return () => window.removeEventListener('devpilot:toggle-sider', onToggle);
  }, []);

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

  const menuItems = GROUPS.map((g) => ({
    type: 'group' as const,
    key: g,
    label: g,
    children: PAGES.filter((p) => p.group === g).map((p) => ({ key: p.key, label: p.label })),
  }));

  return (
    <Layout style={{ height: '100vh' }}>
      <Layout.Sider width={216} collapsedWidth={64} collapsed={collapsed} className="dp-sider" theme="light" trigger={null}>
        <div className={`dp-brand${collapsed ? ' collapsed' : ''}`}>{collapsed ? 'DP' : 'DevPilot'}</div>

        {collapsed ? (
          <CompactNav page={page} onNavigate={onNavigate} />
        ) : (
          <Menu
            mode="inline"
            items={menuItems}
            selectedKeys={[page]}
            onClick={(e) => onNavigate(e.key)}
            style={{ flex: 1, overflowY: 'auto' }}
          />
        )}

        <div className="dp-sider-footer" style={{ padding: collapsed ? '8px 8px 10px' : undefined }}>
          {collapsed ? (
            <Tooltip title="设置" placement="right">
              <button
                type="button" aria-label="设置" onClick={() => onNavigate('9')}
                style={{
                  width: '100%', height: 32, border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                  background: page === '9' ? 'var(--dp-primary-soft)' : 'transparent',
                  color: page === '9' ? 'var(--dp-primary)' : 'var(--dp-text-2)',
                }}
              >设</button>
            </Tooltip>
          ) : (
            <Menu
              mode="inline"
              items={[{ key: '9', label: '设置' }]}
              selectedKeys={page === '9' ? ['9'] : []}
              onClick={(e) => onNavigate(e.key)}
            />
          )}
          <div className="dp-backend" style={{ justifyContent: collapsed ? 'center' : 'flex-start' }} title={health.ok ? '后端连接正常' : '后端不可达，请检查进程'}>
            <span className={`dp-dot ${health.ok === null ? '' : health.ok ? 'ok' : 'bad'}`} />
            {!collapsed && <>后端{health.ok === null ? '检测中' : health.ok ? '已连接' : '未连接'}</>}
          </div>
        </div>
      </Layout.Sider>

      <Layout>
        <div className="dp-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <button
              type="button"
              className="dp-icon-btn"
              onClick={toggle}
              aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
              aria-expanded={!collapsed}
              title={collapsed ? '展开侧栏（Ctrl+B）' : '折叠侧栏（Ctrl+B）'}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
                <line x1="6.5" y1="2.5" x2="6.5" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
            <Breadcrumb items={[{ title: current.group }, { title: current.label }]} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <span style={{ fontSize: 12, color: 'var(--dp-text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {current.desc}
            </span>
            <Dropdown
              trigger={['click']}
              placement="bottomRight"
              menu={{
                items: THEME_ITEMS.map((t) => ({ key: t.key, label: t.label })),
                selectedKeys: [themeMode],
                onClick: ({ key }) => onThemeChange(key as ThemeMode),
              }}
            >
              <button type="button" className="dp-icon-btn" aria-label="切换外观" title="切换外观：跟随系统 / 浅色 / 深色">
                <ThemeIcon />
              </button>
            </Dropdown>
          </div>
        </div>
        <Layout.Content className="dp-content">
          <div className="dp-page">{children}</div>
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
