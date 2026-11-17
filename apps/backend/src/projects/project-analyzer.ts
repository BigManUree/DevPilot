import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../database/database.module';
import { AuditService } from '../permissions/audit.service';

/**
 * 项目识别规则引擎（PRD 3.4）：规则先行识别明确事实；
 * 无法确定项标记 unknown，不把猜测当事实。
 */

export interface ServiceDraft {
  name: string;
  service_type: string;
  workdir: string;
  start_command?: string;
  /** CLI 服务的用法提示：example = 可直接复制的完整命令；note = 补充说明；args = 自动启动时附加的参数（不含占位符） */
  usage_hint?: { example: string; note?: string; args?: string };
  build_command?: string;
  port?: number;
  depends_on?: string[];
  shared?: boolean;
}

export interface AnalysisResult {
  facts: {
    language?: string;
    framework?: string;
    project_type?: string;
    package_manager?: string;
  };
  services: ServiceDraft[];
  unknowns: string[];
  needs_ai: boolean;
}

interface RuleOutput {
  facts: AnalysisResult['facts'];
  services: ServiceDraft[];
  unknowns: string[];
}

export class ProjectAnalyzer {
  /** 目录内清单文件 → 语言/框架/服务识别；根目录 + 一级子目录（覆盖 web/server 前后端分层结构） */
  static analyze(root: string): AnalysisResult {
    const facts: RuleOutput['facts'] = {};
    const services: ServiceDraft[] = [];
    const unknowns: string[] = [];

    const dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      // 测试/样例目录不是可运行服务：tests/ 里的 .test.mjs 可能内嵌 HTTP listener，
      // 曾被识别成服务导致启动流程白跑一次 CLI 校验
      .filter((d) => !/^(tests?|__tests__|fixtures?|examples?|e2e|spec|docs?|scripts?)$/i.test(d.name))
      .map((d) => path.join(root, d.name));
    dirs.unshift(root); // 根目录优先

    for (const dir of dirs) {
      const r = this.analyzeDir(dir);
      // 修复：先前 Object.assign 第三参恒为空对象导致子目录 facts 无条件覆盖根目录；
      // 现改为仅当根目录尚未识别出语言时才采用子目录事实
      if (r.facts.language && !facts.language) Object.assign(facts, r.facts);
      services.push(...r.services);
      // 修复：根目录自身的 unknowns 之前因 dir!==root 条件被丢弃，现全部保留
      unknowns.push(...r.unknowns);
    }

    if (!facts.language) unknowns.push('未识别出语言/技术栈，需要 AI 分析或用户输入');
    if (!services.length) unknowns.push('未识别出可启动服务，需要 AI 分析或用户输入');

    return { facts, services, unknowns, needs_ai: unknowns.length > 0 };
  }

  private static analyzeDir(root: string): RuleOutput {
    const facts: RuleOutput['facts'] = {};
    const services: ServiceDraft[] = [];
    const unknowns: string[] = [];

    const has = (...p: string[]) => p.some((f) => fs.existsSync(path.join(root, f)));
    const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;

    // Node.js 系
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      facts.language = 'javascript/typescript';
      const pkg = readJson(pkgPath);
      const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, string>;
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;
      if (deps['vue']) facts.framework = 'vue';
      else if (deps['react']) facts.framework = 'react';
      else if (deps['next']) facts.framework = 'next';
      else if (deps['@nestjs/core']) facts.framework = 'nestjs';
      else if (deps['express']) facts.framework = 'express';
      else if (deps['koa']) facts.framework = 'koa';
      else if (deps.electron) facts.project_type = 'desktop';
      facts.package_manager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';

      const start = scripts.dev ?? scripts.start ?? scripts.serve;
      if (start) {
        // 前端/后端启发式：存在构建产物目录或 vite/webpack 依赖 → frontend，否则 backend；
        // 无依赖声明时按启动入口内容判断（提供 text/html 静态页 → frontend）
        let isFrontend = !!(deps.vite || deps.webpack || deps['vue'] || deps.react);
        if (!isFrontend && !Object.keys(deps).length) {
          const entryFile = (start.match(/node\s+(\S+\.(?:js|ts|mjs|cjs))/i) ?? [])[1];
          if (entryFile) {
            try {
              const content = fs.readFileSync(path.join(root, entryFile), 'utf-8');
              if (/text\/html|sendFile|\.html/i.test(content)) isFrontend = true;
            } catch { /* 读不到按 backend 处理 */ }
          }
        }
        // Next/Vite 前端端口：显式配置优先；Next（自定义 server 包装）默认 3000
        const port = this.detectPort(root)
          ?? (deps.next && isFrontend ? 3000 : undefined)
          ?? (deps.vite ? 5173 : undefined);
        services.push({
          // 服务名会被用作日志文件名/终端标题等本地标识：清洗 npm scope 包名里的
          // / 等非法字符（@career-ops/web → career-ops_web），否则日志路径 ENOENT 炸进程
          name: pkg.name ? `${String(pkg.name).replace(/[/\\:*?"<>|]/g, '_')}-main` : 'node-main',
          service_type: isFrontend ? 'frontend' : 'backend',
          workdir: root,
          start_command: `npm run ${(scripts.dev ? 'dev' : scripts.start ? 'start' : 'serve')}`,
          build_command: scripts.build ? 'npm run build' : undefined,
          port,
        });
      } else {
        // monorepo（npm/pnpm/yarn workspaces）：根脚本只有 dev:web / dev:api 之类，
        // 旧实现直接放弃 → 只靠 compose 里猜出来的 postgres，前端完全识别不到（实测 AIHOT-main）。
        const wsServices = this.detectWorkspaceServices(root, pkg);
        if (wsServices.length) {
          services.push(...wsServices);
        } else {
          unknowns.push('package.json 存在但没有可识别的 dev/start 脚本');
        }
      }
      if (!Object.keys(deps).length) unknowns.push('依赖未安装（node_modules 缺失或锁文件为空）');
    } else {
      // 无 package.json 的纯 node 服务（如 backend/server.js 直接 listen）：识别 .listen( 端口与启动命令
      const jsSvc = this.detectJsListenService(root);
      if (jsSvc) services.push(jsSvc);
    }

    // Java / Maven
    if (has('pom.xml')) {
      facts.language = 'java';
      facts.framework = facts.framework ?? 'spring-boot(候选)';
      facts.package_manager = 'maven';
      // 端口按 Spring 约定位置解析：根目录 → src/main/resources（回归：之前只扫根目录，
      // application.properties 里声明的端口被忽略，autostart 修复链路会把端口漂移到 8080）
      const port = this.detectPort(root) ?? this.detectPort(path.join(root, 'src', 'main', 'resources')) ?? 8080;
      services.push({
        name: 'java-backend',
        service_type: 'backend',
        workdir: root,
        start_command: 'mvn spring-boot:run',
        build_command: 'mvn package -DskipTests',
        port,
      });
      unknowns.push('Maven 项目：需确认是否 Spring Boot 及启动 Profile');
    }

    // Gradle
    if (has('build.gradle', 'build.gradle.kts')) {
      facts.language = 'java';
      facts.package_manager = 'gradle';
      services.push({
        name: 'java-backend',
        service_type: 'backend',
        workdir: root,
        start_command: has('gradlew', 'gradlew.bat') ? '.\\gradlew bootRun' : 'gradle bootRun',
      });
      unknowns.push('Gradle 项目：启动命令需确认（bootRun 是否可用）');
    }

    // Python
    if (has('requirements.txt', 'pyproject.toml', 'setup.py')) {
      facts.language = 'python';
      const pyDeps = this.pythonDependencies(root);
      // uv 管理的项目（uv.lock 存在）统一走 uv run，避免系统解释器缺依赖
      const prefix = has('uv.lock') ? 'uv run ' : '';

      if (has('manage.py')) {
        facts.framework = 'django';
        services.push({
          name: 'django',
          service_type: 'backend',
          workdir: root,
          start_command: `${prefix}python manage.py runserver`,
          port: 8000,
        });
      }

      // FastAPI / uvicorn：入口支持根目录与 app/backend/src/server/api 一级子目录
      // （前后端分层仓库的 Python 入口常在 app/main.py，根目录什么都没有）
      const backendEntry = this.findUvicornEntry(root);
      if (backendEntry && (pyDeps.has('fastapi') || pyDeps.has('uvicorn'))) {
        facts.framework = 'fastapi';
        // 端口优先从入口文件的 uvicorn.run(..., port=N) 解析（回归：硬编码 8000 会撞
        // Windows http.sys / 常见占用，且与用户声明的端口不符）
        const entryFile = path.join(root, `${backendEntry.split(':')[0].replace(/\./g, '/')}.py`);
        const uvPort = this.detectUvicornPort(entryFile) ?? 8000;
        services.push({
          name: 'fastapi-backend',
          service_type: 'backend',
          workdir: root,
          start_command: `${prefix}uvicorn ${backendEntry} --host 127.0.0.1 --port ${uvPort}`,
          port: uvPort,
        });
      } else if (!services.length && has('app.py', 'main.py', 'webui.py', 'server.py')) {
        facts.framework = 'flask/fastapi(候选)';
        // 入口按实际存在的文件挑，不硬编码 app.py（很多仓库入口是 main.py / webui.py）
        const entry = ['app.py', 'webui.py', 'main.py', 'server.py'].find((f) => fs.existsSync(path.join(root, f)))!;
        services.push({
          name: 'python-app',
          service_type: 'backend',
          workdir: root,
          start_command: `${prefix}python ${entry}`,
        });
        unknowns.push(`Python 入口按 ${entry} 猜测，需确认`);
      } else if (!backendEntry && !services.length) {
        unknowns.push('Python 项目：未找到入口文件');
      }

      // Streamlit 前端：依赖里有 streamlit 且存在导入它的入口脚本
      if (pyDeps.has('streamlit')) {
        const stEntry = this.findStreamlitEntry(root);
        if (stEntry) {
          services.push({
            name: 'streamlit-ui',
            service_type: 'frontend',
            workdir: root,
            start_command: `${prefix}streamlit run ${stEntry}`,
            port: 8501,
          });
        }
      }

      // CLI 工具型 Python 项目（无 Web 服务入口）：打包成 Python 包、带 __main__.py，
      // 典型如 sherlock。启动校验用 --help：exit 0 = 依赖装齐 + 入口可用；
      // CLI 不是常驻服务，实际使用按 README 传参（如 python -m xxx <username>）。
      if (!services.length) {
        const cliPkg = this.pythonCliPackage(root);
        if (cliPkg) {
          // 已知 CLI 工具的用法提示（写入 usage_hint，展示在详情页「使用命令」并用于终端自动启动）。
          // sherlock：站点清单在 GitHub 上，国内网络拉不动，必须加 --local 用项目自带的 data.json。
          const CLI_HINTS: Record<string, { args: string; example: string; note: string }> = {
            sherlock_project: {
              args: '--local',
              example: `python -m sherlock_project --local <用户名>`,
              note: '在 400+ 社交网站查找用户名。--local 使用项目自带的站点清单（不访问 GitHub）；查询国外站点时请先开代理并加 --proxy 参数，如 --proxy socks5://127.0.0.1:7890。',
            },
          };
          const hint = CLI_HINTS[cliPkg] ?? {
            args: '',
            example: `python -m ${cliPkg} <参数>`,
            note: '实际使用参数请查看项目 README。',
          };
          services.push({
            name: 'python-cli',
            service_type: 'cli',
            workdir: root,
            start_command: `${prefix}python -m ${cliPkg} --help`,
            usage_hint: hint,
          });
          unknowns.push(`CLI 工具型项目：启动校验用 python -m ${cliPkg} --help${hint.args ? `，使用时加 ${hint.args}` : '，实际使用按 README 传参'}`);
        }
      }
    }

    // Go / Rust / PHP
    if (has('go.mod')) {
      facts.language = 'go';
      let module = '';
      try {
        module = (/^module\s+(\S+)/m.exec(fs.readFileSync(path.join(root, 'go.mod'), 'utf-8')) ?? [])[1] ?? '';
      } catch { /* ignore */ }
      const hasMain = has('main.go') || fs.existsSync(path.join(root, 'cmd'));
      if (hasMain) {
        // TUI 程序（bubbletea/tview 等）需要交互终端：后台 spawn 无 TTY 会异常退出，
        // 识别为 CLI 服务 → DevPilot 打开真实终端窗口运行
        const goMod = (() => { try { return fs.readFileSync(path.join(root, 'go.mod'), 'utf-8'); } catch { return ''; } })();
        const isTui = /charmbracelet\/bubbletea|tview|rivo\/tui/i.test(goMod);
        // HTTP 服务端口：扫描 go 源码里 `:8080` 形式的默认监听端口
        let goPort: number | undefined = this.detectPort(root);
        if (!goPort && !isTui) {
          try {
            for (const f of fs.readdirSync(root).filter((f) => f.endsWith('.go'))) {
              const m = /:(\d{4,5})['"]/.exec(fs.readFileSync(path.join(root, f), 'utf-8'));
              if (m) { goPort = Number(m[1]); break; }
            }
          } catch { /* ignore */ }
        }
        services.push({
          name: module ? module.split('/').pop()!.replace(/[/\\:*?"<>|]/g, '_') : 'go-app',
          service_type: isTui ? 'cli' : 'backend',
          workdir: root,
          start_command: 'go run .',
          port: isTui ? undefined : goPort,
        });
      } else {
        unknowns.push('Go 项目：未找到 main.go / cmd/ 入口，无法确定运行方式');
      }
    }
    if (has('Cargo.toml')) {
      facts.language = 'rust';
      const hasBin = fs.existsSync(path.join(root, 'src', 'main.rs')) || has('src/bin');
      if (hasBin) {
        services.push({ name: 'rust-app', service_type: 'backend', workdir: root, start_command: 'cargo run' });
      } else {
        unknowns.push('Rust 项目：未找到 src/main.rs，可能是库 crate，无运行入口');
      }
    }
    if (has('composer.json')) {
      facts.language = 'php';
      let composer: Record<string, unknown> = {};
      try { composer = readJson(path.join(root, 'composer.json')); } catch { /* ignore */ }
      const require = (composer.require ?? {}) as Record<string, string>;
      const scripts = (composer.scripts ?? {}) as Record<string, string>;
      if (fs.existsSync(path.join(root, 'artisan'))) {
        // Laravel：artisan serve 端口默认 8000
        services.push({ name: 'laravel', service_type: 'backend', workdir: root, start_command: 'php artisan serve --host=127.0.0.1 --port=8000', port: 8000 });
        facts.framework = 'laravel';
      } else if (scripts.start || scripts.serve) {
        const cmd = scripts.start ?? scripts.serve;
        services.push({ name: 'php-app', service_type: 'backend', workdir: root, start_command: `composer run ${scripts.start ? 'start' : 'serve'}` });
        void cmd;
      } else if (require['laravel/framework']) {
        facts.framework = 'laravel';
        unknowns.push('PHP Laravel 项目：未找到 artisan 入口，请确认项目结构');
      } else {
        unknowns.push('PHP 项目：启动方式需确认');
      }
    }

    // docker-compose → 基础服务（DB/缓存类标记 shared 候选）
    // 旧实现按关键词匹配文本，猜出的名字（postgres）和 compose 里真实服务名（db）不一致，
    // 生成的 `docker compose up -d postgres` 根本起不来；这里解析真实服务键与镜像。
    const compose = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
      .map((f) => path.join(root, f))
      .find((f) => fs.existsSync(f));
    if (compose) {
      facts.project_type = 'docker-compose';
      const composeServices = this.parseComposeServices(compose);
      // 本地开发优先跑 workspace 里原生应用（热更新、可调试），compose 只兜底基础设施。
      // 若已有原生应用服务，就不再为 compose 里的同名应用（api/web/worker 容器）建重复服务。
      const hasNativeApps = services.some((s) => s.service_type === 'frontend' || s.service_type === 'backend');
      for (const svc of composeServices) {
        const oneShot = /^(setup|migrate|migration|seed|init|initdb|bootstrap|job|cron)$/i.test(svc.name);
        if (oneShot) continue;
        if (hasNativeApps && svc.kind === 'app') continue;
        services.push({
          name: svc.name,
          service_type: svc.kind,
          workdir: root,
          start_command: `docker compose up -d ${svc.name}`,
          port: svc.hostPort,
          shared: svc.kind !== 'app',
        });
      }
      // 原生应用依赖基础设施：补 depends_on，启动顺序 = db/cache → api/web/worker
      const infra = composeServices.filter((c) => c.kind !== 'app').map((c) => c.name);
      if (infra.length) {
        for (const s of services) {
          if (s.workdir === root && (s.service_type === 'frontend' || s.service_type === 'backend') && !s.depends_on?.length) {
            s.depends_on = infra;
          }
        }
      }
    }

    // .NET：sln / csproj
    const dotnetProj = fs.readdirSync(root).find((f) => f.endsWith('.sln') || f.endsWith('.csproj'));
    if (dotnetProj) {
      facts.language = 'c#';
      if (dotnetProj.endsWith('.csproj')) {
        services.push({ name: path.basename(dotnetProj, '.csproj'), service_type: 'backend', workdir: root, start_command: 'dotnet run' });
      } else {
        unknowns.push('.NET 解决方案：项目结构需进一步分析（多项目 sln 需确认启动项目）');
      }
    }

    // 编译产物分发目录：独立 exe + bat 启动脚本（如 Go/Rust 发布目录）
    if (!services.length && !facts.language) {
      const batDraft = this.detectBinaryDistribution(root);
      if (batDraft) {
        facts.language = 'binary-distribution';
        facts.project_type = 'binary';
        services.push(batDraft);
        unknowns.push(`检测到独立可执行程序分发目录：已从启动脚本提取命令「${batDraft.start_command}」，端口/环境变量需人工确认`);
      }
    }

    if (!facts.language) unknowns.push(`目录 ${path.basename(root)}：未识别出语言/技术栈`);
    if (!services.length && (facts.language || this.looksLikeProject(root)))
      unknowns.push(`目录 ${path.basename(root)}：未识别出可启动服务`);

    return { facts, services, unknowns };
  }

  /**
   * npm/pnpm/yarn workspaces 子包识别（monorepo）。
   * 只认带 dev/start/serve 脚本的子包；端口按「脚本里的 --port」→「.env 里的 *_PORT」→ 框架默认 的顺序确定。
   */
  private static detectWorkspaceServices(root: string, pkg: Record<string, unknown>): ServiceDraft[] {
    const raw = pkg.workspaces as unknown;
    const patterns: string[] = Array.isArray(raw)
      ? raw.map(String)
      : Array.isArray((raw as { packages?: unknown })?.packages)
        ? ((raw as { packages: unknown[] }).packages).map(String)
        : [];
    if (!patterns.length) return [];

    const dirs = new Set<string>();
    for (const pat of patterns) {
      // "apps/*" → base "apps"；"packages/foo" → 直接是包目录
      const clean = pat.replace(/\/?\*+$/, '').replace(/\/+$/, '');
      const base = path.join(root, clean);
      if (pat.endsWith('*')) {
        if (!fs.existsSync(base)) continue;
        for (const d of fs.readdirSync(base, { withFileTypes: true })) {
          if (d.isDirectory()) dirs.add(path.join(base, d.name));
        }
      } else if (fs.existsSync(path.join(base, 'package.json'))) {
        dirs.add(base);
      }
    }

    const envPorts = this.readEnvPorts(root);
    const out: ServiceDraft[] = [];
    for (const dir of dirs) {
      const pkgFile = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgFile)) continue;
      let wp: Record<string, unknown>;
      try { wp = JSON.parse(fs.readFileSync(pkgFile, 'utf-8')) as Record<string, unknown>; } catch { continue; }
      const scripts = (wp.scripts ?? {}) as Record<string, string>;
      const scriptKey = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.serve ? 'serve' : null;
      if (!scriptKey) continue;
      const deps = { ...(wp.dependencies as object), ...(wp.devDependencies as object) } as Record<string, string>;
      const isFrontend = !!(deps.react || deps['react-dom'] || deps.vue || deps.next || deps['@react-router/dev'] || deps['@sveltejs/kit'] || deps.vite);
      const rawName = String(wp.name ?? path.basename(dir));
      const name = rawName.replace(/^@/, '').replace(/[/\\:*?"<>|]/g, '_');
      const shortName = name.split('_').pop() ?? name;
      const port = this.parsePortFromScript(scripts[scriptKey])
        ?? envPorts.get(name)
        ?? envPorts.get(shortName)
        ?? (isFrontend ? 5173 : undefined);
      out.push({
        name,
        service_type: isFrontend ? 'frontend' : 'backend',
        workdir: root,
        start_command: `npm run ${scriptKey} -w ${rawName}`,
        build_command: scripts.build ? `npm run build -w ${rawName}` : undefined,
        port,
      });
    }
    return out;
  }

  /** 从启动脚本里读端口：--port 3000 / --port=3000 / -p 3000 */
  private static parsePortFromScript(script: string | undefined): number | undefined {
    if (!script) return undefined;
    const m = /(?:--port[=\s]+|-p\s+)(\d{2,5})/.exec(script);
    if (!m) return undefined;
    const n = Number(m[1]);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
  }

  /** 读取根 .env / .env.example / compose 里的 *PORT 变量，映射到包名后缀（AIHOT_API_PORT → aihot_api / api） */
  private static readEnvPorts(root: string): Map<string, number> {
    const map = new Map<string, number>();
    const files = ['.env', '.env.example', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
    for (const file of files) {
      const full = path.join(root, file);
      if (!fs.existsSync(full)) continue;
      for (const line of fs.readFileSync(full, 'utf-8').split(/\r?\n/)) {
        // 兼容 .env 的 KEY=1234 与 compose 的 KEY: "1234"
        const m = /^\s*-?\s*([A-Za-z_][\w.]*PORT)\s*[:=]\s*["']?(\d{2,5})["']?\s*$/.exec(line);
        if (!m) continue;
        const port = Number(m[2]);
        if (!Number.isInteger(port) || port <= 0 || port >= 65536) continue;
        const key = m[1].toLowerCase();
        map.set(key, port);
        map.set(key.replace(/_port$/, ''), port);
      }
    }
    return map;
  }

  /** 解析 compose 的 services 段：服务名、类型（按镜像）、宿主机端口 */
  private static parseComposeServices(file: string): Array<{ name: string; kind: string; hostPort?: number }> {
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    const out: Array<{ name: string; kind: string; hostPort?: number }> = [];
    let inServices = false;
    let current: { name: string; kind: string; hostPort?: number } | null = null;
    for (const raw of lines) {
      const line = raw.replace(/\t/g, '  ');
      if (/^services:\s*$/.test(line)) { inServices = true; continue; }
      if (/^[A-Za-z_][\w.-]*:\s*$/.test(line) && !/^\s/.test(line)) { inServices = false; current = null; continue; }
      if (!inServices) continue;
      const svc = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
      if (svc) {
        if (current) out.push(current);
        current = { name: svc[1], kind: 'app' };
        continue;
      }
      if (!current) continue;
      const img = /^ {4}image:\s*["']?([^"'\s]+)/.exec(line);
      if (img) {
        const image = img[1].toLowerCase();
        if (/postgres|mysql|mariadb|mongo|clickhouse/.test(image)) current.kind = 'database';
        else if (/redis|memcached|valkey/.test(image)) current.kind = 'cache';
        else if (/rabbitmq|kafka|nats|elasticsearch/.test(image)) current.kind = 'mq';
      }
      const port = /^\s*-\s*["']?(\d{2,5}):\d{2,5}["']?/.exec(line);
      if (port && !current.hostPort) current.hostPort = Number(port[1]);
    }
    if (current) out.push(current);
    return out;
  }

  /**
   * 检测 exe + bat 分发目录，从 bat 中提取 exe 启动命令。
   * 支持 PowerShell Start-Process 与直接调用两种写法。
   */
  private static detectBinaryDistribution(root: string): ServiceDraft | null {
    const files = fs.readdirSync(root);
    const exes = files.filter((f) => f.toLowerCase().endsWith('.exe'));
    if (!exes.length) return null;
    const bats = files.filter((f) => f.toLowerCase().endsWith('.bat') || f.toLowerCase().endsWith('.ps1'));
    if (!bats.length) return null;

    for (const bat of bats) {
      const content = fs.readFileSync(path.join(root, bat), 'utf-8');
      // PowerShell 写法：Start-Process -FilePath 'xxx.exe' -ArgumentList '-config','config.json'
      const ps = content.match(/Start-Process\s+-FilePath\s+['"]([^'"]+\.exe)['"](?:\s+-ArgumentList\s+(.+))?/i);
      if (ps) {
        const exe = path.basename(ps[1].replace(/%~dp0/gi, ''));
        const argList = ps[2] ?? '';
        const args = [...argList.matchAll(/['"]([^'"]+)['"]/g)]
          .map((m) => m[1])
          .filter((a) => !/^%~[a-z0-9]+$/i.test(a) && !/^(WindowStyle|WorkingDirectory|PassThru)$/i.test(a) && !/^Hidden$/i.test(a) && a !== exe.replace(/\.exe$/i, ''))
          .join(' ');
        const port = this.detectPort(root);
        return {
          name: exe.replace(/\.exe$/i, ''),
          service_type: 'backend',
          workdir: root,
          start_command: args ? `${exe} ${args}` : exe,
          port,
        };
      }
      // 直接调用写法：xxx.exe -arg value（跳过注释/回显行）
      for (const line of content.split(/\r?\n/)) {
        const m = line.match(/^\s*((?:"[^"]+"|[\w.\-]+)\.exe)\s*(.*)$/i);
        if (m && !line.trim().startsWith('rem') && !line.trim().startsWith('::') && !line.includes('taskkill')) {
          const exe = m[1].replace(/"/g, '');
          if (exes.some((e) => e.toLowerCase() === exe.toLowerCase())) {
            return {
              name: exe.replace(/\.exe$/i, ''),
              service_type: 'backend',
              workdir: root,
              start_command: `${exe} ${m[2]}`.trim(),
              port: this.detectPort(root),
            };
          }
        }
      }
    }
    return null;
  }

  /** 读取 pyproject.toml / requirements.txt 里的依赖名集合（小写归一） */
  private static pythonDependencies(root: string): Set<string> {
    const deps = new Set<string>();
    const add = (n: string) => {
      const norm = n.toLowerCase().replace(/_/g, '-');
      if (norm) deps.add(norm);
    };
    const req = path.join(root, 'requirements.txt');
    if (fs.existsSync(req)) {
      for (const l of fs.readFileSync(req, 'utf-8').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9_.\-]+)/.exec(l);
        if (m) add(m[1]);
      }
    }
    const pyproject = path.join(root, 'pyproject.toml');
    if (fs.existsSync(pyproject)) {
      // 逐行扫描 dependencies 数组（不能用 [^\]]* 正则：包名里的 extras 如 uvicorn[standard] 含 ]）
      const lines = fs.readFileSync(pyproject, 'utf-8').split(/\r?\n/);
      let inDeps = false;
      for (const l of lines) {
        if (!inDeps) {
          if (/^\s*dependencies\s*=\s*\[/i.test(l)) inDeps = true;
          continue;
        }
        if (/^\s*\]\s*$/.test(l)) break; // 数组结束
        const d = /["']([A-Za-z0-9_.\-]+)/.exec(l);
        if (d) add(d[1]);
      }
    }
    return deps;
  }

  /**
   * 找 uvicorn 入口：根目录与 app/backend/src/server/api 一级子目录下的 main.py / app.py。
   * 返回 uvicorn 模块路径（如 app.main:app），找不到返回 null。
   */
  private static findUvicornEntry(root: string): string | null {
    const subdirs = ['', 'app', 'backend', 'src', 'server', 'api'];
    for (const d of subdirs) {
      const dir = d ? path.join(root, d) : root;
      if (!fs.existsSync(dir)) continue;
      for (const f of ['main.py', 'app.py']) {
        if (!fs.existsSync(path.join(dir, f))) continue;
        const moduleName = d ? `${d}.${f.replace(/\.py$/, '')}` : f.replace(/\.py$/, '');
        return `${moduleName}:app`;
      }
    }
    return null;
  }

  /**
   * CLI 工具型 Python 包识别：返回可用 `python -m <pkg>` 执行的包名，找不到返回 null。
   * 判据：顶层非代码目录里存在 __main__.py（`python -m pkg` 的硬性要求）；
   * pyproject.toml 的 poetry packages include / console scripts 作为兜底线索。
   */
  private static pythonCliPackage(root: string): string | null {
    // 顶层包目录含 __main__.py（排除 tests/docs 等非代码目录与打包产物）
    const NON_CODE = new Set(['tests', 'test', 'docs', 'doc', 'devel', 'examples', 'scripts', 'build', 'dist', 'src', 'resources']);
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !NON_CODE.has(d.name.toLowerCase()));
    const withMain = dirs.find((d) => fs.existsSync(path.join(root, d.name, '__main__.py')));
    if (withMain) return withMain.name;

    // 兜底：pyproject.toml 声明的 poetry include 包
    const pyproject = path.join(root, 'pyproject.toml');
    if (fs.existsSync(pyproject)) {
      const text = fs.readFileSync(pyproject, 'utf-8');
      const inc = text.match(/packages\s*=\s*\[\s*\{\s*include\s*=\s*["']([\w.]+)["']/);
      if (inc && fs.existsSync(path.join(root, inc[1].split('.')[0], '__main__.py'))) return inc[1].split('.')[0];
    }
    return null;
  }

  /** 找 Streamlit 入口：root / ui / pages / app / webui / streamlit 下第一个 import streamlit 的 .py */
  private static findStreamlitEntry(root: string): string | null {    const subdirs = ['', 'ui', 'pages', 'app', 'webui', 'streamlit'];
    for (const d of subdirs) {
      const dir = d ? path.join(root, d) : root;
      if (!fs.existsSync(dir)) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.py')) continue;
        if (/^(test_|_)/.test(e.name)) continue;
        try {
          const head = fs.readFileSync(path.join(dir, e.name), 'utf-8').slice(0, 4000);
          if (/^\s*(import\s+streamlit|from\s+streamlit)/m.test(head)) {
            return d ? `${d}/${e.name}` : e.name;
          }
        } catch { /* 读不到就跳过 */ }
      }
    }
    return null;
  }

  private static looksLikeProject(root: string): boolean {
    return fs.existsSync(path.join(root, '.git')) || fs.existsSync(path.join(root, 'README.md'));
  }

  private static detectPort(root: string): number | undefined {
    // Spring Boot: application.properties 的 server.port=N（回归：之前只扫 vite/webpack/.env）
    const props = path.join(root, 'application.properties');
    if (fs.existsSync(props)) {
      const m = fs.readFileSync(props, 'utf-8').match(/^\s*server\.port\s*=\s*(\d{2,5})\s*$/m);
      if (m) return Number(m[1]);
    }
    const candidates = ['vite.config.ts', 'vite.config.js', 'vue.config.js', 'webpack.config.js', '.env'];
    for (const f of candidates) {
      const p = path.join(root, f);
      if (!fs.existsSync(p)) continue;
      const m = fs.readFileSync(p, 'utf-8').match(/port\s*[:=]\s*(\d{2,5})/i);
      if (m) return Number(m[1]);
    }
    // 独立服务配置：config.json 的 listen 字段（"127.0.0.1:7863" 形式）
    const cfg = path.join(root, 'config.json');
    if (fs.existsSync(cfg)) {
      const m = fs.readFileSync(cfg, 'utf-8').match(/"listen"\s*:\s*"[\d.]*:(\d{2,5})"/);
      if (m) return Number(m[1]);
    }
    // JS 入口 listen 端口（const PORT = 1234; ... listen(PORT) 或 listen(1234)）
    const jsPort = this.detectJsListenPort(root);
    if (jsPort) return jsPort;
    // Python 入口 uvicorn.run(..., port=N)
    for (const f of ['main.py', 'app.py', 'server.py', 'webui.py']) {
      const p = path.join(root, f);
      if (!fs.existsSync(p)) continue;
      const port = this.detectUvicornPort(p);
      if (port) return port;
    }
    return undefined;
  }

  /** 从 JS 入口文件解析 listen 端口（仅扫根目录一层，跳过 node_modules） */
  private static detectJsListenPort(root: string): number | undefined {
    let files: string[] = [];
    try {
      files = fs.readdirSync(root).filter((f) => /\.(js|ts|mjs|cjs)$/i.test(f)).map((f) => path.join(root, f));
    } catch { return undefined; }
    for (const file of files) {
      let text: string;
      try { text = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      const m = text.match(/\.listen\(\s*(\d{2,5})\b/);
      if (m) return Number(m[1]);
      const varM = text.match(/\.listen\(\s*([A-Za-z_$][\w$]*)/);
      if (varM) {
        const def = text.match(new RegExp(`(?:const|let|var)\\s+${varM[1]}\\s*=\\s*(\\d{2,5})`));
        if (def) return Number(def[1]);
      }
    }
    return undefined;
  }

  /** 从 uvicorn.run(..., port=N) 解析端口 */
  private static detectUvicornPort(entryFile: string): number | undefined {
    try {
      const text = fs.readFileSync(entryFile, 'utf-8');
      const m = text.match(/uvicorn\.run\([^)]{0,300}?port\s*=\s*(\d{2,5})/s);
      if (m) return Number(m[1]);
    } catch { /* ignore */ }
    return undefined;
  }

  /** 无 package.json 的纯 node 服务：扫描根目录 JS/TS，取第一个含 listen 的入口 */
  private static detectJsListenService(root: string): ServiceDraft | null {
    let files: string[] = [];
    try {
      files = fs.readdirSync(root).filter((f) => /\.(js|ts|mjs|cjs)$/i.test(f)).map((f) => path.join(root, f));
    } catch { return null; }
    // 常见命名优先
    files.sort((a, b) => {
      const rank = (p: string) => (/^(server|app|index|main)\.(js|ts|mjs|cjs)$/i.test(path.basename(p)) ? 0 : 1);
      return rank(a) - rank(b);
    });
    for ( const file of files) {
      // 测试/配置文件不是服务入口（.test.mjs 内嵌 listen 曾被误识别成服务）
      if (/\.(test|spec|config|setup)\.(js|ts|mjs|cjs)$/i.test(path.basename(file))) continue;
      let text: string;
      try { text = fs.readFileSync(file, 'utf-8'); } catch { continue; }
      if (!/\.listen\(/.test(text)) continue;
      const port = this.detectJsListenPort(root);
      // 静态 HTML 服务 → frontend；API/JSON 服务 → backend
      const kind: 'frontend' | 'backend' = /text\/html|sendFile|\.html/i.test(text) ? 'frontend' : 'backend';
      return {
        name: `${path.basename(root)}-node`,
        service_type: kind,
        workdir: root,
        start_command: `node ${path.basename(file)}`,
        port,
      };
    }
    return null;
  }
}
