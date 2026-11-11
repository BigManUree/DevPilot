/** 行级统一 Diff（不引第三方依赖，MVP 用） */
export function diffLines(before: string, after: string): Array<{ type: 'same' | 'add' | 'del'; line: string }> {
  const a = before.split('\n');
  const b = after.split('\n');
  // LCS 表
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const out: Array<{ type: 'same' | 'add' | 'del'; line: string }> = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'same', line: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', line: a[i] }); i++; }
    else { out.push({ type: 'add', line: b[j] }); j++; }
  }
  while (i < m) { out.push({ type: 'del', line: a[i] }); i++; }
  while (j < n) { out.push({ type: 'add', line: b[j] }); j++; }
  return out;
}

/** 渲染 unified-diff 风格文本 */
export function renderDiff(path: string, before: string, after: string): string {
  const lines = diffLines(before, after);
  const body = lines
    .map((l) => (l.type === 'same' ? ` ${l.line}` : l.type === 'add' ? `+${l.line}` : `-${l.line}`))
    .join('\n');
  return `--- a/${path}\n+++ b/${path}\n${body}`;
}
