import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectLaunchScript, resolveLaunch } from './launch-script';

/**
 * 一键启动脚本识别回归（用户反馈：wb2api-local 的「启动-workbuddy2api.bat」未被识别）。
 * 覆盖形态：PowerShell Start-Process 包 exe / start "" "x.exe" / 直接 exe / start "" http（辅助行，跳过）。
 */
describe('一键启动脚本识别（含 exe 形态回归）', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devpilot-launch-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function writeFile(rel: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, rel), content);
  }

  it('Start-Process 包 exe：还原成「exe 绝对路径 + 参数」，%~dp0 展开为项目根，端口取脚本内的访问地址', () => {
    writeFile('wb2api.exe', 'MZ');
    writeFile('config.json', '{}');
    writeFile('启动-workbuddy2api.bat', [
      '@echo off',
      'chcp 65001 >nul',
      'cd /d "%~dp0"',
      'echo [1/3] stopping old wb2api ...',
      'taskkill /F /IM wb2api.exe >nul 2>&1',
      'timeout /t 1 /nobreak >nul',
      'echo [2/3] starting wb2api ...',
      "powershell -NoProfile -ExecutionPolicy Bypass -Command \"Start-Process -FilePath '%~dp0wb2api.exe' -ArgumentList '-config','config.json' -WorkingDirectory '%~dp0' -WindowStyle Hidden\"",
      'timeout /t 3 /nobreak >nul',
      'echo [3/3] health check:',
      'curl -s http://127.0.0.1:7863/healthz',
      'echo Panel: http://127.0.0.1:7863/panel/',
      'pause',
    ].join('\r\n'));
    const hit = detectLaunchScript(tmp);
    expect(hit).toBeTruthy();
    expect(hit!.kind).toBe('exe');
    expect(hit!.confidence).toBe('high');
    expect(hit!.command).toBe(path.join(tmp, 'wb2api.exe') + ' -config config.json');
    expect(hit!.port).toBe(7863);
    expect(hit!.command).not.toContain('%~dp0');
    expect(hit!.command).not.toContain('Start-Process');
  });

  it('start "" "x.exe" 形态与直接 exe 行均能识别', () => {
    writeFile('tools\\agent.exe', 'MZ');
    writeFile('run.bat', 'start "" "%~dp0tools\\agent.exe" --mode=daemon\r\n');
    const hit = detectLaunchScript(tmp);
    expect(hit?.kind).toBe('exe');
    expect(hit?.command).toContain('agent.exe');
    expect(hit?.command).toContain('--mode=daemon');
  });

  it('start 打开网页的辅助行不会误判为启动命令', () => {
    writeFile('run.bat', 'start "" http://localhost:8501\r\npause\r\n');
    expect(detectLaunchScript(tmp)).toBeNull();
  });

  it('resolveLaunch：脚本命中时 source=script', () => {
    writeFile('wb2api.exe', 'MZ');
    writeFile('启动-workbuddy2api.bat', "powershell -Command \"Start-Process -FilePath '%~dp0wb2api.exe'\"\r\n");
    const r = resolveLaunch(tmp);
    expect(r.source).toBe('script');
    expect(r.hit?.kind).toBe('exe');
  });
});
