import fs from 'node:fs';
import path from 'node:path';

/**
 * 启动命令合理性守卫（真实缺陷修复：AIHOT-main 被"修复"成 `python -m http.server 8600`）。
 *
 * 背景：Agent 修复循环在拿不到真实入口时，会给出"能起个服务"的兜底命令——
 * 对一个名为 postgres 的数据库服务给出 python 静态服务器，结果是浏览器打开就是目录列表，
 * 用户以为前端坏了。这里在**应用修复之前**做确定性否决，宁可不修，也不写坏配置。
 */

export interface FixGuardInput {
  serviceName: string;
  serviceType: string;
  projectRoot: string;
  /** 修复前的命令（用于判断"没变化"） */
  previousCommand: string | null;
  /** Agent 提议的新命令 */
  proposedCommand: string;
  /** 服务 workdir（默认 projectRoot） */
  workdir?: string;
}

export interface FixGuardVerdict {
  ok: boolean;
  reason?: string;
  /** 建议的替代方向（写进修复步骤，方便用户判断） */
  hint?: string;
}

/** 数据库/缓存/消息队列：只接受真正的服务端程序 */
const INFRA_ALLOW: Array<{ kind: string; re: RegExp; label: string }> = [
  { kind: 'database', re: /\bdocker(\s+compose)?\b|\bpodman\b|\bpg_ctl\b|\bpostgres\b|\bmysqld?\b|\bmariadbd?\b|\bmongod\b/i, label: '数据库' },
  { kind: 'cache', re: /\bdocker(\s+compose)?\b|\bpodman\b|\bredis-server\b|\bvalkey-server\b|\bmemcached\b/i, label: '缓存' },
  { kind: 'mq', re: /\bdocker(\s+compose)?\b|\bpodman\b|\brabbitmq-server\b|\bkafka-server-start\b|\bnats-server\b/i, label: '消息队列' },
];

/** 明显"只为占端口"的静态服务器 */
const STATIC_SERVE_RE = /\bpython(3)?(\.exe)?\s+-m\s+http\.server\b|\bnpx?\s+serve\b|\bhttp-server\b|\bphp\s+-S\b/i;

/** 项目里存在真实应用入口的迹象（有它就不该退化成静态服务器） */
function hasRealAppEntry(root: string): { yes: boolean; evidence: string } {
  // 1) 根或一层子目录里有带 dev/start 脚本的 package.json
  const candidates = [root, ...safeDirs(root).map((d) => path.join(root, d))];
  for (const dir of candidates) {
    const pkgFile = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgFile)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8')) as {
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        workspaces?: unknown;
      };
      const s = pkg.scripts ?? {};
      if (s.dev || s.start || s.serve) {
        return { yes: true, evidence: `${path.relative(root, dir) || '.'}/package.json 有 ${s.dev ? 'dev' : s.start ? 'start' : 'serve'} 脚本` };
      }
      if (pkg.workspaces) {
        return { yes: true, evidence: `${path.relative(root, dir) || '.'}/package.json 声明了 workspaces（monorepo）` };
      }
    } catch { /* 坏 package.json 忽略 */ }
  }
  // 2) Python 入口
  for (const f of ['app.py', 'main.py', 'manage.py', 'streamlit_app.py']) {
    if (fs.existsSync(path.join(root, f))) return { yes: true, evidence: `存在 ${f}` };
  }
  // 3) 常见前后端框架入口
  for (const f of ['manage.py', 'artisan', 'go.mod', 'pom.xml', 'Cargo.toml', 'next.config.js', 'vite.config.ts']) {
    if (fs.existsSync(path.join(root, f))) return { yes: true, evidence: `存在 ${f}` };
  }
  return { yes: false, evidence: '' };
}

function safeDirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !/^(node_modules|\.git|dist|build|target|\.venv|venv|__pycache__)$/i.test(d.name))
      .slice(0, 40)
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** 命令里引用的本地入口文件是否存在（node X / python X / tsx X ...） */
function entryFileMissing(command: string, cwd: string): string | null {
  const m = /^(?:node|tsx|ts-node|bun|deno(?:\s+run)?|python3?|py)(?:\.exe)?\s+(?:--?[\w-]+\s+)*["']?([^\s"']+\.(?:js|mjs|cjs|ts|py))["']?/i.exec(command.trim());
  if (!m) return null;
  const rel = m[1];
  if (/^[a-z]+:\/\//i.test(rel)) return null;
  const full = path.resolve(cwd, rel);
  return fs.existsSync(full) ? null : rel;
}

/**
 * 判定一条"修复后启动命令"是否可以落库。
 */
export function judgeFix(input: FixGuardInput): FixGuardVerdict {
  const proposed = (input.proposedCommand ?? '').trim();
  const previous = (input.previousCommand ?? '').trim();
  const cwd = input.workdir && fs.existsSync(input.workdir) ? input.workdir : input.projectRoot;

  if (!proposed) return { ok: false, reason: '提出的启动命令为空' };
  if (proposed === previous) return { ok: false, reason: '启动命令与修复前完全相同（重复启动只会再次失败）' };

  // 1) 类型不符：数据库/缓存/MQ 被塞了应用服务器命令
  const kind = (input.serviceType ?? '').toLowerCase();
  const rule = INFRA_ALLOW.find((r) => r.kind === kind);
  if (rule && !rule.re.test(proposed)) {
    return {
      ok: false,
      reason: `服务类型是「${rule.label}」，但提议的命令不是 ${rule.label} 服务端程序：${proposed}`,
      hint: `基础设施服务应使用 \`docker compose up -d <服务名>\` 或 ${rule.label} 原生服务端命令；应用启动命令请配到对应的 app/frontend 服务上`,
    };
  }

  // 2) 静态服务器冒充真实应用
  if (STATIC_SERVE_RE.test(proposed)) {
    const real = hasRealAppEntry(input.projectRoot);
    if (real.yes) {
      return {
        ok: false,
        reason: `提议用静态文件服务器启动，但项目里有真实应用入口（${real.evidence}）；这样的命令只会暴露目录列表，不是项目的前端页面`,
        hint: '请在对应应用目录里用真实的 dev/start 脚本（如 `npm run dev -w <包名>`），或在项目里确认端口与启动脚本',
      };
    }
    if (kind === 'frontend') {
      return { ok: false, reason: '项目没有可用的前端构建入口，不能用 python -m http.server 充当前端服务' };
    }
  }

  // 3) 引用的入口文件不存在
  const missing = entryFileMissing(proposed, cwd);
  if (missing) {
    return { ok: false, reason: `命令引用的入口文件不存在：${missing}（工作目录 ${cwd}）`, hint: '确认入口路径与工作目录，或改为包管理器脚本' };
  }

  return { ok: true };
}
