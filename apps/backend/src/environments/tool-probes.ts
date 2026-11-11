import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** 环境检测探针定义（PRD 3.11）：PATH 上找可执行文件 → 版本命令 → 正则提取 */
export interface ToolProbe {
  id: string;
  name: string;
  command: string;
  args: string[];
  versionRegex: RegExp;
  installHint: string;
}

const exec = promisify(execFile);

export const TOOL_PROBES: ToolProbe[] = [
  { id: 'node', name: 'Node.js', command: 'node', args: ['--version'], versionRegex: /v(\d+\.\d+\.\d+)/, installHint: 'https://nodejs.org/' },
  { id: 'npm', name: 'npm', command: 'npm', args: ['--version'], versionRegex: /(\d+\.\d+\.\d+)/, installHint: '随 Node.js 安装' },
  { id: 'pnpm', name: 'pnpm', command: 'pnpm', args: ['--version'], versionRegex: /(\d+\.\d+\.\d+)/, installHint: 'npm i -g pnpm' },
  { id: 'yarn', name: 'yarn', command: 'yarn', args: ['--version'], versionRegex: /(\d+\.\d+\.\d+)/, installHint: 'npm i -g yarn' },
  { id: 'python', name: 'Python', command: 'python', args: ['--version'], versionRegex: /(\d+\.\d+\.\d+)/, installHint: 'https://www.python.org/downloads/' },
  { id: 'java', name: 'Java', command: 'java', args: ['-version'], versionRegex: /"(\d+\.\d+)[^"]*"/, installHint: 'https://adoptium.net/' },
  { id: 'javac', name: 'JDK (javac)', command: 'javac', args: ['-version'], versionRegex: /(\d+(?:\.\d+)?)/, installHint: 'https://adoptium.net/（需要 JDK 而非 JRE）' },
  { id: 'maven', name: 'Maven', command: 'mvn', args: ['--version'], versionRegex: /Apache Maven (\d+\.\d+\.\d+)/, installHint: 'https://maven.apache.org/download.cgi' },
  { id: 'gradle', name: 'Gradle', command: 'gradle', args: ['--version'], versionRegex: /Gradle (\d+\.\d+(?:\.\d+)?)/, installHint: 'https://gradle.org/install/' },
  { id: 'go', name: 'Go', command: 'go', args: ['version'], versionRegex: /go(\d+\.\d+(?:\.\d+)?)/, installHint: 'https://go.dev/dl/' },
  { id: 'rust', name: 'Rust', command: 'rustc', args: ['--version'], versionRegex: /(\d+\.\d+\.\d+)/, installHint: 'https://rustup.rs/' },
  { id: 'php', name: 'PHP', command: 'php', args: ['--version'], versionRegex: /PHP (\d+\.\d+\.\d+)/, installHint: 'https://windows.php.net/download/' },
  { id: 'composer', name: 'Composer', command: 'composer', args: ['--version'], versionRegex: /Composer version (\d+\.\d+\.\d+)/, installHint: 'https://getcomposer.org/' },
  { id: 'git', name: 'Git', command: 'git', args: ['--version'], versionRegex: /(\d+\.\d+\.\d+)/, installHint: 'https://git-scm.com/' },
  { id: 'docker', name: 'Docker', command: 'docker', args: ['--version'], versionRegex: /(\d+\.\d+\.\d+)/, installHint: 'https://www.docker.com/products/docker-desktop/' },
];

export interface ToolProbeResult {
  id: string;
  name: string;
  status: 'ok' | 'missing' | 'error';
  version?: string;
  installHint: string;
  error?: string;
}

/** 探测单个工具：missing / ok / error。Windows 下 npm 等是 .cmd 包装：先原命令，ENOENT 再试 .cmd */
export async function probeTool(p: ToolProbe): Promise<ToolProbeResult> {
  const attempts: Array<{ command: string; shell: boolean }> = [{ command: p.command, shell: false }];
  if (process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(p.command)) {
    // Node ≥18.20 禁止 shell:false 直接 spawn .cmd（EINVAL），需 shell:true
    attempts.push({ command: `${p.command}.cmd`, shell: true });
  }
  let lastCode = '';
  for (const a of attempts) {
    try {
      const { stdout, stderr } = await exec(a.command, p.args, { timeout: 10_000, windowsHide: true, shell: a.shell });
      const text = (stdout || stderr).trim();
      const m = text.match(p.versionRegex);
      return { id: p.id, name: p.name, status: 'ok', version: m?.[1], installHint: p.installHint };
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      lastCode = e.code ?? '';
      if (e.code === 'ENOENT') continue; // 尝试下一个候选
      return { id: p.id, name: p.name, status: 'error', installHint: p.installHint, error: e.message?.slice(0, 200) };
    }
  }
  return { id: p.id, name: p.name, status: lastCode === 'ENOENT' ? 'missing' : 'error', installHint: p.installHint };
}

export async function probeAll(): Promise<ToolProbeResult[]> {
  return Promise.all(TOOL_PROBES.map(probeTool));
}
