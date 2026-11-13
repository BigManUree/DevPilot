import fs from 'node:fs';
import path from 'node:path';
import type { EnvVarRequirement, ExternalServiceRequirement } from '@devpilot/shared-types';

/**
 * 版本约束解析器：从项目 manifest/锁文件解析真实的语言/工具版本要求。
 * 原则：只报告能从文件内容确证的约束；解析不出来就返回 null，不猜测。
 */

export interface ConstraintResult {
  /** 语言版本要求原文，如 "17"、">=3.10" */
  value: string | null;
  source: string; // 相对路径
  evidence: string; // 命中的行/键
}

function readIfExist(root: string, rel: string, max = 64 * 1024): string | null {
  const p = path.join(root, rel);
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
    const st = fs.statSync(p);
    if (st.size > max) return null;
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function firstMatch(text: string, patterns: RegExp[]): { value: string; line: string } | null {
  for (const line of text.split(/\r?\n/)) {
    for (const re of patterns) {
      const m = line.match(re);
      if (m) return { value: m[1], line: line.trim().slice(0, 200) };
    }
  }
  return null;
}

/** Java 版本：pom.xml 属性 + maven.compiler 插件配置 */
export function javaConstraint(root: string): ConstraintResult | null {
  const pom = readIfExist(root, 'pom.xml');
  if (pom) {
    const m = firstMatch(pom, [
      /<maven\.compiler\.release>([^<]+)<\/maven\.compiler\.release>/,
      /<maven\.compiler\.source>([^<]+)<\/maven\.compiler\.source>/,
      /<java\.version>([^<]+)<\/java\.version>/,
      /<source>(1\.\d+|1[0-9]|2[0-9])<\/source>/,
    ]);
    if (m) return { value: m.value, source: 'pom.xml', evidence: m.line };
  }
  const gp = readIfExist(root, 'gradle.properties');
  if (gp) {
    const m = firstMatch(gp, [/^org\.gradle\.java\.home\s*=\s*(.+)$/m, /^systemProp\..*java.*version\s*=\s*(.+)$/m]);
    if (m) return { value: m.value.trim(), source: 'gradle.properties', evidence: m.line };
  }
  const bg = readIfExist(root, 'build.gradle');
  if (bg) {
    const m = firstMatch(bg, [/sourceCompatibility\s*=\s*['"]?([0-9.]+)['"]?/, /toolchain\s*\{[\s\S]*?languageVersion\s*=\s*JavaLanguageVersion\.of\((\d+)\)/]);
    if (m) return { value: m.value, source: 'build.gradle', evidence: m.line };
  }
  const bgk = readIfExist(root, 'build.gradle.kts');
  if (bgk) {
    const m = firstMatch(bgk, [/sourceCompatibility\s*=\s*["']([^"']+)["']/, /languageVersion\.set\(JavaLanguageVersion\.of\((\d+)\)\)/]);
    if (m) return { value: m.value, source: 'build.gradle.kts', evidence: m.line };
  }
  return null;
}

/** Node 版本：.nvmrc / .node-version / package.json engines */
export function nodeConstraint(root: string): ConstraintResult | null {
  for (const f of ['.nvmrc', '.node-version']) {
    const t = readIfExist(root, f);
    if (t) {
      const v = t.trim().split(/\r?\n/)[0]?.trim();
      if (v && /^[\^~<>=\s]*\d/.test(v)) return { value: v, source: f, evidence: v };
    }
  }
  const pkgText = readIfExist(root, 'package.json');
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { engines?: { node?: string; pnpm?: string; npm?: string; yarn?: string } };
      if (pkg.engines?.node) return { value: pkg.engines.node, source: 'package.json', evidence: `engines.node=${pkg.engines.node}` };
    } catch { /* 非法 JSON 忽略 */ }
  }
  return null;
}

/** Python 版本：pyproject requires-python / .python-version / setup.py python_requires */
export function pythonConstraint(root: string): ConstraintResult | null {
  const pp = readIfExist(root, 'pyproject.toml');
  if (pp) {
    const m = firstMatch(pp, [/requires-python\s*=\s*['"]([^'"]+)['"]/]);
    if (m) return { value: m.value, source: 'pyproject.toml', evidence: m.line };
  }
  const pv = readIfExist(root, '.python-version');
  if (pv) {
    const v = pv.trim().split(/\r?\n/)[0]?.trim();
    if (v) return { value: v, source: '.python-version', evidence: v };
  }
  const sp = readIfExist(root, 'setup.py');
  if (sp) {
    const m = firstMatch(sp, [/python_requires\s*=\s*['"]([^'"]+)['"]/]);
    if (m) return { value: m.value, source: 'setup.py', evidence: m.line };
  }
  return null;
}

/** Go 版本：go.mod go 指令 */
export function goConstraint(root: string): ConstraintResult | null {
  const gm = readIfExist(root, 'go.mod');
  if (gm) {
    const m = firstMatch(gm, [/^go\s+([0-9.]+)\s*$/m]);
    if (m) return { value: m.value, source: 'go.mod', evidence: m.line };
  }
  return null;
}

/** Rust 版本：Cargo.toml edition → 推断最低 rustc */
export function rustConstraint(root: string): ConstraintResult | null {
  const ct = readIfExist(root, 'Cargo.toml');
  if (ct) {
    const m = firstMatch(ct, [/^edition\s*=\s*['"](\d{4})['"]/m, /^\[package\][\s\S]*?edition\s*=\s*['"](\d{4})['"]/m]);
    if (m) {
      const editionToRustc: Record<string, string> = { '2015': '1.0', '2018': '1.31', '2021': '1.56', '2024': '1.85' };
      return { value: editionToRustc[m.value] ?? null, source: 'Cargo.toml', evidence: m.line };
    }
  }
  return null;
}

/** PHP 版本：composer.json require.php */
export function phpConstraint(root: string): ConstraintResult | null {
  const cj = readIfExist(root, 'composer.json');
  if (cj) {
    try {
      const c = JSON.parse(cj) as { require?: Record<string, string> };
      if (c.require?.php) return { value: c.require.php, source: 'composer.json', evidence: `require.php=${c.require.php}` };
    } catch { /* ignore */ }
  }
  return null;
}

/** Gradle 版本：gradle-wrapper.properties distributionUrl */
export function gradleConstraint(root: string): ConstraintResult | null {
  const gw = readIfExist(root, path.join('gradle', 'wrapper', 'gradle-wrapper.properties'));
  if (gw) {
    const m = firstMatch(gw, [/gradle-([0-9.]+)-/]);
    if (m) return { value: m.value, source: 'gradle/wrapper/gradle-wrapper.properties', evidence: m.line };
  }
  return null;
}

/** 包管理器：锁文件优先，其次 packageManager 字段 / pyproject 工具声明 */
export function detectPackageManager(root: string): { name: string; version: string | null; source: string } | null {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return { name: 'pnpm', version: null, source: 'pnpm-lock.yaml' };
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return { name: 'yarn', version: null, source: 'yarn.lock' };
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return { name: 'bun', version: null, source: 'bun.lock' };
  if (fs.existsSync(path.join(root, 'package-lock.json'))) return { name: 'npm', version: null, source: 'package-lock.json' };
  if (fs.existsSync(path.join(root, 'poetry.lock'))) return { name: 'poetry', version: null, source: 'poetry.lock' };
  if (fs.existsSync(path.join(root, 'uv.lock'))) return { name: 'uv', version: null, source: 'uv.lock' };
  if (fs.existsSync(path.join(root, 'Pipfile.lock'))) return { name: 'pipenv', version: null, source: 'Pipfile.lock' };
  const pkgText = readIfExist(root, 'package.json');
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { packageManager?: string };
      if (pkg.packageManager) {
        const m = pkg.packageManager.match(/^(\w+)@([\d.]+)/);
        if (m) return { name: m[1], version: m[2], source: 'package.json packageManager' };
      }
    } catch { /* ignore */ }
  }
  return null;
}

const SENSITIVE_RE = /(password|secret|token|api[_-]?key|credential|private[_-]?key|access[_-]?key)/i;

/** .env.example 解析 → 环境变量需求 */
export function parseEnvTemplate(root: string): { vars: EnvVarRequirement[]; file: string } | null {
  for (const f of ['.env.example', '.env.template', '.env.sample', '.env.sample.yaml']) {
    const t = readIfExist(root, f);
    if (!t) continue;
    const vars: EnvVarRequirement[] = [];
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const raw = m[2].trim();
      const hasDefault = raw.length > 0 && !/^<.*>$/.test(raw) && !/^(changeme|your[-_].*|xxx+)$/i.test(raw);
      vars.push({
        key: m[1],
        source: f,
        required: !hasDefault,
        hasDefault,
        defaultValue: hasDefault ? raw.slice(0, 100) : undefined,
        sensitive: SENSITIVE_RE.test(m[1]),
      });
    }
    if (vars.length) return { vars, file: f };
  }
  return null;
}

/** Spring 配置文件解析 → 环境变量需求（${VAR:default} 占位） */
export function parseSpringConfig(root: string): EnvVarRequirement[] | null {
  for (const f of ['application.yml', 'application.yaml', 'application.properties']) {
    const t = readIfExist(root, f);
    if (!t) continue;
    const vars: EnvVarRequirement[] = [];
    const seen = new Set<string>();
    for (const m of t.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_.]*)(?::([^}]*))?\}/g)) {
      const key = m[1];
      if (seen.has(key)) continue;
      seen.add(key);
      const hasDefault = m[2] !== undefined && m[2] !== '';
      vars.push({
        key,
        source: f,
        required: !hasDefault,
        hasDefault,
        defaultValue: hasDefault ? m[2].slice(0, 100) : undefined,
        sensitive: SENSITIVE_RE.test(key),
      });
    }
    if (vars.length) return vars;
  }
  return null;
}

/** Compose 文件解析 → 外部服务需求（image + ports） */
export function parseComposeServices(root: string): { services: ExternalServiceRequirement[]; raw: string | null } | null {
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml']) {
    const t = readIfExist(root, f);
    if (!t) continue;
    const services: ExternalServiceRequirement[] = [];
    // 粗粒度结构化解析：image 名 → 已知服务类型 + ports 第一个映射
    const blocks = t.split(/^\s{0,2}([a-zA-Z0-9_-]+):\s*$/m);
    for (const m of t.matchAll(/image:\s*['"]?([^\s'"]+)['"]?/g)) {
      const img = m[1];
      const type = matchServiceType(img);
      if (type !== 'unknown') {
        const port = inferDefaultPort(type);
        services.push({ type, host: '127.0.0.1', port, source: f });
      }
    }
    return { services, raw: f };
  }
  return null;
}

export function matchServiceType(text: string): ExternalServiceRequirement['type'] {
  if (/\bmysql\b/i.test(text)) return 'mysql';
  if (/\bpostgre/i.test(text)) return 'postgres';
  if (/\bredis\b/i.test(text)) return 'redis';
  if (/\bmongo\b/i.test(text)) return 'mongodb';
  if (/\brabbitmq\b/i.test(text)) return 'rabbitmq';
  if (/\bkafka\b/i.test(text)) return 'kafka';
  if (/\belastic/i.test(text)) return 'elasticsearch';
  if (/\bminio\b/i.test(text)) return 'minio';
  if (/\bmssql|sqlserver/i.test(text)) return 'mssql';
  return 'unknown';
}

export function inferDefaultPort(type: ExternalServiceRequirement['type']): number | null {
  const map: Record<string, number> = {
    mysql: 3306, postgres: 5432, redis: 6379, mongodb: 27017, rabbitmq: 5672,
    kafka: 9092, elasticsearch: 9200, minio: 9000, mssql: 1433,
  };
  return map[type] ?? null;
}

/** requirements.txt / pyproject 依赖中的已知外部服务客户端推断 */
export function inferExternalServicesFromDeps(deps: string[]): ExternalServiceRequirement[] {
  const map: Array<[RegExp, ExternalServiceRequirement['type']]> = [
    [/^mysql|pymysql|mysqlclient/i, 'mysql'],
    [/psycopg|asyncpg/i, 'postgres'],
    [/^redis|aioredis/i, 'redis'],
    [/pymongo|motor/i, 'mongodb'],
    [/pika|amqp/i, 'rabbitmq'],
    [/kafka-python|confluent-kafka/i, 'kafka'],
    [/elasticsearch/i, 'elasticsearch'],
  ];
  const out: ExternalServiceRequirement[] = [];
  for (const [re, type] of map) {
    const hit = deps.find((d) => re.test(d));
    if (hit) out.push({ type, host: null, port: inferDefaultPort(type), source: `依赖: ${hit}` });
  }
  return out;
}
