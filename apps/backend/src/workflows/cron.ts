/**
 * 极简 cron 表达式解析与匹配（零依赖，工作流 schedule 触发器 A1 第二批）。
 * 标准 5 字段：分 时 日 月 周（0 或 7 均为周日）；支持星号、数字、区间 a-b、步进（星号除以 n、区间除以 n、a 除以 n）、逗号列表。
 * 日/周同时受限时按 Vixie cron 语义取「或」；不支持含秒的 6 字段与 @yearly 等别名。
 */
export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number> | '*';
  month: Set<number>;
  dow: Set<number> | '*';
}

const RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(text: string, min: number, max: number): Set<number> | { error: string } {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    let body = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      body = part.slice(0, slash);
      step = Number(part.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) return { error: `步长非法：${part}` };
    }
    let lo = min;
    let hi = max;
    if (body !== '*') {
      const dash = body.indexOf('-');
      if (dash >= 0) {
        lo = Number(body.slice(0, dash));
        hi = Number(body.slice(dash + 1));
      } else {
        lo = Number(body);
        hi = slash >= 0 ? max : lo; // a/n → 从 a 到 max 步进 n
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return { error: `范围非法：${part}` };
    } else if (slash >= 0 && body === '*') {
      lo = min;
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface CronParseResult {
  ok: boolean;
  /** ok=false 时的失败原因 */
  error?: string;
  /** ok=true 时的解析结果 */
  fields?: CronFields;
}

export function parseCron(expr: string): CronParseResult {
  const parts = (expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return { ok: false, error: `字段数应为 5（分 时 日 月 周），实际 ${parts.length}` };
  const sets: Array<Set<number> | { error: string }> = [];
  for (let i = 0; i < 5; i++) sets.push(parseField(parts[i], RANGES[i][0], RANGES[i][1]));
  for (let i = 0; i < 5; i++) if ('error' in sets[i]) return { ok: false, error: `第 ${i + 1} 字段非法：${(sets[i] as { error: string }).error}` };
  const [minute, hour, domF, month, dowF] = sets as Array<Set<number>>;
  // dow 7 → 0（周日）
  if (dowF.has(7)) { dowF.delete(7); dowF.add(0); }
  return {
    ok: true,
    fields: {
      minute,
      hour,
      dom: parts[2] === '*' ? '*' : domF,
      month,
      dow: parts[4] === '*' ? '*' : dowF,
    },
  };
}

/** 表达式是否匹配给定时刻（解析失败返回 false） */
export function cronMatches(expr: string, d: Date): boolean {
  const p = parseCron(expr);
  if (!p.ok || !p.fields) return false;
  const f = p.fields;
  if (!f.month.has(d.getMonth() + 1)) return false;
  if (!f.hour.has(d.getHours()) || !f.minute.has(d.getMinutes())) return false;
  const domOk = f.dom !== '*' && f.dom.has(d.getDate());
  const dowOk = f.dow !== '*' && f.dow.has(d.getDay());
  if (f.dom === '*' && f.dow === '*') return true;
  if (f.dom === '*') return dowOk;
  if (f.dow === '*') return domOk;
  return domOk || dowOk; // 日、周同时受限：取或（Vixie cron）
}

/** 同一分钟判定（触发去重用） */
export function sameMinute(a: Date, b: Date): boolean {
  return Math.floor(a.getTime() / 60_000) === Math.floor(b.getTime() / 60_000);
}
