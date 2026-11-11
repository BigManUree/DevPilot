import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LogService } from '../logs/log.service';

/**
 * 模型适配层（DeepSeek，OpenAI 兼容协议）：
 * - API Key 存储：data/credentials.json（仅本机用户目录，文件权限收紧），数据库只存引用
 * - chat()：统一对话入口，返回文本；models() 列出可用模型
 * - 首批仅 DeepSeek，接口留供应商扩展位
 */
const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

@Injectable()
export class ModelService {
  private apiKey: string | null = null;
  private baseUrl = process.env.DEVIPILOT_DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE;
  private model = process.env.DEVIPILOT_DEEPSEEK_MODEL ?? 'deepseek-flash';

  constructor(private readonly logs: LogService) {}

  private credFile(): string {
    return path.join(
      process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data'),
      'credentials.json',
    );
  }

  /** 保存 API Key（原子写，文件内容仅 { deepseek: { apiKey } }） */
  setApiKey(provider: 'deepseek', apiKey: string): { stored: string } {
    const file = this.credFile();
    let data: Record<string, { apiKey: string }> = {};
    if (fs.existsSync(file)) {
      try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { data = {}; }
    }
    data[provider] = { apiKey };
    const tmp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.apiKey = apiKey;
    this.logs.log({ level: 'info', sourceModule: 'model', message: `api key stored for ${provider}` });
    return { stored: file };
  }

  hasKey(provider = 'deepseek'): boolean {
    if (this.apiKey) return true;
    // 优先级：内存 > 环境变量（用户级 DEVIPILOT_DEEPSEEK_API_KEY，不落代码/配置文件） > 凭据文件
    if (process.env.DEVIPILOT_DEEPSEEK_API_KEY) {
      this.apiKey = process.env.DEVIPILOT_DEEPSEEK_API_KEY;
      return true;
    }
    const file = this.credFile();
    if (!fs.existsSync(file)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      this.apiKey = data[provider]?.apiKey ?? null;
      return !!this.apiKey;
    } catch { return false; }
  }

  status() {
    const configured = this.hasKey();
    return { provider: 'deepseek', baseUrl: this.baseUrl, model: this.model, keyConfigured: configured };
  }

  /** 对话：OpenAI 兼容 /chat/completions */
  async chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, opts?: { json?: boolean }): Promise<string> {
    if (!this.hasKey()) throw new Error('model api key not configured（请先 POST /api/v1/models/config 设置 DeepSeek API Key）');
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
