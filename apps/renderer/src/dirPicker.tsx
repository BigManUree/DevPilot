/**
 * 浏览器模式的目录选择弹窗（Electron 外的兜底）：
 * 经后端 GET /system/fs/dirs 逐级浏览目录，选中返回绝对路径，取消返回 null。
 * Electron 里走系统原生选择器（preload 的 devpilot.pickDirectory），不经这里。
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, ConfigProvider, List, Modal, Space, Spin, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { buildAntdTheme } from './theme';

interface DirEntry { name: string; path: string }
interface DirListing { path: string; parent: string | null; dirs: DirEntry[]; error?: string }

function BrowserDirPicker({ onDone }: { onDone: (v: string | null) => void }) {
  const [path, setPath] = useState('');
  const [parent, setParent] = useState<string | null>(null);
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const dp = (window as unknown as { devpilot?: { getBackendUrl?: () => Promise<string> } }).devpilot;
      const base = dp?.getBackendUrl ? await dp.getBackendUrl() : 'http://127.0.0.1:37100';
      const res = await fetch(`${base}/api/v1/system/fs/dirs?path=${encodeURIComponent(p)}`);
      const r = (await res.json()) as DirListing;
      if (r.error) { setError(r.error); return; }
      setPath(r.path);
      setParent(r.parent);
      setDirs(r.dirs ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(''); }, []);

  return (
    <Modal
      open
      title="选择项目目录"
      width={560}
      onCancel={() => onDone(null)}
      footer={[
        <Button key="cancel" onClick={() => onDone(null)}>取消</Button>,
        <Button key="ok" type="primary" disabled={!path} onClick={() => onDone(path)}>选择当前目录</Button>,
      ]}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button size="small" disabled={!parent} onClick={() => void load(parent!)}>上一级</Button>
          <Typography.Text code style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {path || '计算机'}
          </Typography.Text>
        </div>
        <div style={{ height: 320, overflowY: 'auto', border: '1px solid var(--dp-border)', borderRadius: 6, background: 'var(--dp-card)' }}>
          {loading && <div style={{ padding: 24, textAlign: 'center' }}><Spin /></div>}
          {!loading && error && <Typography.Text type="danger" style={{ padding: 12 }}>{error}</Typography.Text>}
          {!loading && !error && dirs.length === 0 && (
            <Typography.Text type="secondary" style={{ padding: 12 }}>此目录下没有子目录</Typography.Text>
          )}
          {!loading && !error && (
            <List
              size="small"
              dataSource={dirs}
              renderItem={(item) => (
                <List.Item style={{ cursor: 'pointer', padding: '6px 12px' }} onClick={() => void load(item.path)}>
                  <span className="dp-dir-entry"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>{item.name}</span>
                </List.Item>
              )}
            />
          )}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          点击进入子目录；到目标目录后点「选择当前目录」。当前选中：{path || '（未进入任何目录）'}
        </Typography.Text>
      </Space>
    </Modal>
  );
}

/** 动态挂载目录浏览弹窗，Promise 在选择/取消时 resolve */
export function pickDirectoryInBrowser(): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: string | null) => {
      resolve(v);
      setTimeout(() => { root.unmount(); host.remove(); }, 0);
    };
    const dark = document.documentElement.dataset.theme === 'dark';
    root.render(<ConfigProvider locale={zhCN} theme={buildAntdTheme(dark)}><BrowserDirPicker onDone={done} /></ConfigProvider>);
  });
}
