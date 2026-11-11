import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * OS 安全凭据存储（安全设计 §7）：
 * - win32 → Windows Credential Manager（PasswordVault，Win8+）
 * - 其它平台 / win32 调用失败 → 文件降级（0600，原 credentials.json 行为）
 * 值经 base64 传入 PowerShell 解码，完全避开引号/特殊字符转义问题。
 */

export interface CredentialStore {
  readonly backend: 'win32-passwordvault' | 'file-fallback';
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

function runPowerShell(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64');

function vaultScript(op: 'add' | 'get' | 'del', service: string, account: string, password?: string): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null',
    `$v = New-Object Windows.Security.Credentials.PasswordVault`,
    `$svc = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(service)}'))`,
    `$acct = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(account)}'))`,
    op === 'add' && `$pw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(password ?? '')}'))`,
    op === 'add' && `$c = New-Object Windows.Security.Credentials.PasswordCredential($svc, $acct, $pw); $v.Add($c); 'STORED'`,
    op === 'get' && `try { $r = $v.Retrieve($svc, $acct); $r.RetrievePassword(); 'OK:' + $r.Password } catch { 'NOTFOUND' }`,
    op === 'del' && `try { $v.Remove($v.Retrieve($svc, $acct)); 'DELETED' } catch { 'NOTFOUND' }`,
  ].filter(Boolean).join('; ');
}

class Win32PasswordVaultStore implements CredentialStore {
  readonly backend = 'win32-passwordvault' as const;

  async setPassword(service: string, account: string, password: string): Promise<void> {
    const r = await runPowerShell(vaultScript('add', service, account, password));
    if (!r.stdout.includes('STORED')) throw new Error(`password vault add failed: ${r.stderr.slice(0, 200)}`);
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    const r = await runPowerShell(vaultScript('get', service, account));
    const line = r.stdout.trim();
    if (r.code === 0 && line.startsWith('OK:')) return line.slice(3);
    return null;
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    const r = await runPowerShell(vaultScript('del', service, account));
    return r.code === 0 && r.stdout.includes('DELETED');
  }
}

class FileCredentialStore implements CredentialStore {
  readonly backend = 'file-fallback' as const;

  private file(): string {
    return path.join(
      process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data'),
      'credentials.json',
    );
  }

  private readAll(): Record<string, Record<string, string>> {
    const f = this.file();
    if (!fs.existsSync(f)) return {};
    try { return JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return {}; }
  }

  private writeAll(data: Record<string, Record<string, string>>): void {
    const f = this.file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    const data = this.readAll();
    data[service] = data[service] ?? {};
    data[service][account] = password;
    this.writeAll(data);
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    return this.readAll()[service]?.[account] ?? null;
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    const data = this.readAll();
    if (data[service]?.[account] === undefined) return false;
    delete data[service][account];
    if (Object.keys(data[service]).length === 0) delete data[service];
    this.writeAll(data);
    return true;
  }
}

/** win32 首选 PasswordVault，调用失败自动降级文件存储 */
export function createCredentialStore(): CredentialStore {
  if (process.platform === 'win32') {
    const vault = new Win32PasswordVaultStore();
    // 启动时探测一次可用性（懒探测会让首次保存才有反馈）
    return {
      backend: 'win32-passwordvault',
      setPassword: async (s, a, p) => {
        try { await vault.setPassword(s, a, p); }
        catch { await new FileCredentialStore().setPassword(s, a, p); }
      },
      getPassword: async (s, a) => {
        try { return await vault.getPassword(s, a); }
        catch { return await new FileCredentialStore().getPassword(s, a); }
      },
      deletePassword: async (s, a) => {
        try { return await vault.deletePassword(s, a); }
        catch { return await new FileCredentialStore().deletePassword(s, a); }
      },
    };
  }
  return new FileCredentialStore();
}

export const credentials = createCredentialStore();
