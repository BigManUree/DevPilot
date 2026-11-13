import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProfileEngine } from './profile';
import { nodeConstraint, javaConstraint, pythonConstraint, parseEnvTemplate } from './constraints';
import { satisfiesConstraint } from '../../environments/version-scan';

function makeTempProject(files: Record<string, string>, dirs: Record<string, Record<string, string>> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-profile-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
  }
  for (const [dir, subFiles] of Object.entries(dirs)) {
    for (const [rel, content] of Object.entries(subFiles)) {
      const p = path.join(root, dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    }
  }
  return root;
}

describe('ProfileEngine 组件树档案', () => {
  it('前后端分离项目：识别 vue 前端 + spring-boot 后端 + compose 数据库，含证据与版本约束', () => {
    const root = makeTempProject(
      {
        'docker-compose.yml': 'services:\n  db:\n    image: mysql:8.0\n    ports:\n      - "3306:3306"\n',
        '.env.example': 'DB_PASSWORD=\nREDIS_HOST=127.0.0.1\nAPI_KEY=changeme\n',
      },
      {
        frontend: {
          'package.json': JSON.stringify({ name: 'web', dependencies: { vue: '^3.4.0' }, devDependencies: { vite: '^5.0.0' }, scripts: { dev: 'vite --port 5173' } }),
          '.nvmrc': '20.11.0\n',
        },
        backend: {
          'pom.xml': '<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId></parent><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>',
        },
      },
    );
    const profile = ProfileEngine.build(root);
    try {
      expect(profile.components.length).toBeGreaterThanOrEqual(3);
      const fe = profile.components.find((c) => c.name === 'frontend');
      const be = profile.components.find((c) => c.name === 'backend');
      expect(fe).toBeDefined();
      expect(fe!.framework).toBe('vue');
      expect(fe!.runtime!.languageVersion).toBe('20.11.0');
      expect(fe!.runtime!.packageManager).toBe('npm');
      expect(fe!.evidence.length).toBeGreaterThan(0);
      expect(fe!.confidence).toBeGreaterThan(0.5);
      expect(be).toBeDefined();
      expect(be!.framework).toBe('spring-boot');
      expect(be!.runtime!.languageVersion).toBe('17');
      expect(be!.runtime!.devStartCommand).toContain('spring-boot:run');
      // 指纹稳定性
      const again = ProfileEngine.build(root);
      expect(again.fingerprint).toBe(profile.fingerprint);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Python FastAPI 项目：识别框架与包管理器（uv.lock 优先）', () => {
    const root = makeTempProject(
      {
        'pyproject.toml': '[project]\nname="demo"\ndependencies=["fastapi>=0.110","uvicorn[standard]"]\nrequires-python=">=3.10"\n',
        'uv.lock': '',
        'main.py': 'from fastapi import FastAPI\napp=FastAPI()\n',
      },
    );
    try {
      const profile = ProfileEngine.build(root);
      const comp = profile.components[0];
      expect(comp.language).toBe('python');
      expect(comp.framework).toBe('fastapi');
      expect(comp.packageManager).toBe('uv');
      expect(comp.runtime!.languageVersion).toBe('>=3.10');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('monorepo packages/* 二级目录组件发现', () => {
    const root = makeTempProject({}, {
      'packages/api': { 'package.json': JSON.stringify({ dependencies: { express: '^4' } }) },
      'packages/web': { 'package.json': JSON.stringify({ dependencies: { react: '^18' }, devDependencies: { vite: '^5' } }) },
    });
    try {
      const profile = ProfileEngine.build(root);
      expect(profile.components.some((c) => c.path === 'packages/api')).toBe(true);
      expect(profile.components.some((c) => c.path === 'packages/web')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('空目录：unknowns 非空，不伪造识别结果', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-empty-'));
    try {
      const profile = ProfileEngine.build(root);
      expect(profile.components.length).toBe(0);
      expect(profile.needsConfirmation.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('版本约束解析', () => {
  it('satisfiesConstraint：精确主版本 / 范围 / ^ ~', () => {
    expect(satisfiesConstraint('17.0.9', '17')).toBe(true);
    expect(satisfiesConstraint('8.0.302', '17')).toBe(false);
    expect(satisfiesConstraint('3.11.2', '>=3.10')).toBe(true);
    expect(satisfiesConstraint('3.9.1', '>=3.10')).toBe(false);
    expect(satisfiesConstraint('20.11.0', '^20')).toBe(true);
    expect(satisfiesConstraint('21.0.0', '^20')).toBe(false);
    expect(satisfiesConstraint('1.2.5', '~1.2')).toBe(true);
    expect(satisfiesConstraint('1.3.0', '~1.2')).toBe(false);
  });

  it('nodeConstraint：engines / .nvmrc', () => {
    const root = makeTempProject({ 'package.json': JSON.stringify({ engines: { node: '>=18' } }), '.nvmrc': '20.10.0' });
    try {
      expect(nodeConstraint(root)?.value).toBe('20.10.0');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('javaConstraint：maven.compiler.release', () => {
    const root = makeTempProject({ 'pom.xml': '<project><properties><maven.compiler.release>21</maven.compiler.release></properties></project>' });
    try {
      expect(javaConstraint(root)?.value).toBe('21');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('pythonConstraint：requires-python', () => {
    const root = makeTempProject({ 'pyproject.toml': '[project]\nrequires-python=">=3.11"\n' });
    try {
      expect(pythonConstraint(root)?.value).toBe('>=3.11');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('parseEnvTemplate：必需/默认/敏感变量', () => {
    const root = makeTempProject({ '.env.example': 'DB_PASSWORD=\nREDIS_HOST=127.0.0.1\nAPI_KEY=changeme\n' });
    try {
      const parsed = parseEnvTemplate(root)!;
      const byKey = Object.fromEntries(parsed.vars.map((v) => [v.key, v]));
      expect(byKey['DB_PASSWORD'].required).toBe(true);
      expect(byKey['REDIS_HOST'].hasDefault).toBe(true);
      expect(byKey['API_KEY'].sensitive).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
