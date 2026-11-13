import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Breadcrumb, Dropdown, Input, Layout, Menu, Modal, Tooltip } from 'antd';
import { api } from '../api';
import type { ThemeMode } from '../theme';

export interface NavPage { key: string; label: string; group: string; desc: string }

export const PAGES: NavPage[] = [
  { key: '1', label: '工作台', group: '工作区', desc: '项目运行概览、最近活动与待办事项' },
  { key: '2', label: '项目管理', group: '工作区', desc: '导入、筛选并管理本地项目与服务' },
  { key: '6', label: '日志与诊断', group: '开发', desc: '检索运行日志，使用 AI 诊断并修复问题' },
  { key: '10', label: 'Git', group: '开发', desc: '分支、变更、Diff、提交与远程仓库' },
  { key: '3', label: '任务', group: '开发', desc: '查看 Agent 任务目标、状态与执行结果' },
  { key: '7', label: '审批', group: '开发', desc: '处理待授权的命令与写操作' },
  { key: '17', label: 'Agent', group: '开发', desc: 'Agent 会话、执行过程与工具调用' },
  { key: '18', label: '记忆', group: '开发', desc: '检索并管理跨会话事实与决策' },
  { key: '20', label: '工作流', group: '开发', desc: '定义、运行并追踪自动化工作流' },
  { key: '8', label: '环境与依赖', group: '资源与工具', desc: '检测开发运行时与工具依赖' },
  { key: '12', label: '数据库与服务', group: '资源与工具', desc: '管理数据库连接与本地服务' },
  { key: '13', label: '外部工具', group: '资源与工具', desc: '联动 IDE、浏览器与 Android 模拟器' },
  { key: '14', label: '配置中心', group: '资源与工具', desc: '管理项目环境档案与变量覆盖' },
  { key: '15', label: '备份迁移', group: '资源与工具', desc: '备份、校验、恢复与跨设备迁移' },
  { key: '16', label: '通知', group: '资源与工具', desc: '事件通知、已读状态与订阅规则' },
  { key: '19', label: '插件', group: '资源与工具', desc: '管理本地声明式插件与权限' },
  { key: '9', label: '设置', group: '设置', desc: '外观、模型供应商、凭据与偏好' },
];

const ICON_PROPS = {
  width: 17, height: 17, viewBox: '0 0 24 24', 'aria-hidden': true as const,
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};

export function PageIcon({ k }: { k: string }) {
  const paths: Record<string, React.ReactNode> = {
    '1': <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    '2': <><path d="M3 7.5V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 10h18"/></>,
    '6': <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></>,
    '10': <><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-12 2-12 8"/></>,
    '3': <><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></>,
    '7': <><path d="M12 3 20 6v5c0 5-3 8-8 10-5-2-8-5-8-10V6Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></>,
    '17': <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3M13 15h4"/></>,
    '18': <><path d="M6 3h12a2 2 0 0 1 2 2v16l-8-5-8 5V5a2 2 0 0 1 2-2Z"/></>,
    '20': <><rect x="3" y="3" width="7" height="6" rx="2"/><rect x="14" y="15" width="7" height="6" rx="2"/><path d="M6.5 9v4a2 2 0 0 0 2 2H14"/></>,
    '8': <><path d="m12 2 9 5v10l-9 5-9-5V7Z"/><path d="m3 7 9 5 9-5M12 12v10"/></>,
    '12': <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></>,
    '13': <><path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 8.5 7 6.2 4.7a4 4 0 0 0 5 5L4 17a2.1 2.1 0 0 0 3 3l7.2-7.2a4 4 0 0 0 5-5L17 10l-3.5-3.5Z"/></>,
    '14': <><path d="M4 6h16M4 18h16M4 12h16"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="8" cy="18" r="2" fill="currentColor" stroke="none"/></>,
    '15': <><path d="M3 8h14l-4-4M21 16H7l4 4"/><path d="M17 8a8 8 0 0 1 4 7M7 16a8 8 0 0 1-4-7"/></>,
    '16': <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>,
    '19': <><path d="M8 3h3v3a2 2 0 1 0 4 0V3h3a2 2 0 0 1 2 2v4h-3a2 2 0 1 0 0 4h3v4a2 2 0 0 1-2 2h-4v-3a2 2 0 1 0-4 0v3H6a2 2 0 0 1-2-2v-4h3a2 2 0 1 0 0-4H4V5a2 2 0 0 1 2-2Z"/></>,
    '9': <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  };
  return <svg {...ICON_PROPS}>{paths[k] ?? <circle cx="12" cy="12" r="4"/>}</svg>;
}

function UtilityIcon({ name }: { name: 'search' | 'sun' | 'moon' | 'system' | 'settings' | 'plus' | 'panel' }) {
  const paths = {
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></>,
    moon: <path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z"/>,
    system: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></>,
    settings: <><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    panel: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></>,
  };
  return <svg {...ICON_PROPS}>{paths[name]}</svg>;
}

const GROUPS = ['工作区', '开发', '资源与工具'];
const COLLAPSE_KEY = 'devpilot.siderCollapsed';
const THEME_ITEMS: Array<{ key: ThemeMode; label: string; icon: 'system' | 'sun' | 'moon' }> = [
  { key: 'system', label: '跟随系统', icon: 'system' },
  { key: 'light', label: '浅色模式', icon: 'sun' },
  { key: 'dark', label: '深色模式', icon: 'moon' },
];

function NavLabel({ page }: { page: NavPage }) {
  return <span className="dp-nav-label"><PageIcon k={page.key}/><span>{page.label}</span></span>;
}

export default function Shell({ page, onNavigate, children, themeMode, onThemeChange }: {
  page: string; onNavigate: (k: string) => void; children: React.ReactNode;
  themeMode: ThemeMode; onThemeChange: (m: ThemeMode) => void;
}) {
  const current = PAGES.find((p) => p.key === page) ?? PAGES[0];
  const [health, setHealth] = useState<{ ok: boolean | null }>({ ok: null });
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } });
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<any>(null);

  const toggle = React.useCallback(() => setCollapsed((value) => {
    const next = !value;
    try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* noop */ }
    return next;
  }), []);

  useEffect(() => {
    const onToggle = () => toggle();
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSearchOpen(true); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); toggle(); }
    };
    window.addEventListener('devpilot:toggle-sider', onToggle);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('devpilot:toggle-sider', onToggle); window.removeEventListener('keydown', onKey); };
  }, [toggle]);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try { await api('/health'); if (alive) setHealth({ ok: true }); }
      catch { if (alive) setHealth({ ok: false }); }
    };
    void check();
    const timer = setInterval(check, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  useEffect(() => { if (searchOpen) setTimeout(() => searchRef.current?.focus(), 60); }, [searchOpen]);

  const menuItems = GROUPS.map((group) => ({
    type: 'group' as const, key: group, label: group,
    children: PAGES.filter((p) => p.group === group).map((p) => ({ key: p.key, label: <NavLabel page={p}/> })),
  }));
  const results = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return PAGES.filter((p) => !keyword || `${p.label} ${p.desc} ${p.group}`.toLowerCase().includes(keyword));
  }, [search]);
  const themeIcon = THEME_ITEMS.find((item) => item.key === themeMode)?.icon ?? 'system';

  return (
    <Layout className="dp-shell">
      <Layout.Sider width={232} collapsedWidth={68} collapsed={collapsed} className="dp-sider" theme="light" trigger={null}>
        <button className={`dp-brand${collapsed ? ' collapsed' : ''}`} onClick={() => onNavigate('1')} aria-label="返回工作台">
          <span className="dp-brand-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="m3 11 19-9-9 19-2-8-8-2Z"/>
              <path d="M21 2 12 13"/>
            </svg>
          </span>
          {!collapsed && <span className="dp-brand-name">DevPilot</span>}
        </button>
        {collapsed ? (
          <nav className="dp-compact-nav" aria-label="主导航">
            {PAGES.filter((p) => p.key !== '9').map((p) => (
              <Tooltip key={p.key} title={`${p.group} · ${p.label}`} placement="right">
                <button className={`dp-compact-item${p.key === page ? ' active' : ''}`} aria-label={p.label} aria-current={p.key === page ? 'page' : undefined} onClick={() => onNavigate(p.key)}><PageIcon k={p.key}/></button>
              </Tooltip>
            ))}
          </nav>
        ) : <Menu mode="inline" items={menuItems} selectedKeys={[page]} onClick={(e) => onNavigate(e.key)}/>}
        <div className="dp-sider-footer">
          <Tooltip title={collapsed ? '设置' : ''} placement="right">
            <button className={`dp-settings-link${page === '9' ? ' active' : ''}`} onClick={() => onNavigate('9')}><PageIcon k="9"/>{!collapsed && <span>设置</span>}</button>
          </Tooltip>
          <div className={`dp-backend${collapsed ? ' compact' : ''}`} title={health.ok ? '后端连接正常' : '后端连接状态'}>
            <span className={`dp-dot ${health.ok === null ? '' : health.ok ? 'ok' : 'bad'}`}/>
            {!collapsed && <><span>后端{health.ok === null ? '检测中' : health.ok ? '已连接' : '未连接'}</span><span className="dp-backend-label">本地</span></>}
          </div>
        </div>
      </Layout.Sider>

      <Layout className="dp-main">
        <header className="dp-header">
          <div className="dp-header-left">
            <button type="button" className="dp-icon-btn" onClick={toggle} aria-label={collapsed ? '展开侧栏' : '折叠侧栏'} title={`${collapsed ? '展开' : '折叠'}侧栏（Ctrl+B）`}><UtilityIcon name="panel"/></button>
            <Breadcrumb items={[{ title: current.group }, { title: <span className="dp-crumb-current">{current.label}</span> }]}/>
          </div>
          <button className="dp-global-search" onClick={() => setSearchOpen(true)} aria-label="打开全局搜索">
            <UtilityIcon name="search"/><span>搜索页面与功能</span><kbd>Ctrl K</kbd>
          </button>
          <div className="dp-header-actions">
            <Dropdown trigger={['click']} placement="bottomRight" menu={{ items: [
              { key: '2', label: '导入或管理项目' }, { key: '17', label: '打开 Agent 工作区' }, { key: '20', label: '新建工作流' },
            ], onClick: ({ key }) => onNavigate(key) }}>
              <button className="dp-icon-btn" aria-label="快捷操作" title="快捷操作"><UtilityIcon name="plus"/></button>
            </Dropdown>
            <Dropdown trigger={['click']} placement="bottomRight" menu={{
              items: THEME_ITEMS.map((item) => ({ key: item.key, label: <span className="dp-theme-menu"><UtilityIcon name={item.icon}/>{item.label}{themeMode === item.key && <span className="dp-theme-check">✓</span>}</span> })),
              onClick: ({ key }) => onThemeChange(key as ThemeMode),
            }}>
              <button className="dp-icon-btn" aria-label="切换外观" title={`外观：${THEME_ITEMS.find((t) => t.key === themeMode)?.label}`}><UtilityIcon name={themeIcon}/></button>
            </Dropdown>
            <button className={`dp-icon-btn${page === '9' ? ' active' : ''}`} aria-label="设置" title="设置" onClick={() => onNavigate('9')}><UtilityIcon name="settings"/></button>
          </div>
        </header>
        <Layout.Content className={`dp-content${page === '17' ? ' dp-content-agent' : ''}`}>
          <div className={`dp-page${page === '17' ? ' dp-page-wide' : ''}`}>{children}</div>
        </Layout.Content>
      </Layout>

      <Modal className="dp-search-modal" open={searchOpen} onCancel={() => { setSearchOpen(false); setSearch(''); }} footer={null} closable={false} width={600}>
        <Input ref={searchRef} size="large" allowClear prefix={<UtilityIcon name="search"/>} placeholder="搜索页面、功能或设置…" value={search} onChange={(e) => setSearch(e.target.value)}/>
        <div className="dp-search-results">
          {results.map((p) => <button key={p.key} onClick={() => { onNavigate(p.key); setSearchOpen(false); setSearch(''); }}><span className="dp-search-icon"><PageIcon k={p.key}/></span><span><strong>{p.label}</strong><small>{p.group} · {p.desc}</small></span><span className="dp-search-enter">↵</span></button>)}
          {results.length === 0 && <div className="dp-search-empty">没有匹配的功能页面</div>}
        </div>
        <div className="dp-search-hint"><span>输入关键词筛选</span><span>ESC 关闭</span></div>
      </Modal>
    </Layout>
  );
}
