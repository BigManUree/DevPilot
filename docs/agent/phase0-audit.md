# DevPilot 阶段 0 审计报告：现有系统全面审计

> 审计时间：2026-11-13 · 基线：git `abcabdb`（backup: UI/UX previous version before Apple Premium redesign），工作区含 3 个未提交 renderer 文件（App.tsx / Shell.tsx / styles.css，UI 重设计进行中）
> 方法：全部结论基于实际源码阅读（4 路并行深度审计 + 关键疑点独立复核），行号为真实文件行号。未修改任何源代码、数据库、配置、依赖。
> 文档与代码冲突时以代码为准，不一致处单独标注（见 §D）。

---

## A. 当前 Agent 系统架构图

```text
┌─────────────────────────── DevPilot（pnpm monorepo）───────────────────────────┐
│                                                                                 │
│  apps/desktop（Electron 33）                                                     │
│    main.ts: contextIsolation+sandbox ✓，仅 getBackendUrl/pickDirectory/menuTheme │
│    backend-manager.ts: 拉起后端（dev=系统 node / 打包=electron-as-node ABI130）， │
│    端口 37100 TCP 探活复用，剔除 NODE_OPTIONS                                     │
│                                                                                 │
│  apps/backend（NestJS 10 + better-sqlite3 WAL，127.0.0.1:37100）                 │
│                                                                                 │
│  ┌─ Agent 核心（agents/）──────────────────────────────────────────────┐        │
│  │ AgentService（agent.service.ts 319 行）= Supervisor 执行引擎         │        │
│  │  createTask→runTask：LLM 生成 JSON 计划(≤5 子任务，线性)             │        │
│  │   → 子任务落库 subtasks → 顺序执行（waitWhilePaused 400ms 轮询门）   │        │
│  │   → 每步写 checkpoints → 经 ToolGateway 执行                         │        │
│  │   → 越权转 WaitingApproval（停）→ Validation → 记忆沉淀 memories     │        │
│  │ 状态机（9 态）：Pending/Preparing/Running/Paused/WaitingApproval/    │        │
│  │  WaitingInput/Completed/Failed/Cancelled（shared-types TaskStatus）  │        │
│  │ 6 内置 Agent：supervisor/project-analyzer/diagnostic/repair/        │        │
│  │  validation/git-agent（仅注册，plan 中 agent 字段不路由到独立实现）   │        │
│  │ ModelService（model.service.ts）：6 供应商 OpenAI 兼容 + 主备降级链   │        │
│  │  + OS 凭据存储（Win32 PasswordVault，base64 防注入）                 │        │
│  └─────────────────────────────────────────────────────────────────────┘        │
│                                                                                 │
│  ┌─ 工具与权限（permissions/）────────────────────────────────────────┐        │
│  │ ToolGatewayService：唯一受控执行漏斗 fs.read/fs.write/command.exec  │        │
│  │   权限检查→tool_calls 落库→执行→审计；fsWrite 原子写+备份；         │        │
│  │   commandExec 超时 killTree（仅杀本调用进程树）                     │        │
│  │ PermissionService：6 主体 × 8 类别 × 项目范围；越权自动建 approval；│        │
│  │   user 主体隐式全授权；批准→30 天 permission                        │        │
│  │ AuditService：audit_records + 键名级脱敏 redact()                   │        │
│  │ 调用方：AgentService / WorkflowService(command step) / plugins /    │        │
│  │   diagnostics(repair-loop) / workspace(写) / REST POST /tools/call  │        │
│  └─────────────────────────────────────────────────────────────────────┘        │
│                                                                                 │
│  周边执行域：git.service（push 五道门已实装）· runtime.service（服务生命  │        │
│  周期/自愈/接管，有启动恢复）· autostart+auto-fixer+repair-loop（LLM 修复   │        │
│  闭环）· workflows（DSL 4 步型+cron/interval/event 触发，防重入内存 Set）   │        │
│  terminal（用户交互 shell，绕过网关）· projects（规则引擎识别，无 AI）      │        │
│  memory（3 scope 关键词 LIKE）· mcp（仅 Server：7 工具 JSON-RPC+SSE）       │        │
│                                                                                 │
│  观测面：EventsGateway(/ws 纯内存广播，无持久化/无补齐/无过滤) · LogService │        │
│  （正文写文件不脱敏）· NotificationService（规则订阅）· audit_records        │        │
│                                                                                 │
│  apps/renderer（Vite+React+antd，App.tsx 1897 行 17 页 hash 路由）               │
│    三栏 Agent 工作区雏形（230px/1fr/300px）+ 任务/审批/工作流/记忆等 16 管理页   │
│    数据 100% 真实 API；无 WS（全部 1.2~8s 轮询）；shared-types 0 import；        │
│    api-client 包为空壳；xterm/Monaco 幽灵依赖                                    │
│                                                                                 │
│  数据层：SQLite 31 表，V1–V9 版本化迁移（事务+迁移前备份），WAL+外键             │
└─────────────────────────────────────────────────────────────────────────────────┘
```

执行请求路径（现状）：用户/前端 → REST → AgentService.runTask → ToolGateway →（权限通过）本地 fs/child_process。审批挂起路径：PermissionService.check 失败 → 自动 INSERT approvals → runTask 返回 WaitingApproval 停止 → 用户审批中心 approve → 落 30 天 permission → 重跑（**从头重跑，非断点续跑**）。

---

## B. 已有功能与实现程度对照表

实现程度分级：✅已实现且测试 / 🟡已实现缺测试 / 🟠部分实现 / 🔴仅数据/骨架 / ❌未实现

| 目标能力 | 现状 | 程度 | 证据 |
|---|---|---|---|
| Agent 注册表 | 6 内置 Agent 落 agents 表；但 plan 的 agent 字段仅是标签，无独立实现路由 | 🟠 | agent.service.ts:20-27, 205-211 |
| 任务创建/持久化 | tasks 表持久化，重启后数据在 | ✅ | agent.service.ts:69-76 |
| 状态机 | 9 态 + 后端集中转换 + 409/404 语义 + 10 例单测 | ✅ | agent.service.ts:90-152; agent-state.spec.ts |
| LLM 规划 | JSON 计划生成，失败转 WaitingInput 追问 | 🟡 | agent.service.ts:185-201 |
| 计划校验 | 仅检查 subtasks 非空；无依赖/循环/Schema 校验；LLM 返回 tool 字段运行时无白名单校验 | 🔴 | agent.service.ts:193-194 |
| 子任务依赖执行 | subtasks.depends_on_json 字段存在但从未写入/读取；顺序按数组 | ❌ | database.ts:114; agent.service.ts:226 |
| 动态 Agent Loop | 无"分析结果→决定下一步"循环；固定顺序执行；无步数/Token/成本预算 | ❌ | agent.service.ts:226-272 |
| 暂停/恢复/取消 | 暂停=轮询门，取消=状态+循环检查；前端按钮守卫对齐 | ✅ | agent.service.ts:90-152; agent-state.spec.ts |
| WaitingInput 追问 | 合并补充→Pending→重跑 | ✅ | agent.service.ts:121-131 |
| 审批机制 | 越权自动建 approval；批准→权限；审计 | 🟡 | permission.service.ts:32-116 |
| 审批参数绑定 | **只绑定类别+项目，不绑定具体参数**；批准一次=该类别 30 天任意执行 | 🔴 | permission.service.ts:64-108 |
| 审批状态校验 | approve 不检查当前状态：rejected 可再 approve；无请求主体校验 | 🔴 | permission.service.ts:83-110 |
| Checkpoint | 每步写入 checkpoints 表，**但无任何读取/恢复代码**（纯审计记录） | 🔴 | agent.service.ts:237-240（唯一读取=getTask 展示 :86） |
| 服务重启恢复 | Agent 任务无恢复；重启后 Running/Preparing/WaitingApproval 永久卡死。对比：runtime.service 有（:55-69），workflows 无 | ❌ | agent.service.ts:55-62 |
| 超时 | command.exec 有（120s+killTree）；**LLM 调用无超时**；Run 总超时无 | 🟠 | tool-gateway.service.ts:163-199 |
| 重试 | 无 Run 级重试；repair-loop 有 3 次修复重试（诊断域专用） | 🟠 | diagnostics/repair-loop.service.ts |
| 幂等/防重入 | runTask 无防重入（可并发双跑）；WorkflowService 有内存 Set | 🔴 | agent.service.ts:173-183 |
| 工具注册（Registry） | TOOL_CATEGORY 硬编码 3 工具映射，无版本/Schema/风险等级/超时元数据 | 🔴 | tool-gateway.service.ts:40-44 |
| fs 工具 | read/write 有（写有备份+原子）；list/search/edit/move/delete/diff 无 | 🟠 | tool-gateway.service.ts:138-160 |
| 路径安全 | **无路径规范化/穿越/符号链接校验**；pathScope 传入但从不参与判定；P30 事故后仅 repair-loop 加了越界拦截（agent 主链路没有） | ❌ | tool-gateway.service.ts:138-160; permission.service.ts:52-57 |
| 终端工具 | 用户交互终端（绕过网关、无上限）；Agent 无终端工具接入点 | 🟠 | terminal.service.ts:27-57 |
| Git 工具 | 五道门全部实装（白名单/分支保护/密钥扫描 fail-closed/审批/审计）；白名单注册语义宽松 | ✅ | git.service.ts:193-245 |
| MCP | 仅 Server（7 工具+resources+prompts，JSON-RPC+SSE，外部执行走审批双门）；**无 Client 侧**（接外部 MCP Server）；无超时 | 🟠 | mcp.controller.ts:13-67 |
| 记忆系统 | 3 scope + LIKE 检索 + 手动沉淀 + 任务结果自动沉淀；无向量检索/更新/来源治理；Agent 写库绕过 memory 模块 | 🟠 | memory.controller.ts; agent.service.ts:284-289 |
| 上下文管理 | 规划 prompt 仅拼 goal+项目元数据（4 字段）；无会话上下文/工作记忆/上下文预算/裁剪/摘要 | 🔴 | agent.service.ts:298-305 |
| Token/成本统计 | agent_executions.tokens_json 列存在**从未写入**；usage 仅打日志 | ❌ | database.ts:142（仅定义）; model.service.ts:210 |
| 执行事件 | events 表存在**无人写入**；WS 仅内存广播；无事件持久化/序号/补齐/订阅过滤 | ❌ | events.gateway.ts:42-47; grep "INSERT INTO events"=0 |
| 执行回放 | 无（前端 JSON dump 子任务+检查点原文） | ❌ | App.tsx:93-108 |
| 结果验证 | Validation 仅 `results.every(r=>r.ok)`；非 ok 提前 return，PARTIAL 分支不可达（dead code） | 🔴 | agent.service.ts:274-277 |
| 会话/Run 分离 | 无 Session 实体；Run=task，无 attempt 概念；重跑覆盖式重规划（subtasks 不清旧记录，`plan_version+1` 仅 tasks 表） | ❌ | database/tasks+subtasks 表 |
| WebSocket 实时 | 后端网关就绪；前端 0 接入，全部轮询 | 🟠 | events.gateway.ts; 前端 api.ts:57 wsUrl 死代码 |
| 前端工作台 | 三栏雏形（左任务列表/中子任务时间线/右 Inspector）+16 管理页，数据真实；无 Diff/工具详情/报告/对话流；3 个字段级 bug | 🟠 | App.tsx:1316-1466 |
| 主题三态 | system/light/dark 完整实现（含 Windows matchMedia 兜底） | ✅ | useTheme.ts |
| Prompt Injection 防护 | input_summary 原样进 prompt；工具返回不隔离；无任何测试 | ❌ | agent.service.ts:190 |
| 多 Agent 协作 | 无（Orchestrator/子 Agent/并行/隔离均无） | ❌ | — |

测试现状摘要：单测 62/62（7 suites，真实断言、内存 SQLite+真实迁移），覆盖 agent 状态机/workflows/cron/plugins/configcenter/databases/diff；**permissions、git、mcp、runtime、projects、model 降级链、memory、terminal 全部无单测**。验收 14/14（API 冒烟+安全门禁级；路径硬编码本机，不可进 CI；S12 LLM 全链路 skip）。9 个验证脚本均 console.log 人工判读，无退出码门禁。Agent 关键路径（checkpoint 恢复、重启恢复、超时、并发、注入）零测试覆盖。

---

## C. 缺失功能清单（对照总指令 §3-§10）

**Runtime 层**
1. Agent Loop 动态决策循环 + 执行预算（步数/调用次数/Token/成本/时长/连续失败）
2. Run/Step/ToolExecution/Attempt 四级实体与 Session 分离（当前仅 task/subtask/tool_calls）
3. Checkpoint 读取与断点恢复（写已有、读没有）
4. 服务重启后的任务状态收敛与恢复
5. runTask 防重入（DB 级租约/fencing）
6. LLM 调用超时 + Run 总超时
7. Run 级重试分类策略（区分可重试错误类型）
8. Result Validator 真实验证（测试退出码/文件变更核对），修 dead code
9. 计划结构化校验（Schema、依赖、循环检测、版本历史、tool 白名单运行时校验）

**工具系统**
10. Tool Registry 元数据化（Schema/风险等级/超时/幂等/副作用/审批要求）
11. fs.list/search/edit/move/delete/diff 工具；路径沙箱（白名单根目录+穿越+symlink）
12. terminal.execute 网关化 + 进程树管理 + 会话上限
13. MCP Client 侧（注册外部 Server/工具发现/Schema/调用/超时/信任分级）

**权限审批**
14. 审批绑定具体参数（tool+参数哈希+cwd），参数变更重审批
15. approve/reject 请求主体校验 + 审批状态机校验（防重放/自批）
16. tools/call 端点的调用方认证（P0）
17. 权限分级 L0-L3 体系（当前 8 类别无风险等级）

**上下文/记忆**
18. Session/Task/Working Memory 三层上下文与 Token 预算、历史裁剪、摘要
19. 记忆检索升级（taskId 过滤、update、来源治理、敏感信息闸门）

**可观测性**
20. agent_events 统一事件体系（持久化+序号+查询+补齐）
21. Token/成本落库与汇总（列已有，写没有）
22. 执行回放 API + 前端时间线
23. 错误追踪（分类/可重试标记/堆栈脱敏）

**前端**
24. WS 接入（后端就绪）+ 断线重连 + 事件补齐
25. 任务计划视图/工具调用卡片/文件 Diff/结果报告/对话式多轮
26. 修复 3 个确定性 bug：Inspector project_scope 字段（App.tsx:1446）、审批面板未按 target_ref 过滤、工作流运行详情 404（App.tsx:1783 `/workflow-runs/:id` vs 后端 `/workflows/runs/:runId`）
27. WaitingInput 在 Agent 工作区无补充入口（死路）

---

## D. 安全风险清单（P0 优先）

| # | 级别 | 风险 | 证据 |
|---|---|---|---|
| S1 | **P0** | 权限模型整体绕过：`POST /api/v1/tools/call` 的 subjectType 由请求方自报，声明 `user` 即隐式全授权，fs.write/command.exec 全通（全机读写+任意命令） | permission.controller.ts:38-41 → tool-gateway.service.ts:54-65 → permission.service.ts:36-38 |
| S2 | **P0** | 审批可自批：approve/reject 无请求主体校验、无认证、不检查审批当前状态（rejected 可再 approve）。Agent 可执行 `curl 127.0.0.1:37100/api/v1/approvals/<id>/approve` 自批后获得 30 天权限 | permission.controller.ts:18-26; permission.service.ts:83-116 |
| S3 | P0（按总指令 1.3 定义为安全停线项） | 全 REST/WS 零认证零 Guard（全后端 grep 证实）：本机任意进程=超级用户；Agent 拉起的子进程同样可直调 API | main.ts（无 Guard/Pipe）；audit-platform 全库 grep |
| S4 | P1 | terminal.input 无会话归属校验：任意 WS 客户端可向用户终端注入按键（用户全权限 shell） | events.gateway.ts:50-54; terminal.module.ts:22-26 |
| S5 | P1 | 审批仅绑定类别不绑定参数；30 天有效；参数变化不重审批。违反总指令 §6.2 | permission.service.ts:64-108 |
| S6 | P1 | 路径安全缺失：fs.read/fs.write/command.exec.cwd 无工作目录白名单、无穿越/symlink 防护；pathScope 从不参与校验 | tool-gateway.service.ts:138-160; permission.service.ts:52-57 |
| S7 | P1 | LLM 计划注入面：input_summary 原样进 prompt；plan.tool 运行时无白名单（TS 类型编译期而已），恶意/幻觉 tool 名直通 gateway；categoryFor 未知工具返回 undefined 类别 | agent.service.ts:190-194, 293-296 |
| S8 | P1 | 日志泄漏：log 正文不脱敏（redacted 恒 0）；审计 detail 一处未 redact（command 原文入库）；redact 数组不递归 | log.service.ts:48; tool-gateway.service.ts:100-104; audit.service.ts:48 |
| S9 | P2 | 迁移前备份 `db.backup()` 未 await：备份语义不成立+潜在 unhandledRejection；applyPendingRestore 覆盖前无备份 | database.ts:532; database.module.ts:29-39 |
| S10 | P2 | 凭据存储读写不对称：写降级文件、读永不降级 → 密钥存了读不回；降级时 backend 字段误报 | credential-store.ts:114-135 |
| S11 | P2 | extractArchive 路径双引号拼接注入向量（Win PS $() 插值 / POSIX 反引号） | platform-adapters index.ts:84-92, 147-152 |
| S12 | P2 | 模型降级链 _keyCache + apiKey 复位逻辑存在跨供应商 key 污染窗口（chat() 循环中复位时机） | model.service.ts:230-251 |
| S13 | P3 | Electron setWindowOpenHandler 对任意 URL shell.openExternal 无白名单；F12 打包态可用 | desktop main.ts:36-39, 53 |
| S14 | P3 | 项目删除 deleteFiles=true 直接 fs.rmSync(root_path) 无二次路径保护；cloneRepo execSync 阻塞事件循环 | project.service.ts:226, 263-264 |
| S15 | P3 | 并发/一致性：runTask 无防重入可双跑；Approval approve 幂等缺失；WS 全量广播无过滤；事件名 notification.new vs WS_EVENTS notification.created 分裂；approval.required 事件从未发出 | agent.service.ts:173-183; notification.service.ts:46 |

**文档-代码不一致（已核实，以代码为准）**：① D02"push 尚需实装"过时——五道门已全部实装（git.service.ts:193-245）；② D01 称 waitWhilePaused"可跨重启恢复"不实——重启后无任何任务恢复（agent.service.ts:55-62 仅注册 Agent）；③ 未完成清单"schema v8/31 表"滞后——代码已 V9；④ 导航宣称"AI 诊断"但诊断 UI 从未接入后端 /diagnostics。

---

## E. 数据库与 API 改造建议

**数据库（现有 31 表 V9，全部增量迁移，不换库不重建）**

- V10 建议内容：
  - `agent_sessions`（新增，Session 实体，FK user 无需；关联 project）
  - `tasks` 增列：`session_id`、`current_attempt`、`attempt_count`、`budget_json`、`timeout_at`（既有 plan_version 复用）
  - `agent_run_attempts`（新增：attempt 维度执行记录，重试不覆盖历史）
  - `subtasks` 启用 `depends_on_json`（写入+拓扑校验）；增 `attempt_count`、`error_json`
  - `plans` 表（新增：计划版本化存储，plan_json+version+status，替代"只存 tasks.plan_version"）
  - `agent_events`（新增：run 级事件流，seq 自增+event_type+run_id+step_id+payload_json+created_at；唯一 ID+索引 (run_id, seq)）
  - `tool_calls` 增列：`run_id`、`step_id`、`params_hash`（审批绑定用）、`duration_ms`（修 tool-gateway.service.ts:191 恒 undefined bug）、`attempt`
  - `approvals` 增列：`payload_json`（完整参数快照）、`payload_hash`、`expires_at`、`decision_subject`；`permissions` 增 `approval_id` 回链（单次授权模式）
  - `agent_usage_records`（新增：provider/model/input_tokens/output_tokens/cached/cost_estimate/run_id；填充现有 tokens_json 或直接弃用该列）
  - `agent_memories`：沿用 memories 表，增 `valid_until`/`updated_at`
- 保留：tasks/subtasks/checkpoints/audit_records/permissions/approvals 结构不动大改，走 ALTER。
- SQLite 约束明确化：单实例单 Worker 为主，租约用 `tasks.lease_owner+lease_expires_at`（better-sqlite3 同步事务天然串行，WAL 下读并发）；避免多进程写。

**API（全部新增前缀化，不破坏现有 /api/v1/*）**

- 新增 `/api/v1/agents/sessions`、`/agents/runs`（创建 Run=现在的 task，兼容层：现有 /tasks 端点保留映射）
- Run 操作：`/agents/runs/:id/{pause,resume,cancel,retry,archive}`
- Run 数据：`/agents/runs/:id/{plan,steps,events,tools,result,diff}`（events 支持 `?since=<seq>` 补齐）
- 审批加固：`/approvals/:id/decision`（body 带 decision+请求来源标识）；approve 校验状态与来源
- 新增 `/agents/tools`（Registry 元数据）、`/agents/metrics`（Token/成本聚合）
- 统一响应/错误格式（已有 ApiErrorBody 类型，落实全局 filter + ValidationPipe）
- WS：`/ws` 加订阅协议（subscribe run_id）+ 事件持久化后 lastSeq 重放

---

## F. 现有代码复用方案（不推倒重写清单）

| 现有资产 | 复用方式 |
|---|---|
| ToolGatewayService（tool-gateway.service.ts） | 直接作为 Tool Dispatcher 底座：保留权限→落库→执行→审计管线；扩展 TOOL_CATEGORY 为 Registry 元数据表；fs.read/write 逻辑迁入后加路径沙箱 |
| PermissionService + approvals/permissions 表 | 保留模型；加参数绑定+状态校验+主体校验（§D S2/S5 修复即在此文件） |
| AuditService.redact | 保留；补数组递归（audit.service.ts:48） |
| AgentService 状态机骨架 | 保留 9 态与 pause/resume/cancel/respondInput 语义（已有 10 例单测）；在其外层包 Run/Attempt 实体，runTask 循环重构为 Planner/Executor/Loop 三组件（拆文件不重写逻辑） |
| waitWhilePaused 模式 | 保留暂停门；扩展为统一"协作取消点" |
| ModelService | 直接复用（6 供应商+降级链+凭据存储）；加 fetch AbortController 超时与 usage 解析落库 |
| diagnostics/repair-loop.service.ts | **现成 Agent 执行循环模板**（LLM→计划→门控写→Diff→验证≤3 次→回滚），Executor/Result Validator 设计直接参照；其路径越界拦截（repair-loop.service.ts:111-125）提升为 ToolGateway 公共能力 |
| git.service 五道门 | 原样保留，包装为 git.* 工具注册进 Registry（status/log/diff=只读；commit/push=审批级） |
| runtime.service 进程治理 | 复用拓扑排序/探活/killTree/自愈上限，作为 Agent 沙箱进程管理底座 |
| events.gateway + DevPilotEvent 信封 | 保留信封与 WS 通道；加持久化（写 agent_events）+订阅过滤+since 重放；去 monkey-patch（workflows:187 / plugins:233 改为事件总线订阅） |
| workflows/cron.ts | 直接复用（零依赖+10 例单测） |
| platform-adapters | shellFor/killTree/pidAlive 直接复用；修 POSIX killTreeWait 与 extractArchive 注入 |
| credentials 凭据存储 | 直接复用；修读写不对称 |
| 数据库迁移框架 | V10 起按既有模式追加（事务+备份） |
| testing/helpers（内存 SQLite+真实迁移） | 直接复用为新测试基座 |
| 前端三栏骨架+主题系统+api() | 保留布局与主题；Agent 工作区按 §C-24/25/26 增量改造 |
| acceptance.mjs | 保留场景；参数化路径进 CI |

**不复用/需新建**：MCP Client 侧（全新）、agent_events 事件系统（全新）、plans/Run-Attempt 实体（全新）、上下文管理器（全新）、多 Agent 编排（阶段 6 前不做）。

---

## G. 具体文件级实施计划（阶段 1 为主，供确认后执行）

**阶段 1（Agent 核心 Runtime）——预计触及文件**
1. `apps/backend/src/agents/run/` 新建目录：
   - `state-machine.ts`（迁移集中转换规则，源自 agent.service.ts 现有 409/404 语义）
   - `planner.ts`（迁出 runTask L185-201 规划段 + plan Schema 校验 + 依赖图校验 + tool 白名单）
   - `executor.ts`（迁出 runTask L226-272 执行段 + 步骤超时 + 重试分类）
   - `agent-loop.ts`（新增动态循环 + 预算控制 + 连续失败熔断）
   - `result-validator.ts`（新增：完成条件核对 + 测试退出码验证，替换 :274-277 dead code）
   - `checkpoint.ts`（新增：读取/校验/恢复 API，消费现有 checkpoints 表）
2. `apps/backend/src/agents/agent.service.ts`：runTask 改为调用上述组件；加防重入（status WHERE 守卫 + lease）；保留全部现有端点行为
3. `apps/backend/src/agents/agent.controller.ts`：新增 `/agents/runs*` 端点（现有 /tasks 端点保留）
4. `packages/shared-types/src/index.ts`：Run/Attempt/Plan/Step DTO + 事件类型 + 预算常量
5. `apps/backend/src/database/database.ts`：V10 迁移（§E 清单）
6. 测试：`agents/run/*.spec.ts`（状态机全转换/防重入/预算/超时/checkpoint 恢复/validator）

**阶段 2（工具+权限审批）**
- `permissions/tool-registry.ts` 新建；`tool-gateway.service.ts` 改造（Registry 驱动+路径沙箱+params_hash）
- `permission.service.ts`：审批参数绑定+状态机+主体校验（S2/S5）
- `main.ts`/新增 `auth.guard.ts`：本地令牌机制（S1/S3，需 J-1 决策）
- `git.service.ts` 工具化注册；`terminal.service.ts` 网关化
- `mcp/`：fetch 加超时；新建 `mcp-client/`（外部 Server 注册/发现/调用）

**阶段 3（上下文+可靠性）**
- `agents/context/` 新建（project/session/working-memory + Token 预算裁剪）
- `agents/recovery.ts`（onModuleInit 收敛 Running/Preparing 僵尸 → 状态收敛 + 符合条件者标 Failed-可恢复）
- checkpoint resume 打通 run-external 批准后续跑（替代从头重跑）
- `memory/`：service 层 + taskId 过滤 + update

**阶段 4（可观测性）**
- `events/` 改造 events.gateway（持久化+since+过滤）；agent_events 写入埋点（agent.service 各状态点+gateway 各调用点）
- `agents/usage.ts`（usage 解析+成本落库）；`/agents/metrics`
- 日志脱敏补齐（log.service.ts:48、tool-gateway.service.ts:100、audit.service.ts:48）

**阶段 5（前端）**
- `apps/renderer/src/App.tsx` AgentsCenterPage 重构（保留数据源）：WS 接入、计划视图、工具卡片、Diff 视图、审批面板（按 target_ref 过滤）、结果报告、修复 3 bug
- 移除幽灵依赖或落地 xterm

**阶段 6/7**：多 Agent 编排、全量验收（待前序阶段确认后细化）。

---

## H. 分阶段测试计划

| 阶段 | 单元测试（新增） | 集成/验收 | 安全测试 | 故障注入 |
|---|---|---|---|---|
| 1 | 状态机全转换矩阵、防重入（并发 runTask 双调）、预算熔断、checkpoint 恢复、validator 四态、plan 校验（循环依赖/非法 tool） | run-external 审批批准后续跑不重复执行已完副作用；服务重启恢复场景脚本化断言 | tool 白名单绕过尝试 | kill 后端进程 → 重启 → 断言状态收敛 |
| 2 | Registry schema 校验、路径沙箱（穿越/symlink/越界）、审批绑定（参数变更重审批/过期/重放） | fs.write→diff→回滚链路；git commit/push 门禁 | S1-S8 逐项用例（伪造 user subjectType 应 401；自批应 403） | 审批等待中重启；命令超时 killTree |
| 3 | 上下文裁剪（Token 预算）、记忆 update、幂等键 | 断点续跑端到端 | 记忆敏感信息闸门 | LLM 不可用降级链 |
| 4 | 事件持久化/补齐、成本计算 | 回放 API 全序核对 | 审计脱敏断言 | WS 断线补齐 |
| 5 | 组件级（Vitest 若引入）| acceptance.mjs 参数化 + 新增场景 15-20 | XSS/Diff 注入 | 轮询降级 |
| 7 | 全量回归 | 14 旧场景全过 + 新增 | 全量安全矩阵 | 全量 |

现状基线：62/62 单测 + 14/14 验收必须在每个阶段结束时保持全绿（回归门禁）。

---

## I. 推荐实施顺序

1. **P0 安全止血（先于阶段 1，半天量级）**：S1 tools/call 主体校验、S2 审批状态机+主体校验、S3 本地令牌最小实现、S7 plan tool 白名单。理由：这 4 项是后续所有阶段的安全地基，且改动集中在 3 个文件。
2. 阶段 1 Runtime（§G-1）：先状态机+防重入+超时，再 Planner/Executor 拆分，再 Loop+Validator，最后 checkpoint 读恢复。
3. 阶段 2 工具+审批绑定（含路径沙箱——P30 事故已证明其必要性）。
4. 阶段 3 恢复+上下文。
5. 阶段 4 可观测性。
6. 阶段 5 前端（WS+工作台重构；可与阶段 4 部分并行，因依赖事件体系）。
7. 阶段 6 多 Agent；阶段 7 总验收。
8. 顺手修复类（任意阶段间隙）：tool-gateway durationMs bug、notification 事件名对齐、workflow ne 不对称 bug、V10 迁移备份 await、凭据读写对称、POSIX killTreeWait。

---

## J. 需要用户决策的技术问题

1. **本地认证方案（S1/S3 修复选型）**：A. Electron 启动时生成一次性 token（进程级，最贴合桌面单用户）；B. 本地 Unix socket/命名管道替代 TCP；C. 维持 127.0.0.1 裸奔仅加 tools/call 主体白名单。推荐 A。
2. **审批授权模式**：A. 单次授权（每次审批绑定参数，一次性消耗，最安全）；B. 短时窗授权（绑定参数+有效期如 10 分钟，同参数复用）；C. 保持现状 30 天类别级。推荐 B（平衡体验与总指令 §6.2）。
3. **Run 实体迁移策略**：A. 新建 agent_runs 表，tasks 表保留兼容映射（旧 /tasks API 不变）；B. 直接扩展 tasks 表（迁移重）。推荐 A。
4. **D01 LangGraph 决策复审**：总指令要求动态 Loop + 依赖拓扑，满足 D01 触发条件之一（"条件分支/并行/循环的规划输出"）。是否启动复审，还是继续自研扩展（推荐：继续自研——现有状态机/审批/测试基座耦合度高，自研扩展成本低，复审条件第②条未满足）。
5. **MCP Client 优先级**：总指令 §5.2 要求外部 MCP 接入。放在阶段 2 一起做，还是延后到阶段 3 之后？（推荐阶段 2 末尾）
6. **SQLite 并发上限**：确认"单后端进程 + 单执行 Worker（内存队列）"为生产约束，多 Worker 支持列为远期？（推荐是）
7. **P0 修复是否允许在本确认后、阶段 1 开工前先行提交**（改动仅 permissions/main.ts/agents 三处，可独立回滚）。
8. **未提交的 3 个 renderer 文件**（Apple Premium 重设计中间态）：审计基于该工作树状态完成。阶段 5 前端改造基于哪个视觉基线——当前重设计方向还是 `abcabdb` 备份版？

---

## 附：本阶段执行凭证

- 修改文件数：0（纯只读审计）；新增本文档 1 份。
- 审计覆盖：backend 22 模块全读 / renderer 17 页全查 / 测试 7 suites+14 验收+9 脚本 / docs 5 份 / 开发日志 3 份 / desktop+3 packages。
- 已运行检查命令：grep 验证 tokens_json/checkpoints 读取/events INSERT/路径校验/防重入/启动恢复等 8 组关键疑点，全部有代码级证据。
- 未执行：真实 API 联调（后端未启动，验收脚本需 DB 可写环境）——如需可运行 `node tests/acceptance.mjs` 复核 14 场景。
