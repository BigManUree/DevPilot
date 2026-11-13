import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';

/**
 * 多版本扫描（升级任务书 §5.1）：
 * - Windows：where 全枚举 + JAVA_HOME + 常见安装目录 + 版本管理器目录
 * - POSIX：which + 常见目录
 * - 每个候选真实执行版本命令验证（文件夹存在 ≠ 可用）
 */

const exec = promisify(execFile);

export interface InstalledRuntime {
  toolId: string;
  version: string | null;
  /** 可执行文件路径（真实验证过） */
  executable: string;
  /** 版本来源：where/which 命中、JAVA_HOME、常见目录 */
  source: 'path' | 'where' | 'JAVA_HOME' | 'dir-scan' | 'version-manager';
  /** 真实执行了版本命令才为 true */
  verified: boolean;
  error?: string;
}

function runVersion(cmd: string, args: string[], timeout = 10_000): Promise<string | null> {
  return exec(cmd, args, { timeout, windowsHide: true, shell: process.platform === 'win32' })
    .then(({ stdout, stderr }) => (stdout || stderr).trim().split(/\r?\n/).join(' ').slice(0, 200))
    .catch(() => null);
}

function extractVersion(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m ? m[1] : null;
}

/** where/which 全枚举 */
async function enumerateOnPath(command: string): Promise<string[]> {
  try {
    const { stdout } = await exec(process.platform === 'win32' ? 'where' : 'which', [command], { timeout: 10_000, windowsHide: true });
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && fs.existsSync(l));
  } catch {
    return [];
  }
}

const VERSION_CMDS: Record<string, { args: string[]; re: RegExp; isJava?: boolean }> = {
  node: { args: ['--version'], re: /v(\d+\.\d+\.\d+)/ },
  npm: { args: ['--version'], re: /(\d+\.\d+\.\d+)/ },
  pnpm: { args: ['--version'], re: /(\d+\.\d+\.\d+)/ },
  yarn: { args: ['--version'], re: /(\d+\.\d+\.\d+)/ },
  python: { args: ['--version'], re: /(\d+\.\d+\.\d+)/ },
  java: { args: ['-version'], re: /"(\d+(?:\.\d+)?(?:\.\d+)?)[^"]*"/, isJava: true },
  javac: { args: ['-version'], re: /(\d+(?:\.\d+)?(?:\.\d+)?)/, isJava: true },
  maven: { args: ['--version'], re: /Apache Maven (\d+\.\d+\.\d+)/ },
  gradle: { args: ['--version'], re: /Gradle (\d+\.\d+(?:\.\d+)?)/ },
  go: { args: ['version'], re: /go(\d+\.\d+(?:\.\d+)?)/ },
  rust: { args: ['--version'], re: /(\d+\.\d+\.\d+)/ },
  php: { args: ['--version'], re: /PHP (\d+\.\d+\.\d+)/ },
  docker: { args: ['--version'], re: /(\d+\.\d+\.\d+)/ },
  composer: { args: ['--version'], re: /Composer version (\d+\.\d+\.\d+)/ },
};

/** 验证一个可执行文件的真实版本 */
async function verify(toolId: string, executable: string): Promise<InstalledRuntime> {
  const spec = VERSION_CMDS[toolId];
  if (!spec) return { toolId, version: null, executable, source: 'dir-scan', verified: false, error: '无版本命令定义' };
  // Java 老式版本号 1.8 → 8
  const text = await runVersion(executable, spec.args);
  let version = text ? extractVersion(text, spec.re) : null;
  if (version && spec.isJava && version.startsWith('1.')) version = version.split('.')[1];
  return {
    toolId,
    version,
    executable,
    source: 'path',
    verified: version !== null,
    error: version === null ? (text ?? '版本命令执行失败或输出不匹配') : undefined,
  };
}

/** 常见安装目录扫描（真实验证版本） */
async function scanCommonDirs(toolId: string): Promise<InstalledRuntime[]> {
  const out: InstalledRuntime[] = [];
  const home = os.homedir();
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env['LOCALAPPDATA'] ?? '';

  const probeDirs: Record<string, Array<{ root: string; exePattern: RegExp; subExe?: string }>> = {
    java: [
      { root: path.join(programFiles, 'Java'), exePattern: /^jdk|^java|^zulu|^corretto|^temurin|adopt/i, subExe: path.join('bin', 'java.exe') },
      { root: path.join(programFiles, 'Eclipse Adoptium'), exePattern: /jdk/i, subExe: path.join('bin', 'java.exe') },
      { root: path.join(programFiles, 'Microsoft'), exePattern: /jdk/i, subExe: path.join('bin', 'java.exe') },
      { root: 'C:\\Program Files\\Android\\Android Studio\\jbr', exePattern: /.*/, subExe: path.join('bin', 'java.exe') },
    ],
    node: [
      { root: path.join(localAppData, 'nvm'), exePattern: /^v\d/i, subExe: 'node.exe' },
      { root: path.join(programFiles, 'nodejs'), exePattern: /.*/, subExe: 'node.exe' },
    ],
    python: [
      { root: path.join(localAppData, 'Programs', 'Python'), exePattern: /^Python\d+/i, subExe: 'python.exe' },
      { root: 'C:\\Python', exePattern: /^Python?\d*/i, subExe: 'python.exe' },
    ],
    maven: [{ root: path.join(programFiles, 'Apache'), exePattern: /maven/i, subExe: path.join('bin', 'mvn.cmd') }],
    go: [{ root: path.join(programFiles, 'Go'), exePattern: /.*/, subExe: path.join('bin', 'go.exe') }],
    rust: [{ root: path.join(home, '.cargo', 'bin'), exePattern: /.*/, subExe: 'rustc.exe' }],
  };
  const spec = probeDirs[toolId];
  if (!spec) return out;
  for (const { root, exePattern, subExe } of spec) {
    if (!fs.existsSync(root)) continue;
    const st = fs.statSync(root);
    if (st.isFile()) {
      // root 本身就是安装目录（如 Android Studio jbr）
      const exe = path.join(root, subExe ?? '');
      if (fs.existsSync(exe)) out.push(await verify(toolId, exe));
      continue;
    }
    try {
      for (const d of fs.readdirSync(root)) {
        if (!exePattern.test(d)) continue;
        const exe = path.join(root, d, subExe ?? '');
        if (fs.existsSync(exe)) out.push(await verify(toolId, exe));
      }
    } catch { /* 权限不足等，忽略 */ }
  }
  return out;
}

/** 扫描某工具本机全部已安装版本（去重：同 executable 只留一个） */
export async function scanVersions(toolId: string): Promise<InstalledRuntime[]> {
  const results = new Map<string, InstalledRuntime>();
  const add = (r: InstalledRuntime) => {
    const key = path.resolve(r.executable).toLowerCase();
    const prev = results.get(key);
    if (!prev || (!prev.verified && r.verified)) results.set(key, r);
  };

  // 1) PATH 上的（含 .cmd 解析）
  for (const p of await enumerateOnPath(toolId)) {
    add(await verify(toolId, p));
  }
  // node 多版本管理器目录
  for (const r of await scanCommonDirs(toolId)) {
    add(r);
  }
  // 2) JAVA_HOME
  if (toolId === 'java' || toolId === 'javac') {
    const jh = process.env['JAVA_HOME'];
    if (jh) {
      const exe = path.join(jh, 'bin', toolId === 'java' ? 'java.exe' : 'javac.exe');
      if (fs.existsSync(exe)) {
        const r = await verify(toolId, exe);
        r.source = 'JAVA_HOME';
        add(r);
      }
    }
  }
  return [...results.values()];
}

/** 扫描全部重点工具 */
export async function scanAllVersions(toolIds?: string[]): Promise<Record<string, InstalledRuntime[]>> {
  const ids = toolIds ?? ['node', 'python', 'java', 'maven', 'gradle', 'go', 'rust', 'php', 'docker'];
  const out: Record<string, InstalledRuntime[]> = {};
  await Promise.all(ids.map(async (id) => { out[id] = await scanVersions(id); }));
  return out;
}

// ============ 版本匹配规则引擎（§5.2） ============

export type MatchStatus = 'satisfied' | 'mismatch' | 'missing' | 'unknown' | 'conflict';

export interface VersionMatchResult {
  toolId: string;
  requirement: string | null;
  requirementSource: string | null;
  installed: Array<{ version: string; executable: string; source: string }>;
  status: MatchStatus;
  /** 推荐使用的可执行文件（满足要求的版本） */
  recommendedExecutable: string | null;
  evidence: string[];
  advice: string;
}

/** 语义化比较：支持 ^ ~ >= > < = 前缀与 x.y.z / x.y */
function parseSemver(v: string): number[] | null {
  const m = v.replace(/^[v=\s]+/, '').match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

/** 检查版本是否满足约束（支持 "17"（精确主版本）、">=3.10"、"^20"、"~1.2"、多个约束 &&） */
export function satisfiesConstraint(version: string, constraint: string): boolean {
  const ver = parseSemver(version);
  if (!ver) return false;
  const clauses = constraint.split(/\s*&&\s*/).map((c) => c.trim()).filter(Boolean);
  return clauses.every((clause) => {
    const m = clause.match(/^\s*(\^|~|>=|<=|>|<|=)?\s*(.+)$/);
    if (!m) return false;
    const op = m[1] ?? '=';
    const req = parseSemver(m[2]);
    if (!req) return false;
    switch (op) {
      case '>=': return cmp(ver, req) >= 0;
      case '<=': return cmp(ver, req) <= 0;
      case '>': return cmp(ver, req) > 0;
      case '<': return cmp(ver, req) < 0;
      case '^': return cmp(ver, req) >= 0 && ver[0] === req[0];
      case '~': return cmp(ver, req) >= 0 && ver[0] === req[0] && ver[1] === req[1];
      case '=': {
        // "17" 表示主版本一致即可；"17.0.1" 全等
        const reqParts = m[2].replace(/^[v=\s]+/, '').split('.').filter(Boolean);
        if (reqParts.length === 1) return ver[0] === req[0];
        if (reqParts.length === 2) return ver[0] === req[0] && ver[1] === req[1];
        return cmp(ver, req) === 0;
      }
      default: return false;
    }
  });
}

/**
 * 项目要求 vs 本机多版本匹配。
 * requirement 来自分析引擎的 constraints（如 pom.xml 的 17、.nvmrc 的 20.x），无法解析传 null。
 */
export async function matchRequirement(toolId: string, requirement: string | null, requirementSource: string | null): Promise<VersionMatchResult> {
  const installed = await scanVersions(toolId);
  const verified = installed.filter((r) => r.verified && r.version);
  const evidence: string[] = installed.map((r) => `${r.executable}（${r.verified ? `版本 ${r.version}，来源 ${r.source}` : `验证失败：${r.error}`}）`);

  if (!verified.length) {
    return {
      toolId, requirement, requirementSource, installed: verified.map((r) => ({ version: r.version!, executable: r.executable, source: r.source })),
      status: 'missing', recommendedExecutable: null, evidence,
      advice: `本机未检测到可用的 ${toolId}。${requirement ? `项目要求 ${requirement}，` : ''}请安装后重试（不自动安装系统软件）。`,
    };
  }

  if (!requirement) {
    return {
      toolId, requirement: null, requirementSource: null, installed: verified.map((r) => ({ version: r.version!, executable: r.executable, source: r.source })),
      status: 'unknown', recommendedExecutable: verified[0].executable, evidence,
      advice: `项目未声明 ${toolId} 版本约束，默认使用 PATH 上的 ${verified[0].version}。`,
    };
  }

  const satisfying = verified.filter((r) => satisfiesConstraint(r.version!, requirement));
  if (satisfying.length) {
    const best = satisfying[0];
    return {
      toolId, requirement, requirementSource, installed: verified.map((r) => ({ version: r.version!, executable: r.executable, source: r.source })),
      status: satisfying.length > 1 ? 'satisfied' : 'satisfied', recommendedExecutable: best.executable, evidence,
      advice: `本机存在满足要求（${requirement}）的 ${toolId} ${best.version}：${best.executable}。建议为当前项目指定该版本，不修改系统默认。`,
    };
  }

  // 有安装但不满足
  const advice = `项目要求 ${toolId} ${requirement}（来源 ${requirementSource ?? '未声明'}），本机仅有 ${verified.map((v) => v.version).join('、')}，无满足版本。请安装对应版本或使用版本管理器，不覆盖系统默认。`;
  return {
    toolId, requirement, requirementSource, installed: verified.map((r) => ({ version: r.version!, executable: r.executable, source: r.source })),
    status: 'mismatch', recommendedExecutable: null, evidence, advice,
  };
}
