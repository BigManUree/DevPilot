import { parseCron, cronMatches, sameMinute } from './cron';

const d = (s: string) => new Date(s);

describe('cron 解析', () => {
  it('合法表达式通过并还原字段集', () => {
    const p = parseCron('0 9 * * 1-5');
    expect(p.ok).toBe(true);
    if (p.ok && p.fields) {
      expect([...p.fields.minute]).toEqual([0]);
      expect([...p.fields.hour]).toEqual([9]);
      expect(p.fields.dom).toBe('*');
      expect(p.fields.dow).toEqual(new Set([1, 2, 3, 4, 5]));
    }
  });
  it('步长与列表：*/15、1,5,9、1-5/2', () => {
    const p = parseCron('*/15 1,5,9 1-15/2 * *');
    expect(p.ok).toBe(true);
    if (p.ok && p.fields) {
      expect([...p.fields.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
      expect([...p.fields.hour].sort((a, b) => a - b)).toEqual([1, 5, 9]);
      expect([...(p.fields.dom as Set<number>)].sort((a, b) => a - b)).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
    }
  });
  it('非法：字段数错 / 范围越界 / 步长 0', () => {
    expect(parseCron('* * * *').ok).toBe(false);
    expect(parseCron('60 * * * *').ok).toBe(false);
    expect(parseCron('* */0 * * *').ok).toBe(false);
    expect(parseCron('* * 32 * *').ok).toBe(false);
    expect(parseCron('a * * * *').ok).toBe(false);
  });
});

describe('cron 匹配', () => {
  it('每天 09:00（周一至周五）', () => {
    expect(cronMatches('0 9 * * 1-5', d('2026-11-09T09:00:00'))).toBe(true);  // 周一
    expect(cronMatches('0 9 * * 1-5', d('2026-11-07T09:00:00'))).toBe(false); // 周六
    expect(cronMatches('0 9 * * 1-5', d('2026-11-09T09:01:00'))).toBe(false);
    expect(cronMatches('0 9 * * 1-5', d('2026-11-09T10:00:00'))).toBe(false);
  });
  it('每周日 7 与 0 等价', () => {
    expect(cronMatches('30 8 * * 7', d('2026-11-08T08:30:00'))).toBe(true);  // 周日
    expect(cronMatches('30 8 * * 0', d('2026-11-08T08:30:00'))).toBe(true);
  });
  it('每月 1 号 0 点', () => {
    expect(cronMatches('0 0 1 * *', d('2026-11-01T00:00:00'))).toBe(true);
    expect(cronMatches('0 0 1 * *', d('2026-11-02T00:00:00'))).toBe(false);
  });
  it('日/周同时受限 → 取或（Vixie cron）', () => {
    // 13 号周五 或 周五：2026-11-13 是周五 → 两者都命中
    expect(cronMatches('0 12 13 * 5', d('2026-11-13T12:00:00'))).toBe(true);
    // 2026-11-10 周二，非 13 号非周五 → 不命中
    expect(cronMatches('0 12 13 * 5', d('2026-11-10T12:00:00'))).toBe(false);
  });
  it('月份过滤', () => {
    expect(cronMatches('0 0 1 1 *', d('2026-01-01T00:00:00'))).toBe(true);
    expect(cronMatches('0 0 1 1 *', d('2026-02-01T00:00:00'))).toBe(false);
  });
  it('解析失败 → 匹配 false', () => {
    expect(cronMatches('bad expr', d('2026-11-11T00:00:00'))).toBe(false);
  });
});

describe('sameMinute 去重判定', () => {
  it('同一分钟 true，跨分钟 false', () => {
    expect(sameMinute(d('2026-11-11T09:00:30'), d('2026-11-11T09:00:59'))).toBe(true);
    expect(sameMinute(d('2026-11-11T09:00:59'), d('2026-11-11T09:01:00'))).toBe(false);
  });
});
