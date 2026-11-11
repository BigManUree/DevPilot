import { DatabasesService } from './databases.service';
import { makeMemoryDs, stub } from '../testing/helpers';

/** DatabasesService 构造：探测/进程逻辑不被本批用例触达，stub 掉审计即可 */
function makeService() {
  const ds = makeMemoryDs();
  const svc = new DatabasesService(stub(ds), stub({ record: jest.fn() }), stub({}));
  return { ds, svc };
}

describe('DatabasesService 本地服务冲突与缺失语义', () => {
  it('upsertLocalService 首建 → id', () => {
    const { svc } = makeService();
    const r = svc.upsertLocalService({ name: 'mysql-local', serviceKind: 'mysql', exePath: 'C:/mysql.exe' });
    expect(r).toHaveProperty('id');
  });

  it('同名再建 → 409', () => {
    const { svc } = makeService();
    svc.upsertLocalService({ name: 'mysql-local', serviceKind: 'mysql', exePath: 'C:/mysql.exe' });
    try {
      svc.upsertLocalService({ name: 'mysql-local', serviceKind: 'mysql', exePath: 'C:/mysql2.exe' });
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.getStatus()).toBe(409);
      expect(e.message).toContain('同名');
    }
  });

  it('更新不存在 id → 404', () => {
    const { svc } = makeService();
    expect(() => svc.upsertLocalService({ id: 'no-such', name: 'x', serviceKind: 'custom', exePath: 'C:/x.exe' }))
      .toThrow(/不存在/);
    try {
      svc.upsertLocalService({ id: 'no-such', name: 'x', serviceKind: 'custom', exePath: 'C:/x.exe' });
    } catch (e: any) {
      expect(e.getStatus()).toBe(404);
    }
  });

  it('start/stop/check 不存在 id → 404', async () => {
    const { svc } = makeService();
    const expect404 = async (fn: () => Promise<unknown>) => {
      try { await fn(); throw new Error('should have thrown'); } catch (e: any) {
        expect(e.getStatus()).toBe(404);
      }
    };
    await expect404(() => svc.startLocalService('no-such'));
    await expect404(() => svc.stopLocalService('no-such'));
    await expect404(() => svc.checkLocalService('no-such'));
  });

  it('delete 不存在 id → 404', () => {
    const { svc } = makeService();
    try {
      svc.deleteLocalService('no-such');
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e.getStatus()).toBe(404);
    }
  });

  it('更新走 UPDATE 分支（保 id，字段落库）', () => {
    const { ds, svc } = makeService();
    const { id } = svc.upsertLocalService({ name: 'svc-a', serviceKind: 'custom', exePath: 'C:/a.exe' });
    svc.upsertLocalService({ id, name: 'svc-a', serviceKind: 'custom', exePath: 'C:/b.exe', port: 9000 });
    const row = ds.db.prepare('SELECT exe_path, port FROM local_services WHERE id=?').get(id) as { exe_path: string; port: number };
    expect(row.exe_path).toBe('C:/b.exe');
    expect(row.port).toBe(9000);
  });
});
