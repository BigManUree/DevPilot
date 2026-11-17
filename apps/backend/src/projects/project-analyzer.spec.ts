import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectAnalyzer } from './project-analyzer';

/** 回归：分析器端口解析与无 package.json 服务识别（审计第二轮 E2E 发现的缺陷） */
describe('ProjectAnalyzer 端口解析与服务识别（第二轮审计回归）', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-analyzer-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('Spring Boot：解析 src/main/resources/application.properties 的 server.port', () => {
    const proj = path.join(tmp, 'spring');
    fs.mkdirSync(path.join(proj, 'src', 'main', 'resources'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'pom.xml'), '<project/>');
    fs.writeFileSync(path.join(proj, 'src', 'main', 'resources', 'application.properties'), 'server.port=19124\n');
    const r = ProjectAnalyzer.analyze(proj);
    const svc = r.services.find((s) => s.name === 'java-backend');
    expect(svc?.port).toBe(19124);
  });

  it('FastAPI：解析 uvicorn.run(..., port=N)，不再硬编码 8000', () => {
    const proj = path.join(tmp, 'fastapi');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'requirements.txt'), 'fastapi\nuvicorn\n');
    fs.writeFileSync(path.join(proj, 'main.py'), `from fastapi import FastAPI\napp = FastAPI()\nif __name__ == "__main__":\n    import uvicorn\n    uvicorn.run(app, host="127.0.0.1", port=19125)\n`);
    const r = ProjectAnalyzer.analyze(proj);
    const svc = r.services.find((s) => s.name === 'fastapi-backend');
    expect(svc?.port).toBe(19125);
    expect(svc?.start_command).toContain('--port 19125');
  });

  it('无 package.json 的 node 服务（listen 端口）被识别为 backend', () => {
    const proj = path.join(tmp, 'split');
    const be = path.join(proj, 'backend');
    fs.mkdirSync(be, { recursive: true });
    fs.writeFileSync(path.join(be, 'server.js'), `const http=require('http');http.createServer((q,s)=>{s.end('{}')}).listen(19126);`);
    const r = ProjectAnalyzer.analyze(proj);
    const svc = r.services.find((s) => s.name === 'backend-node');
    expect(svc).toBeTruthy();
    expect(svc?.service_type).toBe('backend');
    expect(svc?.port).toBe(19126);
    expect(svc?.start_command).toBe('node server.js');
  });

  it('无依赖声明但服务 HTML 的 node 项目归类为 frontend', () => {
    const proj = path.join(tmp, 'fe');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'fe', scripts: { start: 'node server.js' } }));
    fs.writeFileSync(path.join(proj, 'server.js'), `http.createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<h1/>')}).listen(19127);`);
    const r = ProjectAnalyzer.analyze(proj);
    const svc = r.services[0];
    expect(svc.service_type).toBe('frontend');
    expect(svc.port).toBe(19127);
  });

  it('JS listen 直接端口号与常量两种写法都能解析', () => {
    const proj = path.join(tmp, 'ports');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'a.js'), `const PORT = 19001; http.createServer().listen(PORT);`);
    expect(ProjectAnalyzer.analyze(proj).services[0]?.port).toBe(19001);
  });

  it('Go：module 名识别 + main.go 存在生成 go run . 服务', () => {
    const proj = path.join(tmp, 'gosvc');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'go.mod'), 'module github.com/user/eval-svc\n\ngo 1.21\n');
    fs.writeFileSync(path.join(proj, 'main.go'), 'package main\nfunc main() {}');
    const r = ProjectAnalyzer.analyze(proj);
    expect(r.facts.language).toBe('go');
    const svc = r.services[0];
    expect(svc?.start_command).toBe('go run .');
    expect(svc?.name).toBe('eval-svc');
  });

  it('Go：无 main.go/cmd 入口时不伪造启动命令', () => {
    const proj = path.join(tmp, 'golib');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'go.mod'), 'module lib\n\ngo 1.21\n');
    const r = ProjectAnalyzer.analyze(proj);
    expect(r.facts.language).toBe('go');
    expect(r.services.length).toBe(0);
    expect(r.unknowns.join(' ')).toContain('未找到 main.go');
  });

  it('Rust：src/main.rs 存在生成 cargo run；库 crate 不伪造', () => {
    const bin = path.join(tmp, 'rsbin');
    fs.mkdirSync(path.join(bin, 'src'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'Cargo.toml'), '[package]\nname="rsbin"\nversion="0.1.0"\nedition="2021"\n');
    fs.writeFileSync(path.join(bin, 'src', 'main.rs'), 'fn main() {}');
    const rb = ProjectAnalyzer.analyze(bin);
    expect(rb.facts.language).toBe('rust');
    expect(rb.services[0]?.start_command).toBe('cargo run');

    const lib = path.join(tmp, 'rslib');
    fs.mkdirSync(path.join(lib, 'src'), { recursive: true });
    fs.writeFileSync(path.join(lib, 'Cargo.toml'), '[package]\nname="rslib"\n');
    fs.writeFileSync(path.join(lib, 'src', 'lib.rs'), '');
    const rl = ProjectAnalyzer.analyze(lib);
    expect(rl.services.length).toBe(0);
    expect(rl.unknowns.join(' ')).toContain('库 crate');
  });

  it('PHP Laravel：artisan 入口识别为 php artisan serve；普通 PHP 不伪造', () => {
    const laravel = path.join(tmp, 'laravel');
    fs.mkdirSync(laravel, { recursive: true });
    fs.writeFileSync(path.join(laravel, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^11' } }));
    fs.writeFileSync(path.join(laravel, 'artisan'), '#!/usr/bin/env php');
    const lv = ProjectAnalyzer.analyze(laravel);
    expect(lv.facts.language).toBe('php');
    expect(lv.facts.framework).toBe('laravel');
    expect(lv.services[0]?.start_command).toContain('php artisan serve');

    const plain = path.join(tmp, 'plainphp');
    fs.mkdirSync(plain, { recursive: true });
    fs.writeFileSync(path.join(plain, 'composer.json'), JSON.stringify({ require: { 'monolog/monolog': '^3' } }));
    const ph = ProjectAnalyzer.analyze(plain);
    expect(ph.facts.language).toBe('php');
    expect(ph.services.length).toBe(0);
    expect(ph.unknowns.join(' ')).toContain('启动方式需确认');
  });

  it('.NET：csproj 识别 dotnet run；sln 标注需进一步分析', () => {
    const cs = path.join(tmp, 'dotnet-api');
    fs.mkdirSync(cs, { recursive: true });
    fs.writeFileSync(path.join(cs, 'Api.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>');
    const r = ProjectAnalyzer.analyze(cs);
    expect(r.facts.language).toBe('c#');
    expect(r.services[0]?.start_command).toBe('dotnet run');

    const sln = path.join(tmp, 'bigsln');
    fs.mkdirSync(sln, { recursive: true });
    fs.writeFileSync(path.join(sln, 'Big.sln'), 'Microsoft Visual Studio Solution File');
    const rs = ProjectAnalyzer.analyze(sln);
    expect(rs.facts.language).toBe('c#');
    expect(rs.services.length).toBe(0);
    expect(rs.unknowns.join(' ')).toContain('解决方案');
  });
});
