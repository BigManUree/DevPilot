import { Injectable, NotFoundException } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.module';
import { tcpProbe, portOccupied } from '../net-probe';

/**
 * 项目配置体检（导入时必跑 + 详情页可重跑）。
 *
 * 目标：导入完就能回答「这个项目现在能不能跑起来」，而不是等用户点启动踩坑：
 * - .env 是否有、是否漏了 .env.example 里的必填键、是否有明显的占位符没改
 * - 大模型 / 第三方 API Key **真实调用一次**验证是否可用（不是只看长度）
 * - DATABASE_URL 能否连上（TCP + 端口）
 * - 服务端口是否被占用、Node 版本是否满足 engines
 * - 启动命令是否为「静态文件服务器冒充应用」这类已知坏配置
 *
 * 所有结果只保存脱敏摘要（不落明文密钥）。
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface ConfigCheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  evidence?: string;
  /** 修复建议 */
  hint?: string;
}

export interface ConfigCheckResult {
  projectId: string;
  rootPath: string;
  overall: 'ok' | 'warn' | 'fail';
  probed: boolean;
  checkedAt: string;
  items: ConfigCheckItem[];
}

const PLACEHOLDER_RE = /^(changeme|change-me|your[-_ ]?|todo|tbd|xxx+|placeholder|<.*>|sk-x+$|test[-_]?key|example|dummy|password$|admin$)/i;

/** 已知提供商的 Key 校验端点（GET，OpenAI 兼容或官方模型列表） */
const KNOWN_PROVIDERS: Array<{
  env: string;
  label: string;
  url: (key: string) => string;
  headers?: (key: string) => Record<string, string>;
  expect?: (status: number, body: string) => { ok: boolean; note: string };
}> = [
  {
    env: 'OPENAI_API_KEY',
    label: 'OpenAI',
    url: () => 'https://api.openai.com/v1/models',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    env: 'DEEPSEEK_API_KEY',
    label: 'DeepSeek',
    url: () => 'https://api.deepseek.com/models',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    env: 'MOONSHOT_API_KEY',
    label: 'Moonshot',
    url: () => 'https://api.moonshot.cn/v1/models',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    env: 'DASHSCOPE_API_KEY',
    label: '通义千问',
    url: () => 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
    headers: (k) => ({ Authorization: `Bearer ${k}` }),
  },
  {
    env: 'ANTHROPIC_API_KEY',
    label: 'Anthropic',
    url: () => 'https://api.anthropic.com/v1/models',
    headers: (k) => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
  },
  {
    env: 'GEMINI_API_KEY',
    label: 'Gemini',
    url: (k) => `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`,
  },
  {
    env: 'GOOGLE_API_KEY',
    label: 'Google AI',
    url: (k) => `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`,
  },
];

@Injectable()
export class ConfigCheckService {
  constructor(private readonly ds: DatabaseService) {}

  async check(projectId: string, opts: { probe?: boolean } = {}): Promise<ConfigCheckResult> {
    const project = this.ds.db.prepare('SELECT id, name, root_path FROM projects WHERE id = ?').get(projectId) as
      | { id: string; name: string; root_path: string }
      | undefined;
    if (!project) throw new NotFoundException(`项目不存在：${projectId}`);

    const root = project.root_path;
    const probe = opts.probe !== false;
    const items: ConfigCheckItem[] = [];

    const env = this.readEnv(path.join(root, '.env'));
    const example = this.readEnv(path.join(root, '.env.example'));

    // ---- 1. .env 文件本身 ----
    if (!env.has('__exists')) {
      if (example.size > 1) {
        items.push({
          id: 'env-file',
          label: '.env 配置',
          status: 'fail',
          detail: '项目提供了 .env.example，但没有 .env；按示例复制并填写后才能启动',
          evidence: '.env.example → .env',
          hint: `复制 .env.example 为 .env 并填写（cp .env.example .env）`,
        });
      } else {
        items.push({ id: 'env-file', label: '.env 配置', status: 'skip', detail: '项目不需要 .env（未发现 .env.example）' });
      }
    } else {
      items.push({ id: 'env-file', label: '.env 配置', status: 'ok', detail: `已存在 .env，${env.size - 1} 个键` });
    }

    // ---- 2. 与 .env.example 对比：漏填的键 ----
    if (example.size > 1 && env.size > 1) {
      const missing = [...example.keys()].filter((k) => k !== '__exists' && !env.has(k));
      items.push({
        id: 'env-missing',
        label: '必填配置项',
        status: missing.length ? 'warn' : 'ok',
        detail: missing.length ? `${missing.length} 个 .env.example 里的键未在 .env 中设置` : '与 .env.example 的键一致',
        evidence: missing.slice(0, 15).join(', '),
        hint: missing.length ? '确认这些键是否必需；缺失常导致启动后 500/鉴权失败' : undefined,
      });
    }

    // ---- 3. 占位符未替换 ----
    const placeholders: string[] = [];
    for (const [k, v] of env) {
      if (k === '__exists') continue;
      if (!v) { placeholders.push(`${k}（空值）`); continue; }
      if (PLACEHOLDER_RE.test(v.trim()) || /^<.+>$/.test(v.trim())) placeholders.push(k);
    }
    if (env.size > 1) {
      items.push({
        id: 'env-placeholder',
        label: '占位值检查',
        status: placeholders.length ? 'fail' : 'ok',
        detail: placeholders.length ? `${placeholders.length} 个配置仍是占位/空值` : '未发现占位符',
        evidence: placeholders.slice(0, 12).join(', '),
        hint: placeholders.length ? '这些键在启动后会被当成真实值使用（例如密钥无效、密码错误）' : undefined,
      });
    }

    // ---- 4. 关键密钥强度 ----
    const weak: string[] = [];
    for (const [k, v] of env) {
      if (/secret|password|token/i.test(k) && typeof v === 'string' && v.length > 0 && v.length < 16) weak.push(`${k}（长度 ${v.length}）`);
    }
    if (weak.length) {
      items.push({
        id: 'env-weak',
        label: '密钥强度',
        status: 'warn',
        detail: `${weak.length} 个密钥/口令偏短（<16）`,
        evidence: weak.join(', '),
        hint: '生产环境建议使用 ≥32 位随机值',
      });
    }

    // ---- 5. 大模型 Key 真实可用性 ----
    const llmBase = env.get('LLM_BASE_URL') ?? example.get('LLM_BASE_URL');
    const llmKey = env.get('LLM_API_KEY') ?? '';
    if (llmKey) {
      if (!probe) {
        items.push({ id: 'llm', label: `大模型 Key（${env.get('LLM_MODEL') ?? '未知模型'}）`, status: 'skip', detail: '未开启联网校验（probe=0）' });
      } else {
        const base = (llmBase ?? '').replace(/\/+$/, '');
        const url = base ? `${base}/models` : null;
        if (!url) {
          items.push({ id: 'llm', label: '大模型 Key', status: 'warn', detail: '设置了 LLM_API_KEY 但没有 LLM_BASE_URL，无法验证', hint: '补上 LLM_BASE_URL（如 https://api.deepseek.com/v1）' });
        } else {
          const r = await this.probeHttp(url, { Authorization: `Bearer ${llmKey}` });
          const item = this.judgeApiResponse(r, 'LLM_API_KEY', url);
          items.push({ id: 'llm', label: `大模型 Key（${env.get('LLM_MODEL') ?? '未知模型'}）`, ...item });
        }
      }
    }

    // ---- 6. 已知第三方 Key ----
    if (probe) {
      for (const p of KNOWN_PROVIDERS) {
        const key = env.get(p.env);
        if (!key) continue;
        const headers = p.headers ? p.headers(key) : {};
        const r = await this.probeHttp(p.url(key), headers);
        const item = this.judgeApiResponse(r, p.env, p.label);
        items.push({ id: `key:${p.env}`, label: `${p.label} Key`, ...item });
      }
    }

    // ---- 7. 数据库连接 ----
    const dbUrl = env.get('DATABASE_URL');
    if (dbUrl) {
      items.push(await this.checkTcp('db', '数据库连接', dbUrl));
      if (dbUrl.includes('@db:') || dbUrl.includes('//db')) {
        items.push({
          id: 'db-host',
          label: '数据库主机名',
          status: 'warn',
          detail: 'DATABASE_URL 里的主机是 docker 内部名（db），本机直连需要改成 localhost:5432',
          evidence: this.maskUrl(dbUrl),
          hint: '本机开发：把 db 换成 localhost；或在 docker 里跑 app',
        });
      }
    }

    // ---- 8. 端口可用性 ----
    const services = this.ds.db
      .prepare(`SELECT name, port, start_command FROM project_services WHERE project_id = ?`)
      .all(projectId) as Array<{ name: string; port: number | null; start_command: string | null }>;
    const portItems: ConfigCheckItem[] = [];
    for (const s of services) {
      if (!s.port) continue;
      const occupied = await portOccupied(s.port);
      portItems.push({
        id: `port:${s.port}`,
        label: `端口 ${s.port}（${s.name}）`,
        status: occupied ? 'warn' : 'ok',
        detail: occupied ? '端口已被占用，启动会失败或接管已有实例' : '端口空闲',
      });
    }
    if (portItems.length) items.push(...portItems);

    // ---- 9. 启动命令可疑性（静态服务器冒充应用）----
    const suspects = services.filter((s) => s.start_command && /-m\s+http\.server|npx?\s+serve\b|http-server/i.test(s.start_command));
    if (suspects.length) {
      items.push({
        id: 'bad-command',
        label: '启动命令可疑',
        status: 'fail',
        detail: `${suspects.length} 个服务用静态文件服务器启动，打开会是目录列表而不是项目页面`,
        evidence: suspects.map((s) => `${s.name}: ${s.start_command}`).join(' | ').slice(0, 200),
        hint: '重新识别项目（项目详情 → 重新分析），把前端/后端换成真实的 dev/start 命令',
      });
    }

    // ---- 9.5 数据库初始化/迁移脚本 ----
    const rootPkgFile = path.join(root, 'package.json');
    if (fs.existsSync(rootPkgFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(rootPkgFile, 'utf-8')) as { scripts?: Record<string, string> };
        const scripts = pkg.scripts ?? {};
        const migrateKey = Object.keys(scripts).find((k) => /^(db:)?migrate$|^migrate(:|$)|^prisma:migrate$|^db:migrate:deploy$/.test(k));
        if (migrateKey) {
          items.push({
            id: 'migrate',
            label: '数据库初始化',
            status: 'warn',
            detail: `项目有迁移脚本「${migrateKey}」，首次启动前需要先执行，否则接口会报表不存在/字段不存在`,
            evidence: `npm run ${migrateKey}`,
            hint: `先在项目根执行 npm run ${migrateKey}（有 Docker 时 compose 的 setup 服务会代做，本机模式需手动执行一次）`,
          });
        }
      } catch { /* 坏 package.json 忽略 */ }
    }

    // ---- 10. Node 版本 ----
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { engines?: { node?: string } };
        const want = pkg.engines?.node;
        if (want) {
          const cur = process.versions.node;
          const ok = this.satisfiesNode(cur, want);
          items.push({
            id: 'node-engine',
            label: 'Node 版本要求',
            status: ok ? 'ok' : 'warn',
            detail: `项目要求 ${want}，本机 ${cur}`,
            hint: ok ? undefined : `用 nvm/volta 切到 ${want}，或确认项目在该版本下可运行`,
          });
        }
      } catch { /* 坏 package.json 忽略 */ }
    }

    // ---- 11. docker 可用性（用到 compose 基础设施时）----
    if (services.some((s) => /docker compose/i.test(s.start_command ?? ''))) {
      const hasDocker = await this.commandExists('docker');
      items.push({
        id: 'docker',
        label: 'Docker 可用性',
        status: hasDocker ? 'ok' : 'warn',
        detail: hasDocker ? '检测到 docker 命令' : '项目依赖 docker compose，但本机未找到 docker 命令',
        hint: hasDocker ? undefined : '安装 Docker Desktop，或改用本机已安装的数据库',
      });
    }

    const overall: ConfigCheckResult['overall'] = items.some((i) => i.status === 'fail')
      ? 'fail'
      : items.some((i) => i.status === 'warn')
        ? 'warn'
        : 'ok';

    const result: ConfigCheckResult = {
      projectId,
      rootPath: root,
      overall,
      probed: probe,
      checkedAt: new Date().toISOString(),
      items,
    };
    this.persist(projectId, result);
    return result;
  }

  /** 读取 .env（含 __exists 标记）；值是字符串，不做类型推断 */
  private readEnv(file: string): Map<string, string> {
    const map = new Map<string, string>();
    if (!fs.existsSync(file)) return map;
    map.set('__exists', '1');
    for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      map.set(m[1], v);
    }
    return map;
  }

  private mask(v: string): string {
    if (!v) return '(空)';
    if (v.length <= 8) return `***（长度 ${v.length}）`;
    return `${v.slice(0, 4)}***${v.slice(-2)}（长度 ${v.length}）`;
  }

  private maskUrl(u: string): string {
    return u.replace(/(:\/\/[^:/@]+:)([^@]+)(@)/, '$1***$3');
  }

  private async probeHttp(url: string, headers: Record<string, string>): Promise<{ status: number; body: string; error?: string }> {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
      const body = (await res.text()).slice(0, 4000);
      return { status: res.status, body };
    } catch (e) {
      return { status: 0, body: '', error: String((e as Error)?.message ?? e).slice(0, 160) };
    }
  }

  /** 把一次 HTTP 探测结果翻译成体检项（401/403 = Key 无效；429 = Key 有效但限流） */
  private judgeApiResponse(
    r: { status: number; body: string; error?: string },
    envKey: string,
    label: string,
  ): { status: CheckStatus; detail: string; evidence?: string; hint?: string } {
    if (r.error) {
      return { status: 'warn', detail: `无法连接 ${label}（${r.error}）`, hint: '检查网络/代理，或该服务在该网络下不可达' };
    }
    if (r.status >= 200 && r.status < 300) {
      // 简单校验返回体里是否像模型列表
      const looksOk = /"data"|"models"|"id"/.test(r.body) || r.body.length > 2;
      return { status: looksOk ? 'ok' : 'warn', detail: `Key 可用（HTTP ${r.status}）`, evidence: r.body.slice(0, 120) };
    }
    if (r.status === 401 || r.status === 403) {
      return { status: 'fail', detail: `${envKey} 校验失败：HTTP ${r.status}（Key 无效或无权限）`, evidence: r.body.slice(0, 160), hint: '到服务商控制台确认 Key 是否有效/是否过期' };
    }
    if (r.status === 429) {
      return { status: 'warn', detail: 'Key 有效但已限流（HTTP 429）' };
    }
    if (r.status === 404) {
      return { status: 'warn', detail: `该服务不提供模型列表接口（HTTP 404），无法据此判断 Key；建议用一次最小调用验证`, evidence: r.body.slice(0, 120) };
    }
    if (r.status === 400) {
      return { status: 'warn', detail: `服务返回 400（可能是参数/额度问题，不一定是 Key 无效）`, evidence: r.body.slice(0, 160) };
    }
    return { status: 'warn', detail: `校验返回 HTTP ${r.status}`, evidence: r.body.slice(0, 160) };
  }

  private async checkTcp(id: string, label: string, url: string): Promise<ConfigCheckItem> {
    let host = '';
    let port = 0;
    try {
      const u = new URL(url);
      host = u.hostname;
      port = Number(u.port || (u.protocol.startsWith('postgres') || u.protocol.startsWith('mysql') ? 5432 : 0));
      if (!port) port = u.protocol.startsWith('redis') ? 6379 : u.protocol.startsWith('mongodb') ? 27017 : 5432;
    } catch {
      return { id, label, status: 'fail', detail: `DATABASE_URL 无法解析：${this.maskUrl(url)}` };
    }
    const ok = await tcpProbe(host, port, 2500);
    return {
      id,
      label,
      status: ok ? 'ok' : 'fail',
      detail: ok ? `可连接 ${host}:${port}` : `连不上 ${host}:${port}`,
      evidence: this.maskUrl(url),
      hint: ok ? undefined : '确认数据库已启动（docker compose up -d db / 本机服务），并检查端口映射',
    };
  }

  /** docker 是否可执行（不阻塞：用 spawn + 1.5s 超时） */
  private commandExists(cmd: string): Promise<boolean> {
    return new Promise((resolve) => {
      const { spawn } = require('node:child_process') as typeof import('node:child_process');
      const child = spawn(cmd, ['--version'], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(false); }, 1500);
      child.once('error', () => { clearTimeout(timer); resolve(false); });
      child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
    });
  }

  /** 简化 semver 范围判断：>=24.22.1 / ^20 / ~18.17 / 20.x */
  private satisfiesNode(current: string, range: string): boolean {
    const cur = current.split('.').map(Number);
    const cmp = (a: number[], b: number[]) => {
      for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
      return 0;
    };
    const parts = range.trim().split(/\s+/).filter(Boolean);
    for (const part of parts) {
      const m = /^(>=|>|<=|<|\^|~|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(part);
      if (!m) continue;
      const op = m[1] ?? '=';
      const want = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
      if (op === '>=' && cmp(cur, want) < 0) return false;
      if (op === '>' && cmp(cur, want) <= 0) return false;
      if (op === '<=' && cmp(cur, want) > 0) return false;
      if (op === '<' && cmp(cur, want) >= 0) return false;
      if ((op === '^' || op === '~' || op === '=') && cmp([cur[0], 0, 0], [want[0], 0, 0]) !== 0) return false;
    }
    return true;
  }

  private persist(projectId: string, result: ConfigCheckResult): void {
    try {
      this.ds.db.prepare(
        `INSERT INTO project_configs (id, project_id, config_type, file_path, version, content_ref, sensitive_fields_json, source, created_at)
         VALUES (?, ?, 'validation', ?, 1, ?, NULL, 'auto-check', ?)`,
      ).run(randomUUID(), projectId, '.env', JSON.stringify(result), new Date().toISOString());
    } catch { /* 落库失败不影响返回 */ }
  }
}
