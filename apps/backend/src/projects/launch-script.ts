import fs from 'node:fs';
import path from 'node:path';

/**
 * 一键启动脚本识别：把项目根目录里自带的 start.bat / run.ps1 / dev.sh 解析成
 * 一条**非交互**的启动命令，供运行时直接 spawn。
 *
 * 为什么需要它：
 * - 导入时的规则引擎只会按文件名猜（python app.py），经常选错解释器
 *   （例如项目把依赖装在 .venv，系统 python 里没有 → ModuleNotFoundError）。
 * - 很多一键脚本是交互菜单（start.bat 里 `set /p CHOICE=`），直接执行会卡在读输入。
 *   所以这里只抽取脚本里真正"启动应用"的那一行命令，并展开脚本内定义的变量。
 */

export interface LaunchScriptHit {
  /** 命中的脚本绝对路径 */
  scriptPath: string;
  /** 相对项目根的路径，用于展示 */
  relative: string;
  /** 展开变量后的可直接执行命令 */
  command: string;
  /** 命令类型（streamlit / vite / uvicorn…），用于提示 */
  kind: string;
  port: number | null;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

const SCRIPT_NAME_PATTERNS: RegExp[] = [
  /^(start|run|dev|serve|launch|bootstrap|startup)\.(bat|cmd|ps1|sh)$/i,
  /^(一键|启动|运行|开始).+\.(bat|cmd|ps1|sh)$/,
  /^(makefile)$/i,
];

const SKIP_LINE =
  /^(echo|@echo|rem\b|::|setlocal|endlocal|chcp|title|cls|pause|timeout|goto|exit\b|if\b|for\b|call\s+:|:\w|\r?$)/i;

/** 命令签名：命中即视为「启动应用的命令」，port 为该类型的常见默认端口 */
const SIGNATURES: Array<{ re: RegExp; kind: string; port?: number }> = [
  { re: /streamlit(\.exe)?["']?\s+run\s+/i, kind: 'streamlit', port: 8501 },
  { re: /python(\.exe)?["']?\s+-m\s+streamlit\b/i, kind: 'streamlit', port: 8501 },
  { re: /uvicorn\b/i, kind: 'uvicorn', port: 8000 },
  { re: /gunicorn\b/i, kind: 'gunicorn', port: 8000 },
  { re: /flask\b.*\brun\b/i, kind: 'flask', port: 5000 },
  { re: /manage\.py\s+runserver\b/i, kind: 'django', port: 8000 },
  { re: /python(\.exe)?["']?\s+-m\s+http\.server\b/i, kind: 'http.server', port: 8000 },
  { re: /\b(vite|vitepress)\b(\s|$)/i, kind: 'vite', port: 5173 },
  { re: /\bnext\s+(dev|start)\b/i, kind: 'next', port: 3000 },
  { re: /\b(nuxt|astro)\s+(dev|start|preview)\b/i, kind: 'nuxt', port: 3000 },
  { re: /\b(pnpm|yarn|npm)\b.*\b(dev|start|serve)\b/i, kind: 'node-dev', port: 3000 },
  { re: /\bnode\s+[\w./\\-]+\.(js|mjs|cjs)\b/i, kind: 'node', port: null as unknown as number },
  { re: /\bgo\s+run\b/i, kind: 'go', port: 8080 },
  { re: /\b(java\s+-jar|mvn\s+spring-boot:run|gradle(w)?\s+bootRun)\b/i, kind: 'java', port: 8080 },
  { re: /\bdotnet\s+run\b/i, kind: 'dotnet', port: 5000 },
  { re: /\bphp\s+-S\b/i, kind: 'php', port: 8000 },
  { re: /\b(rails\s+(s|server)|ruby\s+.*\.rb)\b/i, kind: 'ruby', port: 3000 },
  { re: /\bcargo\s+run\b/i, kind: 'rust', port: null as unknown as number },
];

function isScriptName(name: string): boolean {
  return SCRIPT_NAME_PATTERNS.some((re) => re.test(name));
}

function existsUnder(root: string, p: string): boolean {
  try {
    const abs = path.isAbsolute(p) ? p : path.join(root, p);
    return fs.existsSync(abs);
  } catch {
    return false;
  }
}

/** 展开 %VAR%（cmd）与 $VAR / ${VAR}（sh/ps1） */
function expand(line: string, vars: Map<string, string>, preferred: Map<string, string>): string {
  const pick = (name: string) => preferred.get(name.toUpperCase()) ?? vars.get(name.toUpperCase()) ?? '';
  let out = line;
  for (let i = 0; i < 5; i++) {
    const next = out
      .replace(/%([^%]+)%/g, (_m, k: string) => pick(k))
      .replace(/\$\{([A-Za-z_]\w*)\}/g, (_m, k: string) => pick(k))
      .replace(/\$([A-Za-z_]\w*)/g, (m, k: string) => (vars.has(k.toUpperCase()) ? pick(k) : m));
    if (next === out) break;
    out = next;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function extractPort(cmd: string, content: string): number | null {
  const direct =
    /--server\.port[=\s]+(\d{2,5})/i.exec(cmd) ??
    /--port[=\s]+(\d{2,5})/i.exec(cmd) ??
    /(?:^|\s)-p\s*(\d{2,5})\b/.exec(cmd) ??
    /\bPORT[=:]\s*["']?(\d{2,5})/i.exec(cmd);
  if (direct) return Number(direct[1]);
  // 脚本里 echo 的访问地址（start "" http://localhost:8501）通常就是真实端口
  const fromEcho = /localhost:(\d{2,5})/i.exec(content) ?? /127\.0\.0\.1:(\d{2,5})/i.exec(content);
  if (fromEcho) return Number(fromEcho[1]);
  return null;
}

/** 解析单个脚本，返回最佳启动命令（找不到返回 null） */
export function parseScript(root: string, scriptPath: string): LaunchScriptHit | null {
  let content: string;
  try {
    content = fs.readFileSync(scriptPath, 'utf-8');
  } catch {
    return null;
  }
  // GBK 脚本按 utf-8 读会出替换符，但 ASCII 命令段仍可用；不因中文乱码放弃解析
  const lines = content.split(/\r?\n/);

  // 1) 变量表：记录最后一次赋值，同时记录"路径真实存在"的取值优先使用
  const vars = new Map<string, string>();
  const preferred = new Map<string, string>();
  for (const raw of lines) {
    const line = raw.trim().replace(/^@/, '');
    const m =
      /^set\s+"?([A-Za-z_]\w*)=(.*?)"?$/i.exec(line) ??
      /^\$env:([A-Za-z_]\w*)\s*=\s*["'](.*?)["']$/i.exec(line) ??
      /^([A-Za-z_]\w*)=["']?(.*?)["']?$/.exec(line);
    if (!m) continue;
    const name = m[1].toUpperCase();
    const value = m[2].trim();
    if (!value || /\s/.test(name)) continue;
    vars.set(name, value);
    if (!preferred.has(name) && existsUnder(root, value.replace(/^["']|["']$/g, ''))) preferred.set(name, value);
  }

  // 2) 逐行找启动命令
  const hits: Array<{ command: string; kind: string; defPort: number | null; index: number }> = [];
  lines.forEach((raw, index) => {
    let line = raw.trim().replace(/^@/, '');
    if (!line || SKIP_LINE.test(line)) return;
    if (/^(start|explorer)\s/i.test(line)) return; // 打开浏览器的辅助行
    line = line.replace(/^(call|exec|&\s*)/i, '').trim();
    const cmd = expand(line, vars, preferred);
    if (!cmd || cmd.length < 3) return;
    for (const sig of SIGNATURES) {
      if (sig.re.test(cmd)) {
        hits.push({ command: cmd, kind: sig.kind, defPort: sig.port ?? null, index });
        return;
      }
    }
  });
  if (!hits.length) return null;

  // 3) 打分：靠前、带真实解释器路径、命令较短的优先
  const ranked = hits
    .map((h) => {
      let score = 100 - h.index * 0.1;
      if (/\.venv[\\/]|venv[\\/]|\.exe\b/i.test(h.command)) score += 30;
      if (/npm|pnpm|yarn|vite|next/i.test(h.command)) score += 5;
      score -= h.command.length * 0.05;
      return { ...h, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];

  const port = extractPort(best.command, content) ?? best.defPort;
  const explicitInterpreter = /\.venv[\\/]|\bvenv[\\/]/.test(best.command);
  return {
    scriptPath,
    relative: path.relative(root, scriptPath).replace(/\\/g, '/'),
    command: best.command,
    kind: best.kind,
    port,
    confidence: explicitInterpreter ? 'high' : 'medium',
    reason: explicitInterpreter
      ? `从 ${path.basename(scriptPath)} 解析到带项目虚拟环境的启动命令`
      : `从 ${path.basename(scriptPath)} 解析到启动命令（${best.kind}）`,
  };
}

/** 扫描项目根（含一层常见子目录）寻找一键启动脚本 */
export function detectLaunchScript(root: string): LaunchScriptHit | null {
  if (!root || !fs.existsSync(root)) return null;
  const dirs = [root, path.join(root, 'scripts'), path.join(root, 'bin')].filter((d) => fs.existsSync(d));
  const candidates: LaunchScriptHit[] = [];
  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !isScriptName(e.name)) continue;
      const hit = parseScript(root, path.join(dir, e.name));
      if (hit) candidates.push(hit);
    }
  }
  if (!candidates.length) return null;
  const rank = (h: LaunchScriptHit) => (h.confidence === 'high' ? 2 : h.confidence === 'medium' ? 1 : 0);
  return candidates.sort((a, b) => rank(b) - rank(a))[0];
}

/**
 * 无脚本时的兜底推断：比规则引擎更懂解释器。
 * 重点是把 `.venv` 里的解释器/入口选出来，避免"系统 Python 没装依赖"这类假失败。
 */
export function inferLaunchCommand(root: string): LaunchScriptHit | null {
  if (!root || !fs.existsSync(root)) return null;
  const isWin = process.platform === 'win32';
  const venvPython = isWin ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python');
  const venvStreamlit = isWin ? path.join(root, '.venv', 'Scripts', 'streamlit.exe') : path.join(root, '.venv', 'bin', 'streamlit');
  const py = fs.existsSync(venvPython) ? `"${venvPython}"` : null;
  const st = fs.existsSync(venvStreamlit) ? `"${venvStreamlit}"` : null;

  const has = (f: string) => fs.existsSync(path.join(root, f));
  const read = (f: string) => {
    try { return fs.readFileSync(path.join(root, f), 'utf-8'); } catch { return ''; }
  };

  const appPy = has('app.py') ? read('app.py') : '';
  const isStreamlit = /streamlit/i.test(appPy) || /^streamlit/im.test(read('requirements.txt'));

  if (has('app.py') && isStreamlit) {
    const cmd = st ? `${st} run app.py` : py ? `${py} -m streamlit run app.py` : 'streamlit run app.py';
    return {
      scriptPath: path.join(root, 'app.py'), relative: 'app.py', command: cmd, kind: 'streamlit', port: 8501,
      confidence: st || py ? 'high' : 'medium',
      reason: st ? '检测到 .venv 内的 streamlit，按 Streamlit 应用启动' : '检测到 Streamlit 应用，使用项目虚拟环境启动',
    };
  }
  if (has('manage.py')) {
    const cmd = `${py ?? 'python'} manage.py runserver 127.0.0.1:8000`;
    return { scriptPath: path.join(root, 'manage.py'), relative: 'manage.py', command: cmd, kind: 'django', port: 8000, confidence: 'medium', reason: '检测到 Django manage.py' };
  }
  const pkgRaw = read('package.json');
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const name = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.serve ? 'serve' : null;
      if (name) {
        const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        const port = deps.vite ? 5173 : deps.next ? 3000 : deps.nuxt ? 3000 : deps['react-scripts'] ? 3000 : null;
        return {
          scriptPath: path.join(root, 'package.json'), relative: 'package.json',
          command: `${pm} run ${name}`, kind: 'node-dev', port, confidence: 'medium',
          reason: `package.json 的 scripts.${name}`,
        };
      }
    } catch { /* 非法 package.json 忽略 */ }
  }
  if (has('main.py') && py) {
    return { scriptPath: path.join(root, 'main.py'), relative: 'main.py', command: `${py} main.py`, kind: 'python', port: null, confidence: 'low', reason: '检测到 .venv 与 main.py' };
  }
  return null;
}

/** 项目启动命令解析入口：脚本优先，其次推断 */
export function resolveLaunch(root: string): { hit: LaunchScriptHit | null; source: 'script' | 'infer' | 'none' } {
  const script = detectLaunchScript(root);
  if (script) return { hit: script, source: 'script' };
  const inferred = inferLaunchCommand(root);
  if (inferred) return { hit: inferred, source: 'infer' };
  return { hit: null, source: 'none' };
}
