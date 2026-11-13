# DevPilot

本地优先的 AI 项目管理与开发执行工作台（Windows 桌面形态，Electron + NestJS + SQLite）。设计基线见 `docs/`。

## 当前状态（2026-11-13 智能化升级）

- **验收 22/22 PASSED**（`node tests/acceptance.mjs --help` 支持 --dry-run/--repo/--no-report）
- **单元测试 87/87**（10 suites，`cd apps/backend && pnpm test`）
- 数据库 schema v17（37 表，版本化迁移 + 迁移前自动备份）
- 后端端口 37100（REST `/api/v1/*` + WebSocket `/ws` 事件推送）

## 功能版图（20 页工作台）

| 页面 | 内容 |
|---|---|
| 首页工作台 | Supervisor 输入、任务/审批概览 |
| 项目管理 | 统一导入六来源（文件夹/git clone/压缩包 ZIP·7Z·RAR/HTTP 下载/Docker Compose）、组件树档案、环境体检、运行档案 |
| 任务中心 | 创建/执行/暂停/恢复/取消/追问（WaitingInput）闭环 |
| 运行中心 | 服务启停、端口探活、共享服务引用保护 + force、崩溃自动重启（on-failure ≤3 次） |
| 终端中心 | xterm.js 多会话 |
| 日志与诊断 | 级别过滤、AI 诊断、diff 审查 |
| 审批中心 | 权限审批双门（user/agent/plugin/external/workflow 全主体） |
| 环境与依赖 | 15 探针、missing/error 细分、依赖清单 |
| 系统设置 | 多模型供应商（deepseek/openai/moonshot/qwen/zhipu/custom）切换、Key 进 OS 凭据存储、首次引导重跑 |
| Git 中心 | push 五道门（远程白名单/分支保护/密钥扫描 fail-closed/审批/审计） |
| 代码工作区 | 文件树 + Diff 审查 |
| 数据库与服务 | 连接管理、本地服务、共享服务 |
| 外部工具 | 工具探测、命令级联动动作 |
| 配置中心 | 项目配置与环境档案（409/404 语义化） |
| 备份迁移 | 项目导出/导入 + **跨设备路径重映射** |
| 通知中心 | 规则订阅（类型通配 + 紧急阈值） |
| Agent 中心 | 6 注册 Agent、协作过程 |
| 记忆系统 | scope 过滤、检索、沉淀 |
| 插件中心 | 声明式插件（Manifest 校验/依赖/兼容/启停） |
| 工作流 | JSON DSL 定义、schedule(interval/cron)/event 触发器、SVG DAG 拓扑图、运行历史与上下文 |

## 开放接口

- **MCP Server**：`scripts/mcp-server.mjs`（零依赖 stdio，JSON-RPC 2.0）——tools（健康/项目/任务/任务执行/服务/通知）+ resources + prompts；外部执行走审批双门。HTTP 端点 `POST/GET /api/v1/mcp`（JSON-RPC 同步 + Accept text/event-stream SSE 流式）。接入：`{ "command": "node", "args": ["<repo>/scripts/mcp-server.mjs"] }`
- **REST**：`/api/v1/*` 全模块（projects/tasks/services/workflows/plugins/memories/notifications/...）

## 结构

- `apps/desktop` — Electron 主进程（BackendManager 拉起后端）与 Preload
- `apps/renderer` — React + TypeScript + Ant Design（20 页）
- `apps/backend` — NestJS 本地后端（31 表 SQLite）
- `packages/shared-types` — DTO、事件与共享类型
- `packages/platform-adapters` — OS 差异适配层（shell/进程树/凭据存储/工具发现/解压）
- `packages/api-client` — 前端 API 客户端
- `scripts/` — 打包（prepare-backend）、e2e 验证（desktop/packaged/mcp/selfheal/plugin/workflow/update/p21/p22）、守护（backend-daemon）
- `tests/` — acceptance.mjs（14 场景）+ fixtures

## 开发

```bash
pnpm install
pnpm dev:backend     # 启动本地 NestJS 后端
pnpm dev:renderer    # 前端 Vite 开发服务器
pnpm dev:desktop     # Electron 桌面壳

cd apps/backend && pnpm test      # 单元测试（48 用例）
node tests/acceptance.mjs         # 验收 14 场景（需后端运行）
```

## 文档

- `docs/未完成工作清单.md` — 当前剩余工作与技术事实清单（v2）
- `docs/验收报告-MVP.md` — 14 场景验收明细
- `docs/性能基线报告.md` — API/冷启动/WS 推送实测
- `docs/技术决策记录-D01-D02.md` — Agent 框架定型、git push 策略
- `docs/DevPilot_需求整理文档_V1.0.md` — 需求基线（9.1/9.2 决策已回填）
