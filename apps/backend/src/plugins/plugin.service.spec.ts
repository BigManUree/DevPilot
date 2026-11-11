import { PluginService, PluginManifest } from './plugin.service';
import { makeMemoryDs, stub } from '../testing/helpers';
import { NotFoundException } from '@nestjs/common';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const validManifest: PluginManifest = {
  id: 'echo-hook',
  name: '回显插件',
  version: '1.0.0',
  kind: 'hook',
  hooks: [
    { event: 'notification.new', action: 'log' },
    { event: 'task.failed', action: 'notify', params: { title: '任务失败转发' } },
  ],
};


function makeService(overrides?: { toolGateway?: Record<string, unknown> }) {
  const ds = makeMemoryDs();
  // 临时插件目录：manifest_ref 指向真实文件（list/dispatch 热读路径）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-plugins-'));
  const mf = path.join(tmp, 'echo-hook', 'plugin.json');
  fs.mkdirSync(path.dirname(mf), { recursive: true });
  fs.writeFileSync(mf, JSON.stringify(validManifest));
  (global as any).__mf = mf;
  const logs = { log: jest.fn() };
  const audit = { record: jest.fn() };
  const events = { broadcast: jest.fn() };
  const toolGateway = overrides?.toolGateway ?? { call: jest.fn().mockResolvedValue({ ok: true }) };
  const svc = new PluginService(
    stub(ds),
    stub(events),
    stub(toolGateway),
    stub(audit),
    stub(logs),
  ) as unknown as PluginService;
  return { ds, svc, logs, audit, events, toolGateway };
}

describe('PluginService Manifest 校验', () => {
  it('合法 manifest 通过', () => {
    const { svc } = makeService();
    const r = svc.validateManifest(validManifest);
    expect(r.ok).toBe(true);
  });

  it('id 缺失 / 非法字符 / version 非 semver / kind 未知 / hooks 空 → 拒绝', () => {
    const { svc } = makeService();
    expect(svc.validateManifest({ ...validManifest, id: undefined }).ok).toBe(false);
    expect(svc.validateManifest({ ...validManifest, id: 'a' }).ok).toBe(false);
    expect(svc.validateManifest({ ...validManifest, version: '1.0' }).ok).toBe(false);
    expect(svc.validateManifest({ ...validManifest, kind: 'runtime' as never }).ok).toBe(false);
    expect(svc.validateManifest({ ...validManifest, hooks: [] }).ok).toBe(false);
  });

  it('未知事件与未知 action 白名单拒绝', () => {
    const { svc } = makeService();
    expect(svc.validateManifest({ ...validManifest, hooks: [{ event: 'evil.event', action: 'log' }] }).ok).toBe(false);
    expect(svc.validateManifest({ ...validManifest, hooks: [{ event: 'task.failed', action: 'eval' as never }] }).ok).toBe(false);
  });
});

describe('PluginService 生命周期', () => {
  it('setEnabled：不存在 → NotFoundException；启用后 list.enabled=true', () => {
    const { ds, svc } = makeService();
    ds.db.prepare("INSERT INTO plugins (id, name, version, type, manifest_ref, status) VALUES ('echo-hook','回显插件','1.0.0','hook',?,'installed')")
      .run((global as any).__mf);
    expect(() => svc.setEnabled('no-such', true)).toThrow(NotFoundException);
    svc.setEnabled('echo-hook', true);
    expect(svc.list()[0].enabled).toBe(true);
    svc.setEnabled('echo-hook', false);
    expect(svc.list()[0].enabled).toBe(false);
  });
});

describe('PluginService dispatch', () => {
  it('log action 写插件来源日志；notify action 转发 notification.new', async () => {
    const { ds, svc, logs, events } = makeService();
    ds.db.prepare("INSERT INTO plugins (id, name, version, type, manifest_ref, status) VALUES ('echo-hook','回显插件','1.0.0','hook',?,'enabled')")
      .run((global as any).__mf);
    await svc.dispatch({ event_type: 'notification.new', payload: { title: '你好' } });
    expect(logs.log).toHaveBeenCalledWith(expect.objectContaining({ sourceModule: 'plugin:echo-hook' }));
    await svc.dispatch({ event_type: 'task.failed', payload: { title: '炸了' } });
    expect(events.broadcast).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'notification.new', source_module: 'plugin:echo-hook' }));
  });

  it('未启用的插件不触发；command action 走 tool-gateway（plugin 主体）', async () => {
    const { ds, svc, logs, toolGateway } = makeService();
    const mfc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-plugins-')), 'plugin.json');
    fs.writeFileSync(mfc, JSON.stringify({ ...validManifest, hooks: [{ event: 'task.failed', action: 'command', params: { command: 'echo hi' } }] }));
    ds.db.prepare("INSERT INTO plugins (id, name, version, type, manifest_ref, status) VALUES ('echo-hook','回显插件','1.0.0','hook',?,'disabled')")
      .run(mfc);
    await svc.dispatch({ event_type: 'task.failed', payload: {} });
    expect(logs.log).not.toHaveBeenCalled();
    expect(toolGateway.call).not.toHaveBeenCalled();

    svc.setEnabled('echo-hook', true);
    await svc.dispatch({ event_type: 'task.failed', payload: {} });
    expect(toolGateway.call).toHaveBeenCalledWith(
      expect.objectContaining({ subjectType: 'plugin', subjectId: 'echo-hook', tool: 'command.exec' }),
      'plugin',
    );
  });

  it('hook 抛错不向上传播（dispatch 吞错落日志）', async () => {
    const { ds, svc } = makeService({ toolGateway: { call: jest.fn().mockRejectedValue(new Error('boom')) } });
    const mfc2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-plugins-')), 'plugin.json');
    fs.writeFileSync(mfc2, JSON.stringify({ ...validManifest, hooks: [{ event: 'task.failed', action: 'command', params: {} }] }));
    ds.db.prepare("INSERT INTO plugins (id, name, version, type, manifest_ref, status) VALUES ('echo-hook','回显插件','1.0.0','hook',?,'enabled')")
      .run(mfc2);
    await expect(svc.dispatch({ event_type: 'task.failed', payload: {} })).resolves.toBeUndefined();
  });
});
