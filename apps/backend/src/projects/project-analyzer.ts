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
      .map((d) => path.join(root, d.name));
    dirs.unshift(root); // 根目录优先

    for (const dir of dirs) {
      const r = this.analyzeDir(dir);
      if (r.facts.language) Object.assign(facts, r.facts, facts.language ? {} : {});
      services.push(...r.services);
      if (dir !== root && r.facts.language) unknowns.push(...r.unknowns);
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
        // 前端/后端启发式：存在构建产物目录或 vite/webpack 依赖 → frontend，否则 backend
        const isFrontend = !!(deps.vite || deps.webpack || deps['vue'] || deps.react);
        services.push({
          name: pkg.name ? `${pkg.name}-main` : 'node-main',
          service_type: isFrontend ? 'frontend' : 'backend',
          workdir: root,
          start_command: `npm run ${(scripts.dev ? 'dev' : scripts.start ? 'start' : 'serve')}`,
          build_command: scripts.build ? 'npm run build' : undefined,
          port: this.detectPort(root),
        });
      } else {
        unknowns.push('package.json 存在但没有可识别的 dev/start 脚本');
      }
      if (!Object.keys(deps).length) unknowns.push('依赖未安装（node_modules 缺失或锁文件为空）');
    }

    // Java / Maven
    if (has('pom.xml')) {
      facts.language = 'java';
      facts.framework = facts.framework ?? 'spring-boot(候选)';
      facts.package_manager = 'maven';
      const port = this.detectPort(root) ?? 8080;
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
      if (has('manage.py')) {
        facts.framework = 'django';
        services.push({
          name: 'django',
          service_type: 'backend',
          workdir: root,
          start_command: 'python manage.py runserver',
          port: 8000,
        });
      } else if (has('app.py', 'main.py')) {
        facts.framework = 'flask/fastapi(候选)';
        services.push({
          name: 'python-app',
          service_type: 'backend',
          workdir: root,
          start_command: 'python app.py',
        });
        unknowns.push('Python 入口文件按 app.py 猜测，需确认');
      } else {
        unknowns.push('Python 项目：未找到入口文件');
      }
    }

    // Go / Rust / PHP
    if (has('go.mod')) {
      facts.language = 'go';
      services.push({ name: 'go-app', service_type: 'backend', workdir: root, start_command: 'go run .' });
      unknowns.push('Go 项目：入口与端口需确认');
    }
    if (has('Cargo.toml')) {
      facts.language = 'rust';
      services.push({ name: 'rust-app', service_type: 'backend', workdir: root, start_command: 'cargo run' });
    }
    if (has('composer.json')) {
      facts.language = 'php';
      unknowns.push('PHP 项目：启动方式需确认');
    }

    // docker-compose → 基础服务（DB/缓存类标记 shared 候选）
    const compose = path.join(root, 'docker-compose.yml');
    if (fs.existsSync(compose)) {
      facts.project_type = 'docker-compose';
      const text = fs.readFileSync(compose, 'utf-8');
      for (const [svc, type] of [
        ['mysql', 'database'], ['postgres', 'database'], ['redis', 'cache'],
        ['mongo', 'database'], ['rabbitmq', 'mq'], ['kafka', 'mq'],
      ] as const) {
        if (text.includes(svc)) {
          services.push({
            name: svc,
            service_type: type,
            workdir: root,
            start_command: `docker compose up -d ${svc}`,
            shared: true,
          });
        }
      }
    }

    // .NET
    if (fs.readdirSync(root).some((f) => f.endsWith('.sln'))) {
      facts.language = 'c#';
      unknowns.push('.NET 解决方案：项目结构需进一步分析');
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

  private static looksLikeProject(root: string): boolean {
    return fs.existsSync(path.join(root, '.git')) || fs.existsSync(path.join(root, 'README.md'));
  }

  private static detectPort(root: string): number | undefined {
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
    return undefined;
  }
}
