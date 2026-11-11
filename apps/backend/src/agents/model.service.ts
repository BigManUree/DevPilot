import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { LogService } from '../logs/log.service';
import { credentials } from '@devpilot/platform-adapters';

/**
 * 模型适配层（DeepSeek，OpenAI 兼容协议）：
 * - API Key 存储：优先 Windows 凭据管理器（platform-adapters credential store），
 *   降级 data/credentials.json(0600)；数据库只存引用
 * - chat()：统一对话入口，返回文本；models() 列出可用模型
 * - 首批仅 DeepSeek，接口留供应商扩展位
 */
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

@Injectable()
export class ModelService {
  private apiKey: string | null = null;
  private keyBackend: string | null = null;
  private baseUrl = process.env.DEVIPILOT_DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE;
  private model = process.env.DEVIPILOT_DEEPSEEK_MODEL ?? 'deepseek-flash';

  constructor(private readonly logs: LogService) {}

  private credFile(): string {
    return path.join(
      process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data'),
      'credentials.json',
    );
  }

  /** 保存 API Key：写 OS 凭据存储，成功后清掉 credentials.json 里的明文残留 */
  async setApiKey(provider: 'deepseek', apiKey: string): Promise<{ stored: string }> {
    const service = 'DevPilot';
    await credentials.setPassword(service, provider, apiKey);
    this.apiKey = apiKey;
    this.keyBackend = credentials.backend;
    // 明文降级清理
    const file = this.credFile();
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, { apiKey?: string }>;
        if (data[provider]?.apiKey) {
          delete data[provider].apiKey;
          if (Object.keys(data[provider]).length === 0) delete data[provider];
          if (Object.keys(data).length === 0) fs.rmSync(file, { force: true });
          else fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
        }
      }
    } catch { /* 清理失败不影响保存 */ }
    this.logs.log({ level: 'info', sourceModule: 'model', message: `api key stored for ${provider} via ${credentials.backend}` });
    return { stored: credentials.backend };
  }

  hasKey(provider = 'deepseek'): boolean {
    if (this.apiKey) return true;
    // 优先级：内存 > 环境变量 > OS 凭据存储（同步兜底看降级文件）
    if (process.env.DEVIPILOT_DEEPSEEK_API_KEY) {
      this.apiKey = process.env.DEVIPILOT_DEEPSEEK_API_KEY;
      this.keyBackend = 'env';
      return true;
    }
    const file = this.credFile();
    if (fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, { apiKey?: string }>;
        if (data[provider]?.apiKey) {
          this.apiKey = data[provider].apiKey!;
          this.keyBackend = 'file-fallback';
          return true;
        }
      } catch { /* 文件损坏走凭据存储 */ }
    }
    return false;
  }

  /** 异步补读 OS 凭据存储（同步路径未命中时调用一次） */
  async loadKeyFromStore(provider = 'deepseek'): Promise<boolean> {
    if (this.apiKey) return true;
    const key = await credentials.getPassword('DevPilot', provider);
    if (key) {
      this.apiKey = key;
      this.keyBackend = credentials.backend;
      return true;
    }
    return this.hasKey(provider);
  }

  status() {
    const configured = this.hasKey();
    return { provider: 'deepseek', baseUrl: this.baseUrl, model: this.model, keyConfigured: configured, keyBackend: this.keyBackend };
  }

  /** 对话：OpenAI 兼容 /chat/completions */
  async chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, opts?: { json?: boolean }): Promise<string> {
    if (!(await this.loadKeyFromStore())) throw new Error('model api key not configured（请先 POST /api/v1/models/config 设置 DeepSeek API Key）');
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        ...(opts?.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      this.logs.log({ level: 'error', sourceModule: 'model', message: `chat failed ${res.status}: ${text.slice(0, 300)}` });
      throw new Error(`model api error ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage?: unknown };
    this.logs.log({ level: 'info', sourceModule: 'model', message: `chat ok usage=${JSON.stringify(body.usage ?? {})}` });
    return body.choices[0]?.message?.content ?? '';
  }
}
