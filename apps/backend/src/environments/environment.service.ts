import { Injectable } from '@nestjs/common';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../database/database.module';
import { probeAll } from './tool-probes';
import { tcpProbe } from '../net-probe';

/**
 * 环境与依赖检测（PRD 3.11 + WF-04）：
 * - 全局工具探测（PATH + 版本命令）
 * - 项目需求比对：识别结果 → 需要哪些环境 → 缺失/版本不匹配报告
 * - 端口占用检查
 * 缺工具只给检测结论与官方安装入口，不自动安装。
 */
@Injectable()
export class EnvironmentService {
  constructor(private readonly ds: DatabaseService) {}

  /** 探针缓存（审计 P-02）：15 个探针每次 1.1s，10 并发打满 14s。
   *  加 60s TTL + single-flight：并发请求共享同一次探测，不再重复起进程。 */
  private toolsCache: { at: number; tools: Awaited<ReturnType<typeof probeAll>> } | null = null;
  private toolsInFlight: Promise<Awaited<ReturnType<typeof probeAll>>> | null = null;
  private static readonly TOOLS_TTL_MS = 60_000;

  /** 强制失效（安装/切换工具后由系统设置调用） */
  invalidateToolsCache(): void {
    this.toolsCache = null;
  }

  private async probeCached(force = false): Promise<Awaited<ReturnType<typeof probeAll>>> {
    if (!force && this.toolsCache && Date.now() - this.toolsCache.at < EnvironmentService.TOOLS_TTL_MS) {
      return this.toolsCache.tools;
    }
    if (!this.toolsInFlight) {
      this.toolsInFlight = probeAll()
        .then((tools) => {
          this.toolsCache = { at: Date.now(), tools };
          return tools;
        })
        .finally(() => { this.toolsInFlight = null; });
    }
    return this.toolsInFlight;
  }

  async detectAll(force = false) {
    const tools = await this.probeCached(force);
    // 同步 environments 表
    const upsert = this.ds.db.prepare(
      `INSERT INTO environments (id, name, type, executable_path, version, detect_status, scope, source)
       VALUES (?, ?, 'tool', ?, ?, ?, 'global', 'auto-detect')
       ON CONFLICT(id) DO UPDATE SET version=excluded.version, detect_status=excluded.detect_status`,
    );
    for (const t of tools) upsert.run(t.id, t.name, t.id, t.version ?? null, t.status);
    return tools;
  }

  /** 项目环境需求比对（基于识别事实） */
  async checkProject(projectId: string) {
    const project = this.ds.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | { id: string; language: string | null; framework: string | null; root_path: string }
      | undefined;
    if (!project) throw new Error('project not found');

    const tools = await this.probeCached();
    const byId = new Map(tools.map((t) => [t.id, t]));

    const requirements: Array<{ toolId: string; reason: string }> = [];
    const lang = project.language ?? '';
    if (/javascript|typescript/.test(lang)) {
      requirements.push({ toolId: 'node', reason: 'JavaScript/TypeScript 运行时' }, { toolId: 'npm', reason: '包管理器' });
      if (fs.existsSync(path.join(project.root_path, 'pnpm-lock.yaml'))) requirements.push({ toolId: 'pnpm', reason: '存在 pnpm-lock.yaml' });
      if (fs.existsSync(path.join(project.root_path, 'yarn.lock'))) requirements.push({ toolId: 'yarn', reason: '存在 yarn.lock' });
    }
    if (/java/.test(lang)) {
      requirements.push({ toolId: 'java', reason: 'Java 运行时' }, { toolId: 'javac', reason: '需要 JDK 编译' });
      if (fs.existsSync(path.join(project.root_path, 'pom.xml'))) requirements.push({ toolId: 'maven', reason: '存在 pom.xml' });
      if (fs.existsSync(path.join(project.root_path, 'build.gradle')) || fs.existsSync(path.join(project.root_path, 'build.gradle.kts')))
        requirements.push({ toolId: 'gradle', reason: '存在 Gradle 构建文件' });
    }
    if (/python/.test(lang)) requirements.push({ toolId: 'python', reason: 'Python 运行时' });
    if (/go/.test(lang)) requirements.push({ toolId: 'go', reason: 'Go 工具链' });
    if (/rust/.test(lang)) requirements.push({ toolId: 'rust', reason: 'Rust 工具链' });
    if (/php/.test(lang)) requirements.push({ toolId: 'php', reason: 'PHP 运行时' }, { toolId: 'composer', reason: 'PHP 依赖管理' });
    // docker-compose 项目
    if (fs.existsSync(path.join(project.root_path, 'docker-compose.yml'))) requirements.push({ toolId: 'docker', reason: '存在 docker-compose.yml' });

    // node_modules 存在性检查
    const depsInstalled = fs.existsSync(path.join(project.root_path, 'node_modules'));

    const report = requirements.map((r) => {
      const t = byId.get(r.toolId);
      return {
        toolId: r.toolId,
        reason: r.reason,
        status: t?.status ?? 'missing',
        version: t?.version,
        installHint: t?.installHint,
      };
    });

    // 端口占用检查
    const services = this.ds.db.prepare('SELECT id, name, port FROM project_services WHERE project_id = ?').all(projectId) as Array<{ id: string; name: string; port: number | null }>;
    const portChecks = [];
    for (const s of services) {
      if (!s.port) continue;
      portChecks.push({ service: s.name, port: s.port, occupied: await this.portOccupied(s.port) });
    }

    // 需求 7.3：missing（未安装，含安装入口）与 error（探测异常，需人工排查）分开报告
    const missing = report.filter((r) => r.status === 'missing');
    const errors = report.filter((r) => r.status === 'error');
    const problems = [...missing, ...errors];
    return {
      projectId,
      requirements: report,
      missing,
      errors,
      problems,
      depsInstalled,
      portChecks,
      overall: problems.length === 0 && !portChecks.some((p) => p.occupied) ? 'ready' : 'action-needed',
    };
  }

  portOccupied(port: number, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port, timeout: timeoutMs });
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
      sock.once('error', () => resolve(false));
    });
  }

  // ============ 智能化升级（多版本 / 匹配 / 外部服务 / 环境变量） ============

  /** 多版本扫描：node/java/python/maven/gradle/go/rust/php/docker */
  async scanAllVersions() {
    const { scanAllVersions } = await import('./version-scan');
    return scanAllVersions();
  }

  /** 项目要求 vs 本机多版本匹配（约束来自组件树档案 runtime.languageVersion） */
  async matchProject(projectId: string) {
    const { matchRequirement } = await import('./version-scan');
    const profile = this.getProfile(projectId);
    if (!profile?.components?.length) return { projectId, matches: [], note: '项目尚无组件树档案，请先重新分析' };

    // 按 componentId 去重的语言版本约束
    const reqs: Array<{ componentId: string; componentName: string; toolId: string; requirement: string | null; source: string | null }> = [];
    for (const comp of profile.components) {
      const rt = comp.runtime;
      if (!rt?.languageVersion) continue;
      const map: Record<string, string> = { java: 'java', javascript: 'node', typescript: 'node', python: 'python', go: 'go', rust: 'rust', php: 'php' };
      const toolId = map[comp.language ?? ''];
      if (!toolId) continue;
      reqs.push({ componentId: comp.id, componentName: comp.name, toolId, requirement: rt.languageVersion, source: rt.languageVersionSource });
    }
    // gradle 约束
    for (const comp of profile.components) {
      if (comp.packageManager === 'gradle' && comp.runtime?.packageManagerVersion) {
        reqs.push({ componentId: comp.id, componentName: comp.name, toolId: 'gradle', requirement: comp.runtime.packageManagerVersion, source: comp.runtime.languageVersionSource });
      }
    }

    const matches = [];
    for (const r of reqs) {
      const m = await matchRequirement(r.toolId, r.requirement, r.source);
      matches.push({ component: { id: r.componentId, name: r.componentName }, ...m });
    }
    const overall = matches.some((m) => m.status === 'missing') ? 'missing' : matches.some((m) => m.status === 'mismatch') ? 'mismatch' : matches.length ? 'ready' : 'no-constraints';
    return { projectId, overall, matches };
  }

  /** 外部服务探活：组件档案中的 externalServices + compose 服务 */
  async checkExternalServices(projectId: string) {
    const { execFile } = await import('node:child_process');
    const profile = this.getProfile(projectId);
    const seen = new Map<string, { type: string; port: number | null; source: string }>();
    for (const comp of profile?.components ?? []) {
      for (const svc of comp.runtime?.externalServices ?? []) {
        if (svc.type === 'unknown') continue;
        const key = `${svc.type}:${svc.port ?? ''}`;
        if (!seen.has(key)) seen.set(key, { type: svc.type, port: svc.port, source: `${comp.name}: ${svc.source}` });
      }
    }

    // 补充：用户手工登记的 database/cache/mq 类服务也纳入探活
    // （回归：之前只看档案 externalServices，手动加的 MySQL/Redis 服务检查不到）
    const manual = this.ds.db
      .prepare(`SELECT name, service_type, port FROM project_services WHERE project_id = ? AND service_type IN ('database','cache','mq') AND port IS NOT NULL`)
      .all(projectId) as Array<{ name: string; service_type: string; port: number }>;
    for (const svc of manual) {
      const key = `${svc.service_type}:${svc.port}`;
      if (!seen.has(key)) seen.set(key, { type: svc.service_type, port: svc.port, source: `${svc.name}: 手动登记服务` });
    }

    const results = [];
    for (const svc of seen.values()) {
      if (!svc.port) continue;
      const open = await this.portOccupied(svc.port, 1500);
      // 占用时进一步识别监听进程（Windows netstat）
      let processName: string | null = null;
      if (open && process.platform === 'win32') {
        processName = await new Promise<string | null>((resolve) => {
          execFile('powershell.exe', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${svc.port} -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess | ForEach-Object { (Get-Process -Id $_).ProcessName }`], { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.trim() || null));
        });
      }
      results.push({
        type: svc.type,
        port: svc.port,
        listening: open,
        processName,
        status: open ? 'running' : 'not-running',
        source: svc.source,
        advice: open ? `${svc.type} 在端口 ${svc.port} 可达${processName ? `（进程 ${processName}）` : ''}。` : `${svc.type} 未在端口 ${svc.port} 监听。可安装/启动该服务，或使用 Docker 启动（需用户确认）。`,
      });
    }
    return { projectId, services: results, overall: results.every((r) => r.listening) ? 'ready' : results.length ? 'action-needed' : 'no-external-services' };
  }

  /** 环境变量检查：档案 envVars vs 项目根 .env 实际内容 */
  async checkEnvVars(projectId: string) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const profile = this.getProfile(projectId);
    const project = this.ds.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string } | undefined;
    if (!project) throw new Error('project not found');
    const profile2 = profile as unknown as { components: Array<{ name: string; path: string; runtime: { envVars: Array<{ key: string; source: string; required: boolean; hasDefault: boolean; sensitive: boolean; defaultValue?: string }> } | null }> | undefined };
    const required: Array<{ key: string; source: string; component: string; hasDefault: boolean; sensitive: boolean }> = [];
    for (const comp of profile2?.components ?? []) {
      for (const v of comp.runtime?.envVars ?? []) {
        required.push({ key: v.key, source: v.source, component: comp.name, hasDefault: v.hasDefault, sensitive: v.sensitive });
      }
    }
    if (!required.length) return { projectId, vars: [], missing: [], overall: 'no-requirements' };

    // 已有值：项目根各组件目录下的 .env
    const values = new Map<string, string>();
    const envPath = path.join(project.root_path, '.env');
    if (fs.existsSync(envPath)) {
      for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
        if (m) values.set(m[1], m[2]);
      }
    }
    const results = required.map((r) => {
      const inDotEnv = values.has(r.key);
      const inSystem = !!process.env[r.key];
      return {
        key: r.key,
        component: r.component,
        source: r.source,
        sensitive: r.sensitive,
        provided: inDotEnv || inSystem,
        where: inDotEnv ? '.env' : inSystem ? 'system-env' : null,
        hasDefault: r.hasDefault,
        // 不回显敏感值
        status: inDotEnv || inSystem ? 'provided' : r.hasDefault ? 'default-available' : 'missing',
      };
    });
    const missing = results.filter((r) => r.status === 'missing');
    return {
      projectId,
      vars: results,
      missing,
      overall: missing.length ? 'missing' : 'ready',
      note: missing.length ? `缺失 ${missing.length} 个必填环境变量（不自动生成密钥，请在配置向导中填写）` : null,
    };
  }

  /** 读取项目组件树档案 */
  private getProfile(projectId: string): { components: Array<{ id: string; name: string; path: string; language: string | null; packageManager: string | null; runtime: { languageVersion: string | null; languageVersionSource: string | null; packageManagerVersion: string | null; envVars: Array<{ key: string; source: string; required: boolean; hasDefault: boolean; sensitive: boolean; defaultValue?: string }>; externalServices: Array<{ type: string; host: string | null; port: number | null; source: string }> } | null }> } | null {
    const row = this.ds.db.prepare('SELECT components_json FROM projects WHERE id = ?').get(projectId) as { components_json: string | null } | undefined;
    if (!row?.components_json) return null;
    try {
      return JSON.parse(row.components_json);
    } catch {
      return null;
    }
  }

  // ============ 配置向导：收集 → 验证 → 写回 .env ============

  /** 参数可用性验证：按 key 语义分级校验。返回 null=通过，否则为给用户的友好原因 */
  private validateEnvValue(key: string, raw: string): string | null {
    const value = String(raw ?? '').trim();
    const k = key.toUpperCase();
    if (!value) return '不能为空';
    if (value.length < 4 && /PASSWORD|SECRET|KEY|TOKEN/.test(k)) return '长度太短（至少 4 位）';
    if (/(_URL$|BASE_URL|SITE_URL|ENDPOINT)/.test(k)) {
      if (!/^https?:\/\/.+/i.test(value) && !/^wss?:\/\/.+/i.test(value)) return '需要以 http(s):// 或 ws(s):// 开头的完整地址';
    }
    if (/^(DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL|MYSQL_URL|MONGO_URL|MONGODB_URL|DB_URL)$/.test(k)) {
      if (!/^(postgres(ql)?|mysql|mongodb(\+srv)?)?:\/\//i.test(value)) {
        return '数据库连接串应以 postgres://、mysql:// 或 mongodb:// 开头（如 postgres://user:密码@127.0.0.1:5432/库名）';
      }
    }
    if (/(_PORT$)/.test(k) && !/^\d{2,5}$/.test(value)) return '端口必须是 2-5 位数字';
    if (/(_ENABLED$|_DISABLED$)/.test(k) && !/^(true|false|1|0|yes|no)$/i.test(value)) return '开关类取值应为 true / false';
    return null;
  }

  /** 异步 TCP 可达探测（数据库连接串校验用） */
  /** 数据库连接串验证：格式 + host:port 真实 TCP 可达 */
  private async validateDbUrl(value: string): Promise<string | null> {
    const m = /@([a-zA-Z0-9._-]+):(\d{2,5})/.exec(value);
    if (m) {
      const ok = await tcpProbe(m[1], Number(m[2]), 2000);
      if (!ok) return `无法连接 ${m[1]}:${m[2]}（2 秒超时）。请确认数据库已启动、地址端口正确`;
    }
    return null;
  }

  /**
   * API Key 真实可用性验证（不是只看长度）：
   * - LLM_API_KEY：用同批/已有的 LLM_BASE_URL 调 /models（OpenAI 兼容）
   * - 已知提供商：调各自的模型列表接口
   * - 未知提供商：无法判定可用性，只做格式提示（放行，避免误伤自定义服务）
   */
  private async validateApiKey(key: string, value: string, ctx: Record<string, string>): Promise<string | null> {
    const k = key.toUpperCase();
    const probe = async (url: string, headers: Record<string, string>, label: string): Promise<string | null> => {
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
        if (res.status === 401 || res.status === 403) return `${label} 拒绝了这个 Key（HTTP ${res.status}）：Key 无效、已过期或无权限`;
        if (res.status === 429) return null; // 限流说明 Key 有效
        if (res.status >= 500) return `${label} 服务暂时不可用（HTTP ${res.status}），本次无法确认 Key`;
        return null;
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 80);
        // 网络不通不当作 Key 无效，但要提示用户
        if (/timeout|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(msg)) return `无法连接 ${label} 校验接口（${msg}），请检查网络后重试`;
        return null;
      }
    };

    if (k === 'LLM_API_KEY') {
      const base = (ctx.LLM_BASE_URL ?? '').replace(/\/+$/, '');
      if (!base) return '设置了 LLM_API_KEY 但缺少 LLM_BASE_URL，无法验证 Key 是否可用';
      return probe(`${base}/models`, { Authorization: `Bearer ${value}` }, '大模型服务');
    }
    if (k === 'OPENAI_API_KEY') return probe('https://api.openai.com/v1/models', { Authorization: `Bearer ${value}` }, 'OpenAI');
    if (k === 'DEEPSEEK_API_KEY') return probe('https://api.deepseek.com/models', { Authorization: `Bearer ${value}` }, 'DeepSeek');
    if (k === 'MOONSHOT_API_KEY') return probe('https://api.moonshot.cn/v1/models', { Authorization: `Bearer ${value}` }, 'Moonshot');
    if (k === 'DASHSCOPE_API_KEY') return probe('https://dashscope.aliyuncs.com/compatible-mode/v1/models', { Authorization: `Bearer ${value}` }, '通义千问');
    if (k === 'ANTHROPIC_API_KEY') return probe('https://api.anthropic.com/v1/models', { 'x-api-key': value, 'anthropic-version': '2023-06-01' }, 'Anthropic');
    if (k === 'GEMINI_API_KEY' || k === 'GOOGLE_API_KEY') return probe(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(value)}`, {}, 'Gemini');
    // 未知提供商：仅做形态校验
    if (!/^[A-Za-z0-9_\-.=+/]{16,}$/.test(value)) return 'Key 格式不像有效凭证（通常 ≥16 位且不含空格）';
    return null;
  }

  /** 配置向导保存：验证 → 写回项目根 .env（追加式；已有 key 原地替换）→ 返回仍未通过项 */
  async saveEnvConfig(projectId: string, values: Record<string, string>): Promise<{ ok: boolean; invalid: Array<{ key: string; reason: string }>; remaining: Array<{ key: string }> }> {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const check = await this.checkEnvVars(projectId);
    const invalid: Array<{ key: string; reason: string }> = [];
    const accepted: Array<[string, string]> = [];

    // 合并上下文：已有 .env + 本次输入（LLM_API_KEY 的有效性依赖同批填入的 LLM_BASE_URL）
    const projectRow = this.ds.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string } | undefined;
    const merged: Record<string, string> = {};
    if (projectRow) {
      try {
        const envPath = path.join(projectRow.root_path, '.env');
        if (fs.existsSync(envPath)) {
          for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
            const m = /^\s*([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(line);
            if (m) merged[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
          }
        }
      } catch { /* 读不到就只用本次输入 */ }
    }
    for (const [k, v] of Object.entries(values)) merged[k] = String(v ?? '').trim();

    for (const [key, value] of Object.entries(values)) {
      const v = String(value ?? '').trim();
      const k = key.toUpperCase();
      let reason = this.validateEnvValue(key, v);
      // 数据库连接串做真实 TCP 可达验证
      if (!reason && /^(DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL|MYSQL_URL|MONGO_URL|MONGODB_URL|DB_URL)$/.test(k)) {
        reason = await this.validateDbUrl(v);
      }
      // API Key 真实可用性验证（旧实现只看长度 ≥4，填个 "abcd" 也能通过）
      if (!reason && /(API_KEY|_KEY)$/.test(k)) {
        reason = await this.validateApiKey(k, v, merged);
      }
      if (reason) invalid.push({ key, reason });
      else accepted.push([key, v]);
    }
    if (invalid.length) return { ok: false, invalid, remaining: check.missing ?? [] };

    if (accepted.length) {
      const project = this.ds.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(projectId) as { root_path: string } | undefined;
      if (!project) throw new Error('project not found');
      const envPath = path.join(project.root_path, '.env');
      // 备份原件到数据目录（不覆盖用户已有备份）
      try {
        if (fs.existsSync(envPath)) {
          const backupDir = path.join(process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data'), 'configs', projectId);
          fs.mkdirSync(backupDir, { recursive: true });
          const backup = path.join(backupDir, `env-backup-${Date.now()}`);
          if (!fs.existsSync(backup)) fs.copyFileSync(envPath, backup);
        }
      } catch { /* 备份失败不阻断 */ }
      // 原地替换已有 key 行，缺失则追加；保留原有注释与空行
      const byKey = new Map(accepted);
      let content = '';
      try { content = fs.readFileSync(envPath, 'utf-8'); } catch { content = ''; }
      const lines = content.split(/\r?\n/);
      const seen = new Set<string>();
      const out = lines.map((line) => {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=/);
        if (m && byKey.has(m[1])) { seen.add(m[1]); return `${m[1]}=${byKey.get(m[1])}`; }
        return line;
      });
      for (const [key, value] of accepted) if (!seen.has(key)) out.push(`${key}=${value}`);
      fs.writeFileSync(envPath, out.join('\n').replace(/\n{3,}$/g, '\n\n') + '\n', 'utf-8');
    }

    // 重新检查：返回仍缺失的必填项（用户可能一次没填全）
    const recheck = await this.checkEnvVars(projectId);
    const remaining = (recheck.missing ?? []).map((v: any) => ({ key: v.key }));
    return { ok: true, invalid: [], remaining };
  }
}
