import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { LogService } from '../logs/log.service';
import { credentials } from '@devpilot/platform-adapters';

/**
 * 模型适配层（多供应商，OpenAI 兼容协议，架构债 #3 第一批）：
 * - 供应商目录：deepseek / openai / moonshot / qwen / zhipu / custom（自建兼容网关）
 * - API Key 存储：Windows 凭据管理器优先（vault account = provider id），降级 credentials.json(0600)
 * - active provider 持久化到 data/model-config.json；chat() 走当前激活供应商
 * - 旧调用（body 只带 apiKey）默认 deepseek，完全向后兼容
 */

export interface ProviderInfo {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
}

const PROVIDER_CATALOG: Record<string, ProviderInfo> = {
  deepseek: { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  openai: { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  moonshot: { id: 'moonshot', label: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', defaultModel: 'moonshot-v1-8k' },
  qwen: { id: 'qwen', label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus' },
  zhipu: { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-4-flash' },
  custom: { id: 'custom', label: '自定义（OpenAI 兼容）', baseUrl: '', defaultModel: '' },
};

interface ModelConfigFile {
  activeProvider?: string;
  overrides?: Record<string, { baseUrl?: string; model?: string }>;
}

@Injectable()
export class ModelService {
  private activeProvider = 'deepseek';
  private apiKey: string | null = null;
  private keyBackend: string | null = null;
  private overrides: Record<string, { baseUrl?: string; model?: string }> = {};

  constructor(private readonly logs: LogService) {
    this.loadPersistedConfig();
  }

  private dataDir(): string {
    return process.env.DEVIPILOT_DATA_DIR ?? path.join(process.env.APPDATA ?? process.cwd(), 'devpilot', 'data');
  }

  private credFile(): string {
    return path.join(this.dataDir(), 'credentials.json');
  }

  private configFile(): string {
    return path.join(this.dataDir(), 'model-config.json');
  }

  private loadPersistedConfig(): void {
    try {
      const f = this.configFile();
      if (fs.existsSync(f)) {
        const cfg = JSON.parse(fs.readFileSync(f, 'utf-8')) as ModelConfigFile;
        if (cfg.activeProvider && PROVIDER_CATALOG[cfg.activeProvider]) this.activeProvider = cfg.activeProvider;
        if (cfg.overrides) this.overrides = cfg.overrides;
      }
    } catch { /* 配置损坏按默认 */ }
  }

  private persistConfig(): void {
    const tmp = `${this.configFile()}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ activeProvider: this.activeProvider, overrides: this.overrides }), { mode: 0o600 });
    fs.renameSync(tmp, this.configFile());
  }

  resolveProvider(provider?: string): ProviderInfo {
    const id = provider ?? this.activeProvider;
    const base = PROVIDER_CATALOG[id];
    if (!base) throw new NotFoundException(`未知供应商：${id}（可选：${Object.keys(PROVIDER_CATALOG).join('/')}）`);
    const ov = this.overrides[id] ?? {};
    return { ...base, baseUrl: ov.baseUrl || process.env[`DEVIPILOT_${id.toUpperCase()}_BASE_URL`] || base.baseUrl, defaultModel: ov.model || base.defaultModel };
  }

  listProviders() {
    return Object.values(PROVIDER_CATALOG).map((p) => ({
      ...this.resolveProvider(p.id),
      active: p.id === this.activeProvider,
      keyConfigured: this.providerKeyConfigured(p.id),
    }));
  }

  /** 保存 API Key：写 OS 凭据存储，成功后清掉 credentials.json 里的明文残留 */
  async setApiKey(provider: string, apiKey: string, opts?: { model?: string; baseUrl?: string }): Promise<{ stored: string; provider: string }> {
    const p = this.resolveProvider(provider ?? 'deepseek');
    await credentials.setPassword('DevPilot', p.id, apiKey);
    this.activeProvider = p.id;
    if (opts?.model || opts?.baseUrl) {
      this.overrides[p.id] = { ...(this.overrides[p.id] ?? {}), ...(opts.model ? { model: opts.model } : {}), ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) };
    }
    this.persistConfig();
    this.apiKey = apiKey;
    this.keyBackend = credentials.backend;
    // 明文降级清理
    const file = this.credFile();
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, { apiKey?: string }>;
        if (data[p.id]?.apiKey) {
          delete data[p.id].apiKey;
          if (Object.keys(data[p.id]).length === 0) delete data[p.id];
          if (Object.keys(data).length === 0) fs.rmSync(file, { force: true });
          else fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
        }
      }
    } catch { /* 清理失败不影响保存 */ }
    this.logs.log({ level: 'info', sourceModule: 'model', message: `api key stored for ${p.id} via ${credentials.backend}` });
    return { stored: credentials.backend, provider: p.id };
  }

  providerKeyConfigured(provider: string): boolean {
    // env 通用名（deepseek 兼容旧名 DEVIPILOT_DEEPSEEK_API_KEY）
    if (process.env[`DEVIPILOT_${provider.toUpperCase()}_API_KEY`]) return true;
    try {
      const file = this.credFile();
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, { apiKey?: string }>;
        if (data[provider]?.apiKey) return true;
      }
    } catch { /* 文件损坏忽略 */ }
    return false;
  }

  hasKey(provider = this.activeProvider): boolean {
    if (provider === this.activeProvider && this.apiKey) return true;
    return this.providerKeyConfigured(provider);
  }

  /** 环境变量兜底：DEVIPILOT_<PROVIDER>_API_KEY（容器 / 打包态 / 不想落盘时使用） */
  private envKey(provider: string): string | null {
    const v = process.env[`DEVIPILOT_${provider.toUpperCase()}_API_KEY`];
    return v && v.trim() ? v.trim() : null;
  }

  /** 异步补读 Key：OS 凭据存储优先，其次环境变量。
   *  修复：旧实现只把 vault 的 key 写回 apiKey，env 变量虽被 hasKey() 认作"已配置"，
   *  却没有真正加载 → chatOnce 里 apiKeyFor 返回 null，报「供应商 x 无可用 Key」。 */
  async loadKeyFromStore(provider = this.activeProvider): Promise<boolean> {
    if (provider === this.activeProvider && this.apiKey) return true;
    const key = await credentials.getPassword('DevPilot', provider);
    if (key) {
      this.activeProvider = provider;
      this.apiKey = key;
      this.keyBackend = credentials.backend;
      return true;
    }
    const fromEnv = this.envKey(provider);
    if (fromEnv) {
      this.activeProvider = provider;
      this.apiKey = fromEnv;
      this.keyBackend = 'env';
      return true;
    }
    return this.hasKey(provider);
  }

  async switchProvider(provider: string): Promise<{ provider: string; keyConfigured: boolean }> {
    const p = this.resolveProvider(provider);
    this.activeProvider = p.id;
    this.apiKey = null;
    this.persistConfig();
    const ok = await this.loadKeyFromStore(p.id);
    return { provider: p.id, keyConfigured: ok };
  }

  status() {
    const p = this.resolveProvider();
    return {
      provider: p.id,
      label: p.label,
      baseUrl: p.baseUrl,
      model: p.defaultModel,
      keyConfigured: this.hasKey(),
      keyBackend: this.keyBackend,
      providers: this.listProviders(),
    };
  }

  /** 单供应商调用（内部）：失败抛错，由 chat 的降级链捕获 */
  private async chatOnce(providerId: string, messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, opts?: { json?: boolean }): Promise<string> {
    const p = this.resolveProvider(providerId);
    if (!p.baseUrl) throw new Error(`供应商 ${providerId} 未配置 baseUrl`);
    const key = this.apiKeyFor(providerId);
    if (!key) throw new Error(`供应商 ${providerId} 无可用 Key`);
    const model = this.overrides[providerId]?.model || p.defaultModel;
    const baseUrl = this.overrides[providerId]?.baseUrl || p.baseUrl;
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages,
        ...(opts?.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`model api error ${res.status}: ${text.slice(0, 300)}`);
    }
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage?: unknown };
    this.logs.log({ level: 'info', sourceModule: 'model', message: `chat ok provider=${providerId} usage=${JSON.stringify(body.usage ?? {})}` });
    return body.choices[0]?.message?.content ?? '';
  }

  private apiKeyFor(providerId: string): string | null {
    if (providerId === this.activeProvider && this.apiKey) return this.apiKey;
    // 其他供应商：凭据存储热读（vault/文件），缓存到内存避免重复 IO
    const cached = (this as any)._keyCache as Map<string, string> | undefined;
    if (cached?.has(providerId)) return cached.get(providerId) ?? null;
    // 环境变量兜底（与 loadKeyFromStore 保持一致，避免"配置了但读不到"）
    const fromEnv = this.envKey(providerId);
    if (fromEnv) return fromEnv;
    return null;
  }

  /**
   * 对话（B5 主备降级链）：先走 active provider；网络错误 / 4xx/5xx 时
   * 按 PROVIDER_CATALOG 顺序尝试其他已配置 Key 的供应商，全部失败才抛错。
   * 降级过程逐跳落日志，最终错误信息带完整尝试链。
   */
  async chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, opts?: { json?: boolean }): Promise<string> {
    if (!(await this.loadKeyFromStore())) throw new Error('model api key not configured（请先 POST /api/v1/models/config 设置 API Key）');
    const attempts: string[] = [];
    const chain = [this.activeProvider, ...Object.keys(PROVIDER_CATALOG).filter((id) => id !== this.activeProvider)];
    for (const providerId of chain) {
      // 逐个加载该供应商的 Key（vault 热读），无 Key 跳过
      if (providerId !== this.activeProvider) {
        const ok = await this.loadKeyFromStore(providerId);
        if (!ok || !this.apiKey) { attempts.push(`${providerId}:no-key`); continue; }
        (this as any)._keyCache = (this as any)._keyCache ?? new Map<string, string>();
        (this as any)._keyCache.set(providerId, this.apiKey);
        this.apiKey = null; // 复位，避免污染 active 的 key 状态
      }
      try {
        return await this.chatOnce(providerId, messages, opts);
      } catch (e) {
        attempts.push(`${providerId}:${String(e).slice(0, 80)}`);
        this.logs.log({ level: 'warn', sourceModule: 'model', message: `provider ${providerId} failed, trying next: ${String(e).slice(0, 120)}` });
      }
    }
    throw new Error(`all providers failed（尝试链：${attempts.join(' | ')}）`);
  }
}
