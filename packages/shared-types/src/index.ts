// DevPilot 共享类型与常量基线（逻辑模型对应主文档数据库设计）
export type TaskStatus =
  | 'Pending'
  | 'Preparing'
  | 'Running'
  | 'Paused'
  | 'WaitingApproval'
  | 'WaitingInput'
  | 'Completed'
  | 'Failed'
  | 'Cancelled';

export type ServiceStatus =
  | 'Stopped'
  | 'Starting'
  | 'Running'
  | 'Stopping'
  | 'Failed'
  | 'Unhealthy'
  | 'Unknown';

export type ValidationStatus = 'PASSED' | 'FAILED' | 'PARTIAL' | 'BLOCKED' | 'UNKNOWN';

export type ProjectImportSource = 'folder' | 'drag' | 'script' | 'git' | 'archive' | 'scan';

/** 八类 AI 权限（主文档安全设计第 2 节） */
export type PermissionCategory =
  | 'project_analysis'
  | 'command_execution'
  | 'modify_start_script'
  | 'modify_project_config'
  | 'modify_code'
  | 'auto_retry'
  | 'manage_dev_env'
  | 'git_operation';

/** 统一事件结构（API 与事件接口设计第 4 节） */
export interface DevPilotEvent {
  event_id: string;
  event_type: string;
  timestamp: string; // ISO-8601
  source_module: string;
  project_id?: string;
  task_id?: string;
  agent_id?: string;
  trace_id: string;
  severity: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  payload: Record<string, unknown>;
}

/** 统一错误结构（API 与事件接口设计第 5 节） */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    trace_id: string;
  };
}

/** WebSocket 事件名（API 与事件接口设计第 3 节） */
export const WS_EVENTS = [
  'project.updated',
  'service.status.changed',
  'runtime.log',
  'task.status.changed',
  'task.progress',
  'agent.status.changed',
  'agent.message',
  'tool.call.started',
  'tool.call.completed',
  'approval.required',
  'notification.created',
  'system.health.changed',
] as const;
export type WsEventName = (typeof WS_EVENTS)[number];

/** 服务配置（结构化启动配置原则：非裸脚本） */
export interface ServiceConfig {
  service_id: string;
  project_id: string;
  name: string;
  service_type:
    | 'frontend'
    | 'backend'
    | 'database'
    | 'cache'
    | 'mq'
    | 'file'
    | 'microservice'
    | 'docker'
    | 'custom';
  workdir: string;
  start_command?: string;
  stop_command?: string;
  restart_command?: string;
  build_command?: string;
  port?: number;
  env?: Record<string, string>;
  health_check?: {
    type: 'http' | 'tcp' | 'process' | 'custom';
    target: string;
    timeout_ms: number;
  };
  depends_on?: string[];
  shared?: boolean;
}

/** 执行边界默认值（需求整理 8.4，可配置） */
export const EXECUTION_LIMITS_DEFAULT = {
  maxAutoRepairAttempts: 3,
  commandTimeoutMs: 120_000,
  repairTaskTotalMs: 10 * 60_000,
} as const;

/** 模型配置（DeepSeek OpenAI 兼容） */
export interface ModelProviderConfig {
  provider: 'deepseek';
  baseUrl: string; // 默认 https://api.deepseek.com/v1
  model: string; // 默认 deepseek-v4.1-flash
  apiKeyRef: string; // 凭据存储引用，不存明文
}

// ============ 智能化升级共享类型（2026-11 全量升级） ============

/** 分析证据：每个关键判断的依据链 */
export interface AnalysisEvidence {
  file: string;
  reason: string;
  /** 命中片段（脱敏后），如 package.json 中的依赖名 */
  snippet?: string;
}

/** 识别结论（带置信度与证据，置信度由规则计算，不允许模型编造） */
export interface Finding {
  value: string;
  confidence: number; // 0-1
  evidence: AnalysisEvidence[];
  verified: boolean; // 是否经过实际验证（如真实执行了 --version）
}

/** 项目组件（组件树节点）：一个可独立运行/构建的单元 */
export interface ProjectComponent {
  id: string;
  name: string;
  /** 相对项目根的目录，'' 表示根组件 */
  path: string;
  kind: 'frontend' | 'backend' | 'fullstack' | 'library' | 'cli' | 'database' | 'cache' | 'mq' | 'docker' | 'binary' | 'unknown';
  language: string | null;
  framework: string | null;
  packageManager: string | null;
  /** 识别置信度 */
  confidence: number;
  evidence: AnalysisEvidence[];
  /** 组件运行约束 */
  runtime: ComponentRuntime | null;
  /** 依赖的其他组件 id */
  dependsOn: string[];
}

/** 组件运行约束（从 manifest/锁文件解析出的真实约束） */
export interface ComponentRuntime {
  /** 语言版本要求，如 "17"、">=3.10"、"20.x"，无法解析为 null */
  languageVersion: string | null;
  languageVersionSource: string | null;
  packageManager: string | null;
  packageManagerVersion: string | null;
  buildCommand: string | null;
  devStartCommand: string | null;
  prodStartCommand: string | null;
  testCommand: string | null;
  port: number | null;
  envVars: EnvVarRequirement[];
  externalServices: ExternalServiceRequirement[];
}

/** 环境变量需求（从 .env.example / application.yml / compose 解析） */
export interface EnvVarRequirement {
  key: string;
  source: string;
  required: boolean;
  hasDefault: boolean;
  defaultValue?: string;
  sensitive: boolean;
}

/** 外部服务需求（MySQL/Redis/...） */
export interface ExternalServiceRequirement {
  type: 'mysql' | 'postgres' | 'redis' | 'mongodb' | 'rabbitmq' | 'kafka' | 'elasticsearch' | 'minio' | 'mssql' | 'unknown';
  host: string | null;
  port: number | null;
  source: string;
}

/** 项目分析档案（结构化，持久化到 projects.components_json） */
export interface ProjectProfile {
  /** 项目指纹：关键 manifest 内容 hash，用于档案缓存失效 */
  fingerprint: string;
  analyzedAt: string;
  language: Finding | null;
  framework: Finding | null;
  packageManager: Finding | null;
  components: ProjectComponent[];
  rootComponentId: string | null;
  unknowns: string[];
  /** 需要用户确认的事项 */
  needsConfirmation: string[];
}

/** 统一导入来源 */
export type UnifiedImportSource = 'folder' | 'git' | 'archive' | 'http' | 'docker' | 'scan';

export interface ImportProgress {
  jobId: string;
  phase: 'queued' | 'fetching' | 'validating' | 'extracting' | 'analyzing' | 'saving' | 'done' | 'failed' | 'cancelled';
  percent: number;
  message: string;
  detail?: string;
}

export interface ImportJobRecord {
  id: string;
  source: UnifiedImportSource;
  /** 来源参数（URL/路径等），凭据不入库 */
  sourceRef: string;
  projectId?: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  error?: string;
  created_at: string;
  finished_at?: string;
}

/** Agent 工具描述（注册中心） */
export interface ToolDescriptor {
  name: string;
  title: string;
  /** 参数 JSON Schema（简化版） */
  inputSchema: Record<string, unknown>;
  /** 输出说明（供 LLM 理解） */
  outputHint: string;
  /** 权限类别（PermissionCategory） */
  category: PermissionCategory | null;
  /** 风险等级 */
  risk: 'L0' | 'L1' | 'L2' | 'L3';
  /** 是否有副作用 */
  sideEffects: boolean;
  timeoutMs: number;
}

/** Agent 子任务执行记录 */
export interface SubTaskRun {
  id: string;
  title: string;
  tool: string;
  params: Record<string, unknown>;
  status: 'Pending' | 'Running' | 'Completed' | 'Failed' | 'WaitingApproval' | 'Skipped';
  result?: unknown;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  attempt: number;
}

/** 计划版本（版本化与重规划） */
export interface PlanVersion {
  version: number;
  goal: string;
  steps: Array<{ id: string; title: string; tool: string; params: Record<string, unknown>; status: string; note?: string }>;
  changeReason?: string;
  createdAt: string;
}

/** Agent 任务预算 */
export const AGENT_BUDGET_DEFAULT = {
  maxToolCalls: 40,
  maxPlanIterations: 5,
  maxSubtaskRetries: 2,
  maxDurationMs: 20 * 60_000,
} as const;

/** 错误分类（诊断知识库） */
export type ErrorCategory =
  | 'env_missing'
  | 'version_mismatch'
  | 'dependency_install_failed'
  | 'network'
  | 'permission'
  | 'port_conflict'
  | 'database_connection'
  | 'cache_connection'
  | 'config_missing'
  | 'config_invalid'
  | 'compile_error'
  | 'runtime_exception'
  | 'process_crash'
  | 'docker_error'
  | 'health_check_failed'
  | 'business_error'
  | 'unknown';

export interface DiagnosisResult {
  category: ErrorCategory;
  confidence: number;
  summary: string;
  evidence: string[];
  /** 命中的规则 id（error_patterns），LLM 推理时为 null */
  ruleId?: string;
}

/** 修复方案 */
export interface RepairProposal {
  analysis: string;
  risk: 'L0' | 'L1' | 'L2' | 'L3';
  files: Array<{ path: string; content: string; reason: string }>;
  commands: string[];
  startCommand?: string | null;
  port?: number | null;
  explanation?: string;
}

/** 健康检查配置（项目服务） */
export interface HealthCheckConfig {
  type: 'http' | 'tcp' | 'process';
  path?: string;
  expectedStatus?: number;
  method?: string;
  timeoutMs?: number;
  retries?: number;
  intervalMs?: number;
}

