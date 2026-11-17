import { BadRequestException } from '@nestjs/common';

/**
 * 查询参数里的整数解析（审计 F-04）：
 * 旧实现直接 Number(raw) 后拼进 SQL —— `?limit=abc` 得到 NaN → SQLite 报错 → 500；
 * `?offset=99999999999999999999` 溢出同样 500。这里统一做范围校验并给出可读 400。
 */
export function parseBoundedInt(
  raw: string | undefined,
  opts: { fallback: number; min: number; max: number; name: string },
): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return opts.fallback;
  const text = String(raw).trim();
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < opts.min || n > opts.max) {
    throw new BadRequestException(`${opts.name} 必须是 ${opts.min}..${opts.max} 之间的整数（收到：${text.slice(0, 32)}）`);
  }
  return n;
}
