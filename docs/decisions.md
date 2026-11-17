# 技术决策记录

## D03：审批从类别级升级为参数级（2026-11-14）

**背景**：第二轮审计遗留风险——批准一次 command.exec 获得同类操作 30 天免审批。

**决策**：
1. 审批/授权绑定 `工具 + projectId + 规范化参数摘要`（命令折叠空白、路径绝对化小写、fs.write 绑内容哈希）。
2. 批准生成 one-shot 授权（24h 有效，用一次即失效，消费用 CAS 防并发重放）。
3. L3 高危命令（11 类模式，见 `tool-gateway.service.ts` L3_COMMAND_PATTERNS）绕过一切已授权，强制当次审批。
4. V18 前旧审批（无 param_hash）兼容回退为类别级授权——不放宽任何现有边界。
5. 权衡：同一任务内多次不同命令需多次审批（安全优先于顺畅）；后续可加"本任务内同工具批量授权"作为用户可选。

**落点**：V18 迁移、`permission.service.ts` check/approve、`tool-gateway.service.ts` paramDigest/classifyCommandRisk。

## D04：受管服务互斥（2026-11-14）

**背景**：故障注入实测——A 服务停止会终止端口上属于 B 受管服务的 PID，并触发 B 的 on-failure 自愈重启（跨项目副作用）。

**决策**：端口接管前检查监听 PID 是否属于 tracked 服务；属于则拒绝接管并给出明确指引。外驻实例停止改用 `killTreeWait` + 死亡复核，未死透落 error。

## D05：Agent 评估三档体系（2026-11-14）

**决策**：确定性规则档（jest 日常跑，零成本）→ Mock 档（stub 模型跑完整循环）→ 真实 LLM 档（`scripts/agent-evals-real.mjs`，独立脚本+独立报告，不进 CI）。Mock 结果永不标注为真实 E2E。
