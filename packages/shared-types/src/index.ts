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
