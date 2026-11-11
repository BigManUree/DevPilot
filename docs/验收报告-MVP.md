# DevPilot MVP 验收报告

> 日期：2026-11-10
> 版本：MVP 0.1.0（开发线 T1—T12 全部完成）
> 环境：Windows，Node v22.22.2，后端 127.0.0.1:37100
> 脚本：`tests/acceptance.mjs`（可重复运行，幂等设计）
> 明细数据：`docs/验收报告-MVP.json`

## 1. 验收结果：12/12 PASSED

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

## 3. 未纳入本次自动化（backlog）

- LLM 真实链路（Supervisor 规划执行 / AI 修复全流程）：**待 DeepSeek API Key**，代码与审批/权限/Diff/回滚链路已就绪并单独验证。
- 共享服务引用保护多项目场景：机制已实现（stopService otherRefs 检查），需双项目 fixture。
- Git 操作保护、插件治理、异常退出恢复（kill -9 后端实测）：属第二/三阶段或建议人工执行。

## 4. 已知限制

- 环境检测对未安装工具显示 error（missing/error 细分待细化）。
- 终端为 pre+输入框形态，xterm.js 美化待第二阶段。
- runTask 无 Key 已改为 {status:'Failed'} 返回。
