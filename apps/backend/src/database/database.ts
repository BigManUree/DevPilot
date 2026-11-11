import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * SQLite 数据层（数据库设计第 1、5 节）：
 * - schema 版本化迁移，每次迁移前备份
 * - 迁移失败停止启动关键业务写入
 */
export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

/** V1：核心实体建表（逻辑模型） */
const V1: Migration = {
  version: 1,
  name: 'core-entities',
  up: (db) => {
    db.exec(`
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  project_type TEXT,
  language TEXT,
  framework TEXT,
  import_source TEXT NOT NULL,
  analysis_status TEXT NOT NULL DEFAULT 'pending',
  config_version INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_projects_path ON projects(root_path);

CREATE TABLE project_services (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  service_type TEXT NOT NULL,
  workdir TEXT NOT NULL,
  start_command TEXT,
  stop_command TEXT,
  restart_command TEXT,
  build_command TEXT,
  port INTEGER,
  env_json TEXT,
  health_check_json TEXT,
  depends_on_json TEXT,
  shared INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Stopped',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
CREATE INDEX idx_services_project ON project_services(project_id);

CREATE TABLE project_configs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  config_type TEXT NOT NULL,
  file_path TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  content_ref TEXT,
  sensitive_fields_json TEXT,
  source TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_configs_project ON project_configs(project_id);

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  executable_path TEXT,
  version TEXT,
  detect_status TEXT NOT NULL DEFAULT 'unknown',
  scope TEXT,
  source TEXT
);

CREATE TABLE dependencies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version_constraint TEXT,
  dep_type TEXT,
  lockfile_source TEXT,
  install_status TEXT NOT NULL DEFAULT 'unknown'
);
CREATE INDEX idx_deps_project ON dependencies(project_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_scope TEXT,
  task_type TEXT NOT NULL,
  input_summary TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  priority INTEGER NOT NULL DEFAULT 5,
  plan_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  result_summary TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created ON tasks(created_at);

CREATE TABLE subtasks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_json TEXT,
  assigned_agent TEXT,
  input_json TEXT,
  output_ref TEXT,
  status TEXT NOT NULL DEFAULT 'Pending',
  completion_criteria TEXT
);
CREATE INDEX idx_subtasks_task ON subtasks(task_id);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  origin TEXT NOT NULL,
  capabilities_json TEXT,
  model_config_json TEXT,
  permission_template_json TEXT,
  status TEXT NOT NULL DEFAULT 'registered'
);

CREATE TABLE agent_executions (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'Running',
  tokens_json TEXT,
  error_summary TEXT,
  trace_id TEXT
);
CREATE INDEX idx_exec_task ON agent_executions(task_id);
CREATE INDEX idx_exec_agent ON agent_executions(agent_id);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES agent_executions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  params_summary TEXT,
  permission_result TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_status TEXT,
  output_ref TEXT
);
CREATE INDEX idx_calls_exec ON tool_calls(execution_id);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  plan_version INTEGER NOT NULL,
  state_snapshot TEXT,
  completed_subtasks_json TEXT,
  data_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ckpt_task ON checkpoints(task_id);

CREATE TABLE logs (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  source_module TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  trace_id TEXT,
  created_at TEXT NOT NULL,
  body_ref TEXT,
  redacted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_logs_time ON logs(created_at);
CREATE INDEX idx_logs_level ON logs(level);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  related_json TEXT,
  severity TEXT NOT NULL DEFAULT 'info',
  payload_ref TEXT,
  process_status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_type ON events(type);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_summary TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_notif_unread ON notifications(read);

CREATE TABLE permissions (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  category TEXT NOT NULL,
  resource_scope TEXT,
  grant_source TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_perm_subject ON permissions(subject_type, subject_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  target_ref TEXT NOT NULL,
  requester TEXT NOT NULL,
  action_summary TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  approval_status TEXT NOT NULL DEFAULT 'pending',
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_appr_status ON approvals(approval_status);

CREATE TABLE audit_records (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  result TEXT NOT NULL,
  trace_id TEXT,
  detail_summary TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_time ON audit_records(created_at);

CREATE TABLE git_repositories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo_path TEXT NOT NULL,
  remote_url TEXT,
  current_branch TEXT,
  last_checked_at TEXT
);

CREATE TABLE plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  type TEXT NOT NULL,
  origin TEXT,
  compat_json TEXT,
  manifest_ref TEXT,
  status TEXT NOT NULL DEFAULT 'installed',
  permissions_json TEXT
);

CREATE TABLE plugin_dependencies (
  plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  depends_plugin_id TEXT NOT NULL,
  version_constraint TEXT,
  PRIMARY KEY (plugin_id, depends_plugin_id)
);

CREATE TABLE database_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  db_type TEXT NOT NULL,
  host TEXT,
  port INTEGER,
  database_name TEXT,
  credential_ref TEXT,
  status TEXT NOT NULL DEFAULT 'unknown'
);

CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  backup_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  file_path TEXT NOT NULL,
  hash TEXT,
  size_bytes INTEGER,
  app_version TEXT,
  data_version TEXT,
  verify_status TEXT NOT NULL DEFAULT 'unverified',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_backups_time ON backups(created_at);

CREATE TABLE settings (
  key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'global',
  value_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key, scope)
);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  content_ref TEXT NOT NULL,
  source TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  version INTEGER NOT NULL DEFAULT 1,
  access_policy TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mem_scope ON memories(scope, project_id);

CREATE TABLE runtime_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  pids_json TEXT,
  created_by TEXT NOT NULL DEFAULT 'user'
);
CREATE INDEX idx_sessions_project ON runtime_sessions(project_id);
`);
  },
};

/** V2：tool_calls.execution_id 改为可空（支持无任务上下文的 adhoc 调用） */
const V2: Migration = {
  version: 2,
  name: 'tool-calls-nullable-execution',
  up: (db) => {
    db.exec(`
CREATE TABLE tool_calls_v2 (
  id TEXT PRIMARY KEY,
  execution_id TEXT REFERENCES agent_executions(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  params_summary TEXT,
  permission_result TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  exit_status TEXT,
  output_ref TEXT
);
INSERT INTO tool_calls_v2 SELECT * FROM tool_calls;
DROP TABLE tool_calls;
ALTER TABLE tool_calls_v2 RENAME TO tool_calls;
CREATE INDEX idx_calls_exec ON tool_calls(execution_id);
`);
  },
};

/** V3：git_repositories.project_id 改为可空（支持独立仓库注册） */
const V3: Migration = {
  version: 3,
  name: 'git-repos-nullable-project',
  up: (db) => {
    db.exec(`
CREATE TABLE git_repositories_v3 (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  repo_path TEXT NOT NULL,
  remote_url TEXT,
  current_branch TEXT,
  last_checked_at TEXT
);
INSERT INTO git_repositories_v3 SELECT * FROM git_repositories;
DROP TABLE git_repositories;
ALTER TABLE git_repositories_v3 RENAME TO git_repositories;
`);
  },
};

/** V4：本地服务管理 + 多环境配置中心 */
const V4: Migration = {
  version: 4,
  name: 'local-services-and-env-profiles',
  up: (db) => {
    db.exec(`
CREATE TABLE local_services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  service_kind TEXT NOT NULL,
  exe_path TEXT NOT NULL,
  args_json TEXT,
  workdir TEXT,
  port INTEGER,
  env_json TEXT,
  status TEXT NOT NULL DEFAULT 'Stopped',
  pid INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE env_profiles (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  variables_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
`);
  },
};

/** V5：通知规则订阅 + 外部工具命令级联动动作 */
const V5: Migration = {
  version: 5,
  name: 'notification-rules-and-tool-actions',
  up: (db) => {
    db.exec(`
CREATE TABLE notification_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type_pattern TEXT NOT NULL DEFAULT '*',
  project_id TEXT,
  min_priority INTEGER NOT NULL DEFAULT 5,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE external_tool_actions (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  action_name TEXT NOT NULL,
  command_template TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  created_at TEXT NOT NULL,
  UNIQUE(tool_id, action_name)
);
`);
  },
};

/** V6：插件运行时（第三阶段 9.19）。V2 骨架已建 plugins/plugin_dependencies 表，此处补时间列 */
const V6: Migration = {
  version: 6,
  name: 'plugins-runtime-columns',
  up: (db) => {
    db.exec(`ALTER TABLE plugins ADD COLUMN updated_at TEXT;`);
  },
};

/** V7：服务自动重启策略（第三阶段自愈第一批，PRD 3.9 有限且可配置） */
const V7: Migration = {
  version: 7,
  name: 'service-restart-policy',
  up: (db) => {
    db.exec(`ALTER TABLE project_services ADD COLUMN restart_policy TEXT NOT NULL DEFAULT 'off';`);
  },
};

export const MIGRATIONS: Migration[] = [V1, V2, V3, V4, V5, V6, V7];

export function openDatabase(dataDir: string): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'devpilot.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db, dataDir);
  return db;
}

function migrate(db: Database.Database, dataDir: string) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const current = (db.prepare('SELECT MAX(version) v FROM schema_migrations').get() as { v: number | null }).v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    // 迁移前备份当前数据库文件
    const dbPath = path.join(dataDir, 'devpilot.db');
    if (fs.existsSync(dbPath)) {
      const backup = path.join(dataDir, `devpilot.backup.v${m.version}.${Date.now()}.db`);
      db.backup(backup);
    }
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(m.version, m.name, new Date().toISOString());
    });
    try {
      tx();
    } catch (err) {
      // 迁移失败：停止启动关键业务写入，抛给上层
      throw new Error(`migration v${m.version} (${m.name}) failed: ${String(err)}`);
    }
  }
}
