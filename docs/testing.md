# 测试说明

## 分层

| 层 | 命令 | 依赖 | 数量（2026-11-14 UI 修复后） |
|---|---|---|---|
| 全仓类型检查 | `pnpm -r run typecheck` | 无 | 5/5 项目 |
| 后端单元测试 | `cd apps/backend && pnpm test` | 无（内存 SQLite） | 20 suites / 173 cases |
| 官方集成验收 | `DEVIPILOT_API=http://127.0.0.1:37100/api/v1 node tests/acceptance.mjs --no-report` | 运行中的后端 | 24 项 |
| 接口/异常/边界/安全回归 | `node tests/qa/blackbox.mjs <base>` | 隔离实例 37150 | 105 项 |
| 性能/并发/启动耗时 | `node tests/qa/perf.mjs <base>` | 隔离实例 37150 | 14 组 |
| E2E 多技术栈 | `.audit-e2e/e2e.mjs`（隔离端口 37150 + 隔离数据目录） | Node/Java/Maven/Python 本机 | 26 检查项 |
| 故障注入 | `.audit-e2e/faults.mjs`（幂等，可重复跑） | 同上 | 14 场景 |
| Agent 真实 LLM 评估 | `node scripts/agent-evals-real.mjs [--scenario S01]` | 真实模型 Key（费用） | 3+ 场景 |

## 关键回归面（改权限/网关/运行时必跑）

- Agent 文件越界（gateway-containment.spec）
- 参数级审批：同参放行/改参重审/one-shot 防重放/L3 强制（permission-approval.spec + 验收 S5 系列）
- 审批后任务自动恢复、并发重入、无效输出上限（agent-loop-safety.spec）
- 工具包含校验与 pendingApproval 标志（tool-registry-safety.spec）
- 受管服务互斥与外驻停止确认（故障注入 F5/F5b）
- ZIP Slip / 压缩炸弹 / SSRF / 审计脱敏（safe-archive.spec + 故障注入 F10-F12 + 验收 S11）
- 本机防 CSRF：跨源请求拒绝、`Origin: null` 需 token（auth.spec）
- 端口接管归属校验：外部进程不接管、不终止（runtime.service `pidBelongsToProject`）
- 启动命令守卫：数据库/缓存服务不得被写成静态服务器，入口文件必须存在（`runtime/fix-guard.ts`）
- 项目识别：npm workspaces 子包与 compose 服务键解析（`project-analyzer` workspace/compose 用例）
- 配置体检：.env 缺失/占位符/API Key 真实探测/DB 连通/端口占用（`projects/config-check.service.ts`）
- 子进程环境净化：宿主注入的 NODE_OPTIONS/*_SHIM 不得传给被托管项目（`platform-adapters.cleanServiceEnv`）

## 隔离原则

E2E 与故障注入一律使用 `DEVIPILOT_BACKEND_PORT=37150 DEVIPILOT_DATA_DIR=<隔离目录>`，不写真实开发库（:37100），不在用户项目上做破坏性注入。
