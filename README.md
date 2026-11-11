# DevPilot

本地优先的 AI 项目管理与开发执行工作台。设计基线见 `docs/`。

## 结构

- `apps/desktop` — Electron 主进程与 Preload
- `apps/renderer` — React + TypeScript + Ant Design
- `apps/backend` — NestJS 本地后端
- `packages/shared-types` — DTO、事件与共享类型
- `packages/platform-adapters` — OS 差异适配层
- `packages/api-client` — 前端 API 客户端

## 开发

```bash
pnpm install
pnpm dev:backend     # 启动本地 NestJS 后端
pnpm dev:renderer    # 前端 Vite 开发服务器
pnpm dev:desktop     # Electron 桌面壳
```
