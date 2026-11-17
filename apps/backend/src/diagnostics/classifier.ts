import type { DiagnosisResult, ErrorCategory } from '@devpilot/shared-types';

/**
 * 确定性错误分类器（升级任务书 §7.1）：
 * 规则优先（快、可解释、零 token），LLM 兜底处理未知错误。
 * 每条规则命中都携带日志证据行。
 */

interface ErrorRule {
  id: string;
  category: ErrorCategory;
  patterns: RegExp[];
  summary: string;
  scope?: string; // 适用技术栈
}

const RULES: ErrorRule[] = [
  {
    id: 'java-unsupported-class-version',
    category: 'version_mismatch',
    scope: 'java',
    patterns: [/UnsupportedClassVersionError/i, /class file has wrong version (\d+)\.0/i, /bad version number in \.class file/i],
    summary: 'Java 字节码版本高于当前 JVM 支持（JDK 版本不匹配）。CLASS 文件版本映射：52=Java8 61=Java17 65=Java21。',
  },
  {
    id: 'java-javac-not-found',
    category: 'env_missing',
    scope: 'java',
    patterns: [/JAVA_HOME is set to an invalid directory/i, /'javac' is not recognized/i, /javac.*不是内部或外部命令/],
    summary: 'JAVA_HOME 无效或未安装 JDK（只有 JRE）。',
  },
  {
    id: 'maven-dependency-download',
    category: 'network',
    scope: 'java',
    patterns: [/Could not resolve dependencies/i, /Could not transfer artifact .* from central/i, /Failed to read artifact descriptor/i, /Connection timed out.*maven/i],
    summary: 'Maven 依赖下载失败（网络/镜像不可达）。可配置国内镜像或重试。',
  },
  {
    id: 'spring-bean-creation',
    category: 'config_invalid',
    scope: 'java',
    patterns: [/Error creating bean with name/i, /BeanCreationException/i, /UnsatisfiedDependencyException/i],
    summary: 'Spring Bean 创建失败：通常是配置缺失（数据源/端口/环境变量）或依赖注入问题。',
  },
  {
    id: 'db-connection-refused',
    category: 'database_connection',
    patterns: [/Connection refused.*(:?(3306|5432|1433|27017))/i, /Communications link failure/i, /ECONNREFUSED/i, /数据库连接失败/i, /Access denied for user/i, /FATAL:.*password authentication failed/i],
    summary: '数据库连接失败：服务未启动、端口/主机/凭据错误。',
  },
  {
    id: 'redis-connection',
    category: 'cache_connection',
    patterns: [/Could not connect to Redis/i, /Redis connection.*(refused|failed)/i, /ECONNREFUSED.*6379/i],
    summary: 'Redis 连接失败：服务未启动或地址/密码错误。',
  },
  {
    id: 'port-in-use',
    category: 'port_conflict',
    patterns: [/EADDRINUSE/i, /Port (\d{2,5}) is already in use/i, /address already in use/i, /Web server failed to start\. Port \d+ was already in use/i, /端口.*已被.*占用/],
    summary: '端口被占用。可用 netstat 找到占用进程并结束，或改端口后重启。',
  },
  {
    id: 'python-module-not-found',
    category: 'dependency_install_failed',
    scope: 'python',
    patterns: [/ModuleNotFoundError: No module named '([^']+)'/i, /ImportError: cannot import name/i],
    summary: 'Python 模块缺失：依赖未安装（或装到了错误的解释器/虚拟环境）。',
  },
  {
    id: 'python-version-incompatible',
    category: 'version_mismatch',
    scope: 'python',
    patterns: [/Python (\d+\.\d+) (is )?not supported/i, /requires Python/i, /SyntaxError.*invalid syntax.*match /i],
    summary: 'Python 版本不兼容项目要求。',
  },
  {
    id: 'pip-install-failed',
    category: 'dependency_install_failed',
    scope: 'python',
    patterns: [/ERROR: Could not find a version that satisfies the requirement/i, /error: Microsoft Visual C\+\+ .* is required/i, /pip.*install.*failed/i, /ERROR: Failed building wheel/i],
    summary: 'pip 安装失败：网络/源不可达，或需要编译工具链的包在 Windows 上缺编译器。',
  },
  {
    id: 'node-module-not-found',
    category: 'dependency_install_failed',
    scope: 'node',
    patterns: [/Cannot find module '([^']+)'/i, /Error: Cannot find module/i],
    summary: 'Node 模块缺失：node_modules 未安装或依赖丢失，先执行包管理器安装。',
  },
  {
    id: 'npm-eresolve',
    category: 'dependency_install_failed',
    scope: 'node',
    patterns: [/ERESOLVE/i, /unable to resolve dependency tree/i, /peer dep/i, /While resolving:/i],
    summary: 'npm 依赖树冲突（peer dependency）。按项目锁文件选择包管理器安装，必要时 --legacy-peer-deps。',
  },
  {
    id: 'node-version-incompatible',
    category: 'version_mismatch',
    scope: 'node',
    patterns: [/Unsupported engine/i, /requires Node/i, /The engine "node" is incompatible/i],
    summary: 'Node 版本不满足项目 engines 要求。',
  },
  {
    id: 'node-gyp-build-failed',
    category: 'dependency_install_failed',
    scope: 'node',
    patterns: [/node-gyp/i, /gyp ERR!/i, /MSBuild.*error/i],
    summary: '原生模块编译失败：缺少 VS Build Tools / Python 编译环境。',
  },
  {
    id: 'vite-compile-error',
    category: 'compile_error',
    scope: 'frontend',
    patterns: [/\[vite\].*error/i, /ERROR in \.\/src/i, /Module build failed/i, /SyntaxError: .* \(\d+:\d+\)/i, /Type error:/i],
    summary: '前端构建/编译错误：源码语法或类型错误。',
  },
  {
    id: 'docker-daemon-down',
    category: 'docker_error',
    patterns: [/Cannot connect to the Docker daemon/i, /error during connect.*docker/i, /docker: command not found/i, /Is the docker daemon running/i],
    summary: 'Docker Engine 未运行或未安装。',
  },
  {
    id: 'docker-image-pull-failed',
    category: 'docker_error',
    patterns: [/Error response from daemon: pull access denied/i, /manifest unknown/i, /failed to resolve reference/i, /Error response from daemon: Get/i],
    summary: '镜像拉取失败：镜像名错误、无权限或网络受限（可配置镜像加速）。',
  },
  {
    id: 'docker-port-conflict',
    category: 'port_conflict',
    patterns: [/driver failed programming external connectivity/i, /Bind for .* failed: port is already allocated/i],
    summary: '容器端口绑定失败：宿主机端口被占用。',
  },
  {
    id: 'env-var-missing',
    category: 'config_missing',
    patterns: [/Environment variable (\w+) is not set/i, /process\.env\.(\w+) is undefined/i, /Required env var/i, /\$\{(\w+)\}.*not set/i],
    summary: '必需环境变量未设置。',
  },
  {
    id: 'config-file-missing',
    category: 'config_missing',
    patterns: [/ENOENT: no such file or directory, open '([^']*(?:\.ya?ml|\.properties|\.json|\.env|\.toml|\.config))'/i, /Configuration file .* not found/i, /config file not found/i],
    summary: '配置文件缺失。',
  },
  {
    id: 'permission-denied',
    category: 'permission',
    patterns: [/EACCES/i, /Permission denied/i, /EPERM/i, /Access is denied/i],
    summary: '文件/端口权限不足。',
  },
  {
    id: 'process-crash-exit',
    category: 'process_crash',
    patterns: [/Segmentation fault/i, /FATAL ERROR: .*heap/i, /app exited with code (?!0)/i, /exited with code (\d+)/i],
    summary: '进程异常退出/崩溃。',
  },
  {
    id: 'health-check-failed',
    category: 'health_check_failed',
    patterns: [/health check failed/i, /unhealthy/i, /did not become healthy/i],
    summary: '健康检查未通过：进程存活但服务未就绪。',
  },
  {
    id: 'ts-compile-error',
    category: 'compile_error',
    patterns: [/TS\d{4}:/, /error TS\d+/, /tsc .*error/i],
    summary: 'TypeScript 编译错误。',
  },
];

/** 规则分类（确定性）。返回置信度最高的类别；无命中返回 unknown。 */
/** 证据行脱敏：密钥类赋值一律掩码（审计要求：敏感信息不进入诊断/日志） */
export function redactEvidenceLine(line: string): string {
  return line
    .replace(/(password|passwd|pwd|token|secret|api[_-]?key|authorization)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=***REDACTED***')
    .replace(/(mysql:\/\/|postgres:\/\/|redis:\/\/)[^\s@]+:[^@]+@/gi, '$1***:***@');
}

export function classifyError(logText: string): DiagnosisResult {
  const evidence: string[] = [];
  let best: { rule: ErrorRule; score: number } | null = null;

  for (const rule of RULES) {
    let score = 0;
    const hits: string[] = [];
    for (const re of rule.patterns) {
      const m = logText.match(re);
      if (m) {
        score += 2;
        const idx = m.index ?? 0;
        hits.push(redactEvidenceLine(logText.slice(Math.max(0, idx - 80), idx + m[0].length + 120).trim().slice(0, 300)));
      }
    }
    if (score > (best?.score ?? 0)) best = { rule, score };
    evidence.push(...hits.slice(0, 3));
  }

  if (!best || best.score === 0) {
    // 通用兜底特征
    const lower = logText.toLowerCase();
    if (/\berror\b|\bexception\b|failed|错误|异常/.test(lower)) {
      const lines = logText.split(/\r?\n/).filter((l) => /error|exception|failed|错误|异常/i.test(l)).slice(0, 5);
      return {
        category: 'unknown',
        confidence: 0.3,
        summary: '检测到错误输出但未匹配已知规则，需要 LLM 深入分析或人工排查。',
        evidence: lines.map((l) => redactEvidenceLine(l.slice(0, 300))),
      };
    }
    return { category: 'unknown', confidence: 0.1, summary: '日志中未发现明显错误特征。', evidence: [] };
  }

  return {
    category: best.rule.category,
    confidence: Math.min(0.55 + best.score * 0.15, 0.98),
    summary: best.rule.summary,
    evidence: [...new Set(evidence)].slice(0, 5),
    ruleId: best.rule.id,
  };
}

/** 规则库清单（供前端展示与测试） */
export function listRules(): Array<{ id: string; category: ErrorCategory; scope?: string; summary: string }> {
  return RULES.map(({ id, category, scope, summary }) => ({ id, category, scope, summary }));
}
