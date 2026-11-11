# DevPilot 项目审查包说明

快照时间：2026-11-11 21:40（工作区 `C:/Users/administer/WorkBuddy/DevPilot`）
压缩包内为**源码 + 文档 + 测试 + 脚本 + 开发日志**，不含 node_modules / dist / 打包产物 / .git 历史。

## 技术栈

- pnpm monorepo：`apps/backend`（NestJS 10 + better-sqlite3，端口 37100）、`apps/desktop`（Electron 33）、`apps/renderer`（Vite + React + antd）、`packages/platform-adapters`、`packages/shared-types`
- 数据库：better-sqlite3（WAL），版本化迁移 V1–V8，31 表
- 桌面端打包：electron-builder（dir target）

## 快速验证

```bash
pnpm install
cd apps/backend && pnpm test        # 62 用例 / 7 suites
cd apps/backend && pnpm build && node dist/main.js   # 后端 :37100
node tests/acceptance.mjs           # 验收 14 项
```

自包含集成验证脚本在 `scripts/`（每个脚本自起自杀后端，可独立运行）：
`mcp-verify.cjs`、`selfheal-verify.cjs`、`plugin-verify.cjs`、`workflow-verify.cjs`、
`update-verify.cjs`、`p21-verify.cjs`、`p22-verify.cjs`、`perf-baseline.mjs`、`packaged-e2e.cjs`。

## 目录

| 路径 | 内容 |
|---|---|
| `apps/backend/src` | 21 个模块：agents / workflows / mcp / plugins / runtime / git / permissions / notifications / databases / configcenter / diagnostics / logs / testing 等 |
| `apps/renderer/src/App.tsx` | 20 页工作台（含工作流拓扑图 SVG DAG、插件中心、多供应商设置） |
| `apps/desktop/src` | Electron 主进程 + 后端管理（dev 用系统 node，打包用 electron-as-node + ABI 130 prebuild） |
| `packages/platform-adapters` | Win32/Posix 命令执行、进程树 kill、解压、凭据存储 |
| `docs/` | 需求整理、设计文档集、验收报告、未完成工作清单 v2.3、性能基线、技术决策 D01–D02 |
| `.workbuddy/memory/2026-11-10.md` | P1–P24 逐批次开发日志，含每条踩过的坑与修复方式（**审查时建议先读这份**） |

## 当前状态

- 验收 14/14 PASSED；单测 62/62；schema v8；git main 分支已提交
- 未完成清单：`docs/未完成工作清单.md` v2.3（A/B 段全清，仅剩 C 段远期 + 两项外部依赖：exe 替换流水线、多供应商真实 API 联测）

## 建议审查重点

1. `apps/backend/src/permissions/tool-gateway.service.ts` —— 命令执行审批双门（安全边界核心）
2. `apps/backend/src/git/git.service.ts` —— push 五道门（白名单 / 分支保护 / 密钥扫描 fail-closed / 审批 / 审计）
3. `apps/backend/src/workflows/workflow.service.ts` + `cron.ts` —— DSL 引擎、变量插值、触发器、防重入
4. `apps/backend/src/mcp/mcp.controller.ts` —— MCP JSON-RPC + SSE 双传输
5. `apps/backend/src/runtime/runtime.service.ts` —— 服务生命周期、自愈重启、force 停止语义
6. `packages/platform-adapters/src/index.ts` —— 跨平台命令引号处理（cmd.exe `/d /s /c` + verbatim args）
