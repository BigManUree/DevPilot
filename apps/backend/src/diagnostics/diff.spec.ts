import { diffLines, renderDiff } from './diff';

describe('diffLines', () => {
  it('相同文本全部 same', () => {
    const r = diffLines('a\nb\nc', 'a\nb\nc');
    expect(r.every((l) => l.type === 'same')).toBe(true);
    expect(r).toHaveLength(3);
  });

  it('尾部新增标记 add', () => {
    const r = diffLines('a', 'a\nb');
    expect(r).toEqual([
      { type: 'same', line: 'a' },
      { type: 'add', line: 'b' },
    ]);
  });

  it('头部删除标记 del', () => {
    const r = diffLines('x\na', 'a');
    expect(r).toEqual([
      { type: 'del', line: 'x' },
      { type: 'same', line: 'a' },
    ]);
  });

  it('中间替换 = del + add（LCS 保序）', () => {
    const r = diffLines('a\nold\nb', 'a\nnew\nb');
    expect(r).toEqual([
      { type: 'same', line: 'a' },
      { type: 'del', line: 'old' },
      { type: 'add', line: 'new' },
      { type: 'same', line: 'b' },
    ]);
  });

  it('空串 vs 内容（split 语义：空串视为一个空行）', () => {
    expect(diffLines('', 'a')).toEqual([
      { type: 'del', line: '' },
      { type: 'add', line: 'a' },
    ]);
    expect(diffLines('a', '')).toEqual([
      { type: 'del', line: 'a' },
      { type: 'add', line: '' },
    ]);
    expect(diffLines('', '')).toEqual([{ type: 'same', line: '' }]);
  });

  it('行序重排产生最小编辑序列', () => {
    const r = diffLines('a\nb', 'b\na');
    // LCS=1：一对 del/add，且保持原有顺序语义
    expect(r.filter((l) => l.type === 'del')).toHaveLength(1);
    expect(r.filter((l) => l.type === 'add')).toHaveLength(1);
    expect(r.filter((l) => l.type === 'same')).toHaveLength(1);
  });
});

describe('renderDiff', () => {
  it('输出 unified-diff 风格头部与 +/- 前缀', () => {
    const out = renderDiff('app.config.json', 'port=8080', 'port=9090');
    expect(out.startsWith('--- a/app.config.json\n+++ b/app.config.json')).toBe(true);
    expect(out).toContain('-port=8080');
    expect(out).toContain('+port=9090');
  });
});
