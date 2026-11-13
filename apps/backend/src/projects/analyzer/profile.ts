import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ProjectProfile, ProjectComponent, ComponentRuntime, Finding, AnalysisEvidence } from '@devpilot/shared-types';
import {
  nodeConstraint, pythonConstraint, javaConstraint, goConstraint, rustConstraint, phpConstraint,
  gradleConstraint, detectPackageManager, parseEnvTemplate, parseSpringConfig,
  parseComposeServices, matchServiceType, inferDefaultPort, inferExternalServicesFromDeps,
} from './constraints';

/**
 * 项目分析档案引擎 v2：
 * - 组件树（根组件 + 一级/二级子项目组件），不再把多技术栈压成单值
 * - 每个判断带 evidence + 置信度（规则计算）
 * - 运行约束（语言版本/包管理器/启动命令/端口/环境变量/外部服务）从 manifest 真实解析
 * - 指纹 = 关键 manifest 内容 hash（档案缓存失效依据）
 */

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'vendor', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'out', '.next', '.nuxt']);

const MANIFEST_FILES = [
  'package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py', 'go.mod', 'Cargo.toml', 'composer.json',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml', '.env.example',
];

function exists(p: string): boolean {
  try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
}

function readSmall(p: string, max = 256 * 1024): string | null {
  try {
    const st = fs.statSync(p);
    if (st.size > max) return null;
    return fs.readFileSync(p, 'utf-8');
  } catch { return null; }
}

function finding(value: string, confidence: number, evidence: AnalysisEvidence[]): Finding {
  return { value, confidence, evidence, verified: false };
}

/** 收集根 + 一级 + 明显子项目层级的 manifest 路径 */
function discoverComponentDirs(root: string): Array<{ dir: string; rel: string }> {
  const out: Array<{ dir: string; rel: string }> = [{ dir: root, rel: '' }];
  let level1: string[] = [];
  try {
    level1 = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !IGNORE_DIRS.has(d.name) && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch { return out; }
  for (const name of level1) {
    const dir = path.join(root, name);
    const hasManifest = MANIFEST_FILES.some((f) => exists(path.join(dir, f)));
    if (hasManifest) out.push({ dir, rel: name });
    // 二级：常见 monorepo packages/* / apps/*（仅当一级目录本身没有 manifest）
    if (!hasManifest && /^(packages|apps|modules|services|libs|projects|src)$/i.test(name)) {
      try {
        const sub = fs.readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !IGNORE_DIRS.has(d.name) && !d.name.startsWith('.'))
          .map((d) => d.name);
        for (const s of sub) {
          const sdir = path.join(dir, s);
          if (MANIFEST_FILES.some((f) => exists(path.join(sdir, f)))) out.push({ dir: sdir, rel: `${name}/${s}` });
        }
      } catch { /* ignore */ }
    }
  }
  return out;
}

/** 单目录组件识别 */
function buildComponent(dir: string, rel: string): ProjectComponent | null {
  const ev = (file: string, reason: string, snippet?: string): AnalysisEvidence => ({ file: rel ? `${rel}/${file}` : file, reason, snippet });
  const id = rel || 'root';
  const name = rel || path.basename(dir);

  // ---- Node.js ----
  const pkgPath = path.join(dir, 'package.json');
  if (exists(pkgPath)) {
    const raw = readSmall(pkgPath);
    const evList: AnalysisEvidence[] = [ev('package.json', '发现 Node.js 清单文件')];
    let framework: string | null = null;
    let kind: ProjectComponent['kind'] = 'backend';
    let deps: Record<string, string> = {};
    let scripts: Record<string, string> = {};
    let lang = 'javascript';
    if (raw) {
      try {
        const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
        deps = { ...pkg.dependencies, ...pkg.devDependencies };
        scripts = pkg.scripts ?? {};
        if (deps.typescript || exists(path.join(dir, 'tsconfig.json'))) { lang = 'typescript'; evList.push(ev('tsconfig.json/typescript', 'TypeScript 依据')); }
        const fw: Array<[string, RegExp]> = [
          ['next', /^next$/], ['nuxt', /^nuxt$/], ['vue', /^vue$/], ['react', /^react$/], ['angular', /^@angular\/core$/],
          ['vite', /^vite$/], ['webpack', /^webpack$/], ['nestjs', /^@nestjs\/core$/], ['express', /^express$/], ['koa', /^koa$/],
          ['electron', /^electron$/],
        ];
        for (const [name2, re] of fw) {
          if (Object.keys(deps).some((d) => re.test(d))) { framework = name2; evList.push(ev('package.json', `依赖含 ${name2}`)); break; }
        }
        const frontendDeps = ['vite', 'webpack', 'vue', 'react', '@angular/core', 'next', 'nuxt'];
        const isFrontend = frontendDeps.some((d) => deps[d]) || !!scripts.dev?.match(/vite|next dev|nuxt|webpack-serve/);
        kind = isFrontend && (deps.express || deps['@nestjs/core'] || deps.koa) ? 'fullstack' : isFrontend ? 'frontend' : deps.express || deps['@nestjs/core'] || deps.koa ? 'backend' : 'library';
        if (isFrontend) evList.push(ev('package.json', '前端构建工具/框架依赖判定为前端组件'));
      } catch { evList.push(ev('package.json', 'package.json 解析失败（JSON 非法）')); }
    }
    const pm = detectPackageManager(dir);
    if (pm) evList.push(ev(pm.source, `包管理器依据：${pm.source}`));
    const ver = nodeConstraint(dir);
    if (ver) evList.push(ev(ver.source, `Node 版本约束：${ver.value}`));
    const envVars = parseEnvTemplate(dir)?.vars ?? [];
    const startScript = scripts.dev ?? scripts.start ?? scripts.serve ?? null;
    const runtime: ComponentRuntime = {
      languageVersion: ver?.value ?? null,
      languageVersionSource: ver?.source ?? null,
      packageManager: pm?.name ?? 'npm',
      packageManagerVersion: pm?.version ?? null,
      buildCommand: scripts.build ?? null,
      devStartCommand: scripts.dev ?? scripts.start ?? null,
      prodStartCommand: scripts.start ?? null,
      testCommand: scripts.test ?? null,
      port: detectPortFromFiles(dir),
      envVars,
      externalServices: parseComposeServices(dir)?.services ?? [],
    };
    return {
      id, name, path: rel, kind, language: lang, framework,
      packageManager: pm?.name ?? 'npm', confidence: 0.95, evidence: evList,
      runtime, dependsOn: [],
    };
  }

  // ---- Java (Maven/Gradle) ----
  const isMaven = exists(path.join(dir, 'pom.xml'));
  const isGradle = exists(path.join(dir, 'build.gradle')) || exists(path.join(dir, 'build.gradle.kts')) || exists(path.join(dir, 'settings.gradle')) || exists(path.join(dir, 'settings.gradle.kts'));
  if (isMaven || isGradle) {
    const evList: AnalysisEvidence[] = [isMaven ? ev('pom.xml', '发现 Maven 构建文件') : ev('build.gradle', '发现 Gradle 构建文件')];
    let framework: string | null = null;
    let springBoot = false;
    if (isMaven) {
      const pom = readSmall(path.join(dir, 'pom.xml'));
      if (pom) {
        springBoot = /spring-boot-starter/i.test(pom) || /<parent>[\s\S]*spring-boot-starter/i.test(pom);
        if (springBoot) { framework = 'spring-boot'; evList.push(ev('pom.xml', '依赖含 spring-boot-starter')); }
        else if (/mybatis/i.test(pom)) { framework = 'mybatis'; evList.push(ev('pom.xml', '依赖含 mybatis')); }
        else if (/spring-web|springmvc/i.test(pom)) { framework = 'spring-mvc'; evList.push(ev('pom.xml', '依赖含 spring-web')); }
        if (/spring-cloud/i.test(pom)) { framework = `${framework ?? 'spring'}+spring-cloud`; evList.push(ev('pom.xml', '依赖含 spring-cloud')); }
      }
    } else {
      const bg = readSmall(path.join(dir, isGradle && exists(path.join(dir, 'build.gradle.kts')) ? 'build.gradle.kts' : 'build.gradle'));
      if (bg && /spring-boot/i.test(bg)) { framework = 'spring-boot'; springBoot = true; evList.push(ev('build.gradle', '依赖含 spring-boot')); }
    }
    const jv = javaConstraint(dir);
    if (jv) evList.push(ev(jv.source, `Java 版本约束：${jv.value}`));
    const gv = gradleConstraint(dir);
    if (gv && isGradle) evList.push(ev(gv.source, `Gradle 版本约束：${gv.value}`));
    // 多模块检测：pom modules
    let multiModule = false;
    if (isMaven) {
      const pom = readSmall(path.join(dir, 'pom.xml'));
      if (pom && /<modules>/i.test(pom)) { multiModule = true; evList.push(ev('pom.xml', '<modules> 声明为多模块 Maven 项目')); }
    }
    const springCfg = parseSpringConfig(dir);
    const envVars = springCfg ?? parseEnvTemplate(dir)?.vars ?? [];
    const extServices = parseComposeServices(dir)?.services ?? [];
    const appProps = readSmall(path.join(dir, 'src/main/resources/application.properties')) ?? readSmall(path.join(dir, 'src/main/resources/application.yml')) ?? '';
    const portMatch = appProps.match(/server\.port\s*[=:]\s*(\d{2,5})/);
    if (portMatch) evList.push(ev('application.properties', `server.port=${portMatch[1]}`));
    const runtime: ComponentRuntime = {
      languageVersion: jv?.value ?? null,
      languageVersionSource: jv?.source ?? null,
      packageManager: isMaven ? 'maven' : 'gradle',
      packageManagerVersion: gv?.value ?? null,
      buildCommand: isMaven ? 'mvn -q package -DskipTests' : '.\\gradlew build -x test',
      devStartCommand: isMaven ? (springBoot ? 'mvn spring-boot:run' : 'mvn exec:java') : (springBoot ? '.\\gradlew bootRun' : null),
      prodStartCommand: null,
      testCommand: isMaven ? 'mvn test' : '.\\gradlew test',
      port: portMatch ? Number(portMatch[1]) : detectPortFromFiles(dir),
      envVars,
      externalServices: extServices,
    };
    return {
      id, name, path: rel, kind: 'backend', language: 'java', framework,
      packageManager: runtime.packageManager, confidence: springBoot ? 0.9 : 0.85,
      evidence: evList, runtime, dependsOn: [],
    };
  }

  // ---- Python ----
  const pyManifest = (['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'] as const).find((f) => exists(path.join(dir, f)));
  if (pyManifest) {
    const evList: AnalysisEvidence[] = [ev(pyManifest, `发现 Python 清单文件 ${pyManifest}`)];
    let framework: string | null = null;
    const deps: string[] = [];
    const reqPath = path.join(dir, 'requirements.txt');
    if (pyManifest === 'requirements.txt' && exists(reqPath)) {
      for (const line of readSmall(reqPath)?.split(/\r?\n/) ?? []) {
        const m = line.match(/^\s*([A-Za-z0-9_.\[\]-]+)/);
        if (m && !line.trim().startsWith('#')) deps.push(m[1]);
      }
    } else {
      const pp = readSmall(path.join(dir, pyManifest));
      if (pp) {
        for (const m of pp.matchAll(/^\s*(?:dependencies\s*=\s*\[|"|')(fastapi|flask|django|uvicorn|streamlit|scrapy)[^\]]*$/gm)) deps.push(m[1]);
        for (const m of pp.matchAll(/["']([a-z0-9_-]+)[>=<~]/g)) deps.push(m[1]);
      }
    }
    const hasDjango = exists(path.join(dir, 'manage.py')) || deps.some((d) => /^django/i.test(d));
    const hasFastAPI = deps.some((d) => /^fastapi/i.test(d));
    const hasFlask = deps.some((d) => /^flask/i.test(d));
    const hasStreamlit = deps.some((d) => /^streamlit/i.test(d));
    if (hasDjango) { framework = 'django'; evList.push(ev('manage.py/依赖', 'Django 依据')); }
    else if (hasFastAPI) { framework = 'fastapi'; evList.push(ev(pyManifest, '依赖含 fastapi')); }
    else if (hasFlask) { framework = 'flask'; evList.push(ev(pyManifest, '依赖含 flask')); }
    else if (hasStreamlit) { framework = 'streamlit'; evList.push(ev(pyManifest, '依赖含 streamlit')); }
    const pv = pythonConstraint(dir);
    if (pv) evList.push(ev(pv.source, `Python 版本约束：${pv.value}`));
    const pm = detectPackageManager(dir);
    if (pm) evList.push(ev(pm.source, `包管理器依据：${pm.source}`));
    const envVars = parseEnvTemplate(dir)?.vars ?? [];
    const isCli = exists(path.join(dir, '__main__.py'));
    const runtime: ComponentRuntime = {
      languageVersion: pv?.value ?? null,
      languageVersionSource: pv?.source ?? null,
      packageManager: pm?.name ?? 'pip',
      packageManagerVersion: pm?.version ?? null,
      buildCommand: null,
      devStartCommand: hasDjango ? 'python manage.py runserver' : hasStreamlit ? 'python -m streamlit run app.py' : null,
      prodStartCommand: null,
      testCommand: null,
      port: hasDjango ? 8000 : detectPortFromFiles(dir),
      envVars,
      externalServices: inferExternalServicesFromDeps(deps),
    };
    return {
      id, name, path: rel, kind: isCli ? 'cli' : 'backend', language: 'python', framework,
      packageManager: pm?.name ?? 'pip', confidence: 0.9, evidence: evList, runtime, dependsOn: [],
    };
  }

  // ---- Go ----
  if (exists(path.join(dir, 'go.mod'))) {
    const gv = goConstraint(dir);
    const evList: AnalysisEvidence[] = [ev('go.mod', '发现 Go module 文件')];
    if (gv) evList.push(ev('go.mod', `Go 版本约束：${gv.value}`));
    const runtime: ComponentRuntime = {
      languageVersion: gv?.value ?? null, languageVersionSource: gv?.source ?? null,
      packageManager: 'go', packageManagerVersion: null,
      buildCommand: 'go build ./...', devStartCommand: 'go run .', prodStartCommand: null, testCommand: 'go test ./...',
      port: detectPortFromFiles(dir), envVars: [], externalServices: [],
    };
    return { id, name, path: rel, kind: 'backend', language: 'go', framework: null, packageManager: 'go', confidence: 0.95, evidence: evList, runtime, dependsOn: [] };
  }

  // ---- Rust ----
  if (exists(path.join(dir, 'Cargo.toml'))) {
    const rv = rustConstraint(dir);
    const evList: AnalysisEvidence[] = [ev('Cargo.toml', '发现 Rust Cargo 清单')];
    if (rv) evList.push(ev('Cargo.toml', `rustc 版本约束：${rv.value}`));
    const runtime: ComponentRuntime = {
      languageVersion: rv?.value ?? null, languageVersionSource: rv?.source ?? null,
      packageManager: 'cargo', packageManagerVersion: null,
      buildCommand: 'cargo build', devStartCommand: 'cargo run', prodStartCommand: null, testCommand: 'cargo test',
      port: detectPortFromFiles(dir), envVars: [], externalServices: [],
    };
    return { id, name, path: rel, kind: 'backend', language: 'rust', framework: null, packageManager: 'cargo', confidence: 0.95, evidence: evList, runtime, dependsOn: [] };
  }

  // ---- PHP ----
  if (exists(path.join(dir, 'composer.json'))) {
    const pv = phpConstraint(dir);
    const isLaravel = exists(path.join(dir, 'artisan'));
    const evList: AnalysisEvidence[] = [ev('composer.json', '发现 PHP Composer 清单')];
    if (isLaravel) evList.push(ev('artisan', '发现 Laravel artisan 入口'));
    const runtime: ComponentRuntime = {
      languageVersion: pv?.value ?? null, languageVersionSource: pv?.source ?? null,
      packageManager: 'composer', packageManagerVersion: null,
      buildCommand: null, devStartCommand: isLaravel ? 'php artisan serve' : null, prodStartCommand: null, testCommand: null,
      port: isLaravel ? 8000 : null, envVars: parseEnvTemplate(dir)?.vars ?? [], externalServices: [],
    };
    return { id, name, path: rel, kind: 'backend', language: 'php', framework: isLaravel ? 'laravel' : null, packageManager: 'composer', confidence: 0.9, evidence: evList, runtime, dependsOn: [] };
  }

  // ---- Docker Compose（服务编排组件） ----
  const compose = parseComposeServices(dir);
  if (compose?.raw) {
    const evList: AnalysisEvidence[] = [ev(compose.raw, '发现 Docker Compose 编排文件')];
    const runtime: ComponentRuntime = {
      languageVersion: null, languageVersionSource: null, packageManager: null, packageManagerVersion: null,
      buildCommand: null, devStartCommand: 'docker compose up -d', prodStartCommand: null, testCommand: null,
      port: null, envVars: parseEnvTemplate(dir)?.vars ?? [], externalServices: compose.services,
    };
    return { id, name, path: rel, kind: 'docker', language: null, framework: 'docker-compose', packageManager: null, confidence: 0.9, evidence: evList, runtime, dependsOn: [] };
  }

  // ---- Dockerfile 单独存在 ----
  if (exists(path.join(dir, 'Dockerfile'))) {
    const evList: AnalysisEvidence[] = [ev('Dockerfile', '发现 Dockerfile')];
    const dockerfile = readSmall(path.join(dir, 'Dockerfile'));
    if (dockerfile) {
      const base = dockerfile.match(/^FROM\s+([^\s]+)/m);
      if (base) evList.push(ev('Dockerfile', `基础镜像 ${base[1]}`));
    }
    const runtime: ComponentRuntime = {
      languageVersion: null, languageVersionSource: null, packageManager: null, packageManagerVersion: null,
      buildCommand: 'docker build -t <IMAGE> .', devStartCommand: null, prodStartCommand: null, testCommand: null,
      port: detectPortFromFiles(dir), envVars: [], externalServices: [],
    };
    return { id, name, path: rel, kind: 'docker', language: null, framework: 'docker', packageManager: null, confidence: 0.85, evidence: evList, runtime, dependsOn: [] };
  }

  return null;
}

function detectPortFromFiles(dir: string): number | null {
  for (const f of ['vite.config.ts', 'vite.config.js', 'vue.config.js', 'webpack.config.js', 'config.json', '.env', 'application.properties', 'application.yml']) {
    const t = readSmall(path.join(dir, f), 128 * 1024);
    if (!t) continue;
    const m = t.match(/(?:port|listen|"listen")\s*[:=]\s*["']?(?:[\d.]*:)?(\d{2,5})["']?/i);
    if (m) {
      const p = Number(m[1]);
      if (p >= 1 && p <= 65535) return p;
    }
  }
  return null;
}

/** 二进制/构建产物目录识别（exe/jar 分发，无源码） */
function detectBinaryComponent(root: string): ProjectComponent | null {
  try {
    const files = fs.readdirSync(root).map((f) => f.toLowerCase());
    const exe = files.filter((f) => f.endsWith('.exe')).length;
    const jar = files.filter((f) => f.endsWith('.jar')).length;
    if (exe > 0 || jar > 0) {
      const evidence: AnalysisEvidence[] = [{ file: exe ? '*.exe' : '*.jar', reason: '目录含可执行产物，识别为运行产物（非源码项目）' }];
      return {
        id: 'binary', name: path.basename(root), path: '', kind: 'binary', language: jar ? 'java' : null, framework: null,
        packageManager: null, confidence: 0.8, evidence, runtime: null, dependsOn: [],
      };
    }
  } catch { /* ignore */ }
  return null;
}

/** 项目指纹：关键 manifest 的 name+内容 hash，用于档案缓存失效 */
function computeFingerprint(root: string): string {
  const hash = createHash('sha256');
  const collect = (dir: string, rel: string) => {
    for (const f of MANIFEST_FILES) {
      const p = path.join(dir, f);
      if (!exists(p)) continue;
      const content = readSmall(p, 256 * 1024) ?? '';
      hash.update(`${rel}/${f}:${content.length}:${createHash('sha1').update(content).digest('hex')};`);
    }
  };
  collect(root, '');
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory() && !IGNORE_DIRS.has(d.name) && !d.name.startsWith('.')) collect(path.join(root, d.name), d.name);
    }
  } catch { /* ignore */ }
  return hash.digest('hex').slice(0, 32);
}

export class ProfileEngine {
  /** 构建结构化项目档案 */
  static build(root: string): ProjectProfile {
    const dirs = discoverComponentDirs(root);
    const components: ProjectComponent[] = [];
    for (const { dir, rel } of dirs) {
      const c = buildComponent(dir, rel);
      if (c) components.push(c);
    }
    if (!components.length) {
      const bin = detectBinaryComponent(root);
      if (bin) components.push(bin);
    }

    // 根组件
    const rootComp = components.find((c) => c.path === '');
    const multi = components.filter((c) => c.path !== '');
    const needsConfirmation: string[] = [];
    if (!components.length) needsConfirmation.push('未识别出任何技术栈组件，需要用户确认项目类型');
    if (multi.length > 1) needsConfirmation.push(`识别出 ${multi.length} 个子组件，请确认组件关系与启动顺序`);

    // 组件依赖推断：compose 服务依赖 + 前后端端口引用
    for (const c of components) {
      if (c.kind === 'docker' && c.runtime?.externalServices?.length) continue; // compose 自身即编排
      if (c.runtime?.externalServices?.length) {
        const svcComps = components.filter((x) => x.kind === 'docker');
        c.dependsOn.push(...svcComps.map((x) => x.id));
      }
    }

    const language = rootComp?.language ? finding(rootComp.language, rootComp.confidence, rootComp.evidence) : multi.length ? finding(multi[0].language ?? 'unknown', multi[0].confidence, multi[0].evidence) : null;
    const framework = rootComp?.framework ? finding(rootComp.framework, rootComp.confidence, rootComp.evidence) : multi.length && multi[0].framework ? finding(multi[0].framework, multi[0].confidence, multi[0].evidence) : null;
    const packageManager = rootComp?.packageManager ? finding(rootComp.packageManager, 0.9, rootComp.evidence) : null;

    return {
      fingerprint: computeFingerprint(root),
      analyzedAt: new Date().toISOString(),
      language,
      framework,
      packageManager,
      components,
      rootComponentId: rootComp?.id ?? null,
      unknowns: needsConfirmation,
      needsConfirmation,
    };
  }
}
