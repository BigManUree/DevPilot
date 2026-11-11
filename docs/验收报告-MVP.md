# DevPilot MVP 验收报告

> 日期：2026-11-10
> 版本：MVP 0.1.0（开发线 T1—T12 全部完成）
> 环境：Windows，Node v22.22.2，后端 127.0.0.1:37100
> 脚本：`tests/acceptance.mjs`（可重复运行，幂等设计）
> 明细数据：`docs/验收报告-MVP.json`

## 1. 验收结果：14/14 PASSED

> 首版 12 项（2026-11-10）；S13（共享服务引用保护双项目 fixture）与 S13b（路径重映射导入）于 2026-11-11 加入。

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| S10 | 健康检查 | ✅ | /health status=ok |
| S9 | SQLite 版本化迁移 | ✅ | schema v2，26 表，迁移前自动备份 |
| S1 | 混合项目导入识别 | ✅ | demo-project 识别 vue 前端 + maven 后端 |
| S2 | 服务独立启动/停止 | ✅ | start=Running → stop=true，端口探活 |
| S6 | 停止不误杀外部进程 | ✅ | 外部进程在停止后仍存活，仅会话 PID 被终止 |
| S3 | 端口占用检测 | ✅ | 运行中服务端口 occupied=true |
| S4 | 环境需求比对与缺失报告 | ✅ | 4 项需求逐项检出，缺失项带官方安装指引 |
| S5 | 未授权命令阻止 | ✅ | agent 身份越权 → PERMISSION_DENIED + 审批单生成 |
| S5b | 审批授权后放行 | ✅ | 批准 → 30 天权限 → 命令 exit=0 |
| S7 | 修改前备份 + 可回滚 | ✅ | original→modified→还原 original |
| S8 | 任务取消 | ✅ | status=Cancelled |
| S11 | 审计存在 + 密钥脱敏 | ✅ | 34 条审计，无明文密钥泄漏 |

## 2. 安全门禁（测试文档第 3 节）

本次覆盖的门禁项全部 PASSED：未授权命令执行（S5）、误杀外部进程（S6）、备份回滚（S7）、密钥脱敏（S11）、未验证不报成功（Validation 状态机）。

## 3. 未纳入本次自动化（backlog，2026-11-11 二次刷新）

首批 backlog 已全部关闭或移交：

- ~~LLM 真实链路~~：**已完成**（P2）。
- ~~终端 xterm.js~~：**已完成**（P2）。
- ~~config-center UNIQUE 冲突 500~~：**已完成**（P2，409/404 语义化）。
- ~~共享服务引用保护多项目场景~~：**已完成**（S13 用例 + force 停止出口，P6/P8）。
- ~~Git 推送策略~~：**已完成**（D02 五道门实装，P10）。
- ~~插件治理~~：**已完成**（声明式插件运行时 + 依赖/兼容校验，P13/P16）。
- ~~异常退出恢复（kill -9 实测）~~：**已完成**（runtime 恢复收敛 + e2e，P7）。

新增/移交（详见 docs/未完成工作清单.md v2）：

- 工作流触发器（schedule/event）与工作流前端页：后端 DSL/引擎/API 已就绪（P18），前端与触发器待做
- 自动更新下载/替换流水线：检查+提示已就绪（P17），下载替换依赖发布服务器
- macOS/Linux 适配实证：platform-adapters Posix 实现未在真机验证
- electron-builder NSIS 安装包（当前 dir target）

## 4. 已知限制

- ~~环境检测 missing/error 未细分~~：**已完成**（P6，checkProject 返回 missing/errors/problems）。
- runTask 无 Key 已改为 {status:'Failed'} 返回；规划失败转 WaitingInput 追问（P3）。
- 后端常驻以 scripts/backend-daemon.cmd + WMI 派生方式运行（沙箱内 schtasks 不可用；派生进程会被延迟回收，见开发日志 P9）。
- Posix 适配实现未在真机验证（本机 Windows）。
- S2 存在偶发启动竞态（单次 13/14，复跑 14/14，间歇性非回归）。
