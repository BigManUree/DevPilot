import { ConfigCenterService } from './configcenter.service';
import { makeMemoryDs, stub } from '../testing/helpers';

function makeService() {
  const ds = makeMemoryDs();
  const svc = new ConfigCenterService(stub(ds), stub({ record: jest.fn() }));
  // 项目外键依赖
  ds.db.prepare(
    `INSERT INTO projects (id, name, root_path, import_source, created_at, updated_at)
     VALUES ('p1', 'demo', 'C:/demo', 'folder', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run();
  return { ds, svc };
}

describe('ConfigCenterService.upsertProfile 冲突与缺失语义', () => {
  it('首次创建 → 201 形状返回 id', () => {
    const { svc } = makeService();
    const r = svc.upsertProfile('p1', { name: 'dev', variables: { A: '1' } });
    expect(r).toHaveProperty('id');
  });

  it('同名再建 → ConflictException 409（UNIQUE(project_id,name) 预检）', () => {
    const { svc } = makeService();
    svc.upsertProfile('p1', { name: 'dev', variables: {} });
    expect(() => svc.upsertProfile('p1', { name: 'dev', variables: {} }))
      .toThrow(/同名环境档案已存在/);
    try {
      svc.upsertProfile('p1', { name: 'dev', variables: {} });
    } catch (e: any) {
      expect(e.getStatus()).toBe(409);
    }
  });

  it('改名撞已有档案 → 409', () => {
    const { svc } = makeService();
    svc.upsertProfile('p1', { name: 'a', variables: {} });
    const b = svc.upsertProfile('p1', { name: 'b', variables: {} }) as { id: string };
    expect(() => svc.upsertProfile('p1', { id: b.id, name: 'a', variables: {} }))
      .toThrow(/同名环境档案已存在/);
  });

  it('更新指定 id 不存在 → 404', () => {
    const { svc } = makeService();
    expect(() => svc.upsertProfile('p1', { id: 'no-such-id', name: 'x', variables: {} }))
      .toThrow(/不存在/);
    try {
      svc.upsertProfile('p1', { id: 'no-such-id', name: 'x', variables: {} });
    } catch (e: any) {
      expect(e.getStatus()).toBe(404);
    }
  });

  it('激活不存在档案 → 404', () => {
    const { svc } = makeService();
    expect(() => svc.activate('p1', 'no-such-id')).toThrow(/不存在/);
    try {
      svc.activate('p1', 'no-such-id');
    } catch (e: any) {
      expect(e.getStatus()).toBe(404);
    }
  });

  it('激活成功后唯一 active', () => {
    const { ds, svc } = makeService();
    const a = svc.upsertProfile('p1', { name: 'a', variables: {} }) as { id: string };
    const b = svc.upsertProfile('p1', { name: 'b', variables: {} }) as { id: string };
    svc.activate('p1', a.id);
    svc.activate('p1', b.id);
    const actives = ds.db.prepare('SELECT id FROM env_profiles WHERE project_id=? AND active=1').all('p1');
    expect(actives).toEqual([{ id: b.id }]);
  });

  it('diff 不存在档案 → 404', () => {
    const { svc } = makeService();
    expect(() => svc.diffProfiles('p1', 'x1', 'x2')).toThrow(/不存在/);
  });
});
